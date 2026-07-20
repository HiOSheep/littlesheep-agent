// Conversation rendering and execution-progress presentation.
import { useEffect, useState, type ReactNode } from 'react'
import type { TaskComplexity } from '@littlesheep/types'
import {
  type HistoryMessage
} from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import {
  executionDisclosureDefaultOpen,
  executionDisclosureResetKey,
} from '../progressive-disclosure'
import { TraceCard } from '../TraceCard'
import { FileGlyphIcon } from '../ui/icons'
import { assistantTurnStatusLabel, buildArtifactsFromLiveTools, formatMaybeDuration, liveStepStatusLabel, toolFilePath, verificationSummary, verificationVerdictLabel } from './activity-model'
import { hasExecutionStarted, visibleActivitySteps } from './activity-visibility'
import { formatToolInput, formatToolResult, liveToolStatusClass, shortActivityText, toolShellTitle } from './task-progress-indicator'
import { AssistantTurnActivity, ChatMessage, LiveToolEvent } from './types'


export function AssistantTurnMessage({
  message,
  messageKey,
  now,
  onOpenFile,
  onToggleActivity,
}: {
  message: ChatMessage
  messageKey?: string
  now: number
  onOpenFile: (path: string) => void
  onToggleActivity: () => void
}) {
  const activity = message.activity
  if (!activity) {
    return (
      <div className="message assistant" data-message-key={messageKey}>
        {message.text ? <Markdown text={message.text} /> : <span className="loading">思考中...</span>}
        {(message.trace || message.toolCalls) && (
          <TraceCard trace={message.trace} toolCalls={message.toolCalls} durationMs={message.durationMs} onOpenFile={onOpenFile} />
        )}
        {message.artifacts && message.artifacts.length > 0 && (
          <MessageFileStrip files={message.artifacts} label="产出成果" onOpenFile={onOpenFile} />
        )}
      </div>
    )
  }

  const collapsed = Boolean(message.activityCollapsed)
  const commandCount = activity.tools.length
  const runningCommands = activity.tools.filter((tool) => tool.ok === undefined).length
  const visibleSteps = visibleActivitySteps(activity)
  const runningSteps = visibleSteps.filter((step) => step.status === 'running').length
  const thoughtRunning = activity.status === 'running' && !activity.taskBook
  const executionStarted = hasExecutionStarted(activity)
  const executionRunning = activity.status === 'running' && executionStarted
  const thoughtMeta = activity.taskBook
    ? `${taskComplexityLabel(activity.taskBook.complexity)} · ${activity.taskBook.steps.length} 个步骤`
    : '正在判断目标与范围'
  const executionMeta = runningCommands > 0
    ? `正在运行 ${runningCommands} 条命令`
    : runningSteps > 0
      ? `正在执行 ${runningSteps} 个步骤`
      : activity.verificationRunning
        ? '正在验证结果'
        : commandCount > 0
          ? `已运行 ${commandCount} 条命令`
          : visibleSteps.length > 0
            ? `已记录 ${visibleSteps.length} 个步骤`
            : verificationSummary(activity.verificationHistory)
  const hasFinalContent = Boolean(message.text.trim() || activity.error || message.artifacts?.length)

  return (
    <section className={`assistant-turn ${activity.status} ${collapsed ? 'collapsed' : ''}`} data-message-key={messageKey}>
      <button
        type="button"
        className="assistant-turn-header"
        aria-expanded={!collapsed}
        onClick={onToggleActivity}
      >
        <span className={`assistant-turn-status ${activity.status === 'running' ? 'is-running' : ''}`}>
          {assistantTurnStatusLabel(activity, now)}
        </span>
        <span className="assistant-turn-chevron" aria-hidden="true" />
      </button>
      <div
        className={`assistant-turn-process disclosure-panel ${collapsed ? '' : 'open'}`}
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
      >
        <div className="assistant-turn-process-inner">
          <ActivityDisclosure
            title={thoughtRunning ? '思考中' : '思考'}
            meta={thoughtMeta}
            running={thoughtRunning}
            defaultOpen={thoughtRunning}
            resetKey={activity.taskBook ? 'thought-ready' : 'thought-running'}
          >
            <ThoughtSummary activity={activity} />
          </ActivityDisclosure>
          {executionStarted && (
            <ActivityDisclosure
              title={executionRunning ? '执行中' : '执行'}
              meta={executionMeta}
              running={executionRunning}
              defaultOpen={executionDisclosureDefaultOpen(activity.status)}
              resetKey={executionDisclosureResetKey(activity.status)}
            >
              {(visibleSteps.length > 0 || commandCount > 0) && (
                <ActivityTimeline activity={activity} now={now} onOpenFile={onOpenFile} />
              )}
              {(activity.verificationRunning || (activity.verificationHistory?.length ?? 0) > 0) && (
                <div className="activity-verification-block">
                  <div className="activity-verification-heading">
                    <strong className={activity.verificationRunning ? 'is-running' : ''}>
                      {activity.verificationRunning ? '正在验证' : '验证'}
                    </strong>
                    <span>{activity.verificationRunning ? '检查任务是否真正达标' : verificationSummary(activity.verificationHistory)}</span>
                  </div>
                  <VerificationTimeline activity={activity} />
                </div>
              )}
            </ActivityDisclosure>
          )}
        </div>
      </div>
      {hasFinalContent && (
        <div className="message assistant assistant-final">
          {message.text
            ? <Markdown text={message.text} />
            : activity.error
              ? <span className="run-status-error">{activity.error}</span>
              : null}
          {message.artifacts && message.artifacts.length > 0 && (
            <MessageFileStrip files={message.artifacts} label="产出成果" onOpenFile={onOpenFile} />
          )}
        </div>
      )}
    </section>
  )
}


