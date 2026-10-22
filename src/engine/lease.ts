/**
 * Run-level lease: one writer per `runs/<runId>` at a time.
 *
 * `atomicWriteFile` only prevents torn writes; it cannot keep a manual resume
 * and a background job from overwriting each other's checkpoint. The lease is
 * an exclusive file (`lease.json`, created with O_EXCL) with a TTL and a
 * heartbeat. A live lease blocks a second writer; an expired lease (a crashed
 * process) requires an explicit `takeover` so recovery is never silent.
 * @module @deepseek-ai/dsh-workflow-engine/lease
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from './checkpoint.ts'

/** Contents of one run's `lease.json`. */
export interface LeaseInfo {
  runId: string
  /** `manual` or `job:<jobId>` — who holds the run. */
  owner: string
  pid: number
  acquiredAt: number
  heartbeatAt: number
  /** Unix epoch milliseconds after which another writer may take over. */
  expiresAt: number
}

/** A live lease blocked this writer. */
export class LeaseConflictError extends Error {
  constructor(readonly info: LeaseInfo | undefined, message: string) {
    super(message)
    this.name = 'LeaseConflictError'
  }
}

/** An expired lease requires an explicit takeover. */
export class LeaseStaleError extends Error {
  constructor(readonly info: LeaseInfo | undefined, message: string) {
    super(message)
    this.name = 'LeaseStaleError'
  }
}

export interface Lease {
  readonly path: string
  info: LeaseInfo
  /** Extend the TTL by one interval (called by the heartbeat, or by tests). */
  beat(): Promise<void>
  /** Stop the heartbeat and delete the lease file (best effort). */
  release(): Promise<void>
}

export interface AcquireLeaseOptions {
  /** Absolute path of `runs/<runId>/lease.json`. */
  path: string
  runId: string
  owner: string
  /** Take over an expired lease instead of failing. */
  takeover?: boolean
  /** Lease lifetime in milliseconds (default 30s). */
  ttlMs?: number
  /** Heartbeat interval in milliseconds (default 5s); 0 disables the timer. */
  heartbeatMs?: number
  /** Clock override for tests. */
  now?: () => number
}

async function readLease(path: string): Promise<LeaseInfo | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseInfo>
    if (typeof raw?.runId !== 'string' || typeof raw?.owner !== 'string' || typeof raw?.expiresAt !== 'number') return undefined
    return {
      runId: raw.runId,
      owner: raw.owner,
      pid: typeof raw.pid === 'number' ? raw.pid : 0,
      acquiredAt: typeof raw.acquiredAt === 'number' ? raw.acquiredAt : 0,
      heartbeatAt: typeof raw.heartbeatAt === 'number' ? raw.heartbeatAt : 0,
      expiresAt: raw.expiresAt,
    }
  } catch {
    // Missing or corrupt: treat as "no lease" so a crash cannot wedge a run forever.
    return undefined
  }
}

/** Human-readable lease owner for conflict messages. */
export function describeLease(info: LeaseInfo | undefined): string {
  if (info === undefined) return 'another writer'
  return `${info.owner} (pid ${info.pid}, expires ${new Date(info.expiresAt).toISOString()})`
}

/**
 * Create the lease file for one run, or fail when another writer holds it.
 * @throws LeaseConflictError when a live lease exists.
 * @throws LeaseStaleError when an expired lease exists and `takeover` is false.
 */
export async function acquireLease(options: AcquireLeaseOptions): Promise<Lease> {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 30_000
  const heartbeatMs = options.heartbeatMs ?? 5_000
  await mkdir(dirname(options.path), { recursive: true })

  const stamp = now()
  const info: LeaseInfo = {
    runId: options.runId,
    owner: options.owner,
    pid: process.pid,
    acquiredAt: stamp,
    heartbeatAt: stamp,
    expiresAt: stamp + ttlMs,
  }

  let created = false
  try {
    const handle = await open(options.path, 'wx')
    try {
      await handle.writeFile(JSON.stringify(info), 'utf8')
    } finally {
      await handle.close()
    }
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readLease(options.path)
    if (existing !== undefined && existing.expiresAt > now()) {
      throw new LeaseConflictError(
        existing,
        `run ${options.runId} is already active (owner=${describeLease(existing)}); `
        + 'wait for it to settle, kill it, or resume after the lease expires',
      )
    }
    if (options.takeover !== true) {
      throw new LeaseStaleError(
        existing,
        `run ${options.runId} holds a stale lease (owner=${describeLease(existing)}); `
        + 'pass takeover: true to take it over',
      )
    }
    // Explicit takeover of an expired lease: replace the record in place.
    await atomicWriteFile(options.path, JSON.stringify(info))
    created = true
  }

  let released = false
  let timer: NodeJS.Timeout | undefined

  const lease: Lease = {
    path: options.path,
    info,
    async beat(): Promise<void> {
      if (released) return
      const at = now()
      info.heartbeatAt = at
      info.expiresAt = at + ttlMs
      await atomicWriteFile(options.path, JSON.stringify(info))
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      if (timer !== undefined) clearInterval(timer)
      try { await rm(options.path, { force: true }) } catch { /* best effort */ }
    },
  }

  if (heartbeatMs > 0) {
    timer = setInterval(() => { void lease.beat().catch(() => {}) }, heartbeatMs)
    timer.unref?.()
  }
  if (!created) throw new Error(`lease ${options.path} could not be created`)
  return lease
}
