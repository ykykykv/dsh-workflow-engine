import { describe, expect, it } from 'vitest'
import { CodeFailError, executeCodeNode, type CodeNodeApi } from '../code.ts'
import type { CodeNode } from '../../types.ts'

function api(overrides: Partial<CodeNodeApi> = {}): CodeNodeApi {
  const state = { tasks: [1, 2, 3] } as Record<string, unknown>
  return {
    state,
    get: path => path.split('.').reduce<unknown>((value, key) => {
      if (value === null || typeof value !== 'object') return undefined
      return (value as Record<string, unknown>)[key]
    }, state),
    render: template => template,
    now: () => 1_000,
    log: () => {},
    fail: (message: string): never => { throw new CodeFailError(message) },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function node(run: CodeNode['run'], extra: Partial<CodeNode> = {}): CodeNode {
  return { kind: 'code', run, ...extra }
}

const options = { baseDir: process.cwd(), timeoutMs: 1_000 }

describe('code node executor', () => {
  it('returns a patch from an inline body', async () => {
    const result = await executeCodeNode(node('return { patch: { total: state.tasks.length } }'), api(), options)
    expect(result).toEqual({ patch: { total: 3 } })
  })

  it('returns a value and reads state paths', async () => {
    const result = await executeCodeNode(node('return { value: get("tasks.1") }'), api(), options)
    expect(result).toEqual({ value: 2 })
  })

  it('supports an early break signal', async () => {
    const result = await executeCodeNode(node('return { signal: "break" }'), api(), options)
    expect(result.signal).toBe('break')
  })

  it('loads a module body through the import seam', async () => {
    const result = await executeCodeNode(
      node({ module: './code/step.mjs' }),
      api(),
      { ...options, importModule: async () => ({ default: () => ({ value: 42 }) }) },
    )
    expect(result).toEqual({ value: 42 })
  })

  it('rejects a module without a function export', async () => {
    await expect(executeCodeNode(
      node({ module: './code/empty.mjs' }),
      api(),
      { ...options, importModule: async () => ({}) },
    )).rejects.toThrow(/must export a function/)
  })

  it('propagates api.fail as a deliberate failure', async () => {
    await expect(executeCodeNode(node('fail("nope")'), api(), options)).rejects.toBeInstanceOf(CodeFailError)
  })

  it('surfaces a thrown error', async () => {
    await expect(executeCodeNode(node('throw new Error("boom")'), api(), options)).rejects.toThrow('boom')
  })

  it('times out an async body', async () => {
    await expect(executeCodeNode(
      node('return new Promise(() => {})'),
      api(),
      { ...options, timeoutMs: 20 },
    )).rejects.toThrow(/timed out after 20ms/)
  })

  it('rejects an already-aborted run before executing', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(executeCodeNode(node('return { value: 1 }'), api({ signal: controller.signal }), options))
      .rejects.toThrow(/aborted/)
  })

  it('rejects a non-object result and an unknown signal', async () => {
    await expect(executeCodeNode(node('return 42'), api(), options)).rejects.toThrow(/must return an object/)
    await expect(executeCodeNode(node('return { signal: "stop" }'), api(), options)).rejects.toThrow(/only be "break"/)
  })

  it('rejects a body that does not compile', async () => {
    await expect(executeCodeNode(node('return {'), api(), options)).rejects.toThrow(/does not compile/)
  })
})
