import { describe, expect, it } from 'vitest'
import {
  hashSpec,
  serializeCheckpoint,
  parseCheckpoint,
  resumeAllowed,
  planResume,
} from '../checkpoint.ts'
import type { AgentConfig, Checkpoint, FlowSpec } from '../../types.ts'

const spec: FlowSpec = { name: 'demo', state: {}, entry: 'main', nodes: { main: { kind: 'set', assign: { x: '1' } } } }
const agents: Record<string, AgentConfig> = {}
const cp: Checkpoint = {
  flowId: 'demo', runId: 'r1', specHash: 'abc', state: { x: 1 }, lastNodeId: 'main',
  stack: [], agentSessions: { a: 's1' },
}

describe('checkpoint', () => {
  it('round-trips a checkpoint', () => {
    const parsed = parseCheckpoint(serializeCheckpoint(cp))
    expect(parsed).toEqual(cp)
  })
  it('rejects corrupt checkpoints', () => {
    expect(() => parseCheckpoint('not json')).toThrow()
    expect(() => parseCheckpoint('{"flowId":1}')).toThrow()
  })
  it('hashes spec+agents stably', () => {
    expect(hashSpec(spec, agents)).toBe(hashSpec(spec, agents))
    expect(hashSpec(spec, agents)).not.toBe(hashSpec({ ...spec, entry: 'x' }, agents))
  })
  it('gates resume on spec hash unless strict', () => {
    expect(resumeAllowed(cp, 'abc', false)).toBe(true)
    expect(resumeAllowed(cp, 'def', false)).toBe(false)
    expect(resumeAllowed(cp, 'def', true)).toBe(true)
  })
  it('plans resume with missing session tolerance (G6)', () => {
    const { resumable, missing } = planResume(cp, id => id === 's1')
    expect(resumable).toEqual({ a: 's1' })
    expect(missing).toEqual([])
    const { missing: m2 } = planResume(cp, () => false)
    expect(m2).toEqual(['a'])
  })
})
