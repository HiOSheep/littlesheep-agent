// Extension workspace panels, files, terminal, artifacts, and view helpers.
import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useReducer, useRef, useState } from 'react'
import { useTerminalShellSelection } from './use-terminal-shell-selection'
import { WorkspaceTerminalShellPicker } from './terminal-shell-picker'
import { WorkspaceTerminalToolbar } from './terminal-toolbar'
import {
  EMPTY_TERMINAL_SESSIONS,
  reduceTerminalSessions,
  terminalInputTarget,
} from './terminal-sessions'
import {
  WorkspaceTerminalActivityList,
} from './terminal-activity'
export {
  formatDurationMs,
  terminalActivityStatus,
  terminalActivityTip,
} from './terminal-activity'
import {
  closeWorkspaceTerminalSession,
  createWorkspaceTerminalSession,
  interruptWorkspaceTerminalSession,
  listWorkspaceTerminalActivity,
  resizeWorkspaceTerminalSession,
  streamWorkspaceTerminalSession,
  type TerminalActivityRecord
} from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { transientTriggerProps } from '../ui/transient'
import {
  LITTLE_SHEEP_SELECTION_BACKGROUND,
  LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE,
  LITTLE_SHEEP_SELECTION_FOREGROUND,
} from '../selection-style'
import { compactPath } from './path-utils'
import { createTerminalFitScheduler } from './terminal-fit'
import {
  COLUMN_RESIZE_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'
import { createTerminalInputController, type TerminalInputController } from './terminal-input-controller'

const TERMINAL_FONT_FAMILY = '"SimSun", "宋体", monospace'
const TERMINAL_FONT_SIZE = 12
const TERMINAL_LINE_HEIGHT = 1.34

export function WorkspaceTerminal({
  workspacePath,
  sessionId,
  active = true,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
  active?: boolean
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const terminalSessionRef = useRef<string>('')
  const terminalBackendRef = useRef<'pty' | 'spawn'>('spawn')
  const terminalSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('启动中')
  const [terminalBackend, setTerminalBackend] = useState<'pty' | 'spawn' | ''>('')
  const [activities, setActivities] = useState<TerminalActivityRecord[]>([])
  const [activityError, setActivityError] = useState('')
  // UX-29: the shells Main discovered, the saved preference, and what the running session
  // actually is. The picker chooses; Main validates the id and decides executable and args.
  const shellSelection = useTerminalShellSelection()
  const [runningShell, setRunningShell] = useState('')
  // The tab model owns which sessions exist and what state each one is in (UX-30); the strip
  // only appears once there is more than one, so a single terminal looks exactly as before.
  const [sessionTabs, dispatchSessionTabs] = useReducer(reduceTerminalSessions, EMPTY_TERMINAL_SESSIONS)
  const activityRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const inputControllerRef = useRef<TerminalInputController | null>(null)
  const activeRef = useRef(active)
  const sessionTabsRef = useRef(sessionTabs)
  const terminalInputEnabledRef = useRef(false)
  activeRef.current = active
  sessionTabsRef.current = sessionTabs

  useEffect(() => {
    void refreshTerminalActivities()
  }, [workspacePath, sessionId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activityRequestRef.current += 1
      inputControllerRef.current?.dispose()
      inputControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let terminal: XTermTerminal | null = null
    let resizeObserver: ResizeObserver | null = null
    let fitScheduler: ReturnType<typeof createTerminalFitScheduler> | null = null
    let displayCleanup: (() => void) | null = null
    let inputDisposable: { dispose: () => void } | null = null
    const inputController = createTerminalInputController({
      getTerminalSessionId: () => terminalSessionRef.current,
      getAppSessionId: () => sessionId,
      isDisposed: () => disposed || !mountedRef.current,
      writeLine: writeTerminalNotice,
      setStatus,
      onCompletedCommand: () => void refreshTerminalActivities(),
    })
    inputControllerRef.current = inputController

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return
        terminal = new Terminal({
          cols: 80,
          rows: 24,
          // PTY output already carries the shell's cursor and line-ending
          // semantics. Rewriting LF here can move the xterm cursor away from
          // the prompt that ConPTY is tracking.
          convertEol: false,
          cursorBlink: true,
          disableStdin: true,
          scrollOnUserInput: true,
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: TERMINAL_FONT_SIZE,
          lineHeight: TERMINAL_LINE_HEIGHT,
          theme: {
            background: '#1f1f1f',
            foreground: '#d7d7d7',
            selectionBackground: LITTLE_SHEEP_SELECTION_BACKGROUND,
            selectionForeground: LITTLE_SHEEP_SELECTION_FOREGROUND,
            selectionInactiveBackground: LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE,
            cursor: '#d7d7d7',
            black: '#1f1f1f',
            red: '#d86666',
            green: '#77c38a',
            yellow: '#d8b45c',
            blue: '#7ea7d8',
            magenta: '#b99ad9',
            cyan: '#8ecaca',
            white: '#d7d7d7',
            brightBlack: '#777777',
            brightRed: '#ef8b8b',
            brightGreen: '#9ad8a9',
            brightYellow: '#e4c879',
            brightBlue: '#9bbfe3',
            brightMagenta: '#cdb2ea',
            brightCyan: '#a8dada',
            brightWhite: '#f0f0f0',
          },
        })
        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(hostRef.current)
        terminalRef.current = terminal
        fitAddonRef.current = fitAddon
        inputDisposable = terminal.onData((data) => {
          if (!disposed && activeRef.current) inputController.queue(data)
        })
        const fitTerminal = () => {
          if (disposed || !terminalRef.current || !fitAddonRef.current) return
          try {
            const previousCols = terminalRef.current.cols
            const previousRows = terminalRef.current.rows
            fitAddonRef.current.fit()
            if (terminalRef.current.cols === previousCols
              && terminalRef.current.rows === previousRows
              && terminalRef.current.rows > 0) {
              terminalRef.current.refresh(0, terminalRef.current.rows - 1)
            }
            reportTerminalSize()
          } catch {
            // The terminal can be momentarily hidden during animated layout changes.
          }
        }
        const scheduler = createTerminalFitScheduler(
          () => {
            const host = hostRef.current
            if (!host) return null
            const bounds = host.getBoundingClientRect()
            if (bounds.width <= 0 || bounds.height <= 0) return null
            return {
              width: bounds.width,
              height: bounds.height,
              devicePixelRatio: window.devicePixelRatio,
            }
          },
          fitTerminal,
        )
        fitScheduler = scheduler
        // Fit once synchronously so the PTY is created with the real panel
        // geometry instead of printing its prompt at the 80x24 fallback size.
        fitTerminal()
        scheduler.schedule(true)
        resizeObserver = new ResizeObserver(() => {
          if (
            !document.body.classList.contains('is-resizing-column')
            && !document.body.classList.contains('is-workspace-navigator-motion')
          ) scheduler.schedule()
        })
        resizeObserver.observe(hostRef.current)

        const handleColumnResizeEnd = () => scheduler.schedule(true)
        const handleNavigatorMotionStart = () => scheduler.cancel()
        const handleNavigatorMotionEnd = () => scheduler.schedule(true)
        window.addEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
        window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
        window.addEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)

        const scheduleDisplayRefresh = () => scheduler.schedule(true)
        const handleVisibilityChange = () => {
          if (!document.hidden) scheduleDisplayRefresh()
        }
        let resolutionQuery: MediaQueryList | null = null
        const handleResolutionChange = () => {
          resolutionQuery?.removeEventListener('change', handleResolutionChange)
          resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
          resolutionQuery.addEventListener('change', handleResolutionChange)
          scheduleDisplayRefresh()
        }
        resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        resolutionQuery.addEventListener('change', handleResolutionChange)
        window.addEventListener('resize', scheduleDisplayRefresh)
        window.visualViewport?.addEventListener('resize', scheduleDisplayRefresh)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        void document.fonts?.ready.then(() => {
          if (!disposed) scheduleDisplayRefresh()
        })
        displayCleanup = () => {
          resolutionQuery?.removeEventListener('change', handleResolutionChange)
          window.removeEventListener('resize', scheduleDisplayRefresh)
          window.visualViewport?.removeEventListener('resize', scheduleDisplayRefresh)
          document.removeEventListener('visibilitychange', handleVisibilityChange)
          window.removeEventListener(COLUMN_RESIZE_END_EVENT, handleColumnResizeEnd)
          window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_START_EVENT, handleNavigatorMotionStart)
          window.removeEventListener(WORKSPACE_NAVIGATOR_MOTION_END_EVENT, handleNavigatorMotionEnd)
        }
        // The PTY owns the XTerm cursor. Renderer-written banners would move
        // XTerm without moving PowerShell's PSReadLine cursor model, causing
        // the first command to be redrawn beside an earlier line.
        void startTerminalSession(() => disposed)
      })
      .catch((err) => {
        setStatus((err as Error).message)
      })

    return () => {
      disposed = true
      inputController.dispose()
      if (inputControllerRef.current === inputController) inputControllerRef.current = null
      displayCleanup?.()
      fitScheduler?.cancel()
      inputDisposable?.dispose()
      resizeObserver?.disconnect()
      streamAbortRef.current?.abort()
      streamAbortRef.current = null
      const activeSessionId = terminalSessionRef.current
      terminalSessionRef.current = ''
      if (activeSessionId) void closeWorkspaceTerminalSession(activeSessionId).catch(() => undefined)
      terminal?.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId, workspacePath])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    // The tab model decides whether the active session may receive input at all (UX-30):
    // a starting, exited or failed session must never be typed into.
    terminal.options.disableStdin = !terminalInputEnabledRef.current
      || !active
      || terminalInputTarget(sessionTabsRef.current) === null
    if (active && terminalInputEnabledRef.current) terminal.focus()
  }, [active])

  async function startTerminalSession(isDisposed: () => boolean) {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    setTerminalInputEnabled(false)
    setStatus('启动中')
    let terminalOutputSeen = false
    let terminalReadyLabel = runningShell || 'Shell'
    const enableInputAfterOutput = () => {
      if (terminalOutputSeen || isDisposed()) return
      terminalOutputSeen = true
      setStatus(`${terminalReadyLabel} 就绪`)
      setTerminalInputEnabled(true)
      // The session is only usable once it has produced output; the tab says so (UX-30).
      dispatchSessionTabs({
        type: 'status',
        id: terminalSessionRef.current ?? '',
        status: 'ready',
      })
      void inputControllerRef.current?.drain()
    }
    try {
      const size = terminalSizeRef.current.cols > 0 && terminalSizeRef.current.rows > 0
        ? terminalSizeRef.current
        : undefined
      const terminalSession = await createWorkspaceTerminalSession(workspacePath, size, shellSelection.shellIdRef.current ?? undefined)
      if (isDisposed()) {
        await closeWorkspaceTerminalSession(terminalSession.sessionId).catch(() => undefined)
        return
      }
      terminalSessionRef.current = terminalSession.sessionId
      terminalBackendRef.current = terminalSession.backend ?? 'spawn'
      terminalReadyLabel = terminalSession.shell
      setRunningShell(terminalSession.shell)
      // One tab per real session, labelled with the shell Main actually launched (UX-30).
      dispatchSessionTabs({
        type: 'open',
        tab: {
          id: terminalSession.sessionId,
          shellId: shellSelection.shellIdRef.current ?? null,
          shellLabel: terminalSession.shell,
          cwd: terminalSession.cwd ?? workspacePath,
          status: 'starting',
        },
      })
      setTerminalBackend(terminalSession.backend ?? 'spawn')
      terminalSizeRef.current = { cols: terminalSession.cols, rows: terminalSession.rows }
      reportTerminalSize()
      setStatus('正在连接')
      await streamWorkspaceTerminalSession(terminalSession.sessionId, {
        signal: controller.signal,
        onStart: (event) => {
          if (isDisposed()) return
          terminalBackendRef.current = event.backend ?? 'spawn'
          terminalReadyLabel = event.shell
          setTerminalBackend(event.backend ?? 'spawn')
          setStatus('正在连接')
        },
        onStdout: (text) => {
          if (!isDisposed()) {
            writeTerminalText(text)
            enableInputAfterOutput()
          }
        },
        onStderr: (text) => {
          if (!isDisposed()) {
            writeTerminalText(text, 'stderr')
            enableInputAfterOutput()
          }
        },
        onExit: (event) => {
          if (!isDisposed()) {
            setTerminalInputEnabled(false)
            setStatus('终端已退出')
            // An exited session keeps its tab and its state, so the user can see what happened
            // instead of watching a terminal that silently looks alive (UX-30).
            dispatchSessionTabs({
              type: 'status',
              id: terminalSessionRef.current ?? '',
              status: 'exited',
              exitCode: event?.exitCode ?? null,
            })
          }
        },
        onError: (message) => {
          if (isDisposed()) return
          setTerminalInputEnabled(false)
          writeTerminalNotice(`\x1b[31m${message}\x1b[0m`)
          setStatus('终端错误')
        },
      })
    } catch (err) {
      const error = err as Error
      if (error.name === 'AbortError') return
      if (isDisposed()) return
      setTerminalInputEnabled(false)
      setStatus(error.message)
      writeTerminalNotice(`\x1b[31m${error.message}\x1b[0m`)
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
    }
  }

  function writeTerminalLine(line = '') {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.writeln(line)
  }

  function writeTerminalNotice(line = '') {
    if (terminalSessionRef.current && terminalBackendRef.current === 'pty') return
    writeTerminalLine(line)
  }

  function writeTerminalText(text: string, tone: 'normal' | 'stderr' = 'normal') {
    const terminal = terminalRef.current
    if (!terminal || !text) return
    if (terminalBackendRef.current === 'pty') {
      terminal.write(text)
      return
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
    terminal.write(tone === 'stderr' ? `\x1b[33m${normalized}\x1b[0m` : normalized)
  }

  function reportTerminalSize() {
    const terminal = terminalRef.current
    if (!terminal || terminal.cols <= 0 || terminal.rows <= 0) return
    const nextSize = { cols: terminal.cols, rows: terminal.rows }
    if (nextSize.cols === terminalSizeRef.current.cols && nextSize.rows === terminalSizeRef.current.rows) return
    terminalSizeRef.current = nextSize
    const activeSessionId = terminalSessionRef.current
    if (activeSessionId) {
      void resizeWorkspaceTerminalSession(activeSessionId, nextSize.cols, nextSize.rows).catch(() => undefined)
    }
  }

  async function refreshTerminalActivities() {
    const requestId = ++activityRequestRef.current
    setActivityError('')
    try {
      const records = await listWorkspaceTerminalActivity(workspacePath, sessionId, 8)
      if (!mountedRef.current || requestId !== activityRequestRef.current) return
      setActivities(records)
    } catch (err) {
      if (!mountedRef.current || requestId !== activityRequestRef.current) return
      setActivityError((err as Error).message)
    }
  }

  function insertTerminalCommand(nextCommand: string) {
    inputControllerRef.current?.queue(nextCommand)
    terminalRef.current?.focus()
  }

  function setTerminalInputEnabled(enabled: boolean) {
    terminalInputEnabledRef.current = enabled
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !enabled || !activeRef.current
    if (enabled && activeRef.current) terminal.focus()
  }

  async function interruptTerminal() {
    const activeSessionId = terminalSessionRef.current
    if (!activeSessionId) return
    try {
      await interruptWorkspaceTerminalSession(activeSessionId)
      setStatus('已发送 Ctrl+C')
    } catch (err) {
      const error = err as Error
      writeTerminalNotice(`\x1b[31m${error.message}\x1b[0m`)
      setStatus('中断失败')
    }
  }

  async function stopAndRestartTerminal() {
    const activeSessionId = terminalSessionRef.current
    terminalSessionRef.current = ''
    setTerminalInputEnabled(false)
    inputControllerRef.current?.reset()
    streamAbortRef.current?.abort()
    setRunning(true)
    setStatus('正在停止')
    if (activeSessionId) await closeWorkspaceTerminalSession(activeSessionId).catch(() => undefined)
    terminalRef.current?.reset()
    void startTerminalSession(() => !mountedRef.current)
    setRunning(false)
  }

  function clearTerminal() {
    if (terminalSessionRef.current && terminalBackendRef.current === 'pty') {
      inputControllerRef.current?.queue('\x0c')
      terminalRef.current?.focus()
      return
    }
    terminalRef.current?.clear()
  }

  // The real shell, never a hardcoded one: the label follows the running session (UX-29).
  const shellLabel = runningShell || shellSelection.shellId || 'Shell'
  return (
    <div className="workspace-terminal">
      <header className="workspace-terminal-header workspace-page-leading-row">
        <div className="workspace-terminal-title">
          <span>终端</span>
          <small>{compactPath(workspacePath)}{terminalBackend ? ` · ${terminalBackend === 'pty' ? 'PTY' : 'fallback'}` : ''}</small>
        </div>
        <div className="workspace-terminal-actions">
          <WorkspaceTerminalShellPicker
            profiles={shellSelection.profiles}
            selectedId={shellSelection.shellId}
            busy={!running && status === '启动中'}
            onSelect={(id) => {
              shellSelection.choose(id)
              void stopAndRestartTerminal()
            }}
            onTipChange={(tip) => onTipChange(tip ? buildFloatingHelpTip(tip.label, tip.x, tip.y) : null)}
          />
          <span className={`workspace-terminal-status ${running ? 'running' : ''}`}>{status}</span>
          <WorkspaceTerminalToolbar
            shellLabel={shellLabel}
            onInterrupt={() => void interruptTerminal()}
            onRestart={() => void stopAndRestartTerminal()}
            onClear={clearTerminal}
            onTipChange={onTipChange}
          />
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={clearTerminal}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('清空终端输出', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('清空终端输出', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('清空终端输出', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            清空
          </button>
        </div>
        {/* A saved Shell that is no longer installed says so here instead of vanishing. */}
        {shellSelection.notice && (
          <p className="workspace-terminal-shell-notice" role="status">{shellSelection.notice}</p>
        )}
      </header>
      <WorkspaceTerminalActivityList
        activities={activities}
        activityError={activityError}
        onInsertCommand={insertTerminalCommand}
        onRefresh={() => void refreshTerminalActivities()}
        onTipChange={onTipChange}
      />
      <div className="workspace-terminal-shell" ref={hostRef} aria-label="终端输入与输出" />
    </div>
  )
}
export function dedupeTerminalCommands(commands: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const command of commands) {
    const normalized = command.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

