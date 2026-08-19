/**
 * Pure assistant-text extraction from session events (fallback when
 * `Session.deriveMessages` is unavailable). No dsh imports.
 * @module @deepseek-ai/dsh-workflow-engine/text-extract
 */

export interface TextExtractEvent {
  type: string
  data?: { content?: readonly unknown[] }
}

/** Last assistant message text from a minimal events array (newest first). */
export function lastAssistantTextFromEvents(events: readonly TextExtractEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!e || e.type !== 'assistant/message') continue
    const content = e.data?.content
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}
