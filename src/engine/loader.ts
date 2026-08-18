/**
 * Loader: resolve a flow by path (primary), built-in name, or configured
 * default, dynamically importing the JS data modules (agents + flow spec),
 * then run the validation gate. Dynamic import executes code — shell-level
 * trust model.
 * @module @deepseek-ai/dsh-workflow-engine/loader
 */

import { pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { AgentConfig, FlowSpec } from '../types.ts'
import { validateAgents, validateFlowSpec } from './validate.ts'
import { defaultReaders } from './readers.ts'

/** Cap for `@file:` input expansion. */
const MAX_FILE_INPUT_BYTES = 1024 * 1024

/** List the shipped built-in flow names (directories with agents.js + flow.spec.js). */
export async function listBuiltins(): Promise<string[]> {
  const examplesUrl = new URL('../../examples/', import.meta.url)
  const examplesDir = decodeURIComponent(examplesUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const names: string[] = []
  let entries: { isDirectory(): boolean; name: string }[]
  try {
    entries = await readdir(examplesDir, { withFileTypes: true }) as unknown as { isDirectory(): boolean; name: string }[]
  } catch {
    return names
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (await exists(join(examplesDir, e.name, 'flow.spec.js'))) names.push(e.name)
  }
  return names.sort()
}

export interface LoadedFlow {
  spec: FlowSpec
  agents: Record<string, AgentConfig>
  dir: string
  name: string
  input: Record<string, unknown>
}

export interface LoadOptions {
  /** Explicit path or name; defaults to config.defaultExample. */
  flow?: string
  defaultName?: string
  /** Base for relative paths; defaults to process.cwd(). */
  baseDir?: string
  input?: unknown
}

export async function loadFlow(opts: LoadOptions): Promise<LoadedFlow> {
  const ref = (opts.flow ?? opts.defaultName ?? '').trim()
  if (ref === '') throw new Error('run_workflow: no flow specified and no defaultExample configured')
  const baseDir = opts.baseDir ?? process.cwd()

  let dir: string
  let asBuiltIn = false
  if (isAbsolute(ref) || ref.startsWith('.') || ref.includes('\\') || ref.includes('/')) {
    dir = resolve(baseDir, ref)
  } else {
    // Built-in name → the package's shipped examples/<name>.
    const examplesUrl = new URL('../../examples/', import.meta.url)
    dir = join(decodeURIComponent(examplesUrl.pathname.replace(/^\/([A-Za-z]:)/, '$1')), ref)
    asBuiltIn = true
    if (!(await exists(join(dir, 'agents.js'))) && !(await exists(join(dir, 'flow.spec.js')))) {
      dir = resolve(baseDir, ref)
      asBuiltIn = false
    }
  }

  if (!(await exists(dir))) {
    const hint = asBuiltIn
      ? ` (built-in "${ref}" has no examples/${ref} directory)`
      : await builtInHint(ref)
    throw new Error(`run_workflow: flow not found at "${dir}"${hint}`)
  }
  const agentsPath = join(dir, 'agents.js')
  const specPath = join(dir, 'flow.spec.js')
  if (!(await exists(agentsPath))) throw new Error(`run_workflow: flow directory "${dir}" is missing agents.js`)
  if (!(await exists(specPath))) throw new Error(`run_workflow: flow directory "${dir}" is missing flow.spec.js`)

  const [agentsModule, specModule] = await Promise.all([importSafe(agentsPath), importSafe(specPath)])
  const agents = (agentsModule?.['agents'] ?? {}) as Record<string, AgentConfig>
  const rawSpec = specModule?.['default'] ?? specModule?.['spec']
  if (rawSpec === undefined || typeof rawSpec !== 'object') {
    throw new Error(`run_workflow: ${specPath} did not export a spec (default or named)`)
  }
  const spec = rawSpec as FlowSpec

  const input = await expandInput(opts.input, baseDir)

  const a = validateAgents(agents)
  if (!a.ok) throw new Error(`run_workflow: invalid agents config:\n${a.errors.join('\n')}`)
  const v = validateFlowSpec(spec, agents, input, defaultReaders())
  if (!v.ok) throw new Error(`run_workflow: invalid flow spec "${spec.name}":\n${v.errors.join('\n')}`)

  return { spec, agents, dir, name: spec.name, input }
}

/**
 * Expand `@file:<path>` input values: the file's text (txt/markdown) becomes
 * the field's value. Relative paths resolve against baseDir; absolute allowed.
 * Missing/oversized files fail loud.
 */
async function expandInput(input: unknown, baseDir: string): Promise<Record<string, unknown>> {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) return { ...(input as Record<string, unknown>) }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.startsWith('@file:')) {
      const ref = value.slice('@file:'.length).trim()
      const target = isAbsolute(ref) ? ref : resolve(baseDir, ref)
      if (!(await exists(target))) throw new Error(`run_workflow: input.${key} @file: file not found at "${target}"`)
      let text: string
      try {
        const buf = await readFile(target)
        if (buf.byteLength > MAX_FILE_INPUT_BYTES) {
          throw new Error(`run_workflow: input.${key} @file: "${target}" exceeds the 1 MiB cap`)
        }
        text = buf.toString('utf8')
      } catch (error) {
        throw new Error(`run_workflow: input.${key} @file: failed to read "${target}": ${String(error)}`)
      }
      out[key] = text
    } else {
      out[key] = value
    }
  }
  return out
}

async function importSafe(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = await import(pathToFileURL(url).href)
    return mod as Record<string, unknown>
  } catch (error) {
    throw new Error(`run_workflow: failed to load ${url}: ${String(error)}`)
  }
}

async function exists(p: string): Promise<boolean> {
  try { const { access } = await import('node:fs/promises'); await access(p); return true } catch { return false }
}

/** When a path fails to resolve but a built-in of the same name exists, tell the
 * caller to drop the path prefix (avoids the "searched the wrong place" trap). */
async function builtInHint(ref: string): Promise<string> {
  const base = ref.replace(/^\.\//, '').replace(/[\\/]+$/, '')
  if (base === '') return ''
  const builtins = await listBuiltins()
  return builtins.includes(base)
    ? ` (a built-in "${base}" exists — if you meant the built-in, drop the path prefix: flow: '${base}')`
    : ` (available built-ins: ${builtins.join(', ') || 'none'})`
}

export { dirname }
