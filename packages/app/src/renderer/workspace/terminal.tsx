// Extension workspace panels, files, terminal, artifacts, and view helpers.
import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { preferredShellId } from './terminal-shell-choice'
import { useTerminalShellSelection } from './use-terminal-shell-selection'
import { useTerminalSessions } from './use-terminal-sessions'
import { terminalTabStatusLabel } from './terminal-sessions'
export {
  formatDurationMs,
  terminalActivityStatus,
  terminalActivityTip,
} from './terminal-activity'
import {
  resizeWorkspaceTerminalSession,
} from '../api'
import { FloatingHelpTip } from '../ui/floating-help'
import { createTerminalFitScheduler } from './terminal-fit'
import {
  COLUMN_RESIZE_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_END_EVENT,
  WORKSPACE_NAVIGATOR_MOTION_START_EVENT,
} from '../ui/resize'
import { createTerminalInputController, type TerminalInputController } from './terminal-input-controller'
import {
  APPEARANCE_PREFERENCES_EVENT,
  isAppearanceDark,
  readAppearanceCssColor,
  readAppearancePreferences,
} from '../app-shell/appearance-preferences'

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
  /** The session the keyboard belongs to, mirrored for the surface's own helpers. */
  const activeSessionRef = useRef<string>('')
  /** Lets the hook's callbacks reach the surface's input enablement without re-creating them. */
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalSessionRef = useRef<string>('')
  const terminalBackendRef = useRef<'pty' | 'spawn'>('spawn')
  const terminalSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  // UX-30: the hook owns which sessions exist, one stream each, and which one the keyboard
  // belongs to. The surface keeps the xterm and its rendering.
  const sessions = useTerminalSessions({
    onStart: (event) => {
      terminalBackendRef.current = event.backend ?? 'spawn'
      setStatus(`${event.shell} 正在连接`)
    },
    onActiveOutput: (text, tone) => {
      writeTerminalText(text, tone === 'stderr' ? 'stderr' : 'normal')
      // Output means the shell is reading; the tab's status follows in the same batch and
      // the gate above opens on it. Draining here keeps typing responsive.
      setTerminalInputEnabled(true)
      void inputControllerRef.current?.drain()
    },
    onActiveChange: (tab) => {
      inputControllerRef.current?.reset()
      const terminal = terminalRef.current
      if (!terminal) return
      terminal.reset()
      terminalBackendRef.current = tab?.backend ?? 'spawn'
      // A session that is already running keeps taking input. Disabling it unconditionally
      // left the keyboard dead after switching back: an idle shell at its prompt prints
      // nothing, so nothing would ever turn the input back on (UX-30).
      setTerminalInputEnabled(tab?.status === 'ready')
      if (!tab) return
      setStatus(terminalTabStatusLabel(tab))
      // No local replay here: attaching the stream makes Main replay the session's bounded
      // history into this buffer, so writing what we kept would duplicate it (UX-30).
    },
    onError: (_id, message) => {
      setTerminalInputEnabled(false)
      writeTerminalNotice(`\x1b[31m${message}\x1b[0m`)
      setStatus('终端错误')
    },
  })
  activeSessionRef.current = sessions.activeTab?.id ?? ''
  terminalSessionRef.current = activeSessionRef.current
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('启动中')
  // UX-29: the shells Main discovered, the saved preference, and what the running session
  // actually is. The picker chooses; Main validates the id and decides executable and args.
  const shellSelection = useTerminalShellSelection()
  const mountedRef = useRef(true)
  const inputControllerRef = useRef<TerminalInputController | null>(null)
  const activeRef = useRef(active)
  const terminalInputEnabledRef = useRef(false)
  activeRef.current = active


  // A workspace or conversation switch must not leave sessions running for something the user
  // has left, and must never route input to them (UX-30). Closing the *panel* is different:
  // hiding the terminal keeps its sessions alive, so this runs when the identity actually
  // changes rather than when the component unmounts.
  /** One session per panel mount, even if the effect that starts it runs twice. */
  const startedRef = useRef(false)
  const identityRef = useRef(`${workspacePath}\u0000${sessionId}`)
  useEffect(() => {
    const identity = `${workspacePath}\u0000${sessionId}`
    if (identityRef.current === identity) return
    identityRef.current = identity
    // The sessions belonged to the identity that was left. The new one needs its own session:
    // the surface's start guard is per identity, so it is cleared here — otherwise the panel
    // would stay empty after a workspace or conversation switch until the user clicked 新建.
    startedRef.current = false
    sessions.closeAll()
  }, [workspacePath, sessionId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
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
      onCompletedCommand: () => undefined,
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
          fontSize: readAppearancePreferences().terminalFontSize,
          lineHeight: TERMINAL_LINE_HEIGHT,
          theme: terminalAppearanceTheme(),
        })
        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(hostRef.current)
        terminalRef.current = terminal
        fitAddonRef.current = fitAddon
        const applyAppearance = () => {
          const rootStyles = getComputedStyle(document.documentElement)
          const fontSize = Number.parseInt(rootStyles.getPropertyValue('--terminal-font-size'), 10)
          terminal!.options.fontSize = Number.isFinite(fontSize) ? fontSize : TERMINAL_FONT_SIZE
          terminal!.options.theme = terminalAppearanceTheme()
        }
        applyAppearance()
        document.documentElement.addEventListener(APPEARANCE_PREFERENCES_EVENT, applyAppearance)
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
          document.documentElement.removeEventListener(APPEARANCE_PREFERENCES_EVENT, applyAppearance)
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
        // React may run this effect twice (StrictMode, or a fast remount): one panel must own
        // exactly one session, so the start is guarded by a ref rather than by luck. Without
        // this, opening the terminal leaked a second shell that nothing displayed.
        if (startedRef.current) return
        startedRef.current = true
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
      // Hiding this mounted panel keeps sessions alive; removing it closes every session.
      sessions.closeAll()
      terminal?.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId, workspacePath])

  // The tab model decides whether the active session may receive input at all (UX-30): a
  // starting, exited or failed session must never be typed into. The status is a dependency
  // because that is what changes the moment a session becomes ready.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !terminalInputEnabledRef.current
      || !active
      || sessions.activeTab?.status !== 'ready'
    if (active && terminalInputEnabledRef.current) terminal.focus()
  }, [active, sessions.activeTab?.status])

  useEffect(() => {
    if (!active) return
    const selected = preferredShellId()
    if (!selected || selected === shellSelection.shellIdRef.current) return
    shellSelection.shellIdRef.current = selected
    sessions.closeAll()
    terminalRef.current?.reset()
    void startTerminalSession(() => !mountedRef.current)
  }, [active])

  /**
   * Opens a session — the first one, or another one beside it (UX-30).
   *
   * The hook owns the tab, its stream and its bounded replay buffer; this only reports the
   * outcome to the surface's own status line.
   */
  async function startTerminalSession(isDisposed: () => boolean) {
    const size = terminalSizeRef.current.cols > 0 && terminalSizeRef.current.rows > 0
      ? terminalSizeRef.current
      : undefined
    setTerminalInputEnabled(false)
    setStatus('启动中')
    setRunning(true)
    try {
      const id = await sessions.open({
        workspacePath,
        shellId: shellSelection.shellIdRef.current,
        ...(size ? { size } : {}),
      })
      if (!id || isDisposed()) return
      terminalBackendRef.current = terminalBackendRef.current || 'spawn'
      terminalSizeRef.current = size ?? terminalSizeRef.current
      reportTerminalSize()
    } catch (error) {
      if ((error as Error).name === 'AbortError' || isDisposed()) return
      setTerminalInputEnabled(false)
      setStatus((error as Error).message)
      writeTerminalNotice(`\x1b[31m${(error as Error).message}\x1b[0m`)
    } finally {
      if (!isDisposed()) setRunning(false)
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

  function setTerminalInputEnabled(enabled: boolean) {
    terminalInputEnabledRef.current = enabled
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !enabled || !activeRef.current
    if (enabled && activeRef.current) terminal.focus()
  }

  return (
    <div className="workspace-terminal">
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

function terminalAppearanceTheme() {
  const dark = isAppearanceDark()
  const color = (name: string, fallback: string) => readAppearanceCssColor(name, fallback)
  return {
    background: color('--bg', dark ? '#101010' : '#e9e9e7'),
    foreground: color('--text', dark ? '#d7d7d7' : '#30302e'),
    selectionBackground: color('--selection-background', dark ? '#33507d' : '#c8d9f3'),
    selectionForeground: color('--selection-foreground', dark ? '#f2f2f2' : '#181818'),
    selectionInactiveBackground: color('--selection-background-inactive', dark ? '#2c4266' : '#d7dce4'),
    cursor: color('--text-strong', dark ? '#d7d7d7' : '#171716'),
    black: color('--bg', dark ? '#1f1f1f' : '#e9e9e7'),
    red: dark ? '#d86666' : '#b4232d',
    green: dark ? '#77c38a' : '#1f7a43',
    yellow: dark ? '#d8b45c' : '#805b00',
    blue: dark ? '#7ea7d8' : '#2c649c',
    magenta: dark ? '#b99ad9' : '#7e3da0',
    cyan: dark ? '#8ecaca' : '#187986',
    white: color('--text', dark ? '#d7d7d7' : '#30302e'),
    brightBlack: dark ? '#777777' : '#5e5e5b',
    brightRed: dark ? '#ef8b8b' : '#8c1821',
    brightGreen: dark ? '#9ad8a9' : '#176b36',
    brightYellow: dark ? '#e4c879' : '#664700',
    brightBlue: dark ? '#9bbfe3' : '#204d7a',
    brightMagenta: dark ? '#cdb2ea' : '#653282',
    brightCyan: dark ? '#a8dada' : '#12636c',
    brightWhite: dark ? '#f0f0f0' : '#171716',
  }
}

