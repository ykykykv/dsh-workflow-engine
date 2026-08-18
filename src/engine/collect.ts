/**
 * Output collection (option C): copy flow-declared `outputs` files to
 * `outputDir/<runId>/` after a run, so reports land in a stable, discoverable
 * place. Source paths are templates rendered against `{state, flowId, runId}`.
 * @module @deepseek-ai/dsh-workflow-engine/collect
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { FlowSpec } from '../types.ts'
import { renderTemplate } from './template.ts'
import { defaultReaders } from './readers.ts'

export interface CollectedOutput {
  from: string
  to: string
}

/** Copy each declared output file to `outputDir/<runId>/`; missing/unreadable
 * sources are skipped. Returns the copied mappings. */
export async function collectOutputs(
  spec: FlowSpec,
  state: Record<string, unknown>,
  flowId: string,
  runId: string,
  workspaceRoot: string,
  outputDir: string,
): Promise<CollectedOutput[]> {
  const out: CollectedOutput[] = []
  const env = { state, flowId, runId }
  for (const tpl of spec.outputs ?? []) {
    const rendered = renderTemplate(tpl, env, defaultReaders()).trim()
    if (rendered === '') continue
    const from = isAbsolute(rendered) ? rendered : resolve(workspaceRoot, rendered)
    const to = join(outputDir, runId, basename(from))
    await mkdir(dirname(to), { recursive: true })
    try {
      await copyFile(from, to)
    } catch {
      continue // missing/unreadable source: skip rather than fail the run
    }
    out.push({ from, to })
  }
  return out
}
