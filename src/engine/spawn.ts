/**
 * Runtime agent lifecycle: create/resume spawned agents, run one task call,
 * apply the fixed setup order (preset mount → persona → tool filter →
 * structured output), per-agent memory, abort/timeout fusion, and run-end
 * session disposition (G1/G3/#16).
 * @module @deepseek-ai/dsh-workflow-engine/spawn
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { AgentConfig } from '../types.ts'
import { attachStructuredOutput, type StructuredAttachment } from './structured.ts'

export interface AgentPresetsLike {
  mount(ctx: Context, id?: string): Promise<unknown>
}

/** Minimal systemPrompt surface (plain type, cast via unknown: Context may or may
 * not be augmented with `systemPrompt` depending on the installed seam set). */
interface PromptScope {
  systemPrompt: { section(s: { name: string; order: number; text: string }): unknown }
}

export interface SpawnCall {
  agentId: string
  config: AgentConfig
  taskText: string
  structured?: { schema: Record<string, unknown> }
  timeoutMs?: number
  signal?: AbortSignal
  /** Session id to resume (checkpoint resume); absent for a fresh run. */
  resumeSessionId?: string
}

export interface SpawnResult {
  ok: boolean
  value?: unknown
  error?: string
}

interface LiveAgent {
  handle: { agent: import('@deepseek-ai/dsh-agent').Agent; dispose(): Promise<void> }
  structured?: StructuredAttachment
}

export class AgentRunner {
  private readonly live = new Map<string, LiveAgent>()
  private readonly structuredSessions = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly flowId: string,
    private readonly runId: string,
    private readonly workspaceRoot: string,
    private readonly parentPreset?: string,
  ) {}

  sessionId(agentId: string): SessionId {
    return SessionId(`${this.flowId}:${this.runId}:${agentId}`)
  }

  private workspaceDir(agentId: string): string {
    return `${this.workspaceRoot}\\${this.flowId}\\runs\\${this.runId}\\workspace\\${agentId}`
  }

  /** Run one agent call and return its output. */
  async call(call: SpawnCall): Promise<SpawnResult> {
    const { agentId, config } = call
    if (call.structured) {
      return this.runStructured(call)
    }
    if (config.memory === 'session') {
      return this.runSession(call)
    }
    return this.runOneShot(call, undefined)
  }

  /** Dispose every live session-agent created by this runner. */
  async disposeAll(): Promise<void> {
    for (const live of this.live.values()) {
      try { await live.handle.dispose() } catch { /* best-effort */ }
    }
    this.live.clear()
  }

  private async runOneShot(call: SpawnCall, structured: StructuredAttachment | undefined): Promise<SpawnResult> {
    const sid = this.sessionId(call.agentId)
    const handle = await this.createAgent(sid, call, structured)
    if (!handle) return { ok: false, error: 'agent creation failed' }
    try {
      const ok = await this.drive(handle.handle.agent, call.taskText, call.signal, call.timeoutMs)
      if (!ok) return { ok: false, error: 'agent run aborted' }
      if (call.structured) {
        const cap = handle.structured?.captured()
        if (cap === undefined) return { ok: false, error: 'structured output not captured' }
        return { ok: true, value: cap.value }
      }
      const text = finalAssistantText(handle.handle.agent.session)
      return { ok: true, value: text }
    } finally {
      try { await handle.handle.dispose() } catch { /* best-effort */ }
    }
  }

  private async runSession(call: SpawnCall): Promise<SpawnResult> {
    const sid = this.sessionId(call.agentId)
    let live = this.live.get(call.agentId)
    if (!live) {
      // Reuse a still-live session-mode agent (within-process resume of a
      // paused run) before creating fresh.
      const existing = this.ctx.agents.get(sid)
      if (existing) {
        live = { handle: { agent: existing, dispose: async () => {} } }
      } else {
        const handle = await this.createAgent(sid, call, undefined)
        if (!handle) return { ok: false, error: 'agent creation failed' }
        live = handle
      }
      this.live.set(call.agentId, live)
    }
    const ok = await this.drive(live.handle.agent, call.taskText, call.signal, call.timeoutMs)
    if (!ok) return { ok: false, error: 'agent run aborted' }
    return { ok: true, value: finalAssistantText(live.handle.agent.session) }
  }

  private async runStructured(call: SpawnCall): Promise<SpawnResult> {
    // Decision calls always run fresh so each call gets a fresh structured
    // attachment (the capture guard is per-session by design).
    const sid = this.sessionId(`${call.agentId}:d`)
    return this.runOneShot({ ...call, resumeSessionId: this.structuredSessions.get(call.agentId) }, undefined)
  }

  private async createAgent(
    sid: SessionId,
    call: SpawnCall,
    structured: StructuredAttachment | undefined,
  ): Promise<LiveAgent | null> {
    const setup = async (agentCtx: Context): Promise<void> => {
      const scope = agentCtx as unknown as PromptScope
      // ① preset mount (G3/#16) — required so the spawned agent has tools.
      const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined
      if (presets !== undefined) {
        await presets.mount(agentCtx, call.config.presetId ?? this.parentPreset)
      }
      // ② persona + prompt sections.
      scope.systemPrompt.section({ name: 'persona', order: 0, text: call.config.persona })
      for (const s of call.config.promptSections ?? []) {
        scope.systemPrompt.section({ name: s.name, order: s.order, text: s.text })
      }
      // ③ tool filter.
      if (call.config.tools && call.config.tools.length > 0) {
        agentCtx.tools.restrict({ allow: call.config.tools })
      }
      // ④ structured output (decision nodes only; always fresh-session).
      if (call.structured) {
        const att = attachStructuredOutput(agentCtx, call.structured.schema)
        attach = att
      }
    }
    let attach: StructuredAttachment | undefined = structured
    const signal = fuseSignal(call.signal, call.timeoutMs)
    try {
      const handle = await this.ctx.agents.create({
        sessionId: sid,
        meta: { cwd: this.workspaceDir(call.agentId) },
        agentOptions: {
          provider: call.config.model.provider,
          model: call.config.model.model,
          ...(call.config.maxTokens !== undefined ? { maxTokens: call.config.maxTokens } : {}),
        },
        setup,
        signal,
      })
      return { handle, structured: attach }
    } catch (error) {
      return null
    }
  }

  private async drive(agent: import('@deepseek-ai/dsh-agent').Agent, taskText: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    const fused = fuseSignal(signal, timeoutMs)
    const onAbort = (): void => { try { (agent as unknown as { cancel(cause: string): void }).cancel('run aborted') } catch { /* noop */ } }
    if (fused.aborted) { onAbort(); return false }
    fused.addEventListener('abort', onAbort, { once: true })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskText }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      return !fused.aborted
    } finally {
      fused.removeEventListener('abort', onAbort)
    }
  }
}

function fuseSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal {
  const ctrl = new AbortController()
  if (signal?.aborted) ctrl.abort()
  else if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const clear = (): void => clearTimeout(timer)
    ctrl.signal.addEventListener('abort', clear, { once: true })
    if (signal) signal.addEventListener('abort', clear, { once: true })
  }
  return ctrl.signal
}

/** Last assistant message text from a session's derived messages. */
export function finalAssistantText(session: Session): string {
  const messages: Message[] = (session as unknown as { deriveMessages(): Message[] }).deriveMessages()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const parts: string[] = []
    for (const block of m.content) {
      if (block.type === 'text') parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}
