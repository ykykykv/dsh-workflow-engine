/**
 * Loader: resolve a flow by path (primary), built-in name, or configured
 * default, dynamically importing the JS data modules (agents + flow spec),
 * then run the validation gate. Dynamic import executes code — shell-level
 * trust model.
 * @module @deepseek-ai/dsh-workflow-engine/loader
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { AgentConfig, BundleFile, FlowNode, FlowSpec, StateShape } from '../types.ts'
import { childRefs, validateAgents, validateFlowSpec } from './validate.ts'
import { defaultReaders } from './readers.ts'
import { importFresh } from './import-fresh.ts'

/** Cap for `@file:` input expansion. */
const MAX_FILE_INPUT_BYTES = 1024 * 1024

/** Persona file extensions tried for `personaRef`. */
const PERSONA_EXTENSIONS = ['.md', '.markdown', '.txt']

/** Absolute path to the package's shipped `examples/` directory. */
function examplesDir(): string {
  return fileURLToPath(new URL('../../examples/', import.meta.url))
}

/** List the shipped built-in flow names (directories with agents.js + flow.spec.js). */
export async function listBuiltins(): Promise<string[]> {
  const names: string[] = []
  let entries: { isDirectory(): boolean; name: string }[]
  try {
    entries = await readdir(examplesDir(), { withFileTypes: true }) as unknown as { isDirectory(): boolean; name: string }[]
  } catch {
    return names
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (await exists(join(examplesDir(), e.name, 'flow.spec.js'))) names.push(e.name)
  }
  return names.sort()
}

export interface LoadedFlow {
  spec: FlowSpec
  agents: Record<string, AgentConfig>
  dir: string
  name: string
  input: Record<string, unknown>
  /** External files this flow references (code modules, persona files), by content. */
  bundle: BundleFile[]
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
    dir = join(examplesDir(), ref)
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

  const input = await expandInput(opts.input, baseDir, spec.state)

  const a = validateAgents(agents)
  if (!a.ok) throw new Error(`run_workflow: invalid agents config:\n${a.errors.join('\n')}`)
  const v = validateFlowSpec(spec, agents, input, defaultReaders())
  if (!v.ok) throw new Error(`run_workflow: invalid flow spec "${spec.name}":\n${v.errors.join('\n')}`)

  // Resolve the flow bundle: persona files become inline text, code modules are
  // recorded by content so a changed module moves the spec hash (and blocks a
  // resume that would otherwise mix old and new code).
  const bundle: BundleFile[] = []
  const resolvedAgents = await resolvePersonas(agents, dir, bundle)
  await collectCodeModules(spec, dir, bundle)
  bundle.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0))

  return { spec, agents: resolvedAgents, dir, name: spec.name, input, bundle }
}

/** Hash one file's bytes and describe it relative to the flow directory. */
async function bundleEntry(flowDir: string, file: string): Promise<BundleFile> {
  const bytes = await readFile(file)
  const rel = relative(flowDir, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`run_workflow: referenced file "${file}" is outside the flow directory "${flowDir}"`)
  }
  return { file: rel.split(sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

/** Resolve `personaRef` fields to their file text, recording each file. */
async function resolvePersonas(
  agents: Record<string, AgentConfig>,
  flowDir: string,
  bundle: BundleFile[],
): Promise<Record<string, AgentConfig>> {
  const out: Record<string, AgentConfig> = {}
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.personaRef === undefined) {
      out[id] = agent
      continue
    }
    const candidates = PERSONA_EXTENSIONS.map(ext => join(flowDir, 'personas', `${agent.personaRef}${ext}`))
    let found: string | undefined
    for (const candidate of candidates) {
      if (await exists(candidate)) { found = candidate; break }
    }
    if (found === undefined) {
      throw new Error(
        `run_workflow: agent "${id}" personaRef "${agent.personaRef}" not found; tried `
        + candidates.map(c => `"${relative(flowDir, c).split(sep).join('/')}"`).join(', '),
      )
    }
    const text = await readFile(found, 'utf8')
    bundle.push(await bundleEntry(flowDir, found))
    out[id] = { ...agent, persona: text }
  }
  return out
}

/** Walk every code node (named or inline) and record its module file. */
async function collectCodeModules(spec: FlowSpec, flowDir: string, bundle: BundleFile[]): Promise<void> {
  const seen = new Set<FlowNode | string>()
  const walk = async (ref: string | FlowNode): Promise<void> => {
    if (seen.has(ref)) return
    seen.add(ref)
    const node = typeof ref === 'string' ? spec.nodes[ref] : ref
    if (node === undefined) return
    if (node.kind === 'code' && typeof node.run !== 'string') {
      const modulePath = node.run.module
      const absolute = resolve(flowDir, modulePath)
      if (!(await exists(absolute))) {
        throw new Error(`run_workflow: code node module "${modulePath}" not found at "${absolute}"`)
      }
      bundle.push(await bundleEntry(flowDir, absolute))
    }
    for (const child of childRefs(node)) await walk(child)
  }
  await walk(spec.entry)
}

/**
 * Expand `@file:<path>` input values: the file's text (txt/markdown) becomes
 * the field's value. Relative paths resolve against baseDir; absolute allowed.
 * Missing/oversized files fail loud.
 *
 * Fields the spec marks `path: true` are resolved to absolute paths against
 * baseDir (the session workspace). Member agents run with their own
 * run-isolated cwd, so a value like `./README.md` must arrive absolute or the
 * agent would look for it inside its own empty workspace.
 */
async function expandInput(input: unknown, baseDir: string, state: StateShape): Promise<Record<string, unknown>> {
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
    } else if (typeof value === 'string' && value !== '' && state[key]?.path === true && !isAbsolute(value)) {
      out[key] = resolve(baseDir, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Import one flow data module, busting the ESM cache when its content changed. */
async function importSafe(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await importFresh<Record<string, unknown>>(url)
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
