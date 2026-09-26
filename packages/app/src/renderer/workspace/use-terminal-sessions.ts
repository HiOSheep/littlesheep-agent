// UX-30: owning several terminal sessions at once.
//
// The surface keeps the xterm instance and its rendering; this hook owns *which* sessions exist,
// one stream per session, and which one the keyboard belongs to. Extracting it is what makes
// "new terminal" possible without the surface growing past its line ceiling.
//
// Two rules are deliberate:
// - output is buffered per session even while it is not displayed, so switching back shows
//   what happened instead of a blank screen (`reduceTerminalSessions` bounds that buffer);
// - input goes only to the active session *and* only while it is ready, so a keystroke can
//   never reach a process that is starting, exited or failed.
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  closeWorkspaceTerminalSession,
  createWorkspaceTerminalSession,
  resizeWorkspaceTerminalSession,
  streamWorkspaceTerminalSession,
  writeWorkspaceTerminalInput,
} from '../api/terminal'
import {
  EMPTY_TERMINAL_SESSIONS,
  reduceTerminalSessions,
  terminalInputTarget,
  type TerminalSessionTab,
  type TerminalSessionsState,
} from './terminal-sessions'

export interface TerminalSessionsCallbacks {
  /** A new session's stream reported its shell/backend. */
  onStart?: (event: { sessionId: string; shell: string; backend?: 'pty' | 'spawn' }) => void
  /** Output belonging to the session that is currently displayed. */
  onActiveOutput?: (text: string, tone: 'stdout' | 'stderr') => void
  /** The displayed session changed: the surface should reset and replay this tab. */
  onActiveChange?: (tab: TerminalSessionTab | null) => void
  onError?: (sessionId: string, message: string) => void
}

export interface TerminalSessionsApi {
  state: TerminalSessionsState
  activeTab: TerminalSessionTab | null
  open: (options: { workspacePath: string; shellId?: string | null; size?: { cols: number; rows: number } }) => Promise<string | null>
  close: (id: string) => void
  select: (id: string) => void
  /** Sends input to the active session, and refuses when it must not receive any. */
  write: (data: string) => boolean
  resize: (cols: number, rows: number) => void
}

export function useTerminalSessions(callbacks: TerminalSessionsCallbacks = {}): TerminalSessionsApi {
  const [state, dispatch] = useReducer(reduceTerminalSessions, EMPTY_TERMINAL_SESSIONS)
  const streams = useRef(new Map<string, AbortController>())
  const activeIdRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeId) ?? null,
    [state.tabs, state.activeId],
  )

  // Announce a change of the displayed session, so the surface can switch its buffer.
  useEffect(() => {
    if (activeIdRef.current === state.activeId) return
    activeIdRef.current = state.activeId
    callbacksRef.current.onActiveChange?.(activeTab)
  }, [state.activeId, activeTab])

  useEffect(() => () => {
    for (const controller of streams.current.values()) controller.abort()
    streams.current.clear()
  }, [])

  const open = useCallback<TerminalSessionsApi['open']>(async ({ workspacePath, shellId, size }) => {
    let created: Awaited<ReturnType<typeof createWorkspaceTerminalSession>>
    try {
      created = await createWorkspaceTerminalSession(workspacePath, size, shellId ?? undefined)
    } catch (error) {
      dispatch({ type: 'notice', text: (error as Error).message })
      throw error
    }
    dispatch({
      type: 'open',
      tab: {
        id: created.sessionId,
        shellId: shellId ?? null,
        shellLabel: created.shell,
        cwd: created.cwd ?? workspacePath,
        status: 'starting',
      },
    })

    const controller = new AbortController()
    streams.current.set(created.sessionId, controller)
    void streamWorkspaceTerminalSession(created.sessionId, {
      signal: controller.signal,
      onStart: (event) => {
        callbacksRef.current.onStart?.({
          sessionId: created.sessionId,
          shell: event.shell,
          ...(event.backend ? { backend: event.backend } : {}),
        })
      },
      onStdout: (text) => {
        dispatch({ type: 'output', id: created.sessionId, text })
        if (activeIdRef.current === created.sessionId) {
          callbacksRef.current.onActiveOutput?.(text, 'stdout')
        }
        // Any output means the shell is reading input, which is when the tab becomes ready.
        dispatch({ type: 'status', id: created.sessionId, status: 'ready' })
      },
      onStderr: (text) => {
        dispatch({ type: 'output', id: created.sessionId, text })
        if (activeIdRef.current === created.sessionId) {
          callbacksRef.current.onActiveOutput?.(text, 'stderr')
        }
        dispatch({ type: 'status', id: created.sessionId, status: 'ready' })
      },
      onExit: (event) => {
        streams.current.delete(created.sessionId)
        dispatch({
          type: 'status',
          id: created.sessionId,
          status: 'exited',
          exitCode: event?.exitCode ?? null,
        })
      },
      onError: (message) => {
        streams.current.delete(created.sessionId)
        dispatch({ type: 'status', id: created.sessionId, status: 'failed' })
        callbacksRef.current.onError?.(created.sessionId, message)
      },
    }).catch((error: unknown) => {
      if ((error as Error).name === 'AbortError') return
      streams.current.delete(created.sessionId)
      dispatch({ type: 'status', id: created.sessionId, status: 'failed' })
      callbacksRef.current.onError?.(created.sessionId, (error as Error).message)
    })
    return created.sessionId
  }, [])

  const close = useCallback((id: string) => {
    streams.current.get(id)?.abort()
    streams.current.delete(id)
    dispatch({ type: 'close', id })
    void closeWorkspaceTerminalSession(id).catch(() => undefined)
  }, [])

  const write = useCallback((data: string) => {
    const target = terminalInputTarget(stateRef.current)
    if (!target) return false
    void writeWorkspaceTerminalInput(target, data).catch(() => undefined)
    return true
  }, [])

  const resize = useCallback((cols: number, rows: number) => {
    const id = activeIdRef.current
    if (id) void resizeWorkspaceTerminalSession(id, cols, rows).catch(() => undefined)
  }, [])

  return { state, activeTab, open, close, select: (id) => dispatch({ type: 'select', id }), write, resize }
}
