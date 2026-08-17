/**
 * Built-in restricted reader/predicate vocabulary. Readers receive raw
 * comma-separated arg strings and resolve them against the environment:
 * `state.<path>` / `item.<path>` paths, bare identifiers (map `as` vars or
 * state keys), quoted strings, numbers, or the raw token itself.
 * @module @deepseek-ai/dsh-workflow-engine/readers
 */

import { getPath } from './path.ts'
import type { ReaderRegistry } from './template.ts'
import type { EvalEnv } from '../types.ts'

export function resolveArg(arg: string, env: EvalEnv): unknown {
  const a = arg.trim()
  if (a.startsWith('state.') || a === 'state') return getPath(env.state, a.slice('state.'.length))
  if (a.startsWith('item.') || a === 'item') return getPath(env.item, a.slice('item.'.length))
  if (a.startsWith('"') && a.endsWith('"') && a.length >= 2) return a.slice(1, -1)
  if (a.startsWith("'") && a.endsWith("'") && a.length >= 2) return a.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a)
  if (a === 'true') return true
  if (a === 'false') return false
  if (a === 'null') return null
  if (a in env) return env[a]
  // bare state path (predicate/reader convenience)
  return getPath(env.state, a)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    return String(a) === String(b)
  }
  return false
}

export function defaultReaders(): ReaderRegistry {
  return {
    json(env, args) {
      return JSON.stringify(resolveArg(args[0] ?? '', env) ?? null)
    },
    len(env, args) {
      const v = resolveArg(args[0] ?? '', env)
      if (typeof v === 'string' || Array.isArray(v)) return v.length
      return 0
    },
    join(env, args) {
      const arr = asArray(resolveArg(args[0] ?? '', env))
      const sep = args[1] !== undefined ? String(resolveArg(args[1], env) ?? '') : ','
      return arr.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(sep)
    },
    first(env, args) {
      return asArray(resolveArg(args[0] ?? '', env))[0]
    },
    last(env, args) {
      const arr = asArray(resolveArg(args[0] ?? '', env))
      return arr[arr.length - 1]
    },
    all(env, args) {
      const arr = asArray(resolveArg(args[0] ?? '', env))
      const field = rawField(args[1])
      const want = resolveArg(args[2] ?? '', env)
      return arr.every(el => looseEq((el as Record<string, unknown>)?.[field], want))
    },
    any(env, args) {
      const arr = asArray(resolveArg(args[0] ?? '', env))
      const field = rawField(args[1])
      const want = resolveArg(args[2] ?? '', env)
      return arr.some(el => looseEq((el as Record<string, unknown>)?.[field], want))
    },
    filterBy(env, args) {
      const arr = asArray(resolveArg(args[0] ?? '', env))
      const field = rawField(args[1])
      const want = resolveArg(args[2] ?? '', env)
      return arr.filter(el => looseEq((el as Record<string, unknown>)?.[field], want))
    },
  }
}

/** Field-name arg: a bare identifier (or quoted string), never a state path. */
function rawField(arg: string | undefined): string {
  const a = (arg ?? '').trim()
  if (a.startsWith('"') && a.endsWith('"') && a.length >= 2) return a.slice(1, -1)
  if (a.startsWith("'") && a.endsWith("'") && a.length >= 2) return a.slice(1, -1)
  return a
}
