/**
 * Pure orchestrator state machine: interprets a flow graph with an explicit,
 * serializable frame stack so runs can checkpoint and resume mid-flow.
 * Runtime I/O is injected through `OrchestratorHooks`.
 * @module @deepseek-ai/dsh-workflow-engine/orchestrator
 */

import type { AgentConfig, AgentNode, DecisionNode, FlowNode, FlowSpec, Frame } from '../types.ts'
import { resolveNode } from './validate.ts'
import { getPath } from './path.ts'
import { renderTemplate, type ReaderRegistry } from './template.ts'
import { evalPredicate } from './predicate.ts'

export interface AgentRunOutcome {
  ok: boolean
  store?: string
  value?: unknown
  error?: string
}

export interface OrchestratorHooks {
  runAgent(node: AgentNode | DecisionNode, taskText: string): Promise<AgentRunOutcome>
  emit(event: string, payload: Record<string, unknown> | undefined): void
  checkpoint(snapshot: { lastNodeId: string | null; stack: Frame[]; state: Record<string, unknown> }): void | Promise<void>
  onPhase(title: string): void
  isCancelled(): boolean
  now(): number
  runTimeoutMs(): number
  readers: ReaderRegistry
}

export type StepSignal =
  | { kind: 'ok' }
  | { kind: 'break' }
  | { kind: 'paused' }
  | { kind: 'cancelled' }
  | { kind: 'error'; node: string; message: string }
  | { kind: 'failed'; message: string }

export interface OrchestratorResult {
  stopReason: 'completed' | 'paused' | 'cancelled' | 'failed' | 'error'
  lastNodeId: string | null
  stack: Frame[]
  state: Record<string, unknown>
  error?: { node: string; message: string }
}

interface RunCtx {
  spec: FlowSpec
  agents: Record<string, AgentConfig>
  state: Record<string, unknown>
  hooks: OrchestratorHooks
  stack: Frame[]
  lastNodeId: string | null
  startTs: number
  item?: unknown
  loopIndex?: number
  extra: Record<string, unknown>
  envExtra: Record<string, unknown>
}

function isCompound(node: FlowNode | undefined): boolean {
  if (!node) return false
  return node.kind === 'sequence' || node.kind === 'branch' || node.kind === 'loop' || node.kind === 'map'
}

/** Coerce a rendered `set` value: exact boolean/number literals become typed
 * values so predicates like `allPass==true` behave as expected. */
function coerceScalar(rendered: string): unknown {
  if (rendered === 'true') return true
  if (rendered === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(rendered)) return Number(rendered)
  return rendered
}

