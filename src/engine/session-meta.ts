/**
 * Pure session-meta construction for member agents: lineage, preset identity,
 * and the optional DSH subagent marker used for `visibility: 'hidden'`.
 * Kept dependency-free so it can be unit tested without the dsh runtime.
 * @module @deepseek-ai/dsh-workflow-engine/session-meta
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

export interface SessionMetaInput {
  /** The agent's run-isolated workspace. */
  cwd: string
  /** Preset id the parent composed with (undefined = deployment default). */
  presetId?: string
  /** Calling session id, recorded as durable lineage. */
  parentSessionId?: SessionId
  /** Mark the session `origin: 'subagent'` (hidden from every sidebar bucket). */
  hidden: boolean
}

export interface SessionMeta {
  cwd: string
  agentPreset?: string
  parentSession?: SessionId
  origin?: 'subagent'
  delegationDepth?: number
}

/** Build the durable `ctx.agents.create` meta object. */
export function buildSessionMeta(input: SessionMetaInput): SessionMeta {
  return {
    cwd: input.cwd,
    ...(input.presetId === undefined ? {} : { agentPreset: input.presetId }),
    ...(input.parentSessionId === undefined ? {} : { parentSession: input.parentSessionId }),
    ...(input.hidden ? { origin: 'subagent' as const, delegationDepth: 1 } : {}),
  }
}
