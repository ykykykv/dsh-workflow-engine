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
import type { Checkpoint, EngineConfig, RunWorkflowResult, RunWorkflowStarted, SandboxMode, StopReason } from './types.ts'
import { loadFlow, listBuiltins, type LoadedFlow } from './engine/loader.ts'
import { materializeAgents } from './engine/materialize.ts'
import { collectOutputs } from './engine/collect.ts'
import { AgentRunner, type ParentScope } from './engine/spawn.ts'
import { createMonitor, type WorkflowMonitor } from './engine/monitor.ts'
import { runOrchestrator, type OrchestratorHooks } from './engine/orchestrator.ts'
import type { Frame } from './types.ts'
import { hashSpec, parseCheckpoint, resumeAllowed, serializeCheckpoint, atomicWriteFile } from './engine/checkpoint.ts'
import { assertSafeId } from './engine/validate.ts'
import { defaultReaders } from './engine/readers.ts'
import type { AgentPresetsLike } from './engine/preset-mount.ts'
import { acquireLease } from './engine/lease.ts'
import { backgroundJobs, outcomeOf, runWithAutoResume, truncate, type JobOutcomeLike } from './engine/background.ts'
import { CodeFailError, executeCodeNode, type CodeNodeApi } from './engine/code.ts'
import { getPath } from './engine/path.ts'
import { renderTemplate } from './engine/template.ts'
import { writeTranscript } from './engine/transcript.ts'

export const name = '@deepseek-ai/dsh-workflow-engine'
export const inject = ['tools', 'agents']

/** Read from package.json so materialized snapshots and logs carry the real version. */
const PLUGIN_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

/** How many automatic resumes a background run may perform. */
const MAX_AUTO_RESUME = 3

/** Minimal `sandboxPolicy` surface (0.2.x): workspace root + explicit session override. */
interface SandboxPolicyLike {
  resolve(request?: { session?: Session }): { workspaceRoot: string }
  overrideOf?(session: Session): SandboxMode | undefined
}

export interface Config extends EngineConfig {}

/** Fully resolved plugin configuration. */
interface ResolvedConfig {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  runTimeoutMs: number
  maxResultChars: number
  defaultExample: string
}