export async function runOrchestrator(
  spec: FlowSpec,
  agents: Record<string, AgentConfig>,
  initialState: Record<string, unknown>,
  entry: string,
  hooks: OrchestratorHooks,
  restore?: { lastNodeId: string | null; stack: Frame[] },
  envExtra: Record<string, unknown> = {},
): Promise<OrchestratorResult> {
  const ctx: RunCtx = {
    spec,
    agents,
    state: { ...initialState },
    hooks,
    stack: restore ? restore.stack.map(f => ({ ...f })) : [{ type: 'seq', refs: [entry], index: 0, checkpoint: false }],
    lastNodeId: restore?.lastNodeId ?? null,
    startTs: hooks.now(),
    extra: {},
    envExtra,
  }

  const env = (): { state: Record<string, unknown>; item?: unknown; loopIndex?: number; [k: string]: unknown } => ({
    state: ctx.state,
    item: ctx.item,
    loopIndex: ctx.loopIndex,
    ...ctx.extra,
    ...ctx.envExtra,
  })

  const checkpoint = async (): Promise<StepSignal | null> => {
    await ctx.hooks.checkpoint({ lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state })
    if (ctx.hooks.isCancelled()) return { kind: 'cancelled' }
    const t = ctx.hooks.runTimeoutMs()
    if (t > 0 && ctx.hooks.now() - ctx.startTs > t) return { kind: 'paused' }
    return null
  }

  const renderPayload = (payload: Record<string, string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload)) out[k] = renderTemplate(v, env(), ctx.hooks.readers)
    return out
  }

  const runAgentWithRetry = async (node: AgentNode | DecisionNode): Promise<AgentRunOutcome> => {
    const taskText = renderTemplate(node.task, env(), ctx.hooks.readers)
    // onError.retry.max overrides the fixed default retries (agent 1 / decision node.retry ?? 3).
    const onErrorRetry = node.onError?.kind === 'retry' ? node.onError.max : undefined
    const defRetry = onErrorRetry ?? (node.kind === 'decision' ? (node.retry ?? 3) : 1)
    let last: AgentRunOutcome = { ok: false, error: 'unknown' }
    for (let attempt = 0; attempt <= defRetry; attempt++) {
      const outcome = await ctx.hooks.runAgent(node, taskText)
      last = outcome
      if (outcome.ok) return outcome
    }
    return last
  }

  /** Apply node/spec onError after an agent/decision call failed. */
  const handleAgentFailure = (node: AgentNode | DecisionNode, nodeId: string, outcome: AgentRunOutcome): StepSignal => {
    const p = node.onError ?? ctx.spec.onError
    if (p !== undefined && p.kind === 'continue') {
      ctx.state[outcome.store ?? p.store ?? nodeId] = { error: outcome.error ?? 'agent failed' }
      return { kind: 'ok' }
    }
    if (p !== undefined && p.kind === 'goto') {
      ctx.stack.length = 0
      ctx.stack.push({ type: 'seq', refs: [p.node], index: 0, checkpoint: false })
      return { kind: 'ok' }
    }
    return { kind: 'error', node: nodeId, message: outcome.error ?? `node ${nodeId} failed` }
  }

  const execPrimitive = async (node: FlowNode, nodeId: string): Promise<StepSignal> => {
    switch (node.kind) {
      case 'break':
        return { kind: 'break' }
      case 'fail':
        return { kind: 'failed', message: node.message }
      case 'set': {
        for (const [key, tpl] of Object.entries(node.assign)) {
          ctx.state[key] = coerceScalar(renderTemplate(tpl, env(), ctx.hooks.readers))
        }
        ctx.lastNodeId = nodeId
        return { kind: 'ok' }
      }
      case 'push': {
        const entry: Record<string, unknown> = {}
        for (const [field, tpl] of Object.entries(node.value)) {
          entry[field] = renderTemplate(tpl, env(), ctx.hooks.readers)
        }
        const existing = ctx.state[node.into]
        ctx.state[node.into] = Array.isArray(existing) ? [...existing, entry] : [entry]
        ctx.lastNodeId = nodeId
        return { kind: 'ok' }
      }
      case 'emit':
        ctx.hooks.emit(node.event, node.payload ? renderPayload(node.payload) : undefined)
        ctx.lastNodeId = nodeId
        return { kind: 'ok' }
      case 'agent': {
        const outcome = await runAgentWithRetry(node)
        ctx.lastNodeId = nodeId
        if (outcome.ok) {
          if (outcome.store !== undefined) ctx.state[outcome.store] = outcome.value
          return { kind: 'ok' }
        }
        return handleAgentFailure(node, nodeId, outcome)
      }
      case 'decision': {
        const outcome = await runAgentWithRetry(node)
        ctx.lastNodeId = nodeId
        if (!outcome.ok) return handleAgentFailure(node, nodeId, outcome)
        if (outcome.store !== undefined) ctx.state[outcome.store] = outcome.value
        // Route by the selected output field's String value (decision routing).
        const value = outcome.value as Record<string, unknown> | undefined
        const route = node.routeField !== undefined ? value?.[node.routeField] : undefined
        const key = route === undefined ? undefined : String(route)
        const target = key !== undefined && node.cases[key] !== undefined ? node.cases[key] : node.default
        if (target === undefined) {
          return { kind: 'error', node: nodeId, message: `decision: no case matches "${key ?? 'undefined'}" and no default` }
        }
        const refs: (string | FlowNode)[] = Array.isArray(target) ? target : [target]
        ctx.stack.push({ type: 'seq', refs, index: 0, checkpoint: false })
        return { kind: 'ok' }
      }
      case 'parallel': {
        const signals = await Promise.all(node.branches.map(b => execBranchList(b)))
        const err = signals.find(s => s.kind === 'error')
        if (err) return err
        if (signals.some(s => s.kind === 'break')) return { kind: 'break' }
        if (signals.some(s => s.kind === 'paused')) return { kind: 'paused' }
        if (signals.some(s => s.kind === 'cancelled')) return { kind: 'cancelled' }
        ctx.lastNodeId = nodeId
        return { kind: 'ok' }
      }
      default:
        return { kind: 'error', node: nodeId, message: `unsupported node kind "${(node as { kind: string }).kind}"` }
    }
  }

  // Run a parallel branch (a list of refs) with its own throwaway stack, but
  // sharing state. Distinct store keys are validated up front (G2).
  const execBranchList = async (refs: (string | FlowNode)[]): Promise<StepSignal> => {
    const saved = ctx.stack
    const branchCtx: RunCtx = { ...ctx, stack: [{ type: 'seq', refs, index: 0, checkpoint: false }] }
    // Use the same drive logic but over a local stack.
    const signal = await drive(ctx, branchCtx)
    ctx.stack = saved
    return signal
  }

  const drive = async (owner: RunCtx, ctx: RunCtx): Promise<StepSignal> => {
    for (;;) {
      if (ctx.stack.length === 0) return { kind: 'ok' }
      const top = ctx.stack[ctx.stack.length - 1]!
      if (top.type === 'seq') {
        if (top.index >= top.refs.length) {
          const wasCheckpoint = top.checkpoint
          ctx.stack.pop()
          if (wasCheckpoint) {
            const p = await checkpoint()
            if (p) return p
          }
          continue
        }
        const ref = top.refs[top.index]!
        top.index++
        const node = resolveNode(owner.spec, ref)
        if (!node) return { kind: 'error', node: String(ref), message: 'unknown node' }
        if (isCompound(node)) {
          if (node.kind === 'sequence') ctx.stack.push({ type: 'seq', refs: node.nodes, index: 0, checkpoint: false })
          else if (node.kind === 'branch') {
            const raw = evalPredicate(node.if, env(), ctx.hooks.readers) ? node.then : (node.else ?? [])
            const chosen: (string | FlowNode)[] = Array.isArray(raw) ? raw : [raw]
            ctx.stack.push({ type: 'seq', refs: chosen, index: 0, checkpoint: false })
          } else if (node.kind === 'loop') {
            ctx.stack.push({ type: 'loop', body: node.body, iter: 0, maxIter: node.maxIter, until: node.until })
          } else if (node.kind === 'map') {
            const items = getPath(ctx.state, node.items)
            if (!Array.isArray(items)) return { kind: 'error', node: node.items, message: 'map items is not an array' }
            ctx.stack.push({ type: 'map', items, index: 0, as: node.as, forEach: node.forEach })
          }
          continue
        }
        const sig = await execPrimitive(node, typeof ref === 'string' ? ref : 'inline')
        if (sig.kind === 'break') {
          // Pop up to and including the nearest loop frame; stop the flow if none.
          let found = false
          while (ctx.stack.length > 0) {
            const f = ctx.stack.pop()!
            if (f.type === 'loop') { found = true; break }
          }
          if (!found) return { kind: 'break' }
          continue
        }
        if (sig.kind !== 'ok') return sig
        const p = await checkpoint()
        if (p) return p
        continue
      }
      if (top.type === 'loop') {
        if (top.until !== undefined && evalPredicate(top.until, env(), ctx.hooks.readers)) { ctx.stack.pop(); continue }
        if (top.iter >= top.maxIter) { ctx.stack.pop(); continue }
        top.iter++
        ctx.loopIndex = top.iter
        ctx.hooks.onPhase(`loop#${top.iter}`)
        ctx.stack.push({ type: 'seq', refs: top.body, index: 0, checkpoint: true })
        continue
      }
      if (top.type === 'map') {
        if (top.index >= top.items.length) { ctx.stack.pop(); continue }
        const item = top.items[top.index]!
        top.index++
        ctx.item = item
        ctx.loopIndex = top.index - 1
        ctx.extra[top.as] = item
        ctx.hooks.onPhase(`map#${top.index}`)
        ctx.stack.push({ type: 'seq', refs: top.forEach, index: 0, checkpoint: true })
        continue
      }
      return { kind: 'error', node: ctx.lastNodeId ?? '?', message: 'corrupt stack' }
    }
  }

  const signal = await drive(ctx, ctx)
  switch (signal.kind) {
    case 'ok':
    case 'break':
      return { stopReason: 'completed', lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state }
    case 'paused':
      return { stopReason: 'paused', lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state }
    case 'cancelled':
      return { stopReason: 'cancelled', lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state }
    case 'failed':
      return { stopReason: 'failed', lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state, error: { node: 'fail', message: signal.message } }
    case 'error':
      return { stopReason: 'error', lastNodeId: ctx.lastNodeId, stack: ctx.stack, state: ctx.state, error: signal }
  }
}
