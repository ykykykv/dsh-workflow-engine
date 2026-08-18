import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../session-registry.ts'

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
