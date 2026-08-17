/**
 * Pure predicate evaluator for `branch.if` / `loop.until` (G7).
 * Grammar: `||` / `&&` / `!` / comparisons (`== != > >= < <=`) / literals /
 * paths (with `?.` tolerance) / registered reader calls whose args are raw
 * comma-separated tokens handed to the reader.
 * Environment root: `env.state` (bare paths resolve here), plus `item`,
 * `loopIndex`, and explicit `state.` / `item.` prefixes.
 * @module @deepseek-ai/dsh-workflow-engine/predicate
 */

import { getPath } from './path.ts'
import type { EvalEnv } from '../types.ts'

export interface Reader {
  (env: EvalEnv, args: string[]): unknown
}

export type ReaderRegistry = Record<string, Reader>

class ParseError extends Error {}

class Scanner {
  s: string
  i = 0
  constructor(s: string) { this.s = s }
  skipWs(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++ }
  peek(): string | undefined { this.skipWs(); return this.s[this.i] }
  atEnd(): boolean { this.skipWs(); return this.i >= this.s.length }
}

function expectEnd(sc: Scanner): void {
  if (!sc.atEnd()) throw new ParseError(`unexpected trailing input at "${sc.s.slice(sc.i)}"`)
}

function parsePrimary(sc: Scanner, env: EvalEnv, readers: ReaderRegistry): unknown {
  const ch = sc.peek()
  if (ch === undefined) throw new ParseError('unexpected end of expression')
  if (ch === '(') {
    sc.i++
    const value = parseOr(sc, env, readers)
    if (sc.peek() !== ')') throw new ParseError('expected ")"')
    sc.i++
    return value
  }
  if (ch === "'" || ch === '"') return parseString(sc)
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(sc)
  // identifier: path or reader call or keyword
  const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sc.s.slice(sc.i))
  if (!m) throw new ParseError(`unexpected character "${ch}"`)
  const id = m[0]
  sc.i += id.length
  if (id === 'true') return true
  if (id === 'false') return false
  if (id === 'null') return null
  if (sc.peek() === '(') {
    // reader call: consume raw args
    let depth = 0
    let end = sc.i
    const src = sc.s
    while (end < src.length) {
      const c = src[end]!
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) break }
      end++
    }
    if (depth !== 0) throw new ParseError('unclosed reader call')
    const rawArgs = src.slice(sc.i + 1, end)
    sc.i = end + 1
    const reader = readers[id]
    if (reader === undefined) throw new ParseError(`unknown reader "${id}"`)
    return reader(env, splitArgs(rawArgs))
  }
  // path
  const path = parsePathTail(sc, id)
  return getPath(rootFor(path, env), path)
}

function rootFor(path: string, env: EvalEnv): unknown {
  if (path === 'state' || path.startsWith('state.')) return env.state
  if (path === 'item' || path.startsWith('item.')) return env.item
  return env.state
}

function parsePathTail(sc: Scanner, first: string): string {
  let path = first
  for (;;) {
    const ch = sc.peek()
    if (ch === '.' || ch === '?') {
      if (ch === '?') {
        // optional segment: `?.` or `?`
        sc.i++
        const nxt = sc.peek()
        if (nxt === '.') sc.i++
        const key = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sc.s.slice(sc.i))
        if (!key) throw new ParseError('expected path segment after "?."')
        sc.i += key[0].length
        path += `?.${key[0]}`
        continue
      }
      sc.i++
      const key = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(sc.s.slice(sc.i))
      if (!key) throw new ParseError('expected path segment after "."')
      sc.i += key[0].length
      path += `.${key[0]}`
      continue
    }
    if (ch === '[') {
      sc.i++
      const idx = /^\d+/.exec(sc.s.slice(sc.i))
      if (!idx) throw new ParseError('expected index after "["')
      sc.i += idx[0].length
      if (sc.peek() !== ']') throw new ParseError('expected "]"')
      sc.i++
      path += `[${idx[0]}]`
      continue
    }
    break
  }
  return path
}

