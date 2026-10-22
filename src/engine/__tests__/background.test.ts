import { describe, expect, it } from 'vitest'
import { outcomeOf, runWithAutoResume, truncate } from '../background.ts'
import type { RunWorkflowResult } from '../../types.ts'

const paused: RunWorkflowResult = {
  stopReason: 'paused',
  runId: 'run-1',
  message: 'run paused by the run budget',
  checkpointPath: 'C:/tmp/run-1/checkpoint.json',
}

describe('job outcome mapping', () => {
  it('maps completed to completed and carries the rendered result', () => {
    const outcome = outcomeOf({ stopReason: 'completed', runId: 'run-1', result: { ok: true } }, 10_000)
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain('"stopReason":"completed"')
  })

  it('truncates an oversized job result', () => {
    const outcome = outcomeOf({ stopReason: 'completed', runId: 'run-1', result: 'x'.repeat(50) }, 20)
    expect(outcome.result).toBe(truncate(JSON.stringify({ stopReason: 'completed', runId: 'run-1', result: 'x'.repeat(50) }), 20))
    expect(outcome.result?.endsWith('[truncated]')).toBe(true)
  })

  it('never reports a paused run as completed', () => {
    const outcome = outcomeOf(paused, 10_000)
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('paused')
    expect(outcome.detail).toContain('run-1')
  })

  it('maps cancellation to killed and failures to failed', () => {
    expect(outcomeOf({ stopReason: 'cancelled', runId: 'r', message: 'cancelled' }, 100).status).toBe('killed')
    expect(outcomeOf({ stopReason: 'error', runId: 'r', error: { node: 'n', message: 'boom', checkpointPath: '' } }, 100))
      .toMatchObject({ status: 'failed', detail: 'n: boom' })
  })
})

describe('bounded auto-resume', () => {
  it('resumes paused runs until one completes', async () => {
    const results: RunWorkflowResult[] = [paused, paused, { stopReason: 'completed', runId: 'run-1' }]
    let calls = 0
    const seen: number[] = []
    const final = await runWithAutoResume(async (attempt) => {
      expect(attempt).toBe(calls)
      calls++
      return results.shift() as RunWorkflowResult
    }, 5, attempt => seen.push(attempt))
    expect(final.stopReason).toBe('completed')
    expect(calls).toBe(3)
    expect(seen).toEqual([1, 2])
  })

  it('stops at the configured limit', async () => {
    let calls = 0
    const final = await runWithAutoResume(async () => {
      calls++
      return paused
    }, 2)
    expect(final.stopReason).toBe('paused')
    expect(calls).toBe(3)
  })

  it('does not resume when the limit is zero', async () => {
    let calls = 0
    const final = await runWithAutoResume(async () => {
      calls++
      return paused
    }, 0)
    expect(final.stopReason).toBe('paused')
    expect(calls).toBe(1)
  })
})
