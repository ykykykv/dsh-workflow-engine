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
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { AgentConfig } from '../types.ts'
import { attachStructuredOutput, type StructuredAttachment } from './structured.ts'
import { SessionRegistry } from './session-registry.ts'
import { lastAssistantTextFromEvents } from './text-extract.ts'

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
  private readonly sessions: SessionRegistry

  constructor(
    private readonly ctx: Context,
    private readonly flowId: string,
    private readonly runId: string,
    private readonly workspaceRoot: string,
    private readonly parentPreset?: string,
    seedSessions?: Record<string, string>,
  ) {
    this.sessions = new SessionRegistry(seedSessions)
  }

  /** Stable session id for a session-mode agent within this run. */
  sessionId(agentId: string): SessionId {
    return SessionId(this.sessions.id(agentId))
  }

  /** agentId → sessionId mapping for checkpoint persistence. */
  sessionMap(): Record<string, string> {
    return this.sessions.map()
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
      handle = await this.materializeAgent(sid, call, false)
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
      // paused run) before materializing fresh.
      const existing = this.ctx.agents.get(sid)
      if (existing) {
        live = { handle: { agent: existing, dispose: async () => {} } }
      } else {
        try {
          // Cross-process resume restores the persisted session (conversation
          // memory); fall back to a fresh create if the session is unavailable.
          if (this.sessions.isResuming(call.agentId)) {
            try {
              live = await this.materializeAgent(sid, call, true)
            } catch {
              live = await this.materializeAgent(sid, call, false)
            }
          } else {
            live = await this.materializeAgent(sid, call, false)
          }
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

  private async materializeAgent(sid: SessionId, call: SpawnCall, resume: boolean): Promise<LiveAgent> {
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
      // ③ load per-agent tool plugin modules (absolute paths to ESM plugin files).
      const host = agentCtx as unknown as { plugin(plugin: unknown, config?: unknown): unknown }
      for (const entry of call.config.tools ?? []) {
        const specifier = pathToFileURL(entry).href
        const mod = await import(specifier) as { default?: unknown }
        host.plugin(mod.default ?? mod)
      }
      // ③b register per-agent skills (absolute skill-folder paths; each entry
      // directly containing SKILL.md is scanned via its parent root).
      if (call.config.skills && call.config.skills.length > 0) {
        const roots = new Set<string>()
        for (const entry of call.config.skills) {
          let isDirect = false
          try { await access(join(entry, 'SKILL.md')); isDirect = true } catch { /* not a direct skill folder */ }
          roots.add(isDirect ? dirname(entry) : entry)
        }
        const specifier = '@deepseek-ai/dsh-skill-filesystem'
        const skillMod = await import(specifier) as { default?: unknown }
        host.plugin(skillMod.default ?? skillMod, { providerName: `agent-${call.agentId}`, customSkillDirs: [...roots], includeDefaultRoots: false })
      }
      // ③c optional per-agent sandbox override, seeded like the platform's own
      // delegation events. Under the restricted token, piped child spawns
      // (playwright-cli's daemon uses stdio:'pipe') fail with EPERM; opting an
      // agent into danger-full-access lets such tools run unconfinied.
      if (call.config.sandbox !== undefined) {
        const agentSession = (agentCtx as unknown as { agent?: { session?: { append(kind: string, data: unknown): void } } }).agent?.session
        agentSession?.append('sandbox/mode', { mode: call.config.sandbox, source: 'delegation' })
      }
      // ④ structured output (decision nodes only; always fresh-session).
      if (call.structured) {
        attach = attachStructuredOutput(agentCtx, call.structured.schema)
      }
    }
    const signal = fuseSignal(call.signal, call.timeoutMs).signal
    const agentOptions = {
      provider: call.config.model.provider,
      model: call.config.model.model,
      ...(call.config.maxTokens !== undefined ? { maxTokens: call.config.maxTokens } : {}),
    }
    const handle = resume
      ? await this.ctx.agents.resume({ resumeSessionId: sid, agentOptions, setup, signal })
      : await this.ctx.agents.create({ sessionId: sid, meta: { cwd: this.workspaceDir(call.agentId) }, agentOptions, setup, signal })
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

/** Last assistant message text from a session's derived messages (with a
 * fallback to event folding when `deriveMessages` is unavailable across rc). */
export function finalAssistantText(session: Session): string {
  const s = session as unknown as { deriveMessages?: () => Message[]; events?: readonly { type: string; data?: { content?: readonly unknown[] } }[] }
  if (typeof s.deriveMessages === 'function') {
    try {
      const messages = s.deriveMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!m || m.role !== 'assistant') continue
        const parts: string[] = []
        for (const block of m.content) {
          if (block.type === 'text') parts.push(block.text)
        }
        if (parts.length > 0) return parts.join('\n')
      }
      return ''
    } catch { /* fall through to event folding */ }
  }
  return lastAssistantTextFromEvents(s.events ?? [])
}
