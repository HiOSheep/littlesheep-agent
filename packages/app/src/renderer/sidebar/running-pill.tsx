// The chat column's task pill: which conversation is on screen and what it is running right now.
//
// It floats at the top of the chat column as one compact, width-adaptive pill rather than a
// second toolbar: the left glyph is a ring that spins while anything is running, then the
// conversation's own title, then — only while a run exists to report — the running command and
// its elapsed time. Double-clicking the title renames the conversation in place. Expanding the
// pill lists the run's commands in two groups — still running (each with a stop control), then
// finished — sourced from the same activity the transcript renders, so the pill cannot disagree
// with the chat. When the finished group grows long it folds the older entries behind a
// disclosure row, the way dsh (deepseek harness) collapses its command history.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryActivity } from '../../shared/history-activity'
import { clampNumber } from '../app-shell/navigation'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, type FloatingHelpTip } from '../ui/floating-help'
import { useDismissOnOutside } from '../ui/presence'
import { transientTriggerProps } from '../ui/transient'

/** What the chat column hands the pill: the conversation, its newest run, and the ticking clock. */
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

/** The finished group folds once it passes this many rows; the newest few stay readable. */
export const FINISHED_FOLD_THRESHOLD = 6
/** How many of the newest finished commands stay visible while the rest is folded away. */
export const FINISHED_FOLD_VISIBLE = 4

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

/**
 * Folds a newest-first finished list the way dsh collapses its command history: a short tail is
 * shown whole; a long one keeps only its newest entries and reports how many older ones folded
 * away behind the disclosure row.
 */
export function foldFinishedCommands(finished: TaskCommand[]): { visible: TaskCommand[]; foldedCount: number } {
  if (finished.length <= FINISHED_FOLD_THRESHOLD) return { visible: finished, foldedCount: 0 }
  return { visible: finished.slice(0, FINISHED_FOLD_VISIBLE), foldedCount: finished.length - FINISHED_FOLD_VISIBLE }
}

/** A rename commits only when the trimmed draft actually names the conversation differently. */
export function normalizeRenameDraft(draft: string, current: string): string | null {
  const next = draft.trim()
  return next && next !== current ? next : null
}

/**
 * Filled square for the per-command stop control. Drawn here rather than added to
 * `ui/icons.tsx`, which is a frozen hotspot (see `docs/reference/module-split-map.md`).
 */
function CommandStopGlyph() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  )
}

/** One command row: what ran, who ran it, how long it took — and a stop control while it runs. */
export function TaskCommandRow({ command, onStop }: { command: TaskCommand; onStop?: () => void }) {
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
      {command.running && onStop && (
        <button
          type="button"
          className="running-pill-command-stop"
          aria-label="终止运行"
          title="终止运行"
          onClick={(event) => {
            event.stopPropagation()
            onStop()
          }}
        >
          <CommandStopGlyph />
        </button>
      )}
    </div>
  )
}

export function RunningPill({
  title,
  activity,
  now,
  onRename,
  onStop,
  onTipChange,
}: {
  title: string
  activity: HistoryActivity | null
  /** Ticking clock owned by the chat projection, so elapsed times advance without a second timer. */
  now: number
  /** Commits a renamed conversation title; the pill only calls it with a real change. */
  onRename: (title: string) => void
  /** Stops the current run; every still-running command belongs to it. */
  onStop: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [finishedExpanded, setFinishedExpanded] = useState(false)
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
  // The pill hugs its content: the summary segment exists only while a run leaves something to
  // report, so a conversation that never ran takes up no more room than its title.
  const summary = isRunning
    ? [headline, running.length > 1 ? `还有 ${running.length - 1} 条` : '', formatPillDuration(elapsed)].filter(Boolean).join(' · ')
    : activity
      ? `上次运行 ${formatPillDuration(elapsed) || '刚结束'}`
      : ''
  const tipText = `${title || '未命名对话'}\n${summary || '还没有运行记录'}\n双击可重命名对话`
  const fold = foldFinishedCommands(finished)
  const shownFinished = finishedExpanded ? finished : fold.visible

  const commitRename = (draft: string) => {
    setEditing(false)
    const next = normalizeRenameDraft(draft, title)
    if (next) onRename(next)
  }

  return (
    <div ref={rootRef} className={`running-pill-root ${isRunning ? 'running' : ''}`}>
      {editing ? (
        <div className="running-pill editing">
          <span className="running-pill-ring" aria-hidden="true" />
          <input
            className="running-pill-rename-input"
            defaultValue={title}
            autoFocus
            aria-label="重命名对话"
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename(event.currentTarget.value)
              if (event.key === 'Escape') setEditing(false)
            }}
            onBlur={(event) => commitRename(event.currentTarget.value)}
          />
        </div>
      ) : (
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
          onDoubleClick={() => {
            // The two clicks that lead here toggle the panel open and shut again, so the rename
            // field simply takes the pill's place with nothing left open underneath.
            onTipChange(null)
            setOpen(false)
            setEditing(true)
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
      )}
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
          {running.map((command) => <TaskCommandRow key={command.id} command={command} onStop={onStop} />)}
          <div className="running-pill-panel-section">
            <span>已结束</span>
            <span className="running-pill-panel-count">{finished.length}</span>
          </div>
          {finished.length === 0 && <div className="running-pill-empty">这次运行还没有已结束的指令</div>}
          {shownFinished.map((command) => <TaskCommandRow key={command.id} command={command} />)}
          {fold.foldedCount > 0 && (
            <button
              type="button"
              className="running-pill-fold"
              aria-expanded={finishedExpanded}
              onClick={() => setFinishedExpanded((value) => !value)}
            >
              {finishedExpanded ? '收起更早的指令' : `展开更早的 ${fold.foldedCount} 条`}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
