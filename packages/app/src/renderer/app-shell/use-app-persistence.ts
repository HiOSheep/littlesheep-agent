// Owns app-shell persistence timing, active-session readiness, and coordinated flush events.
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { APPLICATION_PERSISTENCE_FLUSH_EVENT } from '../../shared/application-state-contracts'
import {
  ACTIVE_SESSION_KEY,
  PINNED_SESSIONS_KEY,
  removePreference,
  writeStringPreference,
  writeStringSetPreference,
} from './preferences'
import {
  APP_SHELL_STATE_WRITE_DELAY_MS,
  writePersistedAppShellState,
  type PersistedAppShellState,
} from './persistent-state'
import type { AppRoute, SidebarPanel } from './types'

interface AppPersistenceOptions {
  initialState: PersistedAppShellState
  initialActiveSessionId: string | null
  currentSession: string | undefined
  currentSessionRef: MutableRefObject<string | undefined>
  inputValueRef: MutableRefObject<string>
  input: string
  activeRoute: AppRoute
  conversationCollapsed: boolean
  sidebarPanel: SidebarPanel
  sidebarSearch: string
  pinnedSessionIds: Set<string>
}

export function useAppPersistence(options: AppPersistenceOptions): MutableRefObject<boolean> {
  const {
    initialState,
    initialActiveSessionId,
    currentSession,
    currentSessionRef,
    inputValueRef,
    input,
    activeRoute,
    conversationCollapsed,
    sidebarPanel,
    sidebarSearch,
    pinnedSessionIds,
  } = options
  const activeSessionPersistenceReadyRef = useRef(false)
  const composerSessionIdRef = useRef<string | null>(initialActiveSessionId)
  const pinnedSessionIdsRef = useRef(pinnedSessionIds)
  const persistedStateRef = useRef<PersistedAppShellState>(initialState)

  currentSessionRef.current = currentSession
  if (currentSession !== undefined) {
    composerSessionIdRef.current = currentSession
    activeSessionPersistenceReadyRef.current = true
  } else if (activeSessionPersistenceReadyRef.current) {
    composerSessionIdRef.current = null
  }
  pinnedSessionIdsRef.current = pinnedSessionIds
  persistedStateRef.current = {
    version: 1,
    route: activeRoute,
    conversationCollapsed,
    sidebarPanel,
    sidebarSearch,
    composerDraft: inputValueRef.current,
    composerSessionId: composerSessionIdRef.current,
  }

  const flushPersistentAppState = useCallback(() => {
    writePersistedAppShellState(persistedStateRef.current)
    writeStringSetPreference(PINNED_SESSIONS_KEY, pinnedSessionIdsRef.current)
    if (!activeSessionPersistenceReadyRef.current) return
    if (currentSessionRef.current) writeStringPreference(ACTIVE_SESSION_KEY, currentSessionRef.current)
    else removePreference(ACTIVE_SESSION_KEY)
  }, [currentSessionRef])

  useEffect(() => {
    const timer = window.setTimeout(flushPersistentAppState, APP_SHELL_STATE_WRITE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [activeRoute, conversationCollapsed, currentSession, flushPersistentAppState, input, sidebarPanel, sidebarSearch])

  useEffect(() => {
    const flushAllPersistentState = () => {
      flushPersistentAppState()
      window.dispatchEvent(new Event(APPLICATION_PERSISTENCE_FLUSH_EVENT))
    }
    window.addEventListener('pagehide', flushAllPersistentState)
    window.addEventListener('beforeunload', flushAllPersistentState)
    const unsubscribe = window.littlesheep?.onApplicationStateFlush?.(flushAllPersistentState)
    return () => {
      unsubscribe?.()
      window.removeEventListener('pagehide', flushAllPersistentState)
      window.removeEventListener('beforeunload', flushAllPersistentState)
    }
  }, [flushPersistentAppState])

  useEffect(() => {
    writeStringSetPreference(PINNED_SESSIONS_KEY, pinnedSessionIds)
  }, [pinnedSessionIds])

  useEffect(() => {
    if (!activeSessionPersistenceReadyRef.current) return
    if (currentSession) writeStringPreference(ACTIVE_SESSION_KEY, currentSession)
    else removePreference(ACTIVE_SESSION_KEY)
  }, [currentSession])

  return activeSessionPersistenceReadyRef
}
