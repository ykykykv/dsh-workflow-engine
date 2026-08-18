import { describe, expect, it } from 'vitest'
import { runOrchestrator, type OrchestratorHooks } from '../orchestrator.ts'
import { defaultReaders } from '../readers.ts'
import type { AgentConfig, FlowSpec } from '../../types.ts'

const agents: Record<string, AgentConfig> = {
  worker: { id: 'worker', persona: 'p', model: { provider: 'deepseek-official', model: 'm' }, memory: 'none' },
}

function makeHooks(over: Partial<OrchestratorHooks> = {}): OrchestratorHooks {
  return {
    runAgent: async () => ({ ok: true, store: undefined, value: undefined }),
    emit: () => {},
    checkpoint: () => {},
    onPhase: () => {},
    isCancelled: () => false,
    now: () => 0,
    runTimeoutMs: () => 0,
    readers: defaultReaders(),
    ...over,
  }
}

describe('orchestrator', () => {
  it('runs a sequence of set nodes', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: { main: { kind: 'sequence', nodes: ['a', 'b'] }, a: { kind: 'set', assign: { x: '1' } }, b: { kind: 'set', assign: { y: '{state.x}2' } } },
    }
    const r = await runOrchestrator(spec, agents, {}, 'main', makeHooks())
    expect(r.stopReason).toBe('completed')
    expect(r.lastNodeId).toBe('b')
  })

  it('executes a loop with break', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        halt: { kind: 'break' },
        main: {
          kind: 'loop', maxIter: 10,
          body: [
            { kind: 'agent', agent: 'worker', task: 'guess', outputSchema: {}, store: 'correct' },
            { kind: 'branch', if: 'correct==true', then: 'halt' },
          ],
        },
      },
    }
    let calls = 0
    const hooks = makeHooks({
      runAgent: async () => { calls++; return { ok: true, store: 'correct', value: calls >= 3 } },
    })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('completed')
    expect(calls).toBe(3)
  })

  it('honors loop until and maxIter cap', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: { kind: 'loop', until: 'done==true', maxIter: 5, body: [{ kind: 'set', assign: { n: '{len(counts)}' } }, { kind: 'push', into: 'counts', value: { v: '1' } }] },
      },
    }
    const r = await runOrchestrator(spec, agents, { counts: [] }, 'main', makeHooks())
    expect(r.stopReason).toBe('completed')
  })

  it('runs a map with item scope and push accumulation', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: {
          kind: 'map', items: 'todos', as: 't',
          forEach: [{ kind: 'push', into: 'results', value: { task: '{item.t}', upper: '{item.t}' } }],
        },
      },
    }
    const r = await runOrchestrator(spec, agents, { todos: ['a', 'b', 'c'], results: [] }, 'main', makeHooks())
    expect(r.stopReason).toBe('completed')
  })

  it('runs parallel branches writing distinct keys', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: {
          kind: 'parallel',
          branches: [
            [{ kind: 'agent', agent: 'worker', task: 'pro', store: 'pro' }],
            [{ kind: 'agent', agent: 'worker', task: 'con', store: 'con' }],
          ],
        },
      },
    }
    const r = await runOrchestrator(spec, agents, {}, 'main', makeHooks())
    expect(r.stopReason).toBe('completed')
    expect(r.lastNodeId).toBe('main')
  })

  it('writes a placeholder on onError continue (G4)', async () => {
    const spec: FlowSpec = {
      name: 's', state: {}, onError: { kind: 'continue' },
      entry: 'main',
      nodes: { main: { kind: 'agent', agent: 'worker', task: 't', store: 'out' } },
    }
    const hooks = makeHooks({ runAgent: async () => ({ ok: false, store: 'out', error: 'boom' }) })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('completed')
  })

  it('jumps via onError goto', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: { kind: 'agent', agent: 'worker', task: 't', store: 'out', onError: { kind: 'goto', node: 'fallback' } },
        fallback: { kind: 'set', assign: { out: 'fallback' } },
      },
    }
    const hooks = makeHooks({ runAgent: async () => ({ ok: false, store: 'out', error: 'boom' }) })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('completed')
    expect(r.lastNodeId).toBe('fallback')
  })

  it('returns error when onError is abort', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: { main: { kind: 'agent', agent: 'worker', task: 't', store: 'out' } },
    }
    const hooks = makeHooks({ runAgent: async () => ({ ok: false, error: 'boom' }) })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('error')
    expect(r.error?.node).toBe('main')
  })

  it('fails the run via a fail node', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: { main: { kind: 'fail', message: 'attempt limit reached' } },
    }
    const r = await runOrchestrator(spec, agents, {}, 'main', makeHooks())
    expect(r.stopReason).toBe('failed')
    expect(r.error?.message).toContain('attempt limit reached')
  })

  it('sets loopIndex inside plain loops', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: { main: { kind: 'loop', maxIter: 3, body: [{ kind: 'set', assign: { li: '{loopIndex}' } }] } },
    }
    const r = await runOrchestrator(spec, agents, {}, 'main', makeHooks())
    expect(r.stopReason).toBe('completed')
    expect(r.state['li']).toBe(3)
  })

  it('pauses when runTimeoutMs is exceeded', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: {
          kind: 'sequence',
          nodes: [
            { kind: 'set', assign: { a: '1' } },
            { kind: 'set', assign: { b: '2' } },
            { kind: 'set', assign: { c: '3' } },
          ],
        },
      },
    }
    let ts = 0
    const hooks = makeHooks({ now: () => ts, runTimeoutMs: () => 1000, checkpoint: () => { ts += 500 } })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('paused')
    expect(r.stack.length).toBeGreaterThan(0)
  })

  it('cancels on isCancelled', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: { main: { kind: 'set', assign: { a: '1' } } },
    }
    const hooks = makeHooks({ isCancelled: () => true })
    const r = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r.stopReason).toBe('cancelled')
  })

  it('resumes from a restored stack', async () => {
    const spec: FlowSpec = {
      name: 's', state: {},
      entry: 'main',
      nodes: {
        main: {
          kind: 'sequence',
          nodes: [
            { kind: 'set', assign: { a: '1' } },
            { kind: 'agent', agent: 'worker', task: 't', store: 'out' },
          ],
        },
      },
    }
    let ts = 0
    const hooks = makeHooks({
      now: () => ts,
      runTimeoutMs: () => 1000,
      checkpoint: () => { ts += 600 },
      runAgent: async () => { ts += 600; return { ok: true, store: 'out', value: 'done' } },
    })
    // Pause after the first set node.
    const r1 = await runOrchestrator(spec, agents, {}, 'main', hooks)
    expect(r1.stopReason).toBe('paused')
    // Resume with the captured stack + state.
    const r2 = await runOrchestrator(spec, agents, { a: '1' }, 'main', makeHooks({ runAgent: async () => ({ ok: true, store: 'out', value: 'done' }) }), r1)
    expect(r2.stopReason).toBe('completed')
  })
})
