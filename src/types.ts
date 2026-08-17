/**
 * Shared types for the dsh-workflow-engine plugin: the flow spec vocabulary,
 * agent config, checkpoint, and tool-contract shapes.
 * @module @deepseek-ai/dsh-workflow-engine
 */

/** State-shape field descriptor for the top-of-spec state declaration. */
export interface StateFieldSpec {
  type: 'string' | 'number' | 'boolean' | 'json' | 'array'
  element?: StateFieldSpec
  optional?: boolean
  /** Must be provided via run_workflow `input` (flow cannot start without it). */
  required?: boolean
}

/** Declared run-state shape: validation + checkpoint serialization. */
export type StateShape = Record<string, StateFieldSpec>

/** Failure policy at spec or node level. */
export type OnErrorPolicy =
  | { kind: 'abort' }
  | { kind: 'retry'; max?: number }
  | { kind: 'continue'; store?: string }
  | { kind: 'goto'; node: string }

/** A JSON-Schema node used for decision output. */
export type JsonSchema = Record<string, unknown>

/** Agent node: call one agent with a templated task. */
export interface AgentNode {
  kind: 'agent'
  agent: string
  task: string
  outputSchema?: JsonSchema
  store?: string
  timeoutMs?: number
  context?: string
  onError?: OnErrorPolicy
}

/** Decision node: a routing agent whose schema-validated output selects a case. */
export interface DecisionNode {
  kind: 'decision'
  agent: string
  task: string
  outputSchema: JsonSchema
  store: string
  cases: Record<string, string | string[]>
  default?: string | string[]
  timeoutMs?: number
  retry?: number
  onError?: OnErrorPolicy
}

/** Deterministic predicate branch. */
export interface BranchNode {
  kind: 'branch'
  if: string
  then: string | string[]
  else?: string | string[]
}

export interface SequenceNode {
  kind: 'sequence'
  nodes: (string | FlowNode)[]
}

export interface ParallelNode {
  kind: 'parallel'
  branches: (string | FlowNode)[][]
}

export interface MapNode {
  kind: 'map'
  items: string
  as: string
  forEach: (string | FlowNode)[]
  into?: string
}

export interface LoopNode {
  kind: 'loop'
  body: (string | FlowNode)[]
  until?: string
  maxIter: number
}

export interface SetNode {
  kind: 'set'
  assign: Record<string, string>
}

/** Append a structured object to an array state key (accumulation). */
export interface PushNode {
  kind: 'push'
  into: string
  value: Record<string, string>
}

export interface EmitNode {
  kind: 'emit'
  event: string
  payload?: Record<string, string>
}

export interface BreakNode {
  kind: 'break'
}

export type FlowNode =
  | AgentNode
  | DecisionNode
  | BranchNode
  | SequenceNode
  | ParallelNode
  | MapNode
  | LoopNode
  | SetNode
  | PushNode
  | EmitNode
  | BreakNode

/** One declarative workflow. */
export interface FlowSpec {
  name: string
  description?: string
  state: StateShape
  defaults?: { timeoutMs?: number; runTimeoutMs?: number }
  onError?: OnErrorPolicy
  entry: string
  nodes: Record<string, FlowNode>
}

/** One agent's configuration (single source of truth for runtime + materialization). */
export interface AgentConfig {
  id: string
  persona: string
  tools?: string[]
  promptSections?: { name: string; order: number; text: string }[]
  model: { provider: string; model: string }
  memory: 'session' | 'none'
  maxTokens?: number
  presetId?: string
}

export type AgentsConfig = Record<string, AgentConfig>

/** Engine config from cordis.patch.yml. */
export interface EngineConfig {
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  runTimeoutMs?: number
  defaultExample?: string
  maxResultChars?: number
}

/** Execution stack frame (serializable for checkpoint/resume). */
export type Frame =
  | { type: 'seq'; refs: (string | FlowNode)[]; index: number; checkpoint: boolean }
  | { type: 'loop'; body: (string | FlowNode)[]; iter: number; maxIter: number; until?: string }
  | { type: 'map'; items: unknown[]; index: number; as: string; forEach: (string | FlowNode)[] }

/** Checkpoint payload persisted after each node / loop round. */
export interface Checkpoint {
  flowId: string
  runId: string
  specHash: string
  state: Record<string, unknown>
  lastNodeId: string | null
  stack: Frame[]
  agentSessions: Record<string, string>
}

/** Terminal outcome of one run. */
export type StopReason = 'completed' | 'paused' | 'cancelled' | 'failed' | 'error'

/** run_workflow tool result. */
export interface RunWorkflowResult {
  stopReason: StopReason
  runId: string
  result?: unknown
  error?: { node: string; message: string; checkpointPath: string }
}

/** Environment for template/predicate evaluation. */
export interface EvalEnv {
  state: Record<string, unknown>
  item?: unknown
  loopIndex?: number
  [key: string]: unknown
}
