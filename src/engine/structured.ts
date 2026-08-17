/**
 * Self-implemented structured-output runtime for decision nodes (G2/#17):
 * registers a synthetic `structured_output` tool + prompt instruction on the
 * agent scope, schema-validates arguments with in-turn self-correction,
 * captures the value authoritatively on `tools/result`, and guards later calls.
 * @module @deepseek-ai/dsh-workflow-engine/structured
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, validateJsonSchemaValue, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

export interface StructuredAttachment {
  captured(): { value: unknown } | undefined
}

/**
 * Attach the scoped capture tool, instruction, and enforcement to an agent
 * during its creation window. The captured value commits only after an
 * authoritative, non-error `tools/result`.
 */
export function attachStructuredOutput(agentCtx: Context, schema: Record<string, unknown>): StructuredAttachment {
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
  let captured: { value: unknown } | undefined

  agentCtx.tools.register({
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: schema,
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Structured output recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      staged.set(exec as unknown as ToolExecution, { value: args })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  const scope = agentCtx as unknown as { systemPrompt: { section(s: { name: string; order: number; text: string }): unknown } }
  scope.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: `When you have your final answer, you MUST report it by calling the `
      + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
      + 'Do not finish with a plain text answer: only the tool call counts as your result.',
  })

  agentCtx.tools.guard(() => {
    return captured === undefined
      ? undefined
      : `structured output already recorded: the run is complete, so \`${STRUCTURED_OUTPUT_TOOL}\` is not executed`
  })

  agentCtx.on('tools/result', (exec: ToolExecution, result: { isError: boolean }) => {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec)
      if (entry === undefined) return
      staged.delete(exec)
      if (result.isError) return
      if (captured === undefined) captured = entry
    }
  })

  return { captured: () => captured }
}
