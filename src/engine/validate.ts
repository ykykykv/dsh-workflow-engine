/**
 * Pure validator for a loaded flow spec + agents + tool input.
 * Fails loud before any agent starts (G2/G4/G7).
 * @module @deepseek-ai/dsh-workflow-engine/validate
 */

import type { AgentConfig, FlowNode, FlowSpec, StateFieldSpec } from '../types.ts'
import { checkTemplate } from './template.ts'
import { checkPredicate } from './predicate.ts'
import type { ReaderRegistry } from './template.ts'

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const STATE_TYPES = ['string', 'number', 'boolean', 'json', 'array']

export function asRefList(ref: string | string[]): (string | FlowNode)[] {
  return Array.isArray(ref) ? ref : [ref]
}

function nodeRefs(n: FlowNode): (string | FlowNode)[] {
  switch (n.kind) {
    case 'sequence': return n.nodes
    case 'branch': return [...asRefList(n.then), ...(n.else === undefined ? [] : asRefList(n.else))]
    case 'parallel': return n.branches.flat()
    case 'map': return n.forEach
    case 'loop': return n.body
    default: return []
  }
}

export function resolveNode(spec: FlowSpec, ref: string | FlowNode): FlowNode | undefined {
  if (typeof ref === 'string') return spec.nodes[ref]
  return ref
}

/** Collect every agent id referenced by a node sub-tree (recursively). */
export function collectAgentIds(spec: FlowSpec, refs: (string | FlowNode)[]): string[] {
  const out: string[] = []
  const visit = (ref: string | FlowNode): void => {
    const node = resolveNode(spec, ref)
    if (!node) return
    if (node.kind === 'agent' || node.kind === 'decision') out.push(node.agent)
    for (const r of nodeRefs(node)) visit(r)
  }
  for (const r of refs) visit(r)
  return out
}

function validateStateField(key: string, f: StateFieldSpec, errors: string[]): void {
  if (!STATE_TYPES.includes(f.type)) {
    errors.push(`state.${key}: unknown type "${f.type}"`)
    return
  }
  if (f.type === 'array') {
    if (f.element === undefined || typeof f.element !== 'object') {
      errors.push(`state.${key}: array requires an element spec`)
    } else validateStateField(key, f.element, errors)
  }
}

function validateInputAgainstShape(input: unknown, shape: Record<string, StateFieldSpec>, errors: string[]): void {
  if (input === undefined || input === null) {
    const missing = Object.entries(shape).filter(([, f]) => f.required).map(([k]) => k)
    if (missing.length > 0) errors.push(`input: missing required state field(s): ${missing.join(', ')}`)
    return
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    errors.push('input: expected an object matching the state shape')
    return
  }
  const obj = input as Record<string, unknown>
  for (const [key, f] of Object.entries(shape)) {
    const v = obj[key]
    if (v === undefined) {
      if (f.required) errors.push(`input: missing required state field "${key}"`)
      continue
    }
    switch (f.type) {
      case 'string': if (typeof v !== 'string') errors.push(`input.${key}: expected string`); break
      case 'number': if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`input.${key}: expected number`); break
      case 'boolean': if (typeof v !== 'boolean') errors.push(`input.${key}: expected boolean`); break
      case 'array': if (!Array.isArray(v)) errors.push(`input.${key}: expected array`); break
      case 'json': break
    }
  }
}

