import { describe, expect, it } from 'vitest'
import { validateFlowSpec, validateAgents, assertSafeId } from '../validate.ts'
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
  it('validates code node shape', () => {
    const bad = (node: FlowSpec['nodes'][string]): string => {
      const r = validateFlowSpec({ ...base, nodes: { main: node } }, agents, {}, readers)
      return r.errors.join('; ')
    }
    expect(bad({ kind: 'code', run: '  ' })).toContain('code.run must be a non-empty body')
    expect(bad({ kind: 'code', run: { module: '' } })).toContain('code.run must be a non-empty body')
    expect(bad({ kind: 'code', run: 'return 1', store: '' })).toContain('code.store must be a non-empty state key')
    expect(bad({ kind: 'code', run: 'return 1', timeoutMs: 0 })).toContain('code.timeoutMs must be a positive number')
    expect(bad({ kind: 'code', run: 'return 1' })).toBe('')
  })
  it('validates visibility and transcript knobs', () => {
    const bad = validateAgents({
      ...agents,
      w: {
        id: 'w', persona: 'p', model: { provider: 'p', model: 'm' }, memory: 'none',
        visibility: 'nope' as unknown as 'listed',
        transcript: 'all' as unknown as 'run',
      },
    })
    expect(bad.errors.join('; ')).toContain("visibility must be 'listed' or 'hidden'")
    expect(bad.errors.join('; ')).toContain("transcript must be 'none' or 'run'")
    const spec = validateFlowSpec({ ...base, defaults: { visibility: 'nope' as unknown as 'listed' } }, agents, {}, readers)
    expect(spec.errors.join('; ')).toContain('defaults.visibility')
  })
  it('requires exactly one of persona / personaRef', () => {
    const both = {
      ...agents,
      c: { id: 'c', persona: 'p', personaRef: 'r', model: { provider: 'p', model: 'm' }, memory: 'none' as const },
    }
    expect(validateAgents(both).errors.join('; ')).toContain('mutually exclusive')
    const neither = {
      ...agents,
      d: { id: 'd', model: { provider: 'p', model: 'm' }, memory: 'none' as const },
    }
    expect(validateAgents(neither).errors.join('; ')).toContain('persona or personaRef is required')
    const unsafe = {
      ...agents,
      e: { id: 'e', personaRef: '../x', model: { provider: 'p', model: 'm' }, memory: 'none' as const },
    }
    expect(validateAgents(unsafe).errors.join('; ')).toContain('personaRef must match')
  })
  it('rejects path: true on a non-string state field', () => {
    const spec: FlowSpec = {
      ...base,
      state: { n: { type: 'number', path: true } },
      nodes: { main: { kind: 'set', assign: { n: '1' } } },
    }
    const r = validateFlowSpec(spec, agents, {}, readers)
    expect(r.ok).toBe(false)
    expect(r.errors.join('; ')).toContain('path is only supported on string fields')
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
  it('rejects unsafe flow names and agent ids (path safety)', () => {
    const badName: FlowSpec = { ...base, name: '../escape' }
    expect(validateFlowSpec(badName, agents, { x: 1, list: [] }, readers).ok).toBe(false)
    const badAgents: Record<string, AgentConfig> = { '../x': { id: '../x', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' } }
    expect(validateAgents(badAgents).ok).toBe(false)
  })
  it('assertSafeId accepts safe ids and rejects traversal/invalid ones', () => {
    expect(assertSafeId('x', 'ok_id-1')).toBe(null)
    expect(assertSafeId('x', '../esc')).not.toBe(null)
    expect(assertSafeId('x', 'a:b')).not.toBe(null)
    expect(assertSafeId('x', '')).not.toBe(null)
  })
  it('requires tools/skills entries to be absolute paths', () => {
    const withAbs = { a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' as const, tools: ['C:\\tools\\a.js'], skills: ['C:\\skills\\s'] } }
    expect(validateAgents(withAbs).ok).toBe(true)
    const withRel = { a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' as const, tools: ['./a.js'] } }
    expect(validateAgents(withRel).ok).toBe(false)
    const withRelSkill = { a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' as const, skills: ['skills/s'] } }
    expect(validateAgents(withRelSkill).ok).toBe(false)
  })
  it('accepts valid sandbox modes and rejects unknown ones', () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const ok = { a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' as const, sandbox: mode } }
      expect(validateAgents(ok).ok).toBe(true)
    }
    const bad = { a: { id: 'a', persona: 'p', model: { provider: 'x', model: 'y' }, memory: 'none' as const, sandbox: 'everything' } } as never
    expect(validateAgents(bad).ok).toBe(false)
  })
})
