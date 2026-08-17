import { describe, expect, it } from 'vitest'
import { evalPredicate, checkPredicate } from '../predicate.ts'
import { defaultReaders } from '../readers.ts'

const readers = defaultReaders()

describe('predicate', () => {
  it('evaluates state path truthiness', () => {
    expect(evalPredicate('solved', { state: { solved: true } }, readers)).toBe(true)
    expect(evalPredicate('solved', { state: { solved: false } }, readers)).toBe(false)
  })
  it('compares paths to literals', () => {
    expect(evalPredicate('judge.verdict=="reanalyze"', { state: { judge: { verdict: 'reanalyze' } } }, readers)).toBe(true)
    expect(evalPredicate('count>=3', { state: { count: 4 } }, readers)).toBe(true)
    expect(evalPredicate('count>=3', { state: { count: 2 } }, readers)).toBe(false)
    expect(evalPredicate('name=="a"', { state: { name: 'b' } }, readers)).toBe(false)
  })
  it('supports negation and boolean logic', () => {
    expect(evalPredicate('!splitReview.ok', { state: { splitReview: { ok: false } } }, readers)).toBe(true)
    expect(evalPredicate('a==1 && b==2', { state: { a: 1, b: 2 } }, readers)).toBe(true)
    expect(evalPredicate('a==1 && b==3', { state: { a: 1, b: 2 } }, readers)).toBe(false)
    expect(evalPredicate('a==1 || b==3', { state: { a: 1, b: 2 } }, readers)).toBe(true)
  })
  it('handles missing paths as falsy', () => {
    expect(evalPredicate('missing==true', { state: {} }, readers)).toBe(false)
    expect(evalPredicate('missing', { state: {} }, readers)).toBe(false)
  })
  it('uses reader helpers', () => {
    const state = { results: [{ verdict: 'pass' }, { verdict: 'pass' }] }
    expect(evalPredicate("all(results, verdict, 'pass')", { state }, readers)).toBe(true)
    expect(evalPredicate("all(results, verdict, 'fail')", { state }, readers)).toBe(false)
  })
  it('checkPredicate reports syntax errors', () => {
    expect(checkPredicate('solved', readers)).toBe(null)
    expect(checkPredicate('solved ==', readers)).not.toBe(null)
    expect(checkPredicate('a &&', readers)).not.toBe(null)
  })
})
