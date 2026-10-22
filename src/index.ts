/**
 * @deepseek-ai/dsh-workflow-engine — declarative multi-agent workflow engine.
 * @module @deepseek-ai/dsh-workflow-engine
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Checkpoint, EngineConfig, RunWorkflowResult, SandboxMode, StopReason } from './types.ts'
import { loadFlow, listBuiltins } from './engine/loader.ts'
import { materializeAgents } from './engine/materialize.ts'
import { collectOutputs } from './engine/collect.ts'
import { AgentRunner, type ParentScope } from './engine/spawn.ts'
import { createMonitor } from './engine/monitor.ts'
import { runOrchestrator, type OrchestratorHooks } from './engine/orchestrator.ts'
import type { Frame } from './types.ts'
import { hashSpec, parseCheckpoint, resumeAllowed, serializeCheckpoint, atomicWriteFile } from './engine/checkpoint.ts'
import { assertSafeId } from './engine/validate.ts'
import { defaultReaders } from './engine/readers.ts'
import type { AgentPresetsLike } from './engine/preset-mount.ts'

export const name = '@deepseek-ai/dsh-workflow-engine'
export const inject = ['tools', 'agents']

/** Read from package.json so materialized snapshots and logs carry the real version. */
const PLUGIN_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

/** Minimal `sandboxPolicy` surface (0.2.x): workspace root + explicit session override. */
interface SandboxPolicyLike {
  resolve(request?: { session?: Session }): { workspaceRoot: string }
  overrideOf?(session: Session): SandboxMode | undefined
}

export interface Config extends EngineConfig {}

function clampTimeout(ms: number | undefined, def: number, max: number): number {
  if (ms === undefined || !(ms > 0)) return def
  return Math.min(Math.max(ms, 1), max)
}

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Resolve the workspace root: session cwd first, then the sandbox policy root. */
function resolveWorkspaceRoot(ctx: Context, exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd !== undefined && cwd !== '') return cwd
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
  const root = policy?.resolve(exec.agent === undefined ? undefined : { session: exec.agent.session }).workspaceRoot
  if (root !== undefined && root !== '') return root
  throw new Error(
    'run_workflow: the session has no working directory (cwd) and no sandbox workspace root is available; '
    + 'open the session in a workspace first',
  )
}

/** Parent scope inherited by every member agent of this run (preset, lineage, sandbox). */
function resolveParentScope(ctx: Context, exec: ToolRunContext): ParentScope | undefined {
  const parent = exec.agent
  if (parent === undefined) return undefined
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  const preset = presets?.composedPreset?.(parent.ctx)
    ?? (parent.session.header as unknown as { agentPreset?: string }).agentPreset
  const sandbox = (ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined)?.overrideOf?.(parent.session)
  return { preset, sessionId: parent.session.id, sandbox }
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
      'Built-in flows are ALWAYS available by their bare name (e.g. flow: "task-decomposition") — do NOT search the ' +
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

  let runTimer: NodeJS.Timeout | undefined
  const clearRunTimer = (): void => { if (runTimer !== undefined) { clearTimeout(runTimer); runTimer = undefined } }
  try {
    // Run-level time budget controller (armed after the flow loads).
    let runAbort: AbortController | undefined
    if (flowRef === 'list') {
      const builtins = await listBuiltins()
      return truncate(JSON.stringify({ stopReason: 'completed', runId: null, result: { builtins } }, null, 2), resolved.maxResultChars)
    }
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    const loaded = await loadFlow({ flow: flowRef, defaultName: resolved.defaultExample, input, baseDir: workspaceRoot })
    const flowId = loaded.spec.name
    if (resumeRunId !== undefined) {
      const err = assertSafeId('resumeRunId', resumeRunId)
      if (err !== null) throw new Error(`run_workflow: ${err}`)
    }
    const runId = resumeRunId ?? newRunId()
    const parent = resolveParentScope(ctx, exec)
    const checkpointPath = join(workspaceRoot, flowId, 'runs', runId, 'checkpoint.json')

    // Materialize agents (pure write, regenerate each run).
    await materializeAgents(loaded.agents, { workspaceRoot, flowId, pluginVersion: PLUGIN_VERSION })

    const monitor = exec.agent ? createMonitor(exec.agent.session, runId) : null
    const specHash = hashSpec(loaded.spec, loaded.agents)
    monitor?.runStart(loaded.name)

    let initialState: Record<string, unknown> = { ...(loaded.input ?? {}) }
    let restore: { lastNodeId: string | null; stack: Frame[] } | undefined
    let seedSessions: Record<string, string> | undefined
    if (resumeRunId) {
      let checkpointText: string
      try {
        checkpointText = await readFile(checkpointPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `resume: run ${runId} has no checkpoint (it may have paused before its first node completed); `
            + 're-run without resumeRunId',
          )
        }
        throw error
      }
      const cp = parseCheckpoint(checkpointText)
      if (cp.flowId !== flowId) throw new Error(`resume: runId ${runId} belongs to flow "${cp.flowId}", not "${flowId}"`)
      if (!resumeAllowed(cp, specHash, resumeStrict)) {
        throw new Error('resume: the flow spec or agents changed; pass resumeStrict=true to force')
      }
      initialState = cp.state
      restore = { lastNodeId: cp.lastNodeId, stack: cp.stack }
      seedSessions = cp.agentSessions
    }

    const runner = new AgentRunner(ctx, flowId, runId, workspaceRoot, parent, seedSessions)
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

    // Initial checkpoint: the orchestrator only checkpoints after a node finishes,
    // so a pause inside the very first node must still leave a resumable run.
    if (resumeRunId === undefined) {
      await saveCheckpoint({
        lastNodeId: null,
        stack: [{ type: 'seq', refs: [loaded.spec.entry], index: 0, checkpoint: false }],
        state: initialState,
      })
    }

    // Arm the run-level time budget: the wall-clock timer aborts the in-flight
    // agent so a pause interrupts work instead of waiting for the node to end.
    runAbort = new AbortController()
    const runBudget = loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs
    if (runBudget > 0) {
      runTimer = setTimeout(() => runAbort?.abort(), runBudget)
    }

    const hooks: OrchestratorHooks = {
      async runAgent(node, taskText) {
        if (runAbort?.signal.aborted) return { ok: false, error: 'run paused (timeout)' }
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
          signal: AbortSignal.any([runAbort!.signal, exec.signal]),
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
      isRunPaused: () => runAbort?.signal.aborted === true,
      now: () => Date.now(),
      runTimeoutMs: () => loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs,
      readers: defaultReaders(),
    }

    const result = await runOrchestrator(loaded.spec, loaded.agents, initialState, loaded.spec.entry, hooks, restore, { flowId, runId })
    clearRunTimer()
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
    clearRunTimer()
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
  return text.length > max ? `${text.slice(0, max)}\n—[truncated]` : text
}
