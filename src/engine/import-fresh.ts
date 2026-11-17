/**
 * Import an ESM file with a content-derived cache key.
 *
 * Node's ESM loader caches by URL for the life of the process, so a plain
 * absolute path keeps serving the first version of a file after an edit. The
 * `?v=<mtime>-<size>` suffix changes only when the file does — flows, code
 * nodes, and per-agent tool modules all go through here so "edit and re-run"
 * works without restarting dsh.
 * @module @deepseek-ai/dsh-workflow-engine/import-fresh
 */

import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Import one file, bypassing the ESM cache when its content changed. */
export async function importFresh<T = Record<string, unknown>>(file: string): Promise<T> {
  const info = await stat(file)
  const specifier = `${pathToFileURL(file).href}?v=${info.mtimeMs}-${info.size}`
  return await import(specifier) as T
}
