/**
 * Runtime agent lifecycle: create/resume spawned agents, run one task call,
 * apply the fixed setup order (preset mount → persona → tool filter →
 * structured output), per-agent memory, abort/timeout fusion, and run-end
 * session disposition (G1/G3/#16).
 *
 * Session ids are random UUIDs (filesystem-safe: the JSONL persistence
 * backend uses the id in a file path, so colons etc. break on Windows).
 * @module @deepseek-ai/dsh-workflow-engine/spawn
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  /** Stable filesystem-safe session id per (run, agentId). */
  private readonly sessions = new Map<string, SessionId>()

  constructor(
    private readonly ctx: Context,
    private readonly flowId: string,
    private readonly runId: string,
    private readonly workspaceRoot: string,
    private readonly parentPreset?: string,
  ) {}

  /** Stable session id for a session-mode agent within this run. */
  sessionId(agentId: string): SessionId {
    let sid = this.sessions.get(agentId)
    if (sid === undefined) {
      sid = SessionId(randomUUID())
      this.sessions.set(agentId, sid)
    }
    return sid
  }

  /** agentId → sessionId mapping for checkpoint persistence. */
  sessionMap(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [agentId, sid] of this.sessions) out[agentId] = String(sid)
    return out
  }

  private workspaceDir(agentId: string): string {
    return join(this.workspaceRoot, this.flowId, 'runs', this.runId, 'workspace', agentId)
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
    return this.runOneShot(call)
  }

  /** Dispose every live session-agent created by this runner. */
  async disposeAll(): Promise<void> {
    for (const live of this.live.values()) {
      try { await live.handle.dispose() } catch { /* best-effort */ }
    }
    this.live.clear()
  }

  private async runOneShot(call: SpawnCall): Promise<SpawnResult> {
    const sid = call.structured ? SessionId(randomUUID()) : this.sessionId(call.agentId)
    let handle: LiveAgent
    try {
      handle = await this.createAgent(sid, call)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    try {
      const d = await this.drive(handle.handle.agent, call.taskText, call.signal, call.timeoutMs)
      if (!d.ok) return { ok: false, error: d.error ?? 'agent run aborted' }
      if (call.structured) {
        const cap = handle.structured?.captured()
        if (cap === undefined) return { ok: false, error: 'structured output not captured' }
        return { ok: true, value: cap.value }
      }
      const text = finalAssistantText(handle.handle.agent.session)
      return { ok: true, value: text }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
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
        try {
          live = await this.createAgent(sid, call)
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      }
      this.live.set(call.agentId, live)
    }
    try {
      const d = await this.drive(live.handle.agent, call.taskText, call.signal, call.timeoutMs)
      if (!d.ok) return { ok: false, error: d.error ?? 'agent run aborted' }
      return { ok: true, value: finalAssistantText(live.handle.agent.session) }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  private async runStructured(call: SpawnCall): Promise<SpawnResult> {
    // Decision calls always run fresh so each call gets a fresh structured
    // attachment (the capture guard is per-session by design).
    return this.runOneShot(call)
  }

  private async createAgent(sid: SessionId, call: SpawnCall): Promise<LiveAgent> {
    // Ensure the agent's run-isolated workspace directory exists.
    await mkdir(this.workspaceDir(call.agentId), { recursive: true })
    let attach: StructuredAttachment | undefined
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
        attach = attachStructuredOutput(agentCtx, call.structured.schema)
      }
    }
    const signal = fuseSignal(call.signal, call.timeoutMs).signal
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
  }

  private async drive(agent: import('@deepseek-ai/dsh-agent').Agent, taskText: string, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; error?: string }> {
    const fused = fuseSignal(signal, timeoutMs)
    const onAbort = (): void => { try { (agent as unknown as { cancel(cause: string): void }).cancel('run aborted') } catch { /* noop */ } }
    if (fused.signal.aborted) {
      onAbort()
      return { ok: false, error: fused.cause() === 'timeout' ? `agent run timed out after ${timeoutMs ?? '?'}ms` : 'agent run aborted (cancelled)' }
    }
    fused.signal.addEventListener('abort', onAbort, { once: true })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskText }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      if (fused.signal.aborted) {
        return { ok: false, error: fused.cause() === 'timeout' ? `agent run timed out after ${timeoutMs ?? '?'}ms` : 'agent run aborted (cancelled)' }
      }
      return { ok: true }
    } finally {
      fused.signal.removeEventListener('abort', onAbort)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface FusedSignal {
  signal: AbortSignal
  cause: () => 'timeout' | 'cancel' | undefined
}

function fuseSignal(signal: AbortSignal | undefined, timeoutMs?: number): FusedSignal {
  const ctrl = new AbortController()
  let timedOut = false
  if (signal?.aborted) ctrl.abort()
  else if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    const clear = (): void => clearTimeout(timer)
    ctrl.signal.addEventListener('abort', clear, { once: true })
    if (signal) signal.addEventListener('abort', clear, { once: true })
  }
  return {
    signal: ctrl.signal,
    cause: () => (ctrl.signal.aborted ? (timedOut ? 'timeout' : 'cancel') : undefined),
  }
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
