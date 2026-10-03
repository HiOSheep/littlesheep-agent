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
// The bar can also be dragged anywhere inside the chat column (asked for 2026-10-03): a pointer
// press that moves past a small threshold becomes a drag, the press that ends it does not also open
// the panel, and the pill is clamped to the column so it can never park over the sidebar or the
// workspace.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryActivity } from '../../shared/history-activity'
import { clampNumber } from '../app-shell/navigation'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, type FloatingHelpTip } from '../ui/floating-help'
import { RenameIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'
import { transientTriggerProps } from '../ui/transient'
import { VoidRing } from '../ui/void-ring'
import { voidRingStateForActivity } from '../ui/void-ring-state'
import { clampTaskPillOffset } from './task-pill-drag'

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
        <span className="running-pill-command-text" >
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
  offset,
  onRename,
  onStop,
  onOffsetChange,
  onTipChange,
  draggable = true,
  showTips = true,
}: {
  showTips?: boolean
  draggable?: boolean
  title: string
  activity: HistoryActivity | null
  /** Ticking clock owned by the chat projection, so elapsed times advance without a second timer. */
  now: number
  /** Where the bar has been dragged to, from the spot the column docks it at. */
  offset: { x: number; y: number }
  /** Commits a renamed conversation title; the pill only calls it with a real change. */
  onRename: (title: string) => void
  /** Stops the current run; every still-running command belongs to it. */
  onStop: () => void
  onOffsetChange: (offset: { x: number; y: number }) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [finishedExpanded, setFinishedExpanded] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    docked: { left: number; top: number; right: number; bottom: number }
    bounds: { left: number; top: number; right: number; bottom: number }
    moved: boolean
  } | null>(null)
  // One press that ends a drag must not also toggle the panel, and a drag must not be read as the
  // first half of the double-click that renames.
  const swallowClickRef = useRef(false)

  const translate = dragging || offset.x !== 0 || offset.y !== 0
  const pillStyle = translate ? { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` } : undefined

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!draggable || editing || event.button !== 0) return
    const root = rootRef.current
    const column = root?.closest('.chat')
    if (!root || !(column instanceof HTMLElement)) return
    const rect = root.getBoundingClientRect()
    const columnRect = column.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      docked: { left: rect.left - offset.x, top: rect.top - offset.y, right: rect.right - offset.x, bottom: rect.bottom - offset.y },
      bounds: { left: columnRect.left, top: columnRect.top, right: columnRect.right, bottom: columnRect.bottom },
      moved: false,
    }
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    if (!drag.moved) {
      drag.moved = true
      setDragging(true)
      onTipChange(null)
      setOpen(false)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    // The clamp runs against the column, not the window: the bar is the chat's, and a drag that
    // reaches past the column stops at its edge instead of covering a neighbour.
    onOffsetChange(clampTaskPillOffset({ x: drag.originX + dx, y: drag.originY + dy }, drag.bounds, drag.docked))
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!drag.moved) return
    setDragging(false)
    swallowClickRef.current = true
    window.setTimeout(() => { swallowClickRef.current = false }, 0)
  }

  useDismissOnOutside(open, [rootRef, panelRef], () => setOpen(false))
  useEffect(() => { if (open) panelRef.current?.focus({ preventScroll: true }) }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const trigger = buttonRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    // The panel opens from the pill's own left edge, which is the chat column's (2026-10-02: the
    // pair was asked to sit hard left, so the panel neither centres nor drifts from its trigger).
    // The 2px floor is only a window-edge guard for a collapsed sidebar.
    const edge = 8
    const panelWidth = panelRef.current?.offsetWidth || 360
    const panelHeight = panelRef.current?.offsetHeight || 260
    const x = clampNumber(rect.left, 2, Math.max(2, window.innerWidth - panelWidth - edge))
    const below = rect.bottom + 6
    const y = below + panelHeight > window.innerHeight - edge
      ? Math.max(2, rect.top - panelHeight - 6)
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
  // What the pill reports is a *count*, not a sentence: the bar carries the conversation and the
  // number of background tasks, and the panel behind the chevron carries the detail (asked for on
  // 2026-10-02, after the reference bar). A conversation with no run at all keeps no segment, which
  // is how the bar's width follows whether there is anything to report.
  const taskLabel = `${commands.length} 项执行记录`
  // The state sentence moves into the hover tip, where it costs no width.
  const stateText = isRunning
    ? [headline, running.length > 1 ? `还有 ${running.length - 1} 条` : '', formatPillDuration(elapsed)].filter(Boolean).join(' · ')
    : activity
      ? `上次运行 ${formatPillDuration(elapsed) || '刚结束'}`
      : ''
  const tipText = `${title || '未命名对话'}\n${stateText || '还没有运行记录'}\n双击标题、点铅笔或按 F2 重命名`
  const fold = foldFinishedCommands(finished)
  const shownFinished = finishedExpanded ? finished : fold.visible

  const commitRename = (draft: string) => {
    setEditing(false)
    const next = normalizeRenameDraft(draft, title)
    if (next) onRename(next)
  }

  return (
    <div
      ref={rootRef}
      className={`running-pill-root ${isRunning ? 'running' : ''} ${dragging ? 'dragging' : ''}`}
      data-dragged={translate ? 'true' : 'false'}
      style={pillStyle}
    >
      {editing ? (
        <div className="running-pill editing">
          <VoidRing state={voidRingStateForActivity(activity)} size={24} />
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
          aria-label={`当前对话与运行指令：${title}${commands.length > 0 ? `（${taskLabel}）` : ''}`}
          aria-keyshortcuts="F2"
          aria-expanded={open}
          aria-haspopup="dialog"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(event) => {
            // The keyboard path to the rename field; the pointer paths are the double-click and the
            // pencil below.
            if (event.key !== 'F2') return
            event.preventDefault()
            onTipChange(null)
            setOpen(false)
            setEditing(true)
          }}
          onClick={() => {
            // A press that dragged the bar is not also a request to open the panel.
            if (swallowClickRef.current) return
            onTipChange(null)
            setOpen((value) => !value)
          }}
          onDoubleClick={() => {
            if (swallowClickRef.current) return
            // The two clicks that lead here toggle the panel open and shut again, so the rename
            // field simply takes the pill's place with nothing left open underneath.
            onTipChange(null)
            setOpen(false)
            setEditing(true)
          }}
          onMouseEnter={(event) => showTips && onTipChange(buildFloatingHelpTip(tipText, event.clientX, event.clientY))}
          onMouseMove={(event) => showTips && onTipChange(buildFloatingHelpTip(tipText, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => showTips && onTipChange(buildFloatingHelpTipFromElement(tipText, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <VoidRing state={voidRingStateForActivity(activity)} size={24} />
          <span className="running-pill-title">{title || '未命名对话'}</span>
          <span
            className="running-pill-rename"
            aria-hidden="true"
            title={showTips ? '重命名对话（F2）' : undefined}
            onClick={(event) => {
              // A pointer path to the rename field that does not depend on discovering a
              // double-click: the pencil says the title is editable (asked for 2026-10-02).
              event.stopPropagation()
              onTipChange(null)
              setOpen(false)
              setEditing(true)
            }}
          >
            <RenameIcon />
          </span>
          {commands.length > 0 && (
            <span className="running-pill-tasks">
              {taskLabel}
              <span className="running-pill-chevron" aria-hidden="true" />
            </span>
          )}
        </button>
      )}
      {open && createPortal(
        <div
          ref={panelRef}
          className="running-pill-panel"
          role="dialog" tabIndex={-1}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); buttonRef.current?.focus() } }}
          aria-label="当前对话与运行指令"
          style={{ left: position.x, top: position.y }}
        >
          <div className="running-pill-panel-head"><div className="running-pill-panel-title">{title}</div><button type="button" className="chat-panel-close" aria-label="关闭执行记录" onClick={() => { setOpen(false); buttonRef.current?.focus() }}>×</button></div>
          {/* Only sections that have something in them: an empty "进行中 0" and a line saying so
              were two rows that reported nothing (asked for 2026-10-02), and the panel now ends
              where its content ends. */}
          {commands.length === 0 && <div className="running-pill-empty">这次运行还没有指令记录</div>}
          {running.length > 0 && (
            <>
              <div className="running-pill-panel-section">
                <span>进行中</span>
                <span className="running-pill-panel-count">{running.length}</span>
              </div>
              {running.map((command) => <TaskCommandRow key={command.id} command={command} onStop={onStop} />)}
            </>
          )}
          {finished.length > 0 && (
            <>
              <div className="running-pill-panel-section">
                <span>已结束</span>
                <span className="running-pill-panel-count">{finished.length}</span>
              </div>
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
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
