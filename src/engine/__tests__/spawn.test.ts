import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionRegistry } from '../session-registry.ts'
import { mountPreset, type AgentPresetsLike } from '../preset-mount.ts'
import { buildSessionMeta } from '../session-meta.ts'

const ctx = {} as Context

function notFound(id: string): Error {
  return Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' })
}

describe('SessionRegistry seeding (resume)', () => {
  it('returns the seeded session id for a resumed agent', () => {
    const reg = new SessionRegistry({ a: 'old-uuid', b: 'other-uuid' })
    expect(reg.id('a')).toBe('old-uuid')
    expect(reg.id('b')).toBe('other-uuid')
    expect(reg.map()).toEqual({ a: 'old-uuid', b: 'other-uuid' })
    expect(reg.isResuming('a')).toBe(true)
    expect(reg.isResuming('z')).toBe(false)
  })

  it('mints fresh ids for non-seeded agents and includes them in the map', () => {
    const reg = new SessionRegistry({ a: 'old-uuid' })
    const fresh = reg.id('c')
    expect(fresh).not.toBe('old-uuid')
    expect(reg.isResuming('c')).toBe(false)
    expect(reg.map()).toEqual({ a: 'old-uuid', c: fresh })
  })
})

describe('preset mount cross-version alias (code <-> ptc)', () => {
  it('falls back to the alias when the requested preset is unknown', async () => {
    const calls: (string | undefined)[] = []
    const presets: AgentPresetsLike = {
      async mount(_ctx, id) {
        calls.push(id)
        if (id === 'code') throw notFound('code')
      },
    }
    await mountPreset(presets, ctx, 'code')
    expect(calls).toEqual(['code', 'ptc'])
  })

  it('does not retry a non-not-found failure', async () => {
    const calls: (string | undefined)[] = []
    const presets: AgentPresetsLike = {
      async mount(_ctx, id) {
        calls.push(id)
        throw new Error('preset definition is invalid')
      },
    }
    await expect(mountPreset(presets, ctx, 'code')).rejects.toThrow('preset definition is invalid')
    expect(calls).toEqual(['code'])
  })

  it('passes an undefined id straight through', async () => {
    const calls: (string | undefined)[] = []
    const presets: AgentPresetsLike = {
      async mount(_ctx, id) { calls.push(id) },
    }
    await mountPreset(presets, ctx, undefined)
    expect(calls).toEqual([undefined])
  })
})

describe('buildSessionMeta', () => {
  it('marks hidden sessions with DSH\'s only subagent marker', () => {
    const meta = buildSessionMeta({ cwd: 'C:/run/w', presetId: 'standard', parentSessionId: 'parent' as never, hidden: true })
    expect(meta).toEqual({
      cwd: 'C:/run/w',
      agentPreset: 'standard',
      parentSession: 'parent',
      origin: 'subagent',
      delegationDepth: 1,
    })
  })

  it('leaves listed sessions ordinary (no origin, no depth)', () => {
    const meta = buildSessionMeta({ cwd: 'C:/run/w', hidden: false })
    expect(meta).toEqual({ cwd: 'C:/run/w' })
    expect('origin' in meta).toBe(false)
    expect('parentSession' in meta).toBe(false)
  })
})
