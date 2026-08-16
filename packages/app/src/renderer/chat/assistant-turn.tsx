// Conversation rendering and execution-progress presentation.
import { memo } from 'react'
import type { TaskComplexity } from '@littlesheep/types'
import type { HistoryMessage } from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { InlineMarkdown, Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import {
  buildArtifactsFromLiveTools,
  formatDurationMs,
  formatMaybeDuration,
  liveStepStatusLabel,
  verificationVerdictLabel,
} from './activity-model'
import { visibleActivitySteps } from './activity-visibility'
import { AgentToolRow } from './agent-tool-row'
import type {
  AssistantTurnActivity,
  ChatMessage,
  LiveReasoningEvent,
  LiveStepEvent,
  LiveToolEvent,
} from './types'


interface AssistantTurnMessageProps {
  message: ChatMessage
  messageKey?: string
  now: number
  onOpenFile: (path: string) => void
}


export const AssistantTurnMessage = memo(function AssistantTurnMessage({
  message,
  messageKey,
  now,
  onOpenFile,
}: AssistantTurnMessageProps) {
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

  const responseVisible = activity.status === 'running'
    || Boolean(message.text.trim() || activity.error || message.artifacts?.length)

  return (
    <section className={`assistant-turn ${activity.status}`} data-message-key={messageKey}>
      <AssistantActivityFlow activity={activity} now={now} onOpenFile={onOpenFile} />
      {responseVisible && (
        <div
          className="message assistant assistant-final assistant-response-stream"
          data-stream-state={activity.status === 'running' ? 'streaming' : 'settled'}
          aria-live={activity.status === 'running' ? 'polite' : undefined}
        >
          <Markdown text={message.text} streaming={activity.status === 'running'} />
          {!message.text && activity.error && (
            <span className="run-status-error">{activity.error}</span>
          )}
          {message.artifacts && message.artifacts.length > 0 && (
            <MessageFileStrip files={message.artifacts} label="产出成果" onOpenFile={onOpenFile} />
          )}
        </div>
      )}
    </section>
  )
}, sameAssistantTurnProps)


function sameAssistantTurnProps(
  previous: AssistantTurnMessageProps,
  next: AssistantTurnMessageProps,
): boolean {
  if (
    previous.message !== next.message
    || previous.messageKey !== next.messageKey
    || previous.onOpenFile !== next.onOpenFile
  ) return false
  return previous.message.activity?.status !== 'running' || previous.now === next.now
}


export function AssistantActivityFlow({
  activity,
  now,
  onOpenFile,
}: {
  activity: AssistantTurnActivity
  now: number
  onOpenFile: (path: string) => void
}) {
  const steps = visibleActivitySteps(activity)
  const visibleStepIds = new Set(steps.map((step) => step.stepId))
  const standaloneTools = activity.tools.filter((tool) => !tool.stepId || !visibleStepIds.has(tool.stepId))

  return (
    <div className="assistant-activity-flow" role="group" aria-label="Agent 工作过程">
      <AgentReasoningRow activity={activity} now={now} />
      {steps.map((step) => (
        <AgentStepGroup
          key={step.stepId}
          step={step}
          tools={activity.tools.filter((tool) => tool.stepId === step.stepId)}
          now={now}
          onOpenFile={onOpenFile}
        />
      ))}
      {standaloneTools.length > 0 && (
        <AgentToolList tools={standaloneTools} now={now} onOpenFile={onOpenFile} />
      )}
      <AgentVerificationFlow activity={activity} />
    </div>
  )
}


function AgentReasoningRow({
  activity,
  now,
}: {
  activity: AssistantTurnActivity
  now: number
}) {
  const assessment = activity.taskBook?.assessment
  const reasoning = activity.reasoning ?? []
  const currentReasoning = reasoning.at(-1)
  const running = activity.status === 'running' && currentReasoning?.status !== 'failed'
  const settledSummary = assessment?.rationale
    || assessment?.userNeed
    || assessment?.goal
    || reasoning[0]?.summary
    || '已完成响应判断'
  const summary = activity.status === 'running'
    ? currentReasoning?.summary
      || assessment?.rationale
      || assessment?.userNeed
      || '正在理解需求并确定执行范围'
    : settledSummary
  const assessmentDetail = assessment ? reasoningMarkdown(assessment) : ''
  const hasDetails = reasoning.length > 0 || Boolean(assessmentDetail)
  const taskMeta = currentReasoning?.status === 'running'
    ? formatMaybeDuration(currentReasoning.startedAt, currentReasoning.endedAt, now)
    : activity.taskBook
      ? `${taskComplexityLabel(activity.taskBook.complexity)} · ${activity.taskBook.steps.length} 步`
      : formatMaybeDuration(activity.startedAt, activity.endedAt, now)

  return (
    <section className="agent-reasoning">
      <div className={`agent-flow-row agent-reasoning-heading ${running ? 'is-active' : ''}`}>
        <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true">...</span>
        <span className={`agent-flow-title ${running ? 'is-running' : ''}`}>思考</span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">
          <InlineMarkdown text={summary} />
        </span>
        <span className="agent-flow-meta">{taskMeta}</span>
        {running && (
          <span className="agent-flow-sr-only" role="status" aria-live="polite">
            正在思考：{summary}
          </span>
        )}
      </div>
      {hasDetails && (
        <div className="agent-flow-details agent-reasoning-public-details">
          {reasoning.length > 0 && (
            <ReasoningTimeline events={reasoning} now={now} />
          )}
          {assessmentDetail && (
            <div className="agent-reasoning-assessment">
              <Markdown text={assessmentDetail} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}


function ReasoningTimeline({ events, now }: { events: LiveReasoningEvent[]; now: number }) {
  return (
    <div className="agent-reasoning-timeline" aria-label="思考与执行判断轨迹">
      {events.map((event) => (
        <div key={event.phaseId} className={`agent-reasoning-entry ${event.status}`}>
          <span className="agent-reasoning-entry-state" aria-hidden="true" />
          <span className="agent-reasoning-entry-summary">
            <InlineMarkdown text={event.summary} />
          </span>
          <span className="agent-reasoning-entry-meta">
            {event.durationMs === undefined
              ? formatMaybeDuration(event.startedAt, event.endedAt, now)
              : formatDurationMs(event.durationMs)}
          </span>
        </div>
      ))}
    </div>
  )
}


function AgentStepGroup({
  step,
  tools,
  now,
  onOpenFile,
}: {
  step: LiveStepEvent
  tools: LiveToolEvent[]
  now: number
  onOpenFile: (path: string) => void
}) {
  const running = step.status === 'running'
  const description = distinctActivityText(step.description, step.title)
  const result = step.error || ''

  return (
    <section className={`agent-step-group ${step.status}`} data-step-id={step.stepId}>
      <div className={`agent-flow-row agent-step-row ${running ? 'is-active' : ''}`}>
        <span className={`agent-flow-glyph agent-step-glyph ${step.status}`} aria-hidden="true" />
        <span className={`agent-flow-title ${running ? 'is-running' : ''}`}>
          {running ? '执行' : liveStepStatusLabel(step.status)}
        </span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">
          <InlineMarkdown text={step.title} />
        </span>
        <span className="agent-flow-meta">{formatMaybeDuration(step.startedAt, step.endedAt, now)}</span>
        <span aria-hidden="true" />
        {running && (
          <span className="agent-flow-sr-only" role="status" aria-live="polite">
            正在执行：{step.title}
          </span>
        )}
      </div>
      {description && (
        <div className="agent-flow-copy">
          <Markdown text={description} />
        </div>
      )}
      {tools.length > 0 && (
        <div className="agent-flow-children">
          <AgentToolList tools={tools} now={now} onOpenFile={onOpenFile} />
        </div>
      )}
      {result && (
        <div className={`agent-flow-copy agent-step-result ${step.error ? 'error' : ''}`}>
          <Markdown text={result} />
        </div>
      )}
    </section>
  )
}


function AgentToolList({
  tools,
  now,
  onOpenFile,
}: {
  tools: LiveToolEvent[]
  now: number
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="agent-tool-list">
      {tools.map((tool) => (
        <AgentToolRow key={tool.callId} tool={tool} now={now} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}


function AgentVerificationFlow({ activity }: { activity: AssistantTurnActivity }) {
  const records = activity.verificationHistory ?? []
  if (!activity.verificationRunning && records.length === 0) return null

  return (
    <section className="agent-verification-flow" aria-label="验证过程">
      {records.map((record) => (
        <div key={`${record.attempt}:${record.verifiedAt}`} className={`agent-flow-row agent-verification-row ${record.verdict}`}>
          <span className={`agent-flow-glyph agent-verification-glyph ${record.verdict}`} aria-hidden="true" />
          <span className="agent-flow-title">{verificationVerdictLabel(record.verdict)}</span>
          <span className="agent-flow-separator" aria-hidden="true" />
          <span className="agent-flow-summary">
            <InlineMarkdown text={record.reason} />
          </span>
          <span className="agent-flow-meta">第 {record.attempt} 次</span>
          <span aria-hidden="true" />
        </div>
      ))}
      {activity.verificationRunning && (
        <div className="agent-flow-row agent-verification-row running is-active">
          <span className="agent-flow-glyph agent-verification-glyph running" aria-hidden="true" />
          <span className="agent-flow-title is-running">验证</span>
          <span className="agent-flow-separator" aria-hidden="true" />
          <span className="agent-flow-summary">
            <InlineMarkdown text="正在按任务目标、步骤证据和验收标准检查结果" />
          </span>
          <span className="agent-flow-meta" />
          <span aria-hidden="true" />
          <span className="agent-flow-sr-only" role="status" aria-live="polite">正在验证结果</span>
        </div>
      )}
    </section>
  )
}


function reasoningMarkdown(assessment: NonNullable<AssistantTurnActivity['taskBook']>['assessment']): string {
  const sections = [assessment.rationale || assessment.userNeed]
  if (assessment.goal) sections.push(`**目标**\n\n${assessment.goal}`)
  if (assessment.successCriteria.length > 0) {
    sections.push(`**验收标准**\n\n${assessment.successCriteria.map((item) => `- ${item}`).join('\n')}`)
  }
  return sections.filter(Boolean).join('\n\n')
}


function distinctActivityText(value: string | undefined, title: string): string {
  if (!value) return ''
  const normalized = value.replace(/\s+/gu, ' ').trim()
  const normalizedTitle = title.replace(/\s+/gu, ' ').trim()
  return normalized && normalized !== normalizedTitle ? value : ''
}


function taskComplexityLabel(complexity: TaskComplexity): string {
  if (complexity === 'trivial') return '轻量任务'
  if (complexity === 'simple') return '简单任务'
  if (complexity === 'complex') return '复杂任务'
  return '普通任务'
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
