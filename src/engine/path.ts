/**
 * Pure path access over JSON-ish values with `?.` tolerance.
 * Grammar: `a.b.c`, `a[0].b`, optional segments via `a?.b` or `a.b?`.
 * @module @deepseek-ai/dsh-workflow-engine/path
 */

export type Segment = { kind: 'key'; key: string; optional: boolean } | { kind: 'index'; index: number }

export function parsePath(path: string): Segment[] | null {
  const segs: Segment[] = []
  let rest = path.trim()
  if (rest === '') return null
  while (rest.length > 0) {
    // leading identifier key
    const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)(\?)?/.exec(rest)
    if (keyMatch) {
      segs.push({ kind: 'key', key: keyMatch[1]!, optional: keyMatch[2] !== undefined })
      rest = rest.slice(keyMatch[0].length)
    } else {
      // index access
      const idxMatch = /^\[(\d+)\]/.exec(rest)
      if (idxMatch) {
        segs.push({ kind: 'index', index: Number(idxMatch[1]) })
        rest = rest.slice(idxMatch[0].length)
      } else {
        return null
      }
    }
    if (rest === '') break
    if (rest[0] === '[') continue
    if (rest[0] === '.' || rest[0] === '?') {
      rest = rest[0] === '.' ? rest.slice(1) : rest.slice(2)
      continue
    }
    return null
  }
  return segs
}

/**
 * Resolve a parsed path against a value. Missing path (and any optional
 * segment) yields `{ found: false }`; otherwise `{ found: true, value }`.
 */
export function resolvePath(value: unknown, segs: Segment[]): { found: boolean; value?: unknown } {
  let current: unknown = value
  for (const seg of segs) {
    if (current === undefined || current === null) {
      return { found: false }
    }
    if (seg.kind === 'index') {
      if (Array.isArray(current) && seg.index < current.length) {
        current = current[seg.index]
      } else {
        return { found: false }
      }
    } else {
      if (typeof current === 'object') {
        const obj = current as Record<string, unknown>
        if (seg.key in obj) current = obj[seg.key]
        else return { found: false }
      } else {
        return { found: false }
      }
    }
  }
  return { found: true, value: current }
}

/** Resolve a full dotted path string against a value (missing → undefined). */
export function getPath(value: unknown, path: string): unknown {
  const segs = parsePath(path)
  if (segs === null) return undefined
  const r = resolvePath(value, segs)
  return r.found ? r.value : undefined
}
