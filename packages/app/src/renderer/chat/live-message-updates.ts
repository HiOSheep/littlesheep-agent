// Identity and in-place text updates for live (not yet durable) conversation messages.
//
// Extracted from `run-actions.ts` (2026-09-28): that module is a registered composition hotspot
// (`docs/reference/module-split-map.md`), and the failed turn's retry action had to fit inside its
// frozen ceiling. Both helpers are pure and own nothing but the shapes they touch — the id a
// streamed message carries until the durable one replaces it, and the last assistant message's
// text while deltas arrive.
import type { ChatMessage } from './types'


export function localMessageId(role: 'user' | 'assistant'): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `live-${role}-${uuid}`
}


export function updateLastAssistantText(
  messages: ChatMessage[],
  update: (text: string) => string,
): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return messages
  const next = [...messages]
  next[next.length - 1] = { ...last, text: update(last.text) }
  return next
}
