import { useEffect, useState } from 'react'

export type ConversationDisplayMode = 'normal' | 'compact'

export const CONVERSATION_DISPLAY_MODE_KEY = 'littlesheep.ui.conversationDisplayMode'
export const CONVERSATION_DISPLAY_MODE_EVENT = 'littlesheep:conversation-display-mode'

export function readConversationDisplayMode(): ConversationDisplayMode {
  if (typeof window === 'undefined') return 'normal'
  try {
    return window.localStorage.getItem(CONVERSATION_DISPLAY_MODE_KEY) === 'compact' ? 'compact' : 'normal'
  } catch {
    return 'normal'
  }
}

export function writeConversationDisplayMode(mode: ConversationDisplayMode): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(CONVERSATION_DISPLAY_MODE_KEY, mode) } catch { /* best effort */ }
  window.dispatchEvent(new CustomEvent(CONVERSATION_DISPLAY_MODE_EVENT, { detail: mode }))
}

export function useConversationDisplayMode(): ConversationDisplayMode {
  const [mode, setMode] = useState<ConversationDisplayMode>(readConversationDisplayMode)
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<ConversationDisplayMode>).detail
      setMode(detail === 'compact' ? 'compact' : readConversationDisplayMode())
    }
    window.addEventListener(CONVERSATION_DISPLAY_MODE_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(CONVERSATION_DISPLAY_MODE_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  return mode
}
