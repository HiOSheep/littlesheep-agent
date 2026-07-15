// Conversation rendering and execution-progress presentation.
import { useEffect, useState, type ReactNode } from 'react'
import {
  type HistoryMessage
} from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { Markdown } from '../Markdown'
import {
  executionDisclosureDefaultOpen,
  executionDisclosureResetKey,
  verificationDisclosureDefaultOpen,
  verificationDisclosureResetKey,
} from '../progressive-disclosure'
import { TraceCard } from '../TraceCard'
import { FileGlyphIcon } from '../ui/icons'
import { assistantTurnStatusLabel, buildArtifactsFromLiveTools, formatMaybeDuration, liveStepStatusLabel, toolFilePath, verificationSummary, verificationVerdictLabel } from './activity-model'
import { formatToolInput, formatToolResult, liveToolStatusClass, shortActivityText, toolShellTitle } from './task-progress-indicator'
import { AssistantTurnActivity, ChatMessage, LiveToolEvent } from './types'


export function AssistantTurnMessage({
  message,
  now,
  onOpenFile,
  onToggleActivity,
}: {
  message: ChatMessage
  now: number
  onOpenFile: (path: string) => void
  onToggleActivity: () => void
}) {
  const activity = message.activity
  if (!activity) {
    return (
      <div className="message assistant">
        {message.text ? <Markdown text={message.text} /> : <span className="loading">思考中...</span>}
        {(message.trace || message.toolCalls) && (
          <TraceCard trace={message.trace} toolCalls={message.toolCalls} durationMs={message.durationMs} onOpenFile={onOpenFile} />
        )}
        {message.artifacts && message.artifacts.length > 0 && (
          <MessageFileStrip files={message.artifacts} label="产物" onOpenFile={onOpenFile} />
        )}
      </div>
    )
  }

  const collapsed = Boolean(message.activityCollapsed)
  const commandCount = activity.tools.length
  const runningCommands = activity.tools.filter((tool) => tool.ok === undefined).length

  return (
    <section className={`assistant-turn ${activity.status} ${collapsed ? 'collapsed' : ''}`}>
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
      <div className={`assistant-turn-process disclosure-panel ${collapsed ? '' : 'open'}`} aria-hidden={collapsed}>
        <div className="assistant-turn-process-inner">
          <ActivityDisclosure title="指令" meta="1 条" defaultOpen={false}>
            <div className="assistant-turn-instruction">
              <Markdown text={activity.instruction} />
            </div>
          </ActivityDisclosure>
          <ActivityDisclosure
            title="执行过程"
            meta={runningCommands > 0 ? `正在运行 ${runningCommands} 条命令` : commandCount > 0 ? `已运行 ${commandCount} 条命令` : '等待执行'}
            defaultOpen={executionDisclosureDefaultOpen(activity.status)}
            resetKey={executionDisclosureResetKey(activity.status)}
          >
            <ActivityTimeline activity={activity} now={now} onOpenFile={onOpenFile} />
          </ActivityDisclosure>
          {(activity.verificationRunning || (activity.verificationHistory?.length ?? 0) > 0) && (
            <ActivityDisclosure
              title="验证"
              meta={activity.verificationRunning ? '正在验证' : verificationSummary(activity.verificationHistory)}
              defaultOpen={verificationDisclosureDefaultOpen(Boolean(activity.verificationRunning))}
              resetKey={verificationDisclosureResetKey(activity.status, Boolean(activity.verificationRunning))}
            >
              <VerificationTimeline activity={activity} />
            </ActivityDisclosure>
          )}
        </div>
      </div>
      <div className="message assistant assistant-final">
        {message.text ? <Markdown text={message.text} /> : <span className="loading task-running-text is-running">正在执行...</span>}
        {message.artifacts && message.artifacts.length > 0 && (
          <MessageFileStrip files={message.artifacts} label="产物" onOpenFile={onOpenFile} />
        )}
      </div>
    </section>
  )
}


export function ActivityDisclosure({
  title,
  meta,
  defaultOpen = false,
  resetKey,
  children,
}: {
  title: string
  meta?: string
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
        <span className="activity-disclosure-title">{title}</span>
        {meta && <span className="activity-disclosure-meta">{meta}</span>}
        <span className="activity-disclosure-chevron" aria-hidden="true" />
      </button>
      <div className={`activity-disclosure-body disclosure-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="activity-disclosure-inner">{children}</div>
      </div>
    </section>
  )
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
  if (activity.steps.length === 0 && activity.tools.length === 0) {
    return <div className="activity-empty">等待状态机进入执行阶段。</div>
  }

  return (
    <div className="activity-timeline">
      {activity.steps.map((step) => {
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
      <div className={`activity-command-body disclosure-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
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
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    durationMs: message.durationMs,
    activity: message.activity,
    activityCollapsed: message.activityCollapsed,
    artifacts,
  }
}
