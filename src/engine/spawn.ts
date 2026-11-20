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
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import type { AgentConfig, SandboxMode } from '../types.ts'
import { importFresh } from './import-fresh.ts'
import { buildSessionMeta } from './session-meta.ts'
import { attachStructuredOutput, type StructuredAttachment } from './structured.ts'
import { mountPreset, type AgentPresetsLike } from './preset-mount.ts'
import { SessionRegistry } from './session-registry.ts'
import { lastAssistantTextFromEvents } from './text-extract.ts'

/** Minimal systemPrompt surface (plain type, cast via unknown: Context may or may
 * not be augmented with `systemPrompt` depending on the installed seam set). */
interface PromptScope {
  systemPrompt: { section(s: { name: string; order: number; text: string }): unknown }
}

/** What a member agent inherits from the parent session: the composed preset,
 * durable lineage, and the parent's explicit sandbox override. Mirrors the
 * platform's own delegation capture (`dsh-subagent`). */
export interface ParentScope {
  /** Preset id the parent agent was composed with (undefined = deployment default). */
  preset?: string
  /** Parent session id, recorded as durable lineage on each child session. */
  sessionId?: SessionId
  /** The parent session's explicit sandbox override, if it had one. */
  sandbox?: SandboxMode
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

/** Brand a plain string as a SessionId (ids are minted as UUIDs by the registry
 * or restored from an already-validated checkpoint header). */
const toSessionId = (value: string): SessionId => value as SessionId

interface LiveAgent {
  handle: { agent: Agent; dispose(): Promise<void> }
  structured?: StructuredAttachment
  config: AgentConfig
}

/** Run-scoped knobs that are not part of any single agent's config. */
export interface AgentRunnerOptions {
  /** Flow-level `defaults.visibility`; an agent's own `visibility` wins. */
  defaultVisibility?: 'listed' | 'hidden'
  /** Called before a session is disposed when its agent asked for `transcript: 'run'`. */
  onTranscript?: (agentId: string, config: AgentConfig, session: Session) => Promise<void>
}

export class AgentRunner {
  private readonly live = new Map<string, LiveAgent>()
  private readonly sessions: SessionRegistry

  constructor(
    private readonly ctx: Context,
    private readonly flowId: string,
    private readonly runId: string,
    private readonly workspaceRoot: string,
    private readonly parent: ParentScope = {},
    seedSessions?: Record<string, string>,
    private readonly options: AgentRunnerOptions = {},
  ) {
    this.sessions = new SessionRegistry(seedSessions)
  }

  /** Stable session id for a session-mode agent within this run. */
  sessionId(agentId: string): SessionId {
    return toSessionId(this.sessions.id(agentId))
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

  /** Dispose every live session-agent created by this runner (exporting transcripts first). */
  async disposeAll(): Promise<void> {
    for (const [agentId, live] of this.live) {
      await this.maybeExport(agentId, live.config, live.handle.agent.session)
      try { await live.handle.dispose() } catch { /* best-effort */ }
    }
    this.live.clear()
  }

  /** Export a transcript copy when the agent opted into `transcript: 'run'`. */
  private async maybeExport(agentId: string, config: AgentConfig, session: Session): Promise<void> {
    if (config.transcript !== 'run' || this.options.onTranscript === undefined) return
    try {
      await this.options.onTranscript(agentId, config, session)
    } catch (error) {
      const logger = (this.ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
      logger?.warn?.(`workflow ${this.flowId}: transcript export for agent "${agentId}" failed: ${messageOf(error)}`)
    }
  }

  private async runOneShot(call: SpawnCall): Promise<SpawnResult> {
    const sid = call.structured ? toSessionId(randomUUID()) : this.sessionId(call.agentId)
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
      await this.maybeExport(call.agentId, call.config, handle.handle.agent.session)
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
        live = { handle: { agent: existing, dispose: async () => {} }, config: call.config }
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
    const presetId = call.config.presetId ?? this.parent.preset
    const setup = async (agentCtx: Context, agent?: Agent): Promise<void> => {
      const scope = agentCtx as unknown as PromptScope
      // ① preset mount (G3/#16) — required so the spawned agent has tools.
      const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined
      if (presets !== undefined) {
        await mountPreset(presets, agentCtx, presetId)
      }
      // ② persona + prompt sections.
      scope.systemPrompt.section({ name: 'persona', order: 0, text: call.config.persona ?? '' })
      for (const s of call.config.promptSections ?? []) {
        scope.systemPrompt.section({ name: s.name, order: s.order, text: s.text })
      }
      // ③ load per-agent tool plugin modules (absolute paths to ESM plugin files).
      // importFresh lets an edited tool module take effect without a restart.
      const host = agentCtx as unknown as { plugin(plugin: unknown, config?: unknown): unknown }
      for (const entry of call.config.tools ?? []) {
        const mod = await importFresh<{ default?: unknown }>(entry)
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
      // ③c per-agent sandbox + approval policy, seeded exactly like the
      // platform's own delegation events: the parent's explicit sandbox override
      // is inherited unless the agent config overrides it, and approvals are
      // pinned to 'never' so a background member never blocks the run on an
      // interactive prompt. Under the restricted token, piped child spawns
      // (playwright-cli's daemon uses stdio:'pipe') fail with EPERM; opting an
      // agent into danger-full-access lets such tools run unconfined.
      const target = agent ?? (agentCtx as unknown as { agent?: Agent }).agent
      const agentSession = target?.session
      if (agentSession !== undefined) {
        agentSession.append('approval/policy', { policy: 'never', source: 'delegation' })
        const mode = call.config.sandbox ?? this.parent.sandbox
        if (mode !== undefined) {
          agentSession.append('sandbox/mode', { mode, source: 'delegation' })
        }
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
    // Durable session metadata: preset identity and parent lineage (same fields
    // the platform's subagent delegation records), so a resumed or inspected
    // session knows how it was composed. `visibility: 'hidden'` adds DSH's only
    // subagent marker, which keeps the session out of every sidebar bucket
    // (the Web client hides `origin === 'subagent'`) without deleting it.
    const hidden = (call.config.visibility ?? this.options.defaultVisibility ?? 'listed') === 'hidden'
    const meta = buildSessionMeta({
      cwd: this.workspaceDir(call.agentId),
      presetId,
      parentSessionId: this.parent.sessionId,
      hidden,
    })
    const handle = resume
      ? await this.ctx.agents.resume({ resumeSessionId: sid, agentOptions, setup, signal })
      : await this.ctx.agents.create({ sessionId: sid, meta, agentOptions, setup, signal })
    return { handle, structured: attach, config: call.config }
  }

  private async drive(agent: Agent, taskText: string, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; error?: string }> {
    const fused = fuseSignal(signal, timeoutMs)
    const onAbort = (): void => { try { agent.cancel({ kind: 'hook', reason: 'workflow run aborted' }) } catch { /* noop */ } }
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
