/**
 * Background-job glue: a minimal duck-typed view of `ctx.jobs` (the seam is
 * optional, so the plugin never imports its implementation), the mapping from a
 * run outcome to a job outcome, and the bounded auto-resume loop.
 * @module @deepseek-ai/dsh-workflow-engine/background
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RunWorkflowResult } from '../types.ts'

/** Producer face of one registered job (`ctx.jobs` handle). */
export interface JobHandleLike {
  readonly id: string
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void
  updateProgress(line: string): void
}

/** Terminal job outcome. `result` is a string handed to the model once. */
export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  result?: string
}

export interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<JobOutcomeLike>
}

/** The slice of `ctx.jobs` this plugin uses. */
export interface JobsLike {
  start(spec: {
    kind: string
    label: string
    owner?: unknown
    toolCall?: unknown
    run(job: JobHandleLike): JobHooksLike
  }): string
}

/** Resolve the optional job registry (`dsh-jobs` + `dsh-tool-jobs`). */
export function backgroundJobs(ctx: Context): JobsLike | undefined {
  return ctx.get('jobs') as JobsLike | undefined
}

/** Bound a model-facing string (also used for job results). */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n—[truncated]` : text
}

/**
 * Map a run result onto the job registry's three terminal states.
 *
 * `paused` has no job equivalent: it settles `failed` with a detail that names
 * the run and how to resume, because `completed` would claim a finished run.
 */
export function outcomeOf(result: RunWorkflowResult, maxResultChars: number): JobOutcomeLike {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', result: truncate(JSON.stringify(result), maxResultChars) }
    case 'cancelled':
      return { status: 'killed', detail: result.message ?? 'cancelled' }
    case 'paused':
      return {
        status: 'failed',
        detail: `paused: ${result.message ?? 'run budget elapsed'} (runId=${result.runId})`,
      }
    case 'failed':
    case 'error':
    default:
      return {
        status: 'failed',
        detail: result.error === undefined ? result.stopReason : `${result.error.node}: ${result.error.message}`,
      }
  }
}

/**
 * Run once, then resume a paused run at most `autoResume` more times. Every
 * resume gets a fresh run budget, so `autoResume` is also the token guard:
 * total work is bounded by `budget × (autoResume + 1)`.
 */
export async function runWithAutoResume(
  runOnce: (attempt: number) => Promise<RunWorkflowResult>,
  autoResume: number,
  onResume?: (attempt: number, result: RunWorkflowResult) => void,
): Promise<RunWorkflowResult> {
  let result = await runOnce(0)
  let attempt = 0
  while (result.stopReason === 'paused' && attempt < autoResume) {
    attempt++
    onResume?.(attempt, result)
    result = await runOnce(attempt)
  }
  return result
}
