/**
 * Durable transcript export: one JSONL file per agent under the run directory.
 *
 * The session store already keeps the conversation; this copy exists so a run
 * remains auditable after the session record is cleaned up (or when the member
 * session is marked `hidden` and no longer shows up in the Web sidebar).
 * @module @deepseek-ai/dsh-workflow-engine/transcript
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Serialize a session as JSONL: a `session/header` line followed by every
 * event in sequence order. Lossless (each line is the event object itself).
 */
export function transcriptText(session: Session): string {
  const lines: string[] = [JSON.stringify({ type: 'session/header', header: session.header })]
  for (const event of session.snapshotEvents()) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/** Write `<dir>/<agentId>.jsonl` and return the path. */
export async function writeTranscript(dir: string, agentId: string, session: Session): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${agentId}.jsonl`)
  await writeFile(file, transcriptText(session), 'utf8')
  return file
}
