/**
 * Pure checkpoint protocol: serialization, spec-hash gating, resume tolerance.
 * @module @deepseek-ai/dsh-workflow-engine/checkpoint
 */

import { createHash } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import type { AgentConfig, Checkpoint, FlowSpec } from '../types.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Write a file atomically-ish: temp + rename, with Windows-safe retry and a
 * direct-write fallback. Renaming over an EXISTING file can fail with EPERM on
 * Windows when the destination is transiently locked; retry briefly, then
 * remove the destination and retry, then fall back to a direct write so the
 * engine never wedges on checkpoint persistence.
 */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, path)
    return
  } catch {
    // fall through to retry path
  }
  for (let i = 0; i < 3; i++) {
    await delay(50 * (i + 1))
    try {
      await rename(tmp, path)
      return
    } catch { /* retry */ }
  }
  // Destination may be transiently locked: remove it, then rename.
  try { await rm(path, { force: true }) } catch { /* ignore */ }
  try {
    await rename(tmp, path)
    return
  } catch { /* fall back to direct write */ }
  try { await writeFile(path, content, 'utf8') } finally {
    try { await rm(tmp, { force: true }) } catch { /* ignore */ }
  }
}
/** Stable hash of the loaded spec + agents: the resume gate. */
export function hashSpec(spec: FlowSpec, agents: Record<string, AgentConfig>): string {
  const stable = JSON.stringify({ spec, agents })
  return createHash('sha256').update(stable).digest('hex')
}

export function serializeCheckpoint(cp: Checkpoint): string {
  return JSON.stringify(cp)
}

export function parseCheckpoint(text: string): Checkpoint {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (typeof raw['flowId'] !== 'string') throw new Error('checkpoint: missing flowId')
  if (typeof raw['runId'] !== 'string') throw new Error('checkpoint: missing runId')
  if (typeof raw['specHash'] !== 'string') throw new Error('checkpoint: missing specHash')
  if (raw['state'] === undefined || typeof raw['state'] !== 'object') throw new Error('checkpoint: missing state')
  if (typeof raw['lastNodeId'] !== 'string' && raw['lastNodeId'] !== null) {
    throw new Error('checkpoint: invalid lastNodeId')
  }
  const stack = raw['stack'] === undefined ? [] : raw['stack']
  const agentSessions = raw['agentSessions'] === undefined ? {} : raw['agentSessions']
  if (!Array.isArray(stack) || typeof agentSessions !== 'object') {
    throw new Error('checkpoint: invalid stack or agentSessions')
  }
  return {
    flowId: raw['flowId'],
    runId: raw['runId'],
    specHash: raw['specHash'],
    state: raw['state'] as Record<string, unknown>,
    lastNodeId: raw['lastNodeId'] as string | null,
    stack: stack as Checkpoint['stack'],
    agentSessions: agentSessions as Record<string, string>,
  }
}

/** Resume gate: spec hash must match unless strict override is given. */
export function resumeAllowed(cp: Checkpoint, currentHash: string, strict: boolean): boolean {
  return strict || cp.specHash === currentHash
}

/**
 * Decide which session-mode agents can be resumed from the checkpoint and
 * which must be rebuilt fresh. Missing sessions are signalled, not fatal.
 */
export function planResume(
  cp: Checkpoint,
  knownSessions: (id: string) => boolean,
): { resumable: Record<string, string>; missing: string[] } {
  const resumable: Record<string, string> = {}
  const missing: string[] = []
  for (const [agentId, sessionId] of Object.entries(cp.agentSessions)) {
    if (knownSessions(sessionId)) resumable[agentId] = sessionId
    else missing.push(agentId)
  }
  return { resumable, missing }
}
