// Conversation rendering and execution-progress presentation.
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { buildTaskProgress } from '../task-progress'
import { formatDurationMs } from './activity-model'
import { visibleActivitySteps } from './activity-visibility'
import { AssistantTurnActivity, LiveToolEvent } from './types'


export const TASK_PROGRESS_COMPLETE_HOLD_MS = 700

export const TASK_PROGRESS_EXIT_MS = 260

export const TASK_PROGRESS_HOVER_DELAY_MS = 500

export const TASK_PROGRESS_CLOSE_DELAY_MS = 100


export function TaskProgressPresence({
  activity,
  now,
}: {
  activity: AssistantTurnActivity | null
  now: number
}) {
  const [presentation, setPresentation] = useState<{
    activity: AssistantTurnActivity
    exiting: boolean
  } | null>(null)
  const activeKeyRef = useRef<string>()
  const completedKeyRef = useRef<string>()
  const holdTimerRef = useRef<number>()
  const exitTimerRef = useRef<number>()

  function clearTimers() {
    window.clearTimeout(holdTimerRef.current)
    window.clearTimeout(exitTimerRef.current)
    holdTimerRef.current = undefined
    exitTimerRef.current = undefined
  }

  useEffect(() => {
    const key = activity ? `${activity.startedAt}:${activity.instruction}` : undefined
    if (activity?.status === 'running' && key) {
      clearTimers()
      activeKeyRef.current = key
      completedKeyRef.current = undefined
      setPresentation({ activity, exiting: false })
      return
    }

    if (activity && key && key === activeKeyRef.current) {
      setPresentation((current) => current ? { ...current, activity, exiting: false } : { activity, exiting: false })
      if (completedKeyRef.current === key) return
      completedKeyRef.current = key
      holdTimerRef.current = window.setTimeout(() => {
        setPresentation((current) => current ? { ...current, exiting: true } : current)
        exitTimerRef.current = window.setTimeout(() => {
          setPresentation(null)
          activeKeyRef.current = undefined
          completedKeyRef.current = undefined
        }, TASK_PROGRESS_EXIT_MS)
      }, TASK_PROGRESS_COMPLETE_HOLD_MS)
      return
    }

    clearTimers()
    activeKeyRef.current = undefined
    completedKeyRef.current = undefined
    setPresentation(null)
  }, [activity])

  useEffect(() => () => clearTimers(), [])

  if (!presentation) return null
  return (
    <div className={`task-progress-anchor ${presentation.exiting ? 'exiting' : ''}`}>
      <TaskProgressIndicator activity={presentation.activity} now={now} />
    </div>
  )
}


export function TaskProgressIndicator({
  activity,
  now,
}: {
  activity: AssistantTurnActivity
  now: number
}) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const indicatorRef = useRef<HTMLButtonElement>(null)
  const hoverTimerRef = useRef<number>()
  const closeTimerRef = useRef<number>()
  const popoverId = useId()
  const progress = buildTaskProgress(activity)
  const visibleSteps = visibleActivitySteps(activity)
  const style = { '--task-progress-angle': `${progress.percent * 3.6}deg` } as CSSProperties
  const currentDetail = progress.phase === 'planning'
    ? '正在校准需求并生成执行计划'
    : progress.phase === 'verifying'
      ? '正在按验收标准检查执行结果'
      : progress.activeStep ?? '等待下一步'
  const compactStatus = progress.totalSteps > 0
    ? `${progress.completedSteps}/${progress.totalSteps} 步`
    : '准备中'

  function clearHoverTimer() {
    window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = undefined
  }

  function clearCloseTimer() {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }

  function openImmediately() {
    clearHoverTimer()
    clearCloseTimer()
    setPopoverOpen(true)
  }

  function scheduleOpen() {
    clearCloseTimer()
    if (popoverOpen || hoverTimerRef.current !== undefined) return
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined
      setPopoverOpen(true)
    }, TASK_PROGRESS_HOVER_DELAY_MS)
  }

  function scheduleClose() {
    clearHoverTimer()
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      setPopoverOpen(false)
    }, TASK_PROGRESS_CLOSE_DELAY_MS)
  }

  useEffect(() => {
    if (!popoverOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node)) setPopoverOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [popoverOpen])

  useEffect(() => () => {
    clearHoverTimer()
    clearCloseTimer()
  }, [])

  return (
    <button
      ref={indicatorRef}
      type="button"
      className={`task-progress-indicator phase-${progress.phase} ${popoverOpen ? 'popover-open' : ''}`}
      style={style}
      aria-label={`${progress.label}，${compactStatus}，${progress.percent}%`}
      aria-expanded={popoverOpen}
      aria-controls={popoverId}
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onFocus={openImmediately}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose()
      }}
      onClick={openImmediately}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setPopoverOpen(false)
        event.currentTarget.blur()
      }}
    >
      <span className="task-progress-ring" aria-hidden="true" />
      <span id={popoverId} className={`task-progress-popover ${popoverOpen ? 'open' : ''}`}>
          <span className="task-progress-popover-head">
            <strong>{progress.label}</strong>
            <span>{progress.percent}%</span>
          </span>
          <span className="task-progress-popover-copy">{currentDetail}</span>
          <span className="task-progress-popover-meta">{compactStatus} · {formatDurationMs(now - activity.startedAt)}</span>
          {activity.taskBook?.assessment.requiresTaskBook && visibleSteps.length > 0 && (
            <span className="task-progress-step-list">
              {visibleSteps.map((step) => (
                <span key={step.stepId} className={`task-progress-step ${step.status}`}>
                  <span className="task-progress-step-dot" aria-hidden="true" />
                  <span>{step.title}</span>
                </span>
              ))}
            </span>
          )}
      </span>
    </button>
  )
}


export function liveToolStatusClass(tool: LiveToolEvent): 'pending' | 'pass' | 'fail' {
  if (tool.ok === undefined) return 'pending'
  return tool.ok ? 'pass' : 'fail'
}


export function shortActivityText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}


export function formatToolInput(tool: LiveToolEvent): string {
  if (tool.input === undefined) return ''
  if (typeof tool.input === 'string') return tool.input
  if (isRecord(tool.input)) {
    const command = tool.input.command
    if (typeof command === 'string') return `$ ${command}`
  }
  return formatUnknownForActivity(tool.input)
}


export function formatToolResult(tool: LiveToolEvent): string {
  if (tool.error) return tool.error
  if (tool.output === undefined) return ''
  return typeof tool.output === 'string' ? tool.output : formatUnknownForActivity(tool.output)
}


export function formatUnknownForActivity(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
