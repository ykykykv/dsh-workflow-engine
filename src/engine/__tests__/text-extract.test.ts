import { describe, expect, it } from 'vitest'
import { lastAssistantTextFromEvents } from '../text-extract.ts'

describe('lastAssistantTextFromEvents', () => {
  it('returns the newest assistant message text', () => {
    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'final' }] } },
    ]
    expect(lastAssistantTextFromEvents(events)).toBe('final')
  })
  it('joins text blocks in order', () => {
    const events = [
      { type: 'assistant/message', data: { content: [{ type: 'text', text: 'a ' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'b' }] } },
    ]
    expect(lastAssistantTextFromEvents(events)).toBe('a \nb')
  })
  it('returns empty when no assistant text exists', () => {
    expect(lastAssistantTextFromEvents([{ type: 'user/message', data: { content: [] } }])).toBe('')
    expect(lastAssistantTextFromEvents([])).toBe('')
  })
})
