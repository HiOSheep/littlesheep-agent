// Conversation-owned model choices; application Runtime remains the shared provider catalogue.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimePatch, RuntimeState } from '../api'
import { isRuntimeReasoning } from '../../shared/model-capabilities'
import { readStringPreference, writeStringPreference } from './preferences'

export type ConversationRuntimeChoice = Pick<RuntimePatch, 'model' | 'reasoning' | 'profile' | 'workspace'>
export const CONVERSATION_RUNTIME_KEY = 'littlesheep.ui.conversationRuntime.v1'

export function readConversationRuntimeChoices(): Record<string, ConversationRuntimeChoice> {
  try {
    const value: unknown = JSON.parse(readStringPreference(CONVERSATION_RUNTIME_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
      const entry = candidate as Record<string, unknown>
      const choice: ConversationRuntimeChoice = {}
      if (typeof entry.model === 'string' && entry.model.length > 0 && entry.model.length <= 256) choice.model = entry.model
      if (typeof entry.workspace === 'string' && entry.workspace.length <= 4096) choice.workspace = entry.workspace
      if (typeof entry.reasoning === 'string' && isRuntimeReasoning(entry.reasoning)) choice.reasoning = entry.reasoning
      if (entry.profile === 'general' || entry.profile === 'coding') choice.profile = entry.profile
      return [[key, choice]]
    }))
  } catch { return {} }
}

export function useConversationRuntime(options: {
  currentSession?: string; initialSessionId: string | null; defaults: RuntimeState | null
}) {
  const [initialChoices] = useState(readConversationRuntimeChoices)
  const choicesRef = useRef(initialChoices)
  const keyRef = useRef(options.initialSessionId ?? 'draft')
  const defaultsRef = useRef(options.defaults)
  defaultsRef.current = options.defaults
  const [, render] = useState(0)
  const persist = useCallback(() => {
    writeStringPreference(CONVERSATION_RUNTIME_KEY, JSON.stringify(choicesRef.current))
    render(value => value + 1)
  }, [])
  const capture = useCallback(() => {
    const defaults = defaultsRef.current
    if (!choicesRef.current[keyRef.current] && defaults) {
      choicesRef.current[keyRef.current] = { model: defaults.model, reasoning: defaults.reasoning, profile: defaults.profile }
      persist()
    }
  }, [persist])
  const activate = useCallback((sessionId?: string) => {
    keyRef.current = sessionId ?? 'draft'
    if (!sessionId) delete choicesRef.current.draft
    capture()
    render(value => value + 1)
  }, [capture])
  useEffect(() => {
    if (options.currentSession && keyRef.current !== options.currentSession) {
      if (keyRef.current === 'draft') {
        choicesRef.current[options.currentSession] ??= choicesRef.current.draft ?? {}
        delete choicesRef.current.draft
      }
      keyRef.current = options.currentSession
      persist()
    }
    capture()
  }, [options.currentSession, options.defaults, capture, persist])
  const update = useCallback((patch: ConversationRuntimeChoice) => {
    choicesRef.current[keyRef.current] = { ...choicesRef.current[keyRef.current], ...patch }
    persist()
  }, [persist])
  const runtime = options.defaults ? { ...options.defaults, ...choicesRef.current[keyRef.current] } : null
  return { runtime, activate, update }
}
