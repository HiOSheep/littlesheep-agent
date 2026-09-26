// The titlebar's task pill: which conversation is on screen and what it is running right now.
//
// It is deliberately one compact pill rather than a second toolbar: the left glyph is a ring that
// spins while anything is running, then the conversation's own title, then the running command and
// its elapsed time. Expanding it lists the run's commands in two groups — still running, then
// finished — sourced from the same activity the transcript renders, so the pill cannot disagree
// with the chat.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryActivity } from '../../shared/history-activity'
import { clampNumber } from '../app-shell/navigation'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, type FloatingHelpTip } from '../ui/floating-help'
import { useDismissOnOutside } from '../ui/presence'
import { transientTriggerProps } from '../ui/transient'

/** What the titlebar hands the pill: the conversation, its newest run, and the ticking clock. */
export interface TitlebarTask {
  title: string
  hasSession: boolean
  activity: HistoryActivity | null
  now: number
}

/** One command the run started, in the order the activity recorded it. */
interface TaskCommand {
  id: string
  label: string
  detail: string
  running: boolean
  failed: boolean
  durationMs: number | null
}

export function formatPillDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs < 1000) return '不足 1 秒'
  if (durationMs < 60_000) return `${Math.floor(durationMs / 1000)} 秒`
  const minutes = Math.floor(durationMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** The command text a tool call carries, when it carries one the reader would recognise. */
export function taskCommandDetail(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** Splits a run's tools into what is still going and what already ended. */
export function taskCommands(activity: HistoryActivity | null, now: number): TaskCommand[] {
  if (!activity) return []
  return activity.tools
    .filter((tool) => tool.startedAt !== undefined || tool.endedAt !== undefined)
    .map((tool) => {
      const running = tool.endedAt === undefined
      const startedAt = tool.startedAt ?? tool.endedAt ?? now
      const endedAt = tool.endedAt ?? now
      return {
        id: tool.callId,
        label: tool.name,
        detail: taskCommandDetail(tool.input),
        running,
        failed: tool.ok === false,
        durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null,
      }
    })
    .slice(-24)
}

/** One command row: what ran, who ran it, and how long it took. */
export function TaskCommandRow({ command }: { command: TaskCommand }) {
  const state = command.running ? 'running' : command.failed ? 'failed' : 'done'
  const meta = [command.label, command.running ? '运行中' : command.failed ? '失败' : '完成'].filter(Boolean).join(' · ')
  return (
    <div className={`running-pill-command ${state}`}>
      <span className="running-pill-command-dot" aria-hidden="true" />
      <span className="running-pill-command-body">
        <span className="running-pill-command-text" title={command.detail || command.label}>
          {command.detail || command.label}
        </span>
        <span className="running-pill-command-meta">{meta}</span>
      </span>
      <span className="running-pill-command-time">{formatPillDuration(command.durationMs)}</span>
    </div>
  )
}

export function RunningPill({
  title,
  activity,
  now,
  onTipChange,
}: {
  title: string
  activity: HistoryActivity | null
  /** Ticking clock owned by the chat projection, so elapsed times advance without a second timer. */
  now: number
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useDismissOnOutside(open, [rootRef, panelRef], () => setOpen(false))

  useLayoutEffect(() => {
    if (!open) return
    const trigger = buttonRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const panelWidth = panelRef.current?.offsetWidth || 360
    const panelHeight = panelRef.current?.offsetHeight || 260
    const x = clampNumber(rect.left, margin, Math.max(margin, window.innerWidth - panelWidth - margin))
    const below = rect.bottom + 6
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 6)
      : below
    setPosition({ x, y })
  }, [open, activity])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [open])

  const commands = taskCommands(activity, now)
  const running = commands.filter((command) => command.running)
  const finished = commands.filter((command) => !command.running).reverse()
  const status = activity?.status ?? 'done'
  const isRunning = status === 'running' || running.length > 0
  const elapsed = activity ? (activity.endedAt ?? now) - activity.startedAt : null
  const headline = running[0]?.detail || running[0]?.label || ''
  const summary = isRunning
    ? [headline, running.length > 1 ? `还有 ${running.length - 1} 条` : '', formatPillDuration(elapsed)].filter(Boolean).join(' · ')
    : activity
      ? `上次运行 ${formatPillDuration(elapsed) || '刚结束'}`
      : '还没有运行记录'
  const tipText = `${title || '未命名对话'}\n${summary}`

  return (
    <div ref={rootRef} className={`running-pill-root ${isRunning ? 'running' : ''}`} data-window-drag-ignore>
      <button
        {...transientTriggerProps()}
        ref={buttonRef}
        className="running-pill"
        type="button"
        aria-label={`当前对话与运行指令：${title}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          onTipChange(null)
          setOpen((value) => !value)
        }}
        onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tipText, event.clientX, event.clientY))}
        onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tipText, event.clientX, event.clientY))}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tipText, event.currentTarget))}
        onBlur={() => onTipChange(null)}
      >
        <span className="running-pill-ring" aria-hidden="true" />
        <span className="running-pill-title">{title || '未命名对话'}</span>
        {summary && <span className="running-pill-summary">{summary}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="running-pill-panel"
          role="dialog"
          aria-label="当前对话与运行指令"
          style={{ left: position.x, top: position.y }}
        >
          <div className="running-pill-panel-title" title={title}>{title}</div>
          <div className="running-pill-panel-section">
            <span>进行中</span>
            <span className="running-pill-panel-count">{running.length}</span>
          </div>
          {running.length === 0 && <div className="running-pill-empty">当前没有正在运行的指令</div>}
          {running.map((command) => <TaskCommandRow key={command.id} command={command} />)}
          <div className="running-pill-panel-section">
            <span>已结束</span>
            <span className="running-pill-panel-count">{finished.length}</span>
          </div>
          {finished.length === 0 && <div className="running-pill-empty">这次运行还没有已结束的指令</div>}
          {finished.map((command) => <TaskCommandRow key={command.id} command={command} />)}
        </div>,
        document.body,
      )}
    </div>
  )
}