function clampTimeout(ms: number | undefined, def: number, max: number): number {
  if (ms === undefined || !(ms > 0)) return def
  return Math.min(Math.max(ms, 1), max)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function runLeasePath(workspaceRoot: string, flowId: string, runId: string): string {
  return join(workspaceRoot, flowId, 'runs', runId, 'lease.json')
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    defaultTimeoutMs: config.defaultTimeoutMs ?? 120_000,
    maxTimeoutMs: config.maxTimeoutMs ?? 600_000,
    runTimeoutMs: config.runTimeoutMs ?? 0,
    maxResultChars: config.maxResultChars ?? 20_000,
    defaultExample: config.defaultExample ?? 'guess-number',
  }

  ctx.tools.register(defineTool({
    name: 'run_workflow',
    description:
      'Run a declarative multi-agent workflow described by a flow spec (flow spec + agents config). ' +
      'Built-in flows are ALWAYS available by their bare name (e.g. flow: "task-decomposition") — do NOT search the ' +
      'filesystem for them and do NOT prefix them with ./ or a path; only use an absolute/workspace-relative path for ' +
      'flows YOU authored. flow: "list" returns the available built-in flow names. ' +
      'Supports serial/parallel/conditional/loop orchestration, schema-validated decision agents, checkpoint ' +
      'pause-resume by runId, per-agent memory, and collected report outputs. Long workflows return "paused" with a ' +
      'runId when runTimeoutMs elapses; resume with the same flow and resumeRunId. ' +
      'Set background: true to register the run as a background job and return a jobId immediately (the flow needs a ' +
      'positive run budget); check it with job_output, stop it with job_kill. ' +
      'When the user describes a task in natural language, map it onto the flow\'s input fields; if unsure of the ' +
      'field names, read the flow\'s flow.spec.js (its description declares the required/optional input contract).',
    parameters: {
      flow: { type: 'string', description: 'Path to a flow directory or a built-in name. Default: configured defaultExample.' },
      input: { type: 'object', additionalProperties: true, description: 'Initial run-state input, validated against the spec state shape. A string value "@file:<path>" imports that file\'s content.' },
      resumeRunId: { type: 'string', description: 'Resume a paused/interrupted run by its id.' },
      resumeStrict: { type: 'boolean', description: 'Resume even when the spec changed (default false).' },
      outputDir: { type: 'string', description: 'Directory the flow\'s declared outputs are copied to (absolute or relative to the session workspace). Default: <workspace>/<flowId>/output.' },
      background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately instead of holding the turn. Needs a positive run budget (spec defaults.runTimeoutMs or plugin runTimeoutMs).' },
      autoResume: { type: 'integer', description: 'Background only: automatically resume a paused run up to this many times (0-3, default 0). Each resume spends a fresh budget window, so it also bounds token spend.' },
      takeover: { type: 'boolean', description: 'Take over an expired run lease left by a crashed process. Fails while the lease is still live.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => runWorkflow(ctx, resolved, args as WorkflowArgs, exec),
  }))
}

interface WorkflowArgs {
  flow?: unknown
  input?: unknown
  resumeRunId?: unknown
  resumeStrict?: unknown
  outputDir?: unknown
  background?: unknown
  autoResume?: unknown
  takeover?: unknown
}

interface ParsedArgs {
  flowRef?: string
  input?: Record<string, unknown>
  resumeRunId?: string
  resumeStrict: boolean
  outputDir?: string
  background: boolean
  autoResume: number
  takeover: boolean
}

function parseArgs(args: WorkflowArgs): ParsedArgs {
  const autoResumeRaw = typeof args.autoResume === 'number' && Number.isFinite(args.autoResume) ? Math.trunc(args.autoResume) : 0
  return {
    flowRef: typeof args.flow === 'string' && args.flow !== '' ? args.flow : undefined,
    input: (args.input ?? undefined) as Record<string, unknown> | undefined,
    resumeRunId: typeof args.resumeRunId === 'string' && args.resumeRunId !== '' ? args.resumeRunId : undefined,
    resumeStrict: args.resumeStrict === true,
    outputDir: typeof args.outputDir === 'string' && args.outputDir !== '' ? args.outputDir : undefined,
    background: args.background === true,
    autoResume: Math.min(Math.max(autoResumeRaw, 0), MAX_AUTO_RESUME),
    takeover: args.takeover === true,
  }
}

/** Everything one run needs from its caller (foreground turn vs background job). */
interface RunControl {
  signal: AbortSignal
  /** Resume the persisted run id instead of starting a fresh one. */
  resume: boolean
  onPhase?: (title: string) => void
  onLog?: (line: string) => void
  /** Parent scope inherited by member agents (preset/lineage/sandbox). */
  parent?: ParentScope
  /** Run/phase/member status events for the calling session, when there is one. */
  monitor?: WorkflowMonitor | null
}

async function runWorkflow(ctx: Context, resolved: ResolvedConfig, args: WorkflowArgs, exec: ToolRunContext): Promise<string> {
  const parsed = parseArgs(args)
  try {
    if (parsed.flowRef === 'list') {
      const builtins = await listBuiltins()
      return truncate(JSON.stringify({ stopReason: 'completed', runId: null, result: { builtins } }, null, 2), resolved.maxResultChars)
    }
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    const loaded = await loadFlow({ flow: parsed.flowRef, defaultName: resolved.defaultExample, input: parsed.input, baseDir: workspaceRoot })
    if (parsed.resumeRunId !== undefined) {
      const err = assertSafeId('resumeRunId', parsed.resumeRunId)
      if (err !== null) throw new Error(`run_workflow: ${err}`)
    }

    if (parsed.background) {
      const started = await startBackground(ctx, resolved, loaded, workspaceRoot, parsed, exec)
      return truncate(JSON.stringify(started, null, 2), resolved.maxResultChars)
    }

    const runId = parsed.resumeRunId ?? newRunId()
    const lease = await acquireLease({
      path: runLeasePath(workspaceRoot, loaded.spec.name, runId),
      runId,
      owner: `manual:${process.pid}`,
      takeover: parsed.takeover,
    })
    try {
      const result = await executeRun(ctx, resolved, loaded, workspaceRoot, parsed, runId, {
        signal: exec.signal,
        resume: parsed.resumeRunId !== undefined,
        parent: resolveParentScope(ctx, exec),
        monitor: exec.agent ? createMonitor(exec.agent.session, runId) : null,
      })
      return truncate(JSON.stringify(result, null, 2), resolved.maxResultChars)
    } finally {
      await lease.release()
    }
  } catch (error) {
    return truncate(JSON.stringify({
      stopReason: 'error',
      runId: parsed.resumeRunId ?? null,
      error: { node: 'run_workflow', message: messageOf(error), checkpointPath: '' },
    }, null, 2), resolved.maxResultChars)
  }
}

/** Register the run as an owned `ctx.jobs` job and return immediately. */
async function startBackground(
  ctx: Context,
  resolved: ResolvedConfig,
  loaded: LoadedFlow,
  workspaceRoot: string,
  parsed: ParsedArgs,
  exec: ToolRunContext,
): Promise<RunWorkflowStarted> {
  const jobs = backgroundJobs(ctx)
  if (jobs === undefined) {
    throw new Error('run_workflow: background jobs unavailable — load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs in this composition')
  }
  const flowId = loaded.spec.name
  const runId = parsed.resumeRunId ?? newRunId()
  const budget = loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs
  if (!(budget > 0)) {
    throw new Error(
      'run_workflow: background runs need a positive run budget — set the flow\'s defaults.runTimeoutMs '
      + 'or the plugin runTimeoutMs (both are 0, which means "no budget" and would let a background run burn tokens unsupervised)',
    )
  }

  const lease = await acquireLease({
    path: runLeasePath(workspaceRoot, flowId, runId),
    runId,
    owner: `background:${process.pid}`,
    takeover: parsed.takeover,
  })

  let jobId: string
  const parent = resolveParentScope(ctx, exec)
  const monitor = exec.agent ? createMonitor(exec.agent.session, runId) : null
  try {
    jobId = jobs.start({
      kind: 'workflow-engine',
      label: `${flowId}${parsed.resumeRunId === undefined ? '' : ' (resume)'}`,
      owner: exec.agent?.session.id,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      run: (job) => {
        const controller = new AbortController()
        let settled: Promise<JobOutcomeLike>
        try {
          settled = (async (): Promise<JobOutcomeLike> => {
            try {
              job.updateProgress('running')
              const result = await runWithAutoResume(
                attempt => executeRun(ctx, resolved, loaded, workspaceRoot, parsed, runId, {
                  signal: controller.signal,
                  resume: parsed.resumeRunId !== undefined || attempt > 0,
                  parent,
                  monitor,
                  onPhase: title => job.updateProgress(title),
                  onLog: line => job.append(line, { channel: 'log' }),
                }),
                parsed.autoResume,
                (attempt) => job.append(`paused; auto-resume ${attempt}/${parsed.autoResume}`, { channel: 'log' }),
              )
              job.updateProgress(result.stopReason)
              return outcomeOf(result, resolved.maxResultChars)
            } catch (error) {
              return { status: 'failed', detail: messageOf(error) }
            } finally {
              await lease.release()
            }
          })()
        } catch (error) {
          void lease.release()
          throw error
        }
        return {
          cancel: (reason?: string) => controller.abort(reason ?? 'background run killed'),
          done: settled,
        }
      },
    })
  } catch (error) {
    await lease.release()
    throw new Error(`run_workflow: could not start the background job: ${messageOf(error)}`)
  }

  return {
    stopReason: 'started',
    runId,
    jobId,
    message: `run ${runId} started in the background as job ${jobId}; check it with job_output, stop it with job_kill`,
  }
}

/** Load, checkpoint, orchestrate, dispose, collect — one run attempt. */
async function executeRun(
  ctx: Context,
  resolved: ResolvedConfig,
  loaded: LoadedFlow,
  workspaceRoot: string,
  parsed: ParsedArgs,
  runId: string,
  control: RunControl,
): Promise<RunWorkflowResult> {
  const flowId = loaded.spec.name
  const checkpointPath = join(workspaceRoot, flowId, 'runs', runId, 'checkpoint.json')
  let runTimer: NodeJS.Timeout | undefined
  const clearRunTimer = (): void => { if (runTimer !== undefined) { clearTimeout(runTimer); runTimer = undefined } }
  try {
    await materializeAgents(loaded.agents, { workspaceRoot, flowId, pluginVersion: PLUGIN_VERSION })

    const monitor = control.monitor ?? null
    const specHash = hashSpec(loaded.spec, loaded.agents, loaded.bundle)
    monitor?.runStart(loaded.name)

    let initialState: Record<string, unknown> = { ...(loaded.input ?? {}) }
    let restore: { lastNodeId: string | null; stack: Frame[] } | undefined
    let seedSessions: Record<string, string> | undefined
    if (control.resume) {
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
      if (!resumeAllowed(cp, specHash, parsed.resumeStrict)) {
        throw new Error('resume: the flow spec or agents changed; pass resumeStrict=true to force')
      }
      initialState = cp.state
      restore = { lastNodeId: cp.lastNodeId, stack: cp.stack }
      seedSessions = cp.agentSessions
    }

    const transcripts: Record<string, string> = {}
    const runner = new AgentRunner(ctx, flowId, runId, workspaceRoot, control.parent, seedSessions, {
      defaultVisibility: loaded.spec.defaults?.visibility,
      onTranscript: async (agentId, _config, session) => {
        const file = await writeTranscript(join(workspaceRoot, flowId, 'runs', runId, 'agents'), agentId, session)
        transcripts[agentId] = file
        const line = `[workflow:${flowId}] transcript ${agentId} → ${file}`
        control.onLog?.(line)
        console.log(line)
      },
    })
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
    if (!control.resume) {
      await saveCheckpoint({
        lastNodeId: null,
        stack: [{ type: 'seq', refs: [loaded.spec.entry], index: 0, checkpoint: false }],
        state: initialState,
      })
    }

    // Arm the run-level time budget: the wall-clock timer aborts the in-flight
    // agent so a pause interrupts work instead of waiting for the node to end.
    const runAbort = new AbortController()
    const runBudget = loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs
    if (runBudget > 0) {
      runTimer = setTimeout(() => runAbort.abort(), runBudget)
    }

    const readers = defaultReaders()
    const hooks: OrchestratorHooks = {
      async runAgent(node, taskText) {
        if (runAbort.signal.aborted) return { ok: false, error: 'run paused (timeout)' }
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
          signal: AbortSignal.any([runAbort.signal, control.signal]),
        })
        monitor?.agentEnd(seq, result.ok ? 'completed' : 'failed')
        return { ok: result.ok, store: node.store, value: result.value, error: result.error }
      },
      async runCode(node, env) {
        const api: CodeNodeApi = {
          state: env.state,
          item: env.item,
          loopIndex: env.loopIndex,
          get: path => getPath(env.state, path),
          render: template => renderTemplate(template, env, readers),
          now: () => Date.now(),
          log: (message) => {
            const line = `[workflow:${flowId}] code ${message}`
            control.onLog?.(line)
            console.log(line)
          },
          fail: (message: string): never => { throw new CodeFailError(message) },
          signal: control.signal,
        }
        try {
          const result = await executeCodeNode(node, api, {
            baseDir: loaded.dir,
            timeoutMs: clampTimeout(node.timeoutMs, 5_000, resolved.defaultTimeoutMs),
          })
          return { ok: true, ...result }
        } catch (error) {
          if (error instanceof CodeFailError) return { ok: false, fatal: true, error: error.message }
          return { ok: false, error: messageOf(error) }
        }
      },
      emit: (event, payload) => {
        const line = `[workflow:${flowId}] ${event}${payload === undefined ? '' : ` ${JSON.stringify(payload)}`}`
        control.onLog?.(line)
        console.log(line)
      },
      checkpoint: saveCheckpoint,
      onPhase: (title) => {
        control.onPhase?.(title)
        console.log(`[workflow:${flowId}] phase ${title}`)
      },
      isCancelled: () => control.signal.aborted,
      isRunPaused: () => runAbort.signal.aborted,
      now: () => Date.now(),
      runTimeoutMs: () => loaded.spec.defaults?.runTimeoutMs ?? resolved.runTimeoutMs,
      readers,
    }

    const result = await runOrchestrator(loaded.spec, loaded.agents, initialState, loaded.spec.entry, hooks, restore, { flowId, runId })
    clearRunTimer()
    monitor?.runEnd(result.stopReason)

    // Session disposition (G1): completed/failed dispose run sessions.
    if (result.stopReason === 'completed' || result.stopReason === 'error' || result.stopReason === 'failed') {
      await runner.disposeAll()
    }

    // Collect declared outputs to a stable location (option C).
    const outputDir = parsed.outputDir !== undefined
      ? (isAbsolute(parsed.outputDir) ? parsed.outputDir : join(workspaceRoot, parsed.outputDir))
      : join(workspaceRoot, flowId, 'output')
    const outputs = await collectOutputs(loaded.spec, result.state, flowId, runId, workspaceRoot, outputDir)

    const payload: RunWorkflowResult = {
      stopReason: result.stopReason as StopReason,
      runId,
      result: result.stopReason === 'completed' ? summarize(result.state) : undefined,
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(Object.keys(transcripts).length > 0 ? { transcripts } : {}),
      ...(result.error ? { error: { node: result.error.node, message: result.error.message, checkpointPath } } : {}),
    }
    if (result.stopReason === 'paused') {
      payload.checkpointPath = checkpointPath
      payload.message = `run paused by the run budget; resume it with run_workflow({ flow: "${flowId}", resumeRunId: "${runId}" })`
    }
    if (result.stopReason === 'cancelled') {
      payload.checkpointPath = checkpointPath
      payload.message = `run cancelled; checkpoint retained at ${checkpointPath}`
    }
    return payload
  } catch (error) {
    return {
      stopReason: 'error',
      runId,
      error: { node: 'run_workflow', message: messageOf(error), checkpointPath },
    }
  } finally {
    clearRunTimer()
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
