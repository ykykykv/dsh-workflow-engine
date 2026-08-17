import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFlow } from '../loader.ts'

const AGENTS = `export const agents = {
  worker: { id: 'worker', persona: 'p', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'none' },
}`
const SPEC = `export default { name: 'tmp-flow', state: { subject: { type: 'string', required: true } }, entry: 'main', nodes: { main: { kind: 'agent', agent: 'worker', task: 'analyze {state.subject}', store: 'out' } } }`

function makeFlow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wfe-loader-'))
  writeFileSync(join(dir, 'agents.js'), AGENTS)
  writeFileSync(join(dir, 'flow.spec.js'), SPEC)
  return dir
}

describe('loader', () => {
  it('loads a flow by absolute path', async () => {
    const dir = makeFlow()
    const loaded = await loadFlow({ flow: dir, input: { subject: 'x' } })
    expect(loaded.name).toBe('tmp-flow')
  })

  it('loads a flow by relative path against baseDir', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-base-'))
    const dir = join(parent, 'game')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), SPEC)
    const loaded = await loadFlow({ flow: './game', baseDir: parent, input: { subject: 'x' } })
    expect(loaded.name).toBe('tmp-flow')
  })

  it('reports a missing flow directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-missing-'))
    await expect(loadFlow({ flow: './nope', baseDir: parent })).rejects.toThrow(/flow not found/)
  })

  it('reports a flow directory missing flow.spec.js', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-nospec-'))
    const dir = join(parent, 'game')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    await expect(loadFlow({ flow: './game', baseDir: parent })).rejects.toThrow(/missing flow.spec.js/)
  })

  it('expands @file: input from a relative path', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-file-'))
    const dir = join(parent, 'game')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), SPEC)
    writeFileSync(join(parent, 'task.md'), '# Long prompt\nline two')
    const loaded = await loadFlow({ flow: './game', baseDir: parent, input: { subject: '@file:./task.md' } })
    expect(loaded.input['subject']).toBe('# Long prompt\nline two')
  })

  it('fails loudly when an @file: target is missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-filemiss-'))
    const dir = join(parent, 'game')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), SPEC)
    await expect(loadFlow({ flow: './game', baseDir: parent, input: { subject: '@file:./missing.md' } })).rejects.toThrow(/file not found/)
  })

  it('requires declared required inputs', async () => {
    const dir = makeFlow()
    await expect(loadFlow({ flow: dir, input: {} })).rejects.toThrow(/required/)
  })
})
