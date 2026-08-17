/**
 * Pure template renderer: `{state.<path>}` / `{item.<path>}` / `{loopIndex}`
 * / `{<reader>(args)}`, with `?.`-tolerant path lookup and brace escaping.
 * Lookup only — no expressions or operators inside templates (G7).
 * @module @deepseek-ai/dsh-workflow-engine/template
 */

import { getPath } from './path.ts'
import type { EvalEnv } from '../types.ts'

export interface Reader {
  (env: EvalEnv, args: string[]): unknown
}

export type ReaderRegistry = Record<string, Reader>

const PLACEHOLDER_RE = /(\\[{}]|\{([^{}]+)\})/g

/** Split a raw args string on commas, preserving single/double-quoted spans. */
export function splitArgs(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  for (const ch of raw) {
    if (ch === "'" && !inD) inS = !inS
    else if (ch === '"' && !inS) inD = !inD
    if (ch === ',' && !inS && !inD) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

function renderToken(token: string, env: EvalEnv, readers: ReaderRegistry): string {
  const t = token.trim()
  // `{path ?? fallback}`: render the resolved value, or the fallback when empty.
  const fb = t.split('??')
  const head = fb[0]!.trim()
  const fallback = fb.length > 1 ? fb.slice(1).join('??').trim() : undefined
  const value = resolveToken(head, env, readers)
  const rendered = renderValue(value)
  return rendered !== '' ? rendered : (fallback ?? '')
}

function resolveToken(t: string, env: EvalEnv, readers: ReaderRegistry): unknown {
  if (t === 'loopIndex') return env.loopIndex
  if (t === 'state') return env.state
  if (t === 'item') return env.item
  if (t.startsWith('state.')) return getPath(env.state, t.slice('state.'.length))
  if (t.startsWith('item.')) return getPath(env.item, t.slice('item.'.length))
  const call = /^([a-zA-Z_][a-zA-Z0-9_]*)\(([\s\S]*)\)$/.exec(t)
  if (call) {
    const reader = readers[call[1]!]
    if (reader === undefined) return undefined
    return reader(env, splitArgs(call[2]!))
  }
  // bare variable: map `as` var (env extra) → item → state key.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
    if (t in env) return env[t]
    return getPath(env.state, t)
  }
  return undefined
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Render a template against an environment and reader registry. */
export function renderTemplate(tpl: string, env: EvalEnv, readers: ReaderRegistry): string {
  return tpl.replace(PLACEHOLDER_RE, (_m, escaped: string, inner?: string) => {
    if (escaped === '\\{' ) return '{'
    if (escaped === '\\}' ) return '}'
    return renderToken(inner ?? '', env, readers)
  })
}

/**
 * Parse-only check that a template is syntactically well-formed (balanced
 * braces, known token shapes). Returns null when valid, else an error message.
 */
export function checkTemplate(tpl: string, readers: ReaderRegistry): string | null {
  let depth = 0
  let token: string | null = null
  for (let i = 0; i < tpl.length; i++) {
    const ch = tpl[i]!
    if (ch === '\\' && i + 1 < tpl.length && (tpl[i + 1] === '{' || tpl[i + 1] === '}')) { i++; continue }
    if (ch === '{') {
      if (depth === 0) token = ''
      depth++
      if (depth > 1) return 'nested braces are not allowed'
      continue
    }
    if (ch === '}') {
      depth--
      if (depth < 0) return 'unmatched closing brace'
      if (token === null) return 'unexpected closing brace'
      const t = token.trim()
      if (t === '' || t === 'state' || t === 'item' || t === 'loopIndex') { token = null; continue }
      if (t.startsWith('state.') || t.startsWith('item.')) { token = null; continue }
      const head = t.split('??')[0]!.trim()
      const call = /^[a-zA-Z_][a-zA-Z0-9_]*\([\s\S]*\)$/.exec(head)
      const bareVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(head)
      if (call || bareVar) {
        if (call) {
          const name = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(head)![1]!
          if (readers[name] === undefined) return `unknown reader "${name}"`
        }
        token = null
        continue
      }
      return `invalid placeholder "{${t}}"`
    }
    if (depth === 1 && token !== null) token += ch
  }
  if (depth !== 0) return 'unclosed brace'
  return null
}
