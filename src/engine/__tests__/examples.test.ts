import { describe, expect, it } from 'vitest'
import { loadFlow } from '../loader.ts'
import { validateFlowSpec, validateAgents } from '../validate.ts'
import { defaultReaders } from '../readers.ts'
import { runOrchestrator, type OrchestratorHooks } from '../orchestrator.ts'
import type { AgentConfig, FlowSpec } from '../../types.ts'

const EXAMPLES = ['guess-number', 'guess-number-shared', 'department-flow', 'task-decomposition']

const REQUIRED_INPUT: Record<string, Record<string, unknown>> = {
  'guess-number': {},
  'guess-number-shared': {},
  'department-flow': { taskText: 'prepare the quarterly budget' },
  'task-decomposition': { bigTask: 'ship a release' },
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
    await expect(loadFlow({ flow: 'department-flow', input: {} })).rejects.toThrow(/required/)
    await expect(loadFlow({ flow: 'task-decomposition', input: {} })).rejects.toThrow(/required/)
  })

  it('rejects an unknown built-in name', async () => {
    await expect(loadFlow({ flow: 'no-such-example' })).rejects.toThrow()
  })

  it('rejects a missing flow directory by path', async () => {
    await expect(loadFlow({ flow: './no-such-dir', baseDir: process.cwd() })).rejects.toThrow(/flow not found/)
  })
})

describe('example flow orchestration (dry-run, scripted agents)', () => {
  it('runs department-flow routing end-to-end with scripted agents', async () => {
    const loaded = await loadFlow({ flow: 'department-flow', input: { taskText: 'prepare the quarterly budget' } })
    const state: Record<string, unknown> = { taskText: 'prepare the quarterly budget' }
    const hooks = scriptedHooks(loaded.spec, loaded.agents)
    const r = await runOrchestrator(loaded.spec, loaded.agents, state, loaded.spec.entry, hooks)
    expect(r.stopReason).toBe('completed')
  })
})

function scriptedHooks(spec: FlowSpec, agents: Record<string, AgentConfig>): OrchestratorHooks {
  const seq: Record<string, number> = {}
  return {
    async runAgent(node) {
      const n = (seq[node.agent] = (seq[node.agent] ?? 0) + 1)
      if (node.agent === 'supervisor') {
        return { ok: true, store: node.store, value: { dept: 'budget' } }
      }
      if (node.agent === 'deptBudgetSup') {
        return { ok: true, store: node.store, value: { assignee: 'empBudget', detail: 'budget work', approved: true, feedback: 'ok', advice: '', ok: true } }
      }
      return { ok: true, store: node.store, value: { approved: true, feedback: 'ok', verdict: 'pass', guidance: '', tasks: ['a', 'b'], ok: true, problems: '', advice: '' } }
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
