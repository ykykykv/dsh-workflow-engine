import { describe, expect, it } from 'vitest'
import { loadFlow } from '../loader.ts'
import { validateFlowSpec, validateAgents } from '../validate.ts'
import { defaultReaders } from '../readers.ts'
import { runOrchestrator, type OrchestratorHooks } from '../orchestrator.ts'
import type { AgentConfig, FlowSpec } from '../../types.ts'

const EXAMPLES = ['guess-number', 'guess-number-shared', 'task-decomposition', 'analysis-report']

const REQUIRED_INPUT: Record<string, Record<string, unknown>> = {
  'guess-number': {},
  'guess-number-shared': {},
  'task-decomposition': { bigTask: 'ship a release' },
  'analysis-report': { subject: 'AI agents in 2026' },
}

describe('examples', () => {
  it('load and validate every shipped example', async () => {
    for (const name of EXAMPLES) {
      const loaded = await loadFlow({ flow: name, input: REQUIRED_INPUT[name] })
      expect(loaded.name, name).toBe(name)
      expect(validateAgents(loaded.agents).ok, `${name} agents`).toBe(true)
      expect(validateFlowSpec(loaded.spec, loaded.agents, loaded.input, defaultReaders()).ok, `${name} spec`).toBe(true)
    }
  })

  it('requires input for flows that declare required fields', async () => {
    await expect(loadFlow({ flow: 'analysis-report', input: {} })).rejects.toThrow(/required/)
    await expect(loadFlow({ flow: 'task-decomposition', input: {} })).rejects.toThrow(/required/)
  })

  it('rejects an unknown built-in name', async () => {
    await expect(loadFlow({ flow: 'no-such-example' })).rejects.toThrow()
  })

  it('rejects a missing flow directory by path', async () => {
    await expect(loadFlow({ flow: './no-such-dir', baseDir: process.cwd() })).rejects.toThrow(/flow not found/)
  })

  it('allows optional sourceDir in analysis-report', async () => {
    const withDir = await loadFlow({ flow: 'analysis-report', input: { subject: 'x', sourceDir: './materials' } })
    expect(withDir.input['sourceDir']).toBe('./materials')
    const without = await loadFlow({ flow: 'analysis-report', input: { subject: 'x' } })
    expect(without.input['sourceDir']).toBeUndefined()
  })
})

describe('example flow orchestration (dry-run, scripted agents)', () => {
  it('runs analysis-report end-to-end with scripted agents', async () => {
    const loaded = await loadFlow({ flow: 'analysis-report', input: { subject: 'demo' } })
    const hooks = scriptedHooks(loaded.spec, loaded.agents)
    const r = await runOrchestrator(loaded.spec, loaded.agents, loaded.input, loaded.spec.entry, hooks, undefined, { flowId: 'analysis-report', runId: 'r1' })
    expect(r.stopReason).toBe('completed')
  })

  it('task-decomposition analyzes EVERY task (verdictDone reset per item)', async () => {
    const loaded = await loadFlow({ flow: 'task-decomposition', input: { bigTask: 'big' } })
    const hooks = scriptedHooks(loaded.spec, loaded.agents)
    const r = await runOrchestrator(loaded.spec, loaded.agents, loaded.input, loaded.spec.entry, hooks, undefined, { flowId: 'task-decomposition', runId: 'r1' })
    expect(r.stopReason).toBe('completed')
    const results = (r.state['results'] ?? []) as unknown[]
    expect(results.length).toBe(2)
  })

  it('task-decomposition fails when the outer cap is reached without all-pass', async () => {
    const loaded = await loadFlow({ flow: 'task-decomposition', input: { bigTask: 'big' } })
    const hooks = scriptedHooks(loaded.spec, loaded.agents, { alwaysFail: true })
    const r = await runOrchestrator(loaded.spec, loaded.agents, loaded.input, loaded.spec.entry, hooks, undefined, { flowId: 'task-decomposition', runId: 'r1' })
    expect(r.stopReason).toBe('failed')
  })

  it('guess-number actually plays rounds and solves (loop runs, verdict extracted)', async () => {
    const loaded = await loadFlow({ flow: 'guess-number', input: {} })
    let refereeCalls = 0
    const hooks = scriptedHooks(loaded.spec, loaded.agents)
    hooks.runAgent = async (node) => {
      if (node.agent === 'referee') {
        refereeCalls++
        return { ok: true, store: node.store, value: refereeCalls === 1 ? { secret: 7 } : { correct: refereeCalls >= 3 } }
      }
      if (node.agent === 'g0' || node.agent === 'g1' || node.agent === 'g2') {
        return { ok: true, store: node.store, value: '5' }
      }
      return { ok: true, store: node.store, value: 'x' }
    }
    const r = await runOrchestrator(loaded.spec, loaded.agents, loaded.input, loaded.spec.entry, hooks, undefined, { flowId: 'guess-number', runId: 'r1' })
    expect(r.stopReason).toBe('completed')
    expect(r.state['solved']).toBe(true)
    const history = (r.state['history'] ?? []) as unknown[]
    expect(history.length).toBe(2) // g0 wrong, g1 correct
    expect(refereeCalls).toBe(3) // init + 2 judgments
  })
})

function scriptedHooks(spec: FlowSpec, agents: Record<string, AgentConfig>, opts: { alwaysFail?: boolean } = {}): OrchestratorHooks {
  const seq: Record<string, number> = {}
  return {
    async runAgent(node) {
      const n = (seq[node.agent] = (seq[node.agent] ?? 0) + 1)
      switch (node.agent) {
        case 'analyst': return { ok: true, store: node.store, value: '分析要点：\n- 要点一\n- 要点二' }
        case 'writer': return { ok: true, store: node.store, value: 'written' }
        case 'reviewer': return { ok: true, store: node.store, value: { approved: true, feedback: 'ok' } }
        case 'taskSup': return { ok: true, store: node.store, value: { tasks: ['t1', 't2'] } }
        case 'splitReviewer': return { ok: true, store: node.store, value: opts.alwaysFail ? { ok: false, advice: 're-split' } : { ok: true, advice: '' } }
        case 'analystPro': return { ok: true, store: node.store, value: 'feasible' }
        case 'analystCon': return { ok: true, store: node.store, value: 'concern' }
        case 'smallReviewer': return { ok: true, store: node.store, value: { verdict: 'pass', guidance: '' } }
        case 'resplitReviewer': return { ok: true, store: node.store, value: { problems: 'p', advice: 'advice' } }
        default: return { ok: true, store: node.store, value: `out-${n}` }
      }
    },
    emit: () => {},
    checkpoint: () => {},
    onPhase: () => {},
    isCancelled: () => false,
    now: () => 0,
    runTimeoutMs: () => 0,
    readers: defaultReaders(),
  }
}
