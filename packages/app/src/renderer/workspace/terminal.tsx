// Extension workspace panels, files, terminal, artifacts, and view helpers.
import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as XTermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect,useMemo,useRef,useState } from 'react'
import {
closeWorkspaceTerminalSession,
createWorkspaceTerminalSession,
interruptWorkspaceTerminalSession,
listWorkspaceTerminalActivity,
resizeWorkspaceTerminalSession,
streamWorkspaceTerminalSession,
writeWorkspaceTerminalSession,
type TerminalActivityRecord
} from '../api'
import { formatDurationMs } from '../chat/activity-model'
import { FloatingHelpTip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { compactPath } from './path-utils'


export function WorkspaceTerminal({
  workspacePath,
  sessionId,
  onRequestCommandApproval,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
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
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('启动中')
  const [terminalBackend, setTerminalBackend] = useState<'pty' | 'spawn' | ''>('')
  const [activities, setActivities] = useState<TerminalActivityRecord[]>([])
  const [activityError, setActivityError] = useState('')
  const [recentCommands, setRecentCommands] = useState<string[]>([])
  const [historyCursor, setHistoryCursor] = useState(-1)
  const historyDraftRef = useRef('')
  const commandInputRef = useRef<HTMLInputElement>(null)
  const focusFrameRef = useRef<number>()
  const activityRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const commandHistory = useMemo(
    () => dedupeTerminalCommands([
      ...recentCommands,
      ...activities.map((activity) => activity.command),
    ]),
    [activities, recentCommands],
  )

  useEffect(() => {
    void refreshTerminalActivities()
  }, [workspacePath, sessionId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activityRequestRef.current += 1
      window.cancelAnimationFrame(focusFrameRef.current ?? 0)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let terminal: XTermTerminal | null = null
    let resizeObserver: ResizeObserver | null = null
    let fitFrame = 0

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return
        terminal = new Terminal({
          cols: 80,
          rows: 24,
          convertEol: true,
          cursorBlink: false,
          disableStdin: true,
          fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          fontSize: 12,
          lineHeight: 1.32,
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
        const fitTerminal = () => {
          if (disposed || !terminalRef.current || !fitAddonRef.current) return
          try {
            fitAddonRef.current.fit()
            reportTerminalSize()
          } catch {
            // The terminal can be momentarily hidden during animated layout changes.
          }
        }
        fitFrame = window.requestAnimationFrame(fitTerminal)
        resizeObserver = new ResizeObserver(() => {
          if (fitFrame) window.cancelAnimationFrame(fitFrame)
          fitFrame = window.requestAnimationFrame(fitTerminal)
        })
        resizeObserver.observe(hostRef.current)
        writeTerminalLine('LittleSheep PowerShell')
        writeTerminalLine(`cwd: ${workspacePath}`)
        writeTerminalLine('正在启动 LS 内置终端...')
        writeTerminalLine('')
        void startTerminalSession(() => disposed)
      })
      .catch((err) => {
        setStatus((err as Error).message)
      })

    return () => {
      disposed = true
      if (fitFrame) window.cancelAnimationFrame(fitFrame)
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
  }, [workspacePath])

  async function startTerminalSession(isDisposed: () => boolean) {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    setStatus('启动中')
    try {
      const terminalSession = await createWorkspaceTerminalSession(
        workspacePath,
        terminalSizeRef.current.cols > 0 && terminalSizeRef.current.rows > 0
          ? terminalSizeRef.current
          : undefined,
      )
      if (isDisposed()) {
        await closeWorkspaceTerminalSession(terminalSession.sessionId).catch(() => undefined)
        return
      }
      terminalSessionRef.current = terminalSession.sessionId
      terminalBackendRef.current = terminalSession.backend ?? 'spawn'
      setTerminalBackend(terminalSession.backend ?? 'spawn')
      terminalSizeRef.current = { cols: terminalSession.cols, rows: terminalSession.rows }
      reportTerminalSize()
      setStatus(`${terminalSession.shell} 就绪`)
      await streamWorkspaceTerminalSession(terminalSession.sessionId, {
        signal: controller.signal,
        onStart: (event) => {
          if (isDisposed()) return
          terminalBackendRef.current = event.backend ?? 'spawn'
          setTerminalBackend(event.backend ?? 'spawn')
          setStatus(`${event.shell} 就绪`)
        },
        onStdout: (text) => {
          if (!isDisposed()) writeTerminalText(text)
        },
        onStderr: (text) => {
          if (!isDisposed()) writeTerminalText(text, 'stderr')
        },
        onExit: () => {
          if (!isDisposed()) setStatus('终端已退出')
        },
        onError: (message) => {
          if (isDisposed()) return
          writeTerminalLine(`\x1b[31m${message}\x1b[0m`)
          setStatus('终端错误')
        },
      })
    } catch (err) {
      const error = err as Error
      if (error.name === 'AbortError') return
      if (isDisposed()) return
      setStatus(error.message)
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null
    }
  }

  function writeTerminalLine(line = '') {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.writeln(line)
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

  function rememberTerminalCommand(nextCommand: string) {
    setRecentCommands((commands) => dedupeTerminalCommands([nextCommand, ...commands]).slice(0, 24))
    setHistoryCursor(-1)
    historyDraftRef.current = ''
  }

  function pickTerminalCommand(nextCommand: string) {
    setCommand(nextCommand)
    setHistoryCursor(-1)
    historyDraftRef.current = ''
    window.cancelAnimationFrame(focusFrameRef.current ?? 0)
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = undefined
      commandInputRef.current?.focus()
    })
  }

  function moveTerminalHistory(direction: 'older' | 'newer') {
    if (commandHistory.length === 0) return
    if (direction === 'older') {
      const nextCursor = historyCursor < 0 ? 0 : Math.min(historyCursor + 1, commandHistory.length - 1)
      if (historyCursor < 0) historyDraftRef.current = command
      setHistoryCursor(nextCursor)
      setCommand(commandHistory[nextCursor] ?? '')
      return
    }

    if (historyCursor < 0) return
    const nextCursor = historyCursor - 1
    if (nextCursor < 0) {
      setHistoryCursor(-1)
      setCommand(historyDraftRef.current)
      historyDraftRef.current = ''
      return
    }
    setHistoryCursor(nextCursor)
    setCommand(commandHistory[nextCursor] ?? '')
  }

  function handleTerminalInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTerminalHistory('older')
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTerminalHistory('newer')
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setCommand('')
      setHistoryCursor(-1)
      historyDraftRef.current = ''
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      clearTerminal()
    }
  }

  async function submitCommand(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCommand = command.trim()
    if (!nextCommand || running) return

    setCommand('')
    setRunning(true)
    try {
      const approved = await onRequestCommandApproval({
        command: nextCommand,
        cwd: workspacePath,
        root: workspacePath,
      })
      if (!approved) {
        writeTerminalLine('\x1b[33m已取消执行。\x1b[0m')
        writeTerminalLine('')
        setStatus('已取消')
        return
      }
      const activeSessionId = terminalSessionRef.current
      if (!activeSessionId) throw new Error('终端还没有启动完成。')
      await writeWorkspaceTerminalSession(activeSessionId, nextCommand, sessionId)
      rememberTerminalCommand(nextCommand)
      setStatus('PowerShell 就绪')
      void refreshTerminalActivities()
    } catch (err) {
      const error = err as Error
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
      writeTerminalLine('')
      setStatus('失败')
    } finally {
      setRunning(false)
    }
  }

  async function interruptTerminal() {
    const activeSessionId = terminalSessionRef.current
    if (!activeSessionId) return
    try {
      await interruptWorkspaceTerminalSession(activeSessionId)
      setStatus('已发送 Ctrl+C')
    } catch (err) {
      const error = err as Error
      writeTerminalLine(`\x1b[31m${error.message}\x1b[0m`)
      setStatus('中断失败')
    }
  }

  async function stopAndRestartTerminal() {
    const activeSessionId = terminalSessionRef.current
    terminalSessionRef.current = ''
    streamAbortRef.current?.abort()
    setRunning(true)
    setStatus('正在停止')
    if (activeSessionId) await closeWorkspaceTerminalSession(activeSessionId).catch(() => undefined)
    writeTerminalLine('')
    writeTerminalLine('\x1b[33m正在停止当前 PowerShell 会话并重启...\x1b[0m')
    void startTerminalSession(() => false)
    setRunning(false)
  }

  function clearTerminal() {
    terminalRef.current?.clear()
    writeTerminalLine('LittleSheep PowerShell')
    writeTerminalLine(`cwd: ${workspacePath}`)
    writeTerminalLine('')
  }

  return (
    <div className="workspace-terminal">
      <header className="workspace-terminal-header">
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
              onClick={() => pickTerminalCommand(activity.command)}
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
      <div className="workspace-terminal-shell" ref={hostRef} aria-label="终端输出" />
      <form className="workspace-terminal-command" onSubmit={submitCommand}>
        <span className="workspace-terminal-prompt" aria-hidden="true">$</span>
        <input
          ref={commandInputRef}
          value={command}
          disabled={running}
          placeholder={running ? '命令发送中...' : '输入 PowerShell 命令，在当前工作区执行'}
          aria-label="终端命令"
          spellCheck={false}
          onChange={(event) => {
            setCommand(event.target.value)
            setHistoryCursor(-1)
            historyDraftRef.current = ''
          }}
          onKeyDown={handleTerminalInputKeyDown}
        />
        <button
          {...transientTriggerProps()}
          className="workspace-terminal-run"
          type="submit"
          disabled={!command.trim() || running}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('执行命令', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('执行命令', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('执行命令', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          执行
        </button>
      </form>
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
