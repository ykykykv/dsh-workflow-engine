/**
 * Pure session-id registry: stable filesystem-safe UUID per (run, agentId),
 * with checkpoint seeding for resume. No dsh imports, so it is unit-testable
 * in isolation.
 * @module @deepseek-ai/dsh-workflow-engine/session-registry
 */

import { randomUUID } from 'node:crypto'

export class SessionRegistry {
  private readonly sessions = new Map<string, string>()
  private readonly resuming = new Set<string>()

  constructor(seedSessions?: Record<string, string>) {
    if (seedSessions !== undefined) {
      for (const [agentId, sid] of Object.entries(seedSessions)) {
        this.sessions.set(agentId, sid)
        this.resuming.add(agentId)
      }
    }
  }

  /** Stable id for an agent within this run; seeded ids win on resume. */
  id(agentId: string): string {
    let sid = this.sessions.get(agentId)
    if (sid === undefined) {
      sid = randomUUID()
      this.sessions.set(agentId, sid)
    }
    return sid
  }

  /** agentId → sessionId mapping for checkpoint persistence. */
  map(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [agentId, sid] of this.sessions) out[agentId] = sid
    return out
  }

  /** Whether this agent resumes an existing/persisted session. */
  isResuming(agentId: string): boolean {
    return this.resuming.has(agentId)
  }
}
