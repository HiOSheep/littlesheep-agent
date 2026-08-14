// Extension workspace panels, files, terminal, artifacts, and view helpers.
import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import {
  closeWorkspaceTerminalSession,
  createWorkspaceTerminalSession,
  interruptWorkspaceTerminalSession,
  listWorkspaceTerminalActivity,
  resizeWorkspaceTerminalSession,
  streamWorkspaceTerminalSession,
  type TerminalActivityRecord
} from '../api'
import { formatDurationMs } from '../chat/activity-model'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { compactPath } from './path-utils'
import { createTerminalFitScheduler } from './terminal-fit'
import { createTerminalInputController, type TerminalInputController } from './terminal-input-controller'
import type { PermissionModeId } from '../../shared/permission-modes'

const TERMINAL_FONT_FAMILY = '"SimSun", "宋体", monospace'
const TERMINAL_FONT_SIZE = 12
const TERMINAL_LINE_HEIGHT = 1.34

export function WorkspaceTerminal({
  workspacePath,
  sessionId,
  permissionMode,
  workspaceBoundary,
  onRequestCommandApproval,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
  permissionMode: PermissionModeId
  workspaceBoundary: 'inside' | 'outside'
  onRequestCommandApproval: (detail: unknown) => Promise<boolean>
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
  const activityRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const inputControllerRef = useRef<TerminalInputController | null>(null)

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
      getPermissionMode: () => permissionMode,
      getWorkspacePath: () => workspacePath,
      isDisposed: () => disposed || !mountedRef.current,
      requestApproval: onRequestCommandApproval,
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
          if (!disposed) inputController.queue(data)
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
          scheduler.schedule()
        })
        resizeObserver.observe(hostRef.current)

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
  }, [permissionMode, workspaceBoundary, workspacePath])

  async function startTerminalSession(isDisposed: () => boolean) {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    setTerminalInputEnabled(false)
    setStatus('启动中')
    let terminalOutputSeen = false
    let terminalReadyLabel = 'PowerShell'
    const enableInputAfterOutput = () => {
      if (terminalOutputSeen || isDisposed()) return
      terminalOutputSeen = true
      setStatus(`${terminalReadyLabel} 就绪`)
      setTerminalInputEnabled(true)
      void inputControllerRef.current?.drain()
    }
    try {
      const size = terminalSizeRef.current.cols > 0 && terminalSizeRef.current.rows > 0
        ? terminalSizeRef.current
        : undefined
      let terminalSession
      try {
        // Main performs the exact boundary check. A successful first request
        // means no prompt is needed, including full mode inside the container.
        terminalSession = await createWorkspaceTerminalSession(workspacePath, size, permissionMode, false)
      } catch (error) {
        if ((error as { status?: number }).status !== 403) throw error
        const approved = await onRequestCommandApproval({
          action: 'terminal_session',
          command: '打开 LS 内置终端',
          cwd: workspacePath,
          root: workspacePath,
          boundary: workspaceBoundary,
        })
        if (!approved) {
          if (!isDisposed()) {
            writeTerminalLine('\x1b[33m已取消打开终端。\x1b[0m')
            setStatus('已取消')
          }
          return
        }
        terminalSession = await createWorkspaceTerminalSession(workspacePath, size, permissionMode, true)
      }
      if (isDisposed()) {
        await closeWorkspaceTerminalSession(terminalSession.sessionId).catch(() => undefined)
        return
      }
      terminalSessionRef.current = terminalSession.sessionId
      terminalBackendRef.current = terminalSession.backend ?? 'spawn'
      terminalReadyLabel = terminalSession.shell
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
        onExit: () => {
          if (!isDisposed()) {
            setTerminalInputEnabled(false)
            setStatus('终端已退出')
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
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.disableStdin = !enabled
    if (enabled) terminal.focus()
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

  return (
    <div className="workspace-terminal">
      <header className="workspace-terminal-header workspace-page-leading-row">
        <div className="workspace-terminal-title">
          <span>终端</span>
          <small>{compactPath(workspacePath)}{terminalBackend ? ` · ${terminalBackend === 'pty' ? 'PTY' : 'fallback'}` : ''}</small>
        </div>
        <div className="workspace-terminal-actions">
          <span className={`workspace-terminal-status ${running ? 'running' : ''}`}>{status}</span>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={() => void interruptTerminal()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('向当前终端发送 Ctrl+C', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('向当前终端发送 Ctrl+C', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('向当前终端发送 Ctrl+C', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            中断
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            onClick={() => void stopAndRestartTerminal()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('停止当前 PowerShell 会话并重启', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('停止当前 PowerShell 会话并重启', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('停止当前 PowerShell 会话并重启', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            重启
          </button>
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
      </header>
      <div className="workspace-terminal-activity" aria-label="最近终端命令">
        <div className="workspace-terminal-activity-heading">
          <span>最近命令</span>
          <button
            {...transientTriggerProps()}
            className="workspace-terminal-activity-refresh"
            type="button"
            onClick={() => void refreshTerminalActivities()}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新最近命令', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="workspace-terminal-activity-list">
          {activities.length === 0 && !activityError && (
            <span className="workspace-terminal-activity-empty">暂无命令记录</span>
          )}
          {activityError && (
            <span className="workspace-terminal-activity-empty error">{activityError}</span>
          )}
          {activities.map((activity) => (
            <button
              key={activity.id}
              type="button"
              className={`workspace-terminal-activity-row ${activity.exitCode === 0 && !activity.timedOut ? 'ok' : 'warn'}`}
              onClick={() => insertTerminalCommand(activity.command)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(terminalActivityTip(activity), event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(terminalActivityTip(activity), event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(terminalActivityTip(activity), event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className="workspace-terminal-activity-command">{activity.command}</span>
              <span className="workspace-terminal-activity-meta">
                {terminalActivityStatus(activity)} · {formatDurationMs(activity.durationMs)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="workspace-terminal-shell" ref={hostRef} aria-label="终端输入与输出" />
    </div>
  )
}
export function terminalActivityStatus(activity: TerminalActivityRecord): string {
  if (activity.signal === 'session') return '已发送'
  if (activity.signal === 'captured' || activity.signal === 'next-command') return '已记录'
  if (activity.signal === 'interrupt') return '已中断'
  if (activity.signal === 'closed') return '已关闭'
  if (activity.signal === 'send-failed') return '发送失败'
  if (activity.timedOut) return '超时'
  if (activity.exitCode === 0) return '成功'
  return `退出 ${activity.exitCode ?? activity.signal ?? '异常'}`
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
export function terminalActivityTip(activity: TerminalActivityRecord): string {
  const parts = [
    activity.command,
    `cwd: ${activity.cwd}`,
    `${terminalActivityStatus(activity)} · ${formatDurationMs(activity.durationMs)}`,
  ]
  if (activity.stdoutPreview) parts.push(`stdout: ${activity.stdoutPreview.slice(0, 240)}`)
  if (activity.stderrPreview) parts.push(`stderr: ${activity.stderrPreview.slice(0, 240)}`)
  return parts.join('\n')
}
