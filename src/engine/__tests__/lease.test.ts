import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireLease, LeaseConflictError, LeaseStaleError } from '../lease.ts'

function leasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wfe-lease-')), 'runs', 'r1', 'lease.json')
}

describe('run lease', () => {
  it('acquires, blocks a second writer, and frees the run on release', async () => {
    const path = leasePath()
    const lease = await acquireLease({ path, runId: 'r1', owner: 'manual', heartbeatMs: 0 })
    expect(existsSync(path)).toBe(true)
    await expect(acquireLease({ path, runId: 'r1', owner: 'job:x', heartbeatMs: 0 }))
      .rejects.toBeInstanceOf(LeaseConflictError)
    await lease.release()
    expect(existsSync(path)).toBe(false)
    const again = await acquireLease({ path, runId: 'r1', owner: 'job:x', heartbeatMs: 0 })
    expect(again.info.owner).toBe('job:x')
    await again.release()
  })

  it('requires an explicit takeover for an expired lease', async () => {
    let now = 1_000_000
    const path = leasePath()
    const crashed = await acquireLease({ path, runId: 'r1', owner: 'crashed', ttlMs: 1_000, heartbeatMs: 0, now: () => now })
    void crashed

    now += 2_000
    await expect(acquireLease({ path, runId: 'r1', owner: 'manual', heartbeatMs: 0, now: () => now }))
      .rejects.toBeInstanceOf(LeaseStaleError)

    const taken = await acquireLease({ path, runId: 'r1', owner: 'manual', takeover: true, heartbeatMs: 0, now: () => now })
    expect(taken.info.owner).toBe('manual')
    await taken.release()
  })

  it('extends the expiry on a heartbeat', async () => {
    let now = 5_000
    const path = leasePath()
    const lease = await acquireLease({ path, runId: 'r1', owner: 'manual', ttlMs: 1_000, heartbeatMs: 0, now: () => now })
    const before = lease.info.expiresAt
    now += 500
    await lease.beat()
    expect(lease.info.expiresAt).toBeGreaterThan(before)
    await lease.release()
  })

  it('treats a corrupt lease file as stale and recovers with takeover', async () => {
    const path = leasePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not json', 'utf8')
    await expect(acquireLease({ path, runId: 'r1', owner: 'manual', heartbeatMs: 0 }))
      .rejects.toBeInstanceOf(LeaseStaleError)
    const lease = await acquireLease({ path, runId: 'r1', owner: 'manual', takeover: true, heartbeatMs: 0 })
    expect(lease.info.owner).toBe('manual')
    await lease.release()
  })
})
