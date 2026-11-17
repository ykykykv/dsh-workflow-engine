/**
 * Executor for `code` nodes: a deterministic step with a narrow, explicit API.
 *
 * The node is not "the flow written in code" — control flow, retries, and
 * checkpointing stay with the engine; this module only runs one function and
 * normalizes its result. Bodies must be pure (no I/O): a resume replays them.
 * @module @deepseek-ai/dsh-workflow-engine/code
 */

import { resolve } from 'node:path'
import type { CodeNode } from '../types.ts'
import { importFresh } from './import-fresh.ts'

/** Everything a code body may use. Deliberately no `ctx`, no agent access. */
export interface CodeNodeApi {
  /** Read-only view of the run state (a snapshot; do not mutate it). */
  readonly state: Readonly<Record<string, unknown>>
  /** Current `map` item, when the node runs inside a map. */
  readonly item?: unknown
  /** 1-based round inside a loop, when the node runs inside one. */
  readonly loopIndex?: number
  /** Read one `a.b.0.c` path from the state. */
  get(path: string): unknown
  /** Render a flow template against the current environment. */
  render(template: string): string
  /** Unix epoch milliseconds. */
  now(): number
  /** Append a line to the run log. */
  log(message: string): void
  /** Fail the whole run (stopReason 'failed'), bypassing onError. */
  fail(message: string): never
  /** Cancellation of the run (cooperative for async bodies). */
  readonly signal: AbortSignal
}

/** Normalized result of one code node. */
export interface CodeNodeResult {
  /** State keys to merge. */
  patch?: Record<string, unknown>
  /** Value stored at the node's `store` key. */
  value?: unknown
  /** Exit the nearest loop, same as a `break` node. */
  signal?: 'break'
}

/** Thrown by `api.fail`: a deliberate run failure, not a retryable node error. */
export class CodeFailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodeFailError'
  }
}

export interface ExecuteCodeOptions {
  /** Flow directory; module refs resolve against it. */
  baseDir: string
  /** Cooperative timeout for the body (0 disables it). */
  timeoutMs: number
  /** Test seam for module imports. */
  importModule?: (file: string) => Promise<unknown>
}

/** Run one code node and normalize its result. */
export async function executeCodeNode(
  node: CodeNode,
  api: CodeNodeApi,
  options: ExecuteCodeOptions,
): Promise<CodeNodeResult> {
  if (api.signal.aborted) throw new Error('code node aborted')
  const body = await loadBody(node, options)
  const work = Promise.resolve().then(() => body(api))
  const raw = await withTimeout(work, options.timeoutMs, api.signal)
  return normalizeResult(raw)
}

type CodeBody = (api: CodeNodeApi) => unknown

async function loadBody(node: CodeNode, options: ExecuteCodeOptions): Promise<CodeBody> {
  if (typeof node.run === 'string') {
    const source = node.run.trim()
    if (source === '') throw new Error('code node body is empty')
    let compiled: (api: CodeNodeApi) => unknown
    try {
      compiled = new Function(
        'api',
        `"use strict";\nconst { state, item, loopIndex, get, render, now, log, fail, signal } = api;\n${source}`,
      ) as (api: CodeNodeApi) => unknown
    } catch (error) {
      throw new Error(`code node body does not compile: ${error instanceof Error ? error.message : String(error)}`)
    }
    return compiled
  }

  const file = resolve(options.baseDir, node.run.module)
  const loaded = await (options.importModule ?? importFresh)(file) as { default?: unknown; run?: unknown } | undefined
  const candidate = typeof loaded === 'function'
    ? loaded
    : (loaded?.default ?? loaded?.run)
  if (typeof candidate !== 'function') {
    throw new Error(`code node module "${node.run.module}" must export a function (default or named "run")`)
  }
  return candidate as CodeBody
}

function normalizeResult(raw: unknown): CodeNodeResult {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('code node must return an object: { patch?, value?, signal? }')
  }
  const record = raw as Record<string, unknown>
  const out: CodeNodeResult = {}
  if (record['patch'] !== undefined) {
    const patch = record['patch']
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('code node "patch" must be a plain object')
    }
    out.patch = { ...(patch as Record<string, unknown>) }
  }
  if (record['value'] !== undefined) out.value = record['value']
  if (record['signal'] !== undefined) {
    if (record['signal'] !== 'break') throw new Error('code node "signal" may only be "break"')
    out.signal = 'break'
  }
  return out
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const guards: Promise<never>[] = []

  if (timeoutMs > 0) {
    guards.push(new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`code node timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    }))
  }
  if (signal.aborted) {
    guards.push(Promise.reject(new Error('code node aborted')))
  } else {
    guards.push(new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('code node aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }))
  }

  const raced = guards.length > 0 ? Promise.race([work, ...guards]) : work
  return raced.finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  })
}
