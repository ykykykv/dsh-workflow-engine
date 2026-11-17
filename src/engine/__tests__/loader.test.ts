import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFlow, listBuiltins } from '../loader.ts'
import { hashSpec } from '../checkpoint.ts'

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
  it('lists shipped built-in flows', async () => {
    const names = await listBuiltins()
    expect(names).toContain('guess-number')
    expect(names).toContain('analysis-report')
    expect(names).toContain('task-decomposition')
  })

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

  it('resolves state fields declared path: true against the session workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-paths-'))
    const dir = join(parent, 'flow')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), `export default {
      name: 'tmp-paths',
      state: {
        file: { type: 'string', path: true },
        dir: { type: 'string', path: true },
        note: { type: 'string' },
      },
      entry: 'main',
      nodes: { main: { kind: 'set', assign: { note: 'ok' } } },
    }`)
    writeFileSync(join(parent, 'README.md'), '# hi')

    const loaded = await loadFlow({
      flow: './flow',
      baseDir: parent,
      input: { file: './README.md', dir: 'examples/sub', note: './keep-me' },
    })
    expect(loaded.input['file']).toBe(join(parent, 'README.md'))
    expect(loaded.input['dir']).toBe(join(parent, 'examples', 'sub'))
    // Fields without `path: true` are passed through untouched.
    expect(loaded.input['note']).toBe('./keep-me')
  })

  it('keeps absolute path inputs and still expands @file: on path fields', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-paths2-'))
    const dir = join(parent, 'flow')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), `export default {
      name: 'tmp-paths2',
      state: { file: { type: 'string', path: true }, prompt: { type: 'string', path: true } },
      entry: 'main',
      nodes: { main: { kind: 'set', assign: { file: 'x' } } },
    }`)
    writeFileSync(join(parent, 'task.md'), 'long prompt')
    const absolute = join(parent, 'already-absolute.md')

    const loaded = await loadFlow({
      flow: './flow',
      baseDir: parent,
      input: { file: absolute, prompt: '@file:./task.md' },
    })
    expect(loaded.input['file']).toBe(absolute)
    expect(loaded.input['prompt']).toBe('long prompt')
  })

  function makeBundleFlow(): string {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-bundle-'))
    const dir = join(parent, 'flow')
    mkdirSync(join(dir, 'personas'), { recursive: true })
    mkdirSync(join(dir, 'code'), { recursive: true })
    writeFileSync(join(dir, 'personas', 'reviewer.md'), 'You are a reviewer.')
    writeFileSync(join(dir, 'code', 'step.mjs'), 'export default () => ({ value: 7 })')
    writeFileSync(join(dir, 'agents.js'), `export const agents = {
      w: { id: 'w', personaRef: 'reviewer', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, memory: 'none' },
    }`)
    writeFileSync(join(dir, 'flow.spec.js'), `export default {
      name: 'tmp-bundle',
      state: { n: { type: 'number' } },
      entry: 'main',
      nodes: { main: { kind: 'code', run: { module: './code/step.mjs' }, store: 'n' } },
    }`)
    return dir
  }

  it('resolves personaRef and records the flow bundle by content', async () => {
    const dir = makeBundleFlow()
    const loaded = await loadFlow({ flow: dir })
    expect(loaded.agents['w']?.persona).toBe('You are a reviewer.')
    expect(loaded.bundle.map(entry => entry.file).sort()).toEqual(['code/step.mjs', 'personas/reviewer.md'])
    expect(loaded.bundle.every(entry => entry.sha256.length === 64)).toBe(true)
  })

  it('changes the spec hash when a bundled code module changes', async () => {
    const dir = makeBundleFlow()
    const first = await loadFlow({ flow: dir })
    const before = hashSpec(first.spec, first.agents, first.bundle)
    writeFileSync(join(dir, 'code', 'step.mjs'), 'export default () => ({ value: 8 })')
    const second = await loadFlow({ flow: dir })
    expect(hashSpec(second.spec, second.agents, second.bundle)).not.toBe(before)
  })

  it('reports a missing personaRef file', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-persona-'))
    const dir = join(parent, 'flow')
    mkdirSync(dir)
    writeFileSync(join(dir, 'agents.js'), `export const agents = {
      w: { id: 'w', personaRef: 'ghost', model: { provider: 'p', model: 'm' }, memory: 'none' },
    }`)
    writeFileSync(join(dir, 'flow.spec.js'), `export default { name: 'tmp-persona', entry: 'main', state: {}, nodes: { main: { kind: 'set', assign: { x: '1' } } } }`)
    await expect(loadFlow({ flow: dir })).rejects.toThrow(/personaRef "ghost" not found/)
  })

  it('rejects a code module outside the flow directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wfe-escape-'))
    const dir = join(parent, 'flow')
    mkdirSync(dir)
    writeFileSync(join(parent, 'escape.mjs'), 'export default () => ({})')
    writeFileSync(join(dir, 'agents.js'), AGENTS)
    writeFileSync(join(dir, 'flow.spec.js'), `export default {
      name: 'tmp-escape',
      state: {},
      entry: 'main',
      nodes: { main: { kind: 'code', run: { module: '../escape.mjs' } } },
    }`)
    await expect(loadFlow({ flow: dir })).rejects.toThrow(/outside the flow directory/)
  })
})
