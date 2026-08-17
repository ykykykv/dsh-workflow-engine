/**
 * Monitoring: appends `tool-workflow/*` session events (matching the payload
 * shapes `ui-workflow-run` consumes) so run / phase / member status shows in
 * the built-in workflow UI, plus phase progress.
 * @module @deepseek-ai/dsh-workflow-engine/monitor
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'

export interface ToolWorkflowRunStartData { readonly runId: string; readonly name: string }
export interface ToolWorkflowAgentStartData {
  readonly runId: string; readonly seq: number; readonly label: string; readonly phase?: string; readonly childId: SessionId
}
export interface ToolWorkflowAgentEndData { readonly runId: string; readonly seq: number; readonly outcome: string }
export interface ToolWorkflowRunEndData { readonly runId: string; readonly stopReason: string }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool-workflow/run-start': ToolWorkflowRunStartData
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}

export interface WorkflowMonitor {
  runStart(name: string): void
  agentStart(seq: number, label: string, phase: string | undefined, childId: SessionId): void
  agentEnd(seq: number, outcome: string): void
  runEnd(stopReason: string): void
}

/** Build a monitor over a parent session; failures degrade to a no-op log. */
export function createMonitor(session: Session, runId: string): WorkflowMonitor {
  const append = (type: string, data: Record<string, unknown>): void => {
    try {
      ;(session as unknown as { append(t: string, d: Record<string, unknown>): void }).append(type, data)
    } catch (error) {
      console.warn(`[workflow-engine] monitor append ${type} failed: ${String(error)}`)
    }
  }
  return {
    runStart(name) { append('tool-workflow/run-start', { runId, name }) },
    agentStart(seq, label, phase, childId) {
      append('tool-workflow/agent-start', phase === undefined ? { runId, seq, label, childId } : { runId, seq, label, phase, childId })
    },
    agentEnd(seq, outcome) { append('tool-workflow/agent-end', { runId, seq, outcome }) },
    runEnd(stopReason) { append('tool-workflow/run-end', { runId, stopReason }) },
  }
}
