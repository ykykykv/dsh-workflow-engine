/**
 * @deepseek-ai/dsh-workflow-engine ï¿?declarative multi-agent workflow engine.
 * @module @deepseek-ai/dsh-workflow-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Checkpoint, EngineConfig, RunWorkflowResult, StopReason } from './types.ts'
import { loadFlow, listBuiltins } from './engine/loader.ts'
import { materializeAgents } from './engine/materialize.ts'
import { collectOutputs } from './engine/collect.ts'
import { AgentRunner } from './engine/spawn.ts'
import { createMonitor } from './engine/monitor.ts'
import { runOrchestrator, type OrchestratorHooks } from './engine/orchestrator.ts'
import type { Frame } from './types.ts'
import { hashSpec, parseCheckpoint, resumeAllowed, serializeCheckpoint, atomicWriteFile } from './engine/checkpoint.ts'
import { defaultReaders } from './engine/readers.ts'

export const name = '@deepseek-ai/dsh-workflow-engine'
export const inject = ['tools', 'agents']

export interface Config extends EngineConfig {}

function clampTimeout(ms: number | undefined, def: number, max: number): number {
  if (ms === undefined || !(ms > 0)) return def
  return Math.min(Math.max(ms, 1), max)
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function apply(ctx: Context, config: Config = {}): void {
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 120_000
  const maxTimeoutMs = config.maxTimeoutMs ?? 600_000
  const runTimeoutMs = config.runTimeoutMs ?? 0
  const maxResultChars = config.maxResultChars ?? 20_000
  const defaultExample = config.defaultExample ?? 'guess-number'

  ctx.tools.register(defineTool({
    name: 'run_workflow',
    description:
      'Run a declarative multi-agent workflow described by a flow spec (flow spec + agents config). ' +
      'Built-in flows are ALWAYS available by their bare name (e.g. flow: "task-decomposition") ï¿?do NOT search the ' +
      'filesystem for them and do NOT prefix them with ./ or a path; only use an absolute/workspace-relative path for ' +
      'flows YOU authored. flow: "list" returns the available built-in flow names. ' +
      'Supports serial/parallel/conditional/loop orchestration, schema-validated decision agents, checkpoint ' +
      'pause-resume by runId, per-agent memory, and collected report outputs. Long workflows return "paused" with a ' +
      'runId when runTimeoutMs elapses; resume with the same flow and resumeRunId. When the user describes a task in ' +
      'natural language, map it onto the flow\'s input fields; if unsure of the field names, read the flow\'s ' +
      'flow.spec.js (its description declares the required/optional input contract).',
    parameters: {
      flow: { type: 'string', description: 'Path to a flow directory or a built-in name. Default: configured defaultExample.' },
      input: { type: 'object', additionalProperties: true, description: 'Initial run-state input, validated against the spec state shape. A string value "@file:<path>" imports that file\'s content.' },
      resumeRunId: { type: 'string', description: 'Resume a paused/interrupted run by its id.' },
      resumeStrict: { type: 'boolean', description: 'Resume even when the spec changed (default false).' },
      outputDir: { type: 'string', description: 'Directory the flow\'s declared outputs are copied to (absolute or relative to the session workspace). Default: <workspace>/<flowId>/output.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => runWorkflow(ctx, config, { defaultTimeoutMs, maxTimeoutMs, runTimeoutMs, maxResultChars, defaultExample }, args as WorkflowArgs, exec),
  }))
}

interface WorkflowArgs {
  flow?: unknown
  input?: unknown
  resumeRunId?: unknown
  resumeStrict?: unknown
  outputDir?: unknown
}

async function runWorkflow(
  ctx: Context,
  config: Config,
  resolved: { defaultTimeoutMs: number; maxTimeoutMs: number; runTimeoutMs: number; maxResultChars: number; defaultExample: string },
  args: WorkflowArgs,
  exec: ToolRunContext,
): Promise<string> {
  const input = args.input as Record<string, unknown> | undefined
  const resumeRunId = typeof args.resumeRunId === 'string' && args.resumeRunId !== '' ? args.resumeRunId : undefined
  const resumeStrict = args.resumeStrict === true
  const flowRef = typeof args.flow === 'string' && args.flow !== '' ? args.flow : undefined
  const outputDirArg = typeof args.outputDir === 'string' && args.outputDir !== '' ? args.outputDir : undefined

  try {
    if (flowRef === 'list') {
      const builtins = await listBuiltins()
      return truncate(JSON.stringify({ stopReason: 'completed', runId: null, result: { builtins } }, null, 2), resolved.maxResultChars)
    }
    const workspaceRoot = exec.agent?.session.header.cwd ?? process.cwd()
    const loaded = await loadFlow({ flow: flowRef, defaultName: resolved.defaultExample, input, baseDir: workspaceRoot })
    const flowId = loaded.spec.name
    const runId = resumeRunId ?? newRunId()
    const parentPreset = (exec.agent?.session.header as unknown as { agentPreset?: string }).agentPreset
    const checkpointPath = join(workspaceRoot, flowId, 'runs', runId, 'checkpoint.json')

    // Materialize agents (pure write, regenerate each run).
    await materializeAgents(loaded.agents, { workspaceRoot, flowId, pluginVersion: '0.0.13' })

    const monitor = exec.agent ? createMonitor(exec.agent.session, runId) : null
    const specHash = hashSpec(loaded.spec, loaded.agents)
    monitor?.runStart(loaded.name)

    let initialState: Record<string, unknown> = { ...(loaded.input ?? {}) }
    let restore: { lastNodeId: string | null; stack: Frame[] } | undefined
    let seedSessions: Record<string, string> | undefined
    if (resumeRunId) {
      const cp = parseCheckpoint(await readFile(checkpointPath, 'utf8'))
      if (cp.flowId !== flowId) throw new Error(`resume: runId ${runId} belongs to flow "${cp.flowId}", not "${flowId}"`)
      if (!resumeAllowed(cp, specHash, resumeStrict)) {
        throw new Error('resume: the flow spec or agents changed; pass resumeStrict=true to force')
      }
      initialState = cp.state
      restore = { lastNodeId: cp.lastNodeId, stack: cp.stack }
      seedSessions = cp.agentSessions
    }

    const runner = new AgentRunner(ctx, flowId, runId, workspaceRoot, parentPreset, seedSessions)
    let seq = 0

    const saveCheckpoint = async (snapshot: { lastNodeId: string | null; stack: Frame[]; state: Record<string, unknown> }): Promise<void> => {
      const cp: Checkpoint = {
        flowId, runId, specHash,
        state: snapshot.state,
        lastNodeId: snapshot.lastNodeId,
        stack: snapshot.stack,
        agentSessions: runner.sessionMap(),
      }
      await mkdir(dirname(checkpointPath), { recursive: true })
      await atomicWriteFile(checkpointPath, serializeCheckpoint(cp))
    }

    const hooks: OrchestratorHooks = {
      async runAgent(node, taskText) {
        seq++
        const childId = runner.sessionId(node.agent)
        monitor?.agentStart(seq, node.agent, undefined, childId)
        const cfg = loaded.agents[node.agent]
        const result = await runner.call({
          agentId: node.agent,
          config: cfg,
          taskText,
          structured: node.outputSchema ? { schema: node.outputSchema } : undefined,
          timeoutMs: clampTimeout(node.timeoutMs ?? loaded.spec.defaults?.timeoutMs, resolved.defaultTimeoutMs, resolved.maxTimeoutMs),
          signal: exec.signal,
        })
        monitor?.agentEnd(seq, result.ok ? 'completed' : 'failed')
        return { ok: result.ok, store: node.store, value: result.value, error: result.error }
      },
      emit: (event, payload) => {
        console.log(`[workflow:${flowId}] ${event}${payload === undefined ? '' : ` ${JSON.stringify(payload)}`}`)
      },
      checkpoint: saveCheckpoint,
      onPhase: (title) => { console.log(`[workflow:${flowId}] phase ${title}`) },
      isCancelled: () => exec.signal.aborted,
      now: () => Date.now(),
      runTimeoutMs: () => loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs,
      readers: defaultReaders(),
    }

    const result = await runOrchestrator(loaded.spec, loaded.agents, initialState, loaded.spec.entry, hooks, restore, { flowId, runId })
    monitor?.runEnd(result.stopReason)

    // Session disposition (G1): completed/failed dispose run sessions.
    if (result.stopReason === 'completed' || result.stopReason === 'error' || result.stopReason === 'failed') {
      await runner.disposeAll()
    }

    // Collect declared outputs to a stable location (option C).
    const outputDir = outputDirArg !== undefined
      ? (isAbsolute(outputDirArg) ? outputDirArg : join(workspaceRoot, outputDirArg))
      : join(workspaceRoot, flowId, 'output')
    const outputs = await collectOutputs(loaded.spec, result.state, flowId, runId, workspaceRoot, outputDir)

    const payload: RunWorkflowResult = {
      stopReason: result.stopReason as StopReason,
      runId,
      result: result.stopReason === 'completed' ? summarize(result.state) : undefined,
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(result.error ? { error: { node: result.error.node, message: result.error.message, checkpointPath } } : {}),
    }
    return truncate(JSON.stringify(payload, null, 2), resolved.maxResultChars)
  } catch (error) {
    return truncate(JSON.stringify({ stopReason: 'error', runId: resumeRunId ?? null, error: { node: 'run_workflow', message: String((error as Error).message ?? error), checkpointPath: '' } }, null, 2), resolved.maxResultChars)
  }
}

function summarize(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) {
    if (k === 'history' || k === 'results' || k === 'counts') out[k] = Array.isArray(v) ? `${v.length} items` : v
    else out[k] = v
  }
  return out
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\nï¿?[truncated]` : text
}