function parseString(sc: Scanner): string {
  const quote = sc.s[sc.i]!
  sc.i++
  let out = ''
  while (sc.i < sc.s.length) {
    const c = sc.s[sc.i]!
    sc.i++
    if (c === '\\' && sc.i < sc.s.length) { out += sc.s[sc.i]!; sc.i++; continue }
    if (c === quote) return out
    out += c
  }
  throw new ParseError('unterminated string')
}

function parseNumber(sc: Scanner): number {
  const m = /^-?\d+(\.\d+)?/.exec(sc.s.slice(sc.i))
  if (!m) throw new ParseError('invalid number')
  sc.i += m[0].length
  return Number(m[0])
}

function parseUnary(sc: Scanner, env: EvalEnv, readers: ReaderRegistry): unknown {
  if (sc.peek() === '!') {
    sc.i++
    const v = parseUnary(sc, env, readers)
    return !truthy(v)
  }
  return parseComparison(sc, env, readers)
}

function parseComparison(sc: Scanner, env: EvalEnv, readers: ReaderRegistry): unknown {
  const left = parsePrimary(sc, env, readers)
  const two = sc.s.slice(sc.i, sc.i + 2)
  let cmpOp: string | null = null
  if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
    cmpOp = two
    sc.i += 2
  } else {
    const one = sc.peek()
    if (one === '>' || one === '<') {
      cmpOp = one
      sc.i += 1
    }
  }
  if (cmpOp !== null) {
    const right = parsePrimary(sc, env, readers)
    return applyCompare(cmpOp, left, right)
  }
  return left
}

function applyCompare(op: string, a: unknown, b: unknown): boolean {
  if (op === '==') return looseEq(a, b)
  if (op === '!=') return !looseEq(a, b)
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return false
  if (op === '>') return na > nb
  if (op === '>=') return na >= nb
  if (op === '<') return na < nb
  if (op === '<=') return na <= nb
  return false
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    return String(a) === String(b)
  }
  return false
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== '' && v !== 'false'
  return true
}

function peek2(sc: Scanner): string {
  sc.skipWs()
  return sc.s.slice(sc.i, sc.i + 2)
}

function parseAnd(sc: Scanner, env: EvalEnv, readers: ReaderRegistry): unknown {
  let value = parseUnary(sc, env, readers)
  for (;;) {
    if (peek2(sc) === '&&') {
      sc.i += 2
      const right = parseUnary(sc, env, readers)
      value = truthy(value) && truthy(right)
      continue
    }
    break
  }
  return value
}

function parseOr(sc: Scanner, env: EvalEnv, readers: ReaderRegistry): unknown {
  let value = parseAnd(sc, env, readers)
  for (;;) {
    if (peek2(sc) === '||') {
      sc.i += 2
      const right = parseAnd(sc, env, readers)
      value = truthy(value) || truthy(right)
      continue
    }
    break
  }
  return value
}

/** Split a raw args string on commas, preserving quoted spans. */
export function splitArgs(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  for (const ch of raw) {
    if (ch === "'" && !inD) inS = !inS
    else if (ch === '"' && !inS) inD = !inD
    if (ch === ',' && !inS && !inD) { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

/** Evaluate a predicate expression to a truthy/falsy result. Throws on syntax error. */
export function evalPredicate(expr: string, env: EvalEnv, readers: ReaderRegistry): boolean {
  const sc = new Scanner(expr)
  const value = parseOr(sc, env, readers)
  expectEnd(sc)
  return truthy(value)
}

/** Parse-only check; returns null when valid, else an error message. */
export function checkPredicate(expr: string, readers: ReaderRegistry): string | null {
  try {
    const sc = new Scanner(expr)
    parseOr(sc, { state: {} }, readers)
    expectEnd(sc)
    return null
  } catch (e) {
    return e instanceof ParseError ? e.message : String(e)
  }
}
