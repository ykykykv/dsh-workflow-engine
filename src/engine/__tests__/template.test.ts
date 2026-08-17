import { describe, expect, it } from 'vitest'
import { renderTemplate, checkTemplate, splitArgs } from '../template.ts'
import type { ReaderRegistry } from '../template.ts'

const readers: ReaderRegistry = {
  up: (_env, args) => String(resolveArg(args[0]) ?? '').toUpperCase(),
}
function resolveArg(arg: string): unknown { return arg }

describe('template', () => {
  it('renders state and item paths', () => {
    const env = { state: { a: { b: 1 }, s: 'x' }, item: { id: 7 } }
    expect(renderTemplate('{state.s} {state.a.b} {item.id}', env, readers)).toBe('x 1 7')
  })
  it('renders loopIndex', () => {
    expect(renderTemplate('i={loopIndex}', { state: {}, loopIndex: 3 }, readers)).toBe('i=3')
  })
  it('tolerates missing paths and optional segments', () => {
    const env = { state: { a: {} } }
    expect(renderTemplate('[{state.nope}]', env, readers)).toBe('[]')
    expect(renderTemplate('[{state.a.b}]', env, readers)).toBe('[]')
  })
  it('supports ?? fallback', () => {
    const env = { state: { a: 'x' } }
    expect(renderTemplate('{state.nope ?? none}', env, readers)).toBe('none')
    expect(renderTemplate('{state.a ?? none}', env, readers)).toBe('x')
  })
  it('escapes literal braces', () => {
    expect(renderTemplate('\\{literal\\}', { state: {} }, readers)).toBe('{literal}')
  })
  it('calls readers with raw args', () => {
    expect(renderTemplate('{up(hello)}', { state: {} }, readers)).toBe('HELLO')
  })
  it('serializes non-string values', () => {
    expect(renderTemplate('{state.arr}', { state: { arr: [1, 2] } }, readers)).toBe('[1,2]')
  })
  it('checkTemplate flags unbalanced and unknown shapes', () => {
    expect(checkTemplate('{state.x}', readers)).toBe(null)
    expect(checkTemplate('{state.x', readers)).not.toBe(null)
    expect(checkTemplate('{1abc}', readers)).not.toBe(null)
  })
  it('splitArgs honors quotes', () => {
    expect(splitArgs('a, "b,c", d')).toEqual(['a', '"b,c"', 'd'])
  })
})
