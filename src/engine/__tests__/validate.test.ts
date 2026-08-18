import { describe, expect, it } from 'vitest'
import { validateFlowSpec, validateAgents } from '../validate.ts'
import { defaultReaders } from '../readers.ts'
import type { AgentConfig, FlowSpec } from '../../types.ts'

const readers = defaultReaders()

const agents: Record<string, AgentConfig> = {
  a: { id: 'a', persona: 'p', model: { provider: 'deepseek-official', model: 'm' }, memory: 'session' },
  b: { id: 'b', persona: 'p', model: { provider: 'deepseek-official', model: 'm' }, memory: 'none' },
}

const base: FlowSpec = {
  name: 'demo',
  state: { x: { type: 'number' }, list: { type: 'array', element: { type: 'json' } } },
  entry: 'main',
  nodes: {
    main: { kind: 'set', assign: { x: '{state.x}' } },
  },
}

describe('validate', () => {
  it('passes a valid spec', () => {
    expect(validateFlowSpec(base, agents, { x: 1, list: [] }, readers).ok).toBe(true)
  })
  it('rejects unknown agent ids', () => {
    const spec: FlowSpec = { ...base, nodes: { main: { kind: 'agent', agent: 'nope', task: 'hi' } } }
    const r = validateFlowSpec(spec, agents, {}, readers)
    expect(r.ok).toBe(false)
    expect(r.errors.join('; ')).toContain('unknown agent')
  })
  it('rejects a loop without maxIter', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: { main: { kind: 'loop', body: [{ kind: 'set', assign: { x: '1' } }], maxIter: 0 } },
    }
    expect(validateFlowSpec(spec, agents, {}, readers).ok).toBe(false)
  })
  it('rejects unknown node references', () => {
    const spec: FlowSpec = { ...base, nodes: { main: { kind: 'sequence', nodes: ['ghost'] } } }
    expect(validateFlowSpec(spec, agents, {}, readers).ok).toBe(false)
  })
  it('rejects dangling decision cases', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: { main: { kind: 'decision', agent: 'a', task: 't', outputSchema: {}, store: 'd', cases: { x: 'missing' } } },
    }
    expect(validateFlowSpec(spec, agents, {}, readers).ok).toBe(false)
  })
  it('rejects malformed templates and predicates', () => {
    const badTpl: FlowSpec = { ...base, nodes: { main: { kind: 'set', assign: { x: '{state.x' } } } }
    expect(validateFlowSpec(badTpl, agents, {}, readers).ok).toBe(false)
    const badPred: FlowSpec = { ...base, nodes: { main: { kind: 'branch', if: 'a ==', then: 'x' } } }
    expect(validateFlowSpec(badPred, agents, {}, readers).ok).toBe(false)
  })
  it('rejects wrong-typed input fields', () => {
    expect(validateFlowSpec(base, agents, { x: 'not-a-number', list: [] }, readers).ok).toBe(false)
  })
  it('enforces required input fields', () => {
    const spec: FlowSpec = {
      ...base,
      state: {
        x: { type: 'number', required: true },
        list: { type: 'array', element: { type: 'json' } },
      },
    }
    expect(validateFlowSpec(spec, agents, { list: [] }, readers).ok).toBe(false)
    expect(validateFlowSpec(spec, agents, { x: 1, list: [] }, readers).ok).toBe(true)
    expect(validateFlowSpec(spec, agents, {}, readers).ok).toBe(false)
  })
  it('rejects parallel reuse of a session-mode agent across branches (G2)', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: {
        main: {
          kind: 'parallel',
          branches: [
            [{ kind: 'agent', agent: 'a', task: 't1' }],
            [{ kind: 'agent', agent: 'a', task: 't2' }],
          ],
        },
      },
    }
    const r = validateFlowSpec(spec, agents, {}, readers)
    expect(r.ok).toBe(false)
    expect(r.errors.join('; ')).toContain('session-mode')
  })
  it('allows parallel with distinct session agents and none-mode agents', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: {
        main: {
          kind: 'parallel',
          branches: [
            [{ kind: 'agent', agent: 'a', task: 't1' }],
            [{ kind: 'agent', agent: 'b', task: 't2' }],
          ],
        },
      },
    }
    expect(validateFlowSpec(spec, agents, { x: 1, list: [] }, readers).ok).toBe(true)
  })
  it('rejects nodes not reachable from the entry', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: {
        main: { kind: 'set', assign: { x: '1' } },
        orphan: { kind: 'agent', agent: 'a', task: 'never runs' },
      },
    }
    const r = validateFlowSpec(spec, agents, { x: 1, list: [] }, readers)
    expect(r.ok).toBe(false)
    expect(r.errors.join('; ')).toContain('not reachable')
  })
  it('passes when every node is reachable from the entry', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: {
        main: { kind: 'sequence', nodes: ['a', 'b'] },
        a: { kind: 'set', assign: { x: '1' } },
        b: { kind: 'set', assign: { y: '{state.x}2' } },
      },
    }
    expect(validateFlowSpec(spec, agents, { x: 1, list: [] }, readers).ok).toBe(true)
  })
  it('rejects a break outside a loop', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: { main: { kind: 'sequence', nodes: ['halt'] }, halt: { kind: 'break' } },
    }
    const r = validateFlowSpec(spec, agents, { x: 1, list: [] }, readers)
    expect(r.ok).toBe(false)
    expect(r.errors.join('; ')).toContain('break must be inside a loop')
  })
  it('accepts a break inside a loop', () => {
    const spec: FlowSpec = {
      ...base,
      nodes: { main: { kind: 'loop', maxIter: 3, body: [{ kind: 'break' }] } },
    }
    expect(validateFlowSpec(spec, agents, { x: 1, list: [] }, readers).ok).toBe(true)
  })
  it('validates agents config', () => {
    expect(validateAgents(agents).ok).toBe(true)
    expect(validateAgents({ a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'bogus' } as never }).ok).toBe(false)
  })
})