export function ActivityDisclosure({
  title,
  meta,
  running = false,
  defaultOpen = false,
  resetKey,
  children,
}: {
  title: string
  meta?: string
  running?: boolean
  defaultOpen?: boolean
  resetKey?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (resetKey !== undefined) setOpen(defaultOpen)
  }, [defaultOpen, resetKey])

  return (
    <section className={`activity-disclosure ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="activity-disclosure-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`activity-disclosure-title ${running ? 'is-running' : ''}`}>{title}</span>
        {meta && <span className="activity-disclosure-meta">{meta}</span>}
        <span className="activity-disclosure-chevron" aria-hidden="true" />
      </button>
      <div
        className={`activity-disclosure-body disclosure-panel ${open ? 'open' : ''}`}
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="activity-disclosure-inner">{children}</div>
      </div>
    </section>
  )
}


function ThoughtSummary({ activity }: { activity: AssistantTurnActivity }) {
  const assessment = activity.taskBook?.assessment
  if (!assessment) {
    return <div className="activity-empty">正在理解需求，并确定合适的执行范围。</div>
  }

  return (
    <div className="assistant-thought-summary">
      <p>{assessment.rationale || assessment.userNeed}</p>
      <dl>
        <div>
          <dt>目标</dt>
          <dd>{assessment.goal}</dd>
        </div>
        <div>
          <dt>验收</dt>
          <dd>{assessment.successCriteria.join('；')}</dd>
        </div>
      </dl>
    </div>
  )
}


function taskComplexityLabel(complexity: TaskComplexity): string {
  if (complexity === 'trivial') return '轻量任务'
  if (complexity === 'simple') return '简单任务'
  if (complexity === 'complex') return '复杂任务'
  return '普通任务'
}


export function ActivityTimeline({
  activity,
  now,
  onOpenFile,
}: {
  activity: AssistantTurnActivity
  now: number
  onOpenFile: (path: string) => void
}) {
  const visibleSteps = visibleActivitySteps(activity)
  if (visibleSteps.length === 0 && activity.tools.length === 0) return null

  return (
    <div className="activity-timeline">
      {visibleSteps.map((step) => {
        const tools = activity.tools.filter((tool) => tool.stepId === step.stepId)
        return (
          <div key={step.stepId} className={`activity-timeline-step ${step.status}`}>
            <div className="activity-timeline-step-head">
              <span className="activity-step-dot" aria-hidden="true" />
              <span className={`activity-timeline-title ${step.status === 'running' ? 'is-running' : ''}`}>
                {step.status === 'running' ? '正在执行' : liveStepStatusLabel(step.status)}：{step.title}
              </span>
              <span className="activity-timeline-duration">{formatMaybeDuration(step.startedAt, step.endedAt, now)}</span>
            </div>
            {step.description && <div className="activity-timeline-copy">{shortActivityText(step.description, 130)}</div>}
            {tools.length > 0 && <ActivityToolList tools={tools} now={now} onOpenFile={onOpenFile} />}
          </div>
        )
      })}
      {activity.tools.some((tool) => !tool.stepId) && (
        <ActivityToolList tools={activity.tools.filter((tool) => !tool.stepId)} now={now} onOpenFile={onOpenFile} />
      )}
    </div>
  )
}


export function VerificationTimeline({ activity }: { activity: AssistantTurnActivity }) {
  const records = activity.verificationHistory ?? []
  return (
    <div className="verification-timeline">
      {records.map((record) => (
        <div key={`${record.attempt}:${record.verifiedAt}`} className={`verification-record ${record.verdict}`}>
          <span className="verification-record-dot" aria-hidden="true" />
          <span className="verification-record-main">
            <strong>{verificationVerdictLabel(record.verdict)}</strong>
            <span>{record.reason}</span>
          </span>
          <span className="verification-record-attempt">第 {record.attempt} 次</span>
        </div>
      ))}
      {activity.verificationRunning && (
        <div className="verification-record running">
          <span className="verification-record-dot" aria-hidden="true" />
          <span className="verification-record-main">
            <strong className="is-running">正在验证</strong>
            <span>按任务目标、步骤证据和验收标准检查结果。</span>
          </span>
        </div>
      )}
    </div>
  )
}


export function ActivityToolList({
  tools,
  now,
  onOpenFile,
}: {
  tools: LiveToolEvent[]
  now: number
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="activity-command-list">
      {tools.map((tool) => (
        <ActivityCommandItem key={tool.callId} tool={tool} now={now} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}


export function ActivityCommandItem({
  tool,
  now,
  onOpenFile,
}: {
  tool: LiveToolEvent
  now: number
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const status = tool.ok === undefined ? '正在运行' : tool.ok ? '已运行' : '运行失败'
  const commandText = formatToolInput(tool)
  const resultText = formatToolResult(tool)
  const targetPath = toolFilePath(tool.input)

  return (
    <section className={`activity-command ${liveToolStatusClass(tool)} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="activity-command-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-command-icon" aria-hidden="true" />
        <span className={`activity-command-label ${tool.ok === undefined ? 'is-running' : ''}`}>
          {status} {tool.name}
        </span>
        <span className="activity-command-duration">{formatMaybeDuration(tool.startedAt, tool.endedAt, now)}</span>
        <span className="activity-command-chevron" aria-hidden="true" />
      </button>
      <div
        className={`activity-command-body disclosure-panel ${open ? 'open' : ''}`}
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
      >
        <div className="activity-command-shell">
          <div className="activity-command-shell-title">
            <span>{toolShellTitle(tool.name)}</span>
            {targetPath && (
              <button
                type="button"
                className="activity-command-file-action"
                onClick={() => onOpenFile(targetPath)}
              >
                <FileGlyphIcon />
                <span>打开文件</span>
              </button>
            )}
          </div>
          {commandText && <pre>{commandText}</pre>}
          {resultText && <pre className={tool.ok === false ? 'error' : ''}>{resultText}</pre>}
          {!commandText && !resultText && <div className="activity-command-empty">暂无可展开内容。</div>}
          {tool.ok !== undefined && (
            <div className={`activity-command-shell-status ${tool.ok ? 'pass' : 'fail'}`}>
              {tool.ok ? '成功' : '失败'}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}


export function historyMessageToChatMessage(message: HistoryMessage): ChatMessage {
  const artifacts = buildArtifactsFromLiveTools(message.activity?.tools)
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    durationMs: message.durationMs,
    activity: message.activity,
    activityCollapsed: message.activityCollapsed,
    artifacts,
  }
}