/** Validate a full flow + agents (+ optional input). */
export function validateFlowSpec(
  spec: FlowSpec,
  agents: Record<string, AgentConfig>,
  input: unknown,
  readers: ReaderRegistry,
): ValidationResult {
  const errors: string[] = []
  if (spec === null || typeof spec !== 'object') return { ok: false, errors: ['spec: expected an object'] }
  if (typeof spec.name !== 'string' || spec.name === '') errors.push('spec: missing name')
  if (typeof spec.entry !== 'string' || spec.entry === '') errors.push('spec: missing entry')

  // state shape
  if (spec.state === null || typeof spec.state !== 'object') {
    errors.push('spec: state must be an object')
  } else {
    for (const [k, f] of Object.entries(spec.state)) validateStateField(k, f, errors)
    validateInputAgainstShape(input, spec.state, errors)
  }

  if (spec.nodes === null || typeof spec.nodes !== 'object') {
    errors.push('spec: nodes must be an object')
    return { ok: false, errors }
  }

  // entry exists
  if (typeof spec.entry === 'string' && spec.nodes[spec.entry] === undefined) {
    errors.push(`spec: entry node "${spec.entry}" not found`)
  }

  const knownIds = new Set(Object.keys(spec.nodes))
  const agentIds = new Set(Object.keys(agents))
  const sessionAgents = new Set(Object.keys(agents).filter(id => agents[id]?.memory === 'session'))

  // onError grammar + goto target
  if (spec.onError !== undefined) validateOnError(spec.onError, errors)

  const validateNode = (id: string, node: FlowNode): void => {
    switch (node.kind) {
      case 'agent':
        if (!agentIds.has(node.agent)) errors.push(`node ${id}: unknown agent "${node.agent}"`)
        checkTpl(node.task, readers, `node ${id}.task`)
        break
      case 'decision':
        if (!agentIds.has(node.agent)) errors.push(`node ${id}: unknown agent "${node.agent}"`)
        checkTpl(node.task, readers, `node ${id}.task`)
        for (const caseRef of Object.values(node.cases)) for (const r of asRefList(caseRef)) checkRefs(id, r)
        if (node.default !== undefined) for (const r of asRefList(node.default)) checkRefs(id, r)
        break
      case 'branch':
        checkPred(node.if, readers, `node ${id}.if`)
        for (const r of asRefList(node.then)) checkRefs(id, r)
        if (node.else !== undefined) for (const r of asRefList(node.else)) checkRefs(id, r)
        break
      case 'sequence':
        for (const r of node.nodes) checkRefs(id, r)
        break
      case 'parallel':
        for (const branch of node.branches) for (const r of branch) checkRefs(id, r)
        break
      case 'map':
        for (const r of node.forEach) checkRefs(id, r)
        break
      case 'loop':
        if (!Number.isInteger(node.maxIter) || node.maxIter < 1) {
          errors.push(`node ${id}: loop requires a positive integer maxIter`)
        }
        if (node.until !== undefined) checkPred(node.until, readers, `node ${id}.until`)
        for (const r of node.body) checkRefs(id, r)
        break
      case 'set':
        for (const v of Object.values(node.assign)) checkTpl(v, readers, `node ${id}.assign`)
        break
      case 'push':
        for (const v of Object.values(node.value)) checkTpl(v, readers, `node ${id}.value`)
        break
      case 'emit': break
      case 'break': break
      case 'fail':
        if (typeof node.message !== 'string' || node.message === '') errors.push(`node ${id}: fail requires a message`)
        break
      default:
        errors.push(`node ${id}: unknown node kind`)
    }
  }

  const checkRefs = (from: string, ref: string | FlowNode): void => {
    if (typeof ref === 'string' && !knownIds.has(ref)) {
      errors.push(`node ${from}: references unknown node "${ref}"`)
    }
  }

  const checkTpl = (tpl: string, r: ReaderRegistry, where: string): void => {
    const err = checkTemplate(tpl, r)
    if (err !== null) errors.push(`${where}: ${err}`)
  }

  const checkPred = (expr: string, r: ReaderRegistry, where: string): void => {
    const err = checkPredicate(expr, r)
    if (err !== null) errors.push(`${where}: ${err}`)
  }

  function validateOnError(p: NonNullable<FlowSpec['onError']>, errs: string[]): void {
    if (p.kind === 'retry' && p.max !== undefined && (!Number.isInteger(p.max) || p.max < 0)) {
      errs.push('onError.retry: max must be a non-negative integer')
    }
    if (p.kind === 'goto' && !knownIds.has(p.node)) {
      errs.push(`onError.goto: unknown node "${p.node}"`)
    }
  }

  for (const [id, node] of Object.entries(spec.nodes)) validateNode(id, node)

  // Parallel same-session-agent conflict (G2): a parallel must not reuse a
  // `memory: session` agent across more than one branch.
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.kind !== 'parallel') continue
    const seen = new Set<string>()
    for (const branch of node.branches) {
      const ids = new Set(collectAgentIds(spec, branch).filter(a => sessionAgents.has(a)))
      for (const a of ids) {
        if (seen.has(a)) errors.push(`node ${id}: parallel reuses session-mode agent "${a}" across branches`)
        seen.add(a)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/** Validate the agents config itself. */
export function validateAgents(agents: Record<string, AgentConfig>): ValidationResult {
  const errors: string[] = []
  for (const [id, a] of Object.entries(agents)) {
    if (a === null || typeof a !== 'object') { errors.push(`agent ${id}: expected an object`); continue }
    if (typeof a.persona !== 'string') errors.push(`agent ${id}: persona must be a string`)
    if (!a.model || typeof a.model !== 'object' || typeof a.model.provider !== 'string' || typeof a.model.model !== 'string') {
      errors.push(`agent ${id}: model.provider/model required`)
    }
    if (a.memory !== 'session' && a.memory !== 'none') errors.push(`agent ${id}: memory must be 'session' or 'none'`)
  }
  return { ok: errors.length === 0, errors }
}
