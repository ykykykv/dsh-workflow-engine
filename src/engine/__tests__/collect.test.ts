import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectOutputs } from '../collect.ts'
import type { FlowSpec } from '../../types.ts'

describe('collectOutputs', () => {
  it('copies a declared output file to outputDir/<runId> and returns the mapping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfe-collect-'))
    const src = join(root, 'demo', 'runs', 'r1', 'workspace', 'writer', 'output', 'report.md')
    mkdirSync(join(src, '..'), { recursive: true })
    writeFileSync(src, '# report')
    const outputDir = join(root, 'out')
    const spec: FlowSpec = { name: 'demo', state: {}, entry: 'main', nodes: { main: { kind: 'set', assign: { x: '1' } } }, outputs: ['{flowId}/runs/{runId}/workspace/writer/output/report.md'] }
    const mapped = await collectOutputs(spec, {}, 'demo', 'r1', root, outputDir)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.from).toBe(src)
    expect(mapped[0]!.to).toBe(join(outputDir, 'r1', 'report.md'))
    expect(existsSync(mapped[0]!.to)).toBe(true)
  })

  it('skips a missing source file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfe-collect-miss-'))
    const outputDir = join(root, 'out')
    const spec: FlowSpec = { name: 'demo', state: {}, entry: 'main', nodes: { main: { kind: 'set', assign: { x: '1' } } }, outputs: ['{flowId}/runs/{runId}/workspace/writer/output/nope.md'] }
    const mapped = await collectOutputs(spec, {}, 'demo', 'r1', root, outputDir)
    expect(mapped).toHaveLength(0)
  })
})
