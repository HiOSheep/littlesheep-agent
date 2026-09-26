// UX-30: owning several terminal sessions at once.
//
// The surface keeps the xterm instance and its rendering; this hook owns *which* sessions exist,
// the single live stream, and which one the keyboard belongs to. Extracting it is what makes
// "new terminal" possible without the surface growing past its line ceiling.
//
// Three rules are deliberate:
// - exactly ONE session is streamed at a time, the displayed one. Six sessions used to hold six
//   open SSE responses, which is the whole HTTP/1.1 connection budget of one origin: every later
//   request (create, input, resize, the file listing) then queued behind them for ever, so the
//   8-session cap was unreachable and the panel froze instead of refusing (UX-37);
// - output is buffered per session even while it is not displayed, so switching back shows what
//   happened instead of a blank screen. Main replays its own bounded history when a stream
//   attaches, and `reduceTerminalSessions` bounds what the renderer keeps;
// - input goes only to the active session *and* only while it is ready, so a keystroke can never
//   reach a process that is starting, exited or failed.
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
  MAX_TERMINAL_TABS,
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
  /** Ends every session; nothing may be left running for a workspace that is gone. */
  closeAll: () => void
  close: (id: string) => void
  select: (id: string) => void
  /** Sends input to the active session, and refuses when it must not receive any. */
  write: (data: string) => boolean
  resize: (cols: number, rows: number) => void
}

export function useTerminalSessions(callbacks: TerminalSessionsCallbacks = {}): TerminalSessionsApi {
  const [state, dispatch] = useReducer(reduceTerminalSessions, EMPTY_TERMINAL_SESSIONS)
  /** The one session whose output is being read, and the abort handle for that read. */
  const streamRef = useRef<{ id: string; controller: AbortController } | null>(null)
  const ownedIds = useRef(new Set<string>())
  const activeIdRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  const openingRef = useRef(0)
  const lifecycleRef = useRef(0)
  stateRef.current = state
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeId) ?? null,
    [state.tabs, state.activeId],
  )

  const stopStream = useCallback(() => {
    streamRef.current?.controller.abort()
    streamRef.current = null
  }, [])

  /**
   * Reads the given session, and only that one. Main answers with its bounded history first, so
   * the renderer drops what it had for that tab and rebuilds it from the replay.
   */
  const attach = useCallback((id: string) => {
    if (streamRef.current?.id === id) return
    stopStream()
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.status === 'exited' || tab.status === 'failed') return
    const controller = new AbortController()
    streamRef.current = { id, controller }
    dispatch({ type: 'attached', id })
    void streamWorkspaceTerminalSession(id, {
      signal: controller.signal,
      onStart: (event) => {
        if (event.backend) dispatch({ type: 'backend', id, backend: event.backend })
        if (activeIdRef.current !== id) return
        callbacksRef.current.onStart?.({
          sessionId: id,
          shell: event.shell,
          ...(event.backend ? { backend: event.backend } : {}),
        })
      },
      onStdout: (text) => {
        dispatch({ type: 'output', id, text })
        if (activeIdRef.current === id) callbacksRef.current.onActiveOutput?.(text, 'stdout')
        // Any output means the shell is reading input, which is when the tab becomes ready.
        dispatch({ type: 'status', id, status: 'ready' })
      },
      onStderr: (text) => {
        dispatch({ type: 'output', id, text })
        if (activeIdRef.current === id) callbacksRef.current.onActiveOutput?.(text, 'stderr')
        dispatch({ type: 'status', id, status: 'ready' })
      },
      onExit: (event) => {
        if (streamRef.current?.id === id) streamRef.current = null
        dispatch({ type: 'status', id, status: 'exited', exitCode: event?.exitCode ?? null })
      },
      onError: (message) => {
        if (streamRef.current?.id === id) streamRef.current = null
        dispatch({ type: 'status', id, status: 'failed' })
        callbacksRef.current.onError?.(id, message)
      },
    }).catch((error: unknown) => {
      if ((error as Error).name === 'AbortError') return
      if (streamRef.current?.id === id) streamRef.current = null
      dispatch({ type: 'status', id, status: 'failed' })
      callbacksRef.current.onError?.(id, (error as Error).message)
    })
  }, [stopStream])

  // Announce a change of the displayed session, so the surface can switch its buffer, and follow
  // it with the stream: the displayed session is the one whose output is read.
  useEffect(() => {
    const changed = activeIdRef.current !== state.activeId
    activeIdRef.current = state.activeId
    if (changed) callbacksRef.current.onActiveChange?.(activeTab)
    if (state.activeId) attach(state.activeId)
  }, [state.activeId, activeTab, attach])

  useEffect(() => () => {
    lifecycleRef.current += 1
    stopStream()
    for (const id of ownedIds.current) void closeWorkspaceTerminalSession(id).catch(() => undefined)
    ownedIds.current.clear()
  }, [stopStream])

  /** Closes every session: used when the workspace or conversation changes underneath them. */
  const closeAll = useCallback(() => {
    lifecycleRef.current += 1
    stopStream()
    for (const id of ownedIds.current) void closeWorkspaceTerminalSession(id).catch(() => undefined)
    ownedIds.current.clear()
    dispatch({ type: 'reset' })
  }, [stopStream])

  const open = useCallback<TerminalSessionsApi['open']>(async ({ workspacePath, shellId, size }) => {
    if (ownedIds.current.size + openingRef.current >= MAX_TERMINAL_TABS) {
      dispatch({ type: 'notice', text: `最多同时打开 ${MAX_TERMINAL_TABS} 个终端；请先关闭一个再新建。` })
      return null
    }
    openingRef.current += 1
    const lifecycle = lifecycleRef.current
    let created: Awaited<ReturnType<typeof createWorkspaceTerminalSession>>
    try {
      created = await createWorkspaceTerminalSession(workspacePath, size, shellId ?? undefined)
    } catch (error) {
      dispatch({ type: 'notice', text: (error as Error).message })
      throw error
    } finally {
      openingRef.current -= 1
    }
    if (lifecycle !== lifecycleRef.current) {
      // The workspace or conversation changed while this session was being created: it belongs
      // to something the user has left, so it is closed instead of being shown (UX-30).
      void closeWorkspaceTerminalSession(created.sessionId).catch(() => undefined)
      return null
    }
    ownedIds.current.add(created.sessionId)
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
    return created.sessionId
  }, [])

  const close = useCallback((id: string) => {
    ownedIds.current.delete(id)
    if (streamRef.current?.id === id) stopStream()
    dispatch({ type: 'close', id })
    void closeWorkspaceTerminalSession(id).catch(() => undefined)
  }, [stopStream])

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

  return { state, activeTab, open, close, closeAll, select: (id) => dispatch({ type: 'select', id }), write, resize }
}
