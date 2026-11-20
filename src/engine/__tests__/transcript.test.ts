import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { transcriptText, writeTranscript } from '../transcript.ts'

function fakeSession(): Session {
  return {
    header: {
      sessionId: 's1', cwd: 'C:/run/workspace', createdAt: '2026-01-01T00:00:00.000Z',
      formatVersion: 4, origin: 'subagent',
    },
    snapshotEvents: () => [
      { seq: 1, type: 'user/message', time: 1, data: { text: 'hi' } },
      { seq: 2, type: 'assistant/message', time: 2, data: { text: 'yo' } },
    ],
  } as unknown as Session
}

describe('transcript export', () => {
  it('serializes the header then every event, one JSON per line', () => {
    const lines = transcriptText(fakeSession()).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'session/header', header: expect.objectContaining({ origin: 'subagent' }) })
    expect(JSON.parse(lines[1]!)).toEqual(expect.objectContaining({ seq: 1, type: 'user/message' }))
    expect(JSON.parse(lines[2]!)).toEqual(expect.objectContaining({ seq: 2 }))
  })

  it('writes <dir>/<agentId>.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfe-transcript-'))
    const file = await writeTranscript(join(dir, 'agents'), 'worker', fakeSession())
    expect(file).toBe(join(dir, 'agents', 'worker.jsonl'))
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  })
})
