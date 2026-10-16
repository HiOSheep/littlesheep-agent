// Conversation rendering and execution-progress presentation.
import { memo, useId, useState } from 'react'
import type { HistoryMessage } from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { ActivityGlyph } from './activity-glyph'
import { AssistantTranscript, ConversationTimeline } from './assistant-transcript'
export { AssistantTranscript } from './assistant-transcript'
import { TurnUsageButton, turnUsageFigures, turnUsageLabel } from './turn-usage-card'
import { InlineMarkdown, Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import {
  buildArtifactsFromLiveTools,
  formatMaybeDuration,
  liveStepStatusLabel,
} from './activity-model'
import { visibleActivitySteps } from './activity-visibility'
import { summarizeCacheCallGroups } from '../../shared/cache-call-observations'
import { AgentToolRow } from './agent-tool-row'
import { ActivityAttentionRow } from './attention-row'
import { DisclosurePanel } from './disclosure-panel'
import { MessageMeta } from './message-meta'
import { WebSources } from './web-sources'
import type {
  AssistantTurnActivity,
  ChatMessage,
  LiveStepEvent,
  LiveToolEvent,
  TranscriptEntry,
} from './types'
import { activityAttentionLine, activityVerificationLine } from './activity-visibility'

interface AssistantTurnMessageProps {
  message: ChatMessage
  messageKey?: string
  now: number
  /** The workspace the turn's files live in, for their line counts. */
  workspaceRoot?: string
  onOpenFile: (path: string) => void
  /** Forks the conversation at this turn. */
  onBranch?: (messageId: string) => void
  /** Opens one of the turn's files in the workspace review. */
  onOpenReview?: (path: string) => void
  /** Opens the durable daily usage history for this turn. */
  onOpenUsageHistory?: () => void
  /**
   * Re-runs a failed turn's own instruction. Present whenever the app can start a run at all; the
   * turn decides whether it offers the action (only a failed turn can be retried).
   */
  onRetryTurn?: (instruction: string) => void
  /** A run of this conversation is already in flight, so the retry cannot be dispatched yet. */
  retryPending?: boolean
}

export const AssistantTurnMessage = memo(function AssistantTurnMessage({
  message,
  messageKey,
  now,
  workspaceRoot,
  onOpenFile,
  onOpenReview,
  onOpenUsageHistory,
  onBranch,
  onRetryTurn,
  retryPending = false,
}: AssistantTurnMessageProps) {
  const [processOpenOverride, setProcessOpenOverride] = useState<boolean | null>(null)
  const processId = useId()
  const activity = message.activity
  if (!activity) {
    return (
      <div className="message-with-meta assistant" data-message-key={messageKey}>
        <div className="message assistant">
          {message.text ? <Markdown text={message.text} /> : <span className="loading">思考中...</span>}
          {(message.trace || message.toolCalls) && (
            <TraceCard trace={message.trace} toolCalls={message.toolCalls} durationMs={message.durationMs} onOpenFile={onOpenFile} />
          )}
          {message.artifacts && message.artifacts.length > 0 && (
            <MessageFileStrip files={message.artifacts} label="产出成果" workspaceRoot={workspaceRoot} toolCalls={message.activity?.tools} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
          )}
          {message.webEvidence && <WebSources evidence={message.webEvidence} />}
        </div>
        <MessageMeta
          role="assistant"
          text={message.text}
          timestamp={message.timestamp}
          onBranch={message.id && onBranch ? () => onBranch(message.id as string) : undefined}
          usageAction={<TurnUsageAction message={message} onOpenUsageHistory={onOpenUsageHistory} />}
        />
      </div>
    )
  }

  const responseVisible = Boolean(message.text.trim() || activity.error || message.artifacts?.length)
    || (activity.status === 'running' && !activity.transcript?.some((entry) => entry.kind === 'text'))
  const processOpen = processOpenOverride ?? false
  const processTranscript = transcriptWithoutAnswer(activity.transcript ?? [], message.text)
  const timeline = processTranscript.filter((entry) => entry.kind !== 'system')
  const diagnostics = processTranscript.filter((entry) => entry.kind === 'system')
  const processLabel = activity.status === 'running' ? `正在工作 · ${formatMaybeDuration(activity.startedAt, undefined, now)}`
    : activity.status === 'done' ? `用时 ${formatMaybeDuration(activity.startedAt, activity.endedAt, now)}`
      : activity.status === 'aborted' ? '已停止' : activity.status === 'failed' ? '执行失败' : '等待处理'
  const processCounts = turnCountsLine(activity)
  // The verdict rides on the trigger too: while the run is still going it would
  // read as a judgement on an unfinished turn.
  // An ordinary reply without tool work has no acceptance result to advertise.
  // Keep the original records in the expanded process and all failures in the attention line.
  const neutralUnverifiedReply = (activity.tools?.length ?? 0) === 0
    && activity.verificationHistory?.every((record) => record.verdict === 'unverified')
  const processVerification = activity.status === 'running' || activityAttentionLine(activity) || neutralUnverifiedReply
    ? null
    : activityVerificationLine(activity)

  return (
    <section className={`assistant-turn ${activity.status}`} data-message-key={messageKey}>
      <button type="button" className="assistant-process-trigger" aria-expanded={processOpen} aria-controls={processId}
        onClick={() => setProcessOpenOverride(!processOpen)}>
        <span className={`assistant-process-label${activity.status === 'running' ? ' is-running' : ''}`}>{processLabel}</span>
        {processCounts && <span className="assistant-process-counts">{processCounts}</span>}
        {processVerification && (
          <span className="assistant-process-verification">{processVerification}</span>
        )}
        <span className={`agent-flow-chevron ${processOpen ? 'open' : ''}`} aria-hidden="true" />
      </button>
      {/* Outside the panel on purpose: folding the process away must never take an unresolved
          failure, a pending decision or a verdict that did not pass with it (O1). */}
      <ActivityAttentionRow activity={activity} />
      {/* The failed turn's action, in the same place for the same reason: a failure that states its
          cause and offers nothing to do about it is a dead end (`ui/state-view.ts`: a failure allows
          an action). Only a failed turn offers it — an aborted or waiting run needs a decision, and
          a finished one has nothing to redo — and it is rendered outside the folding body so neither
          display mode nor the reader's own fold can take it away. */}
      {activity.status === 'failed' && onRetryTurn && activity.instruction.trim() !== '' && (
        <div className="assistant-turn-retry-row">
          <button
            type="button"
            className="feedback-action assistant-turn-retry"
            disabled={retryPending}
            aria-label="重试这一轮"
            onClick={() => onRetryTurn(activity.instruction)}
          >
            重试
          </button>
          {retryPending && <span className="assistant-retry-hint">当前运行结束后可重试</span>}
        </div>
      )}
      <DisclosurePanel id={processId} open={processOpen} className="assistant-process-content">
        <ContextProjectionRows rows={activity.contextProjections ?? []} />
        <AssistantTranscript transcript={diagnostics} activity={activity} now={now} onOpenFile={onOpenFile} showStatus={false} />
      </DisclosurePanel>
      {timeline.length > 0
        ? <ConversationTimeline transcript={timeline} activity={activity} now={now} onOpenFile={onOpenFile} />
        : <AssistantActivityFlow activity={activity} now={now} onOpenFile={onOpenFile} />}
      <div className="assistant-approval-seat" />
      {responseVisible && (
        <div className="message-with-meta assistant">
          <div
            className="message assistant assistant-final assistant-response-stream"
            data-stream-state={activity.status === 'running' ? 'streaming' : 'settled'}
            aria-live={activity.status === 'running' ? 'polite' : undefined}
          >
            <Markdown text={message.text} streaming={activity.status === 'running'} />
            {activity.error && (
              <span className="run-status-error">{activity.error}</span>
            )}
            {message.artifacts && message.artifacts.length > 0 && (
              <MessageFileStrip files={message.artifacts} label="产出成果" workspaceRoot={workspaceRoot} toolCalls={message.activity?.tools} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
            )}
            {message.webEvidence && <WebSources evidence={message.webEvidence} />}
          </div>
          <MessageMeta
            role="assistant"
            text={message.text}
            timestamp={message.timestamp}
            onBranch={activity.status === 'done' && message.id && onBranch ? () => onBranch(message.id as string) : undefined}
          usageAction={<TurnUsageAction message={message} onOpenUsageHistory={onOpenUsageHistory} />}
          />
        </div>
      )}
    </section>
  )
}, sameAssistantTurnProps)

/** Keep the final answer in one reading seat, without losing earlier model progress. */
export function transcriptWithoutAnswer(transcript: TranscriptEntry[], answer: string): TranscriptEntry[] {
  if (!answer.trim()) return transcript
  let lastText = -1
  for (let index = transcript.length - 1; index >= 0; index--) {
    if (transcript[index]?.kind === 'text') { lastText = index; break }
  }
  const entry = transcript[lastText]
  const matchesAnswer = entry?.kind === 'text' && (entry.text.trim() === answer.trim()
    || (entry.text.endsWith('… [truncated]') && answer.startsWith(entry.text.slice(0, -'… [truncated]'.length))))
  return entry?.kind === 'text' && entry.status !== 'failed' && entry.status !== 'aborted' && matchesAnswer
    ? transcript.filter((_, index) => index !== lastText)
    : transcript
}

function sameAssistantTurnProps(
  previous: AssistantTurnMessageProps,
  next: AssistantTurnMessageProps,
): boolean {
  if (
    previous.message !== next.message
    || previous.messageKey !== next.messageKey
    || previous.onOpenFile !== next.onOpenFile
    || previous.onOpenReview !== next.onOpenReview
    || previous.workspaceRoot !== next.workspaceRoot
    || previous.onBranch !== next.onBranch
    || previous.onOpenUsageHistory !== next.onOpenUsageHistory
    || previous.onRetryTurn !== next.onRetryTurn
    || previous.retryPending !== next.retryPending
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
  if (!isActivityProgressVisible(activity)) return null
  const steps = visibleActivitySteps(activity)
  const visibleStepIds = new Set(steps.map((step) => step.stepId))
  const standaloneTools = activity.tools.filter((tool) => !tool.stepId || !visibleStepIds.has(tool.stepId))

  return (
    <div className="assistant-activity-flow" role="group" aria-label="Agent 工作过程">
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
    </div>
  )
}

/** Legacy history without a visibility field is disclosed only when it has real execution evidence. */
function isActivityProgressVisible(activity: AssistantTurnActivity): boolean {
  return activity.visibility === 'progress'
    || (activity.visibility === undefined && (activity.steps.length > 0 || activity.tools.length > 0))
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
  const [open, setOpen] = useState(true)

  return (
    <div className={`agent-step-group ${step.status}`} data-step-id={step.stepId}>
      <button
        type="button"
        className={`agent-flow-row agent-step-row ${running ? 'is-active' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`agent-flow-glyph agent-step-glyph ${step.status}`} aria-hidden="true"><ActivityGlyph kind="step" /></span>
        <span className={`agent-flow-title ${running ? 'is-running' : ''}`}>
          {running ? '执行' : liveStepStatusLabel(step.status)}
        </span>
        <span className="agent-flow-separator" aria-hidden="true" />
        <span className="agent-flow-summary">
          <InlineMarkdown text={step.title} />
        </span>
        <span className="agent-flow-meta">{formatMaybeDuration(step.startedAt, step.endedAt, now)}</span>
        <span className={`agent-flow-chevron${open ? ' open' : ''}`} aria-hidden="true" />
        {running && (
          <span className="agent-flow-sr-only" role="status" aria-live="polite">
            正在执行：{step.title}
          </span>
        )}
      </button>
      <DisclosurePanel open={open}>
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
      </DisclosurePanel>
    </div>
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

function distinctActivityText(value: string | undefined, title: string): string {
  if (!value) return ''
  const normalized = value.replace(/\s+/gu, ' ').trim()
  const normalizedTitle = title.replace(/\s+/gu, ' ').trim()
  return normalized && normalized !== normalizedTitle ? value : ''
}

export function historyMessageToChatMessage(message: HistoryMessage): ChatMessage {
  const artifacts = buildArtifactsFromLiveTools(message.activity?.tools)
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    durationMs: message.durationMs,
    usage: message.usage,
    modelRef: message.modelRef,
    cacheCalls: message.cacheCalls,
    cacheReasons: message.cacheReasons,
    cacheCallsTruncated: message.cacheCallsTruncated,
    activity: message.activity,
    activityCollapsed: message.activityCollapsed,
    artifacts,
    webEvidence: message.webEvidence,
  }
}

function ContextProjectionRows({ rows }: { rows: NonNullable<AssistantTurnActivity['contextProjections']> }) {
  const [open, setOpen] = useState(false)
  if (!rows.length) return null
  return <div className="assistant-context-projections">
    <button type="button" className="agent-flow-row" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="agent-flow-glyph" aria-hidden="true"><ActivityGlyph kind="system" /></span>
      <span className="agent-flow-title">上下文</span>
      <span className="agent-flow-separator" aria-hidden="true" />
      <span className="agent-flow-summary">{rows.length} 项上下文记录</span>
      <span className={`agent-flow-chevron${open ? ' open' : ''}`} aria-hidden="true" />
    </button>
    <DisclosurePanel open={open}>
      {rows.map((row) => (
        <div key={row.kind} className={`agent-flow-row context-projection-row ${row.kind}`}>
          <span className="agent-flow-glyph context-projection-glyph" aria-hidden="true"><ActivityGlyph kind={row.kind} /></span>
          <span className="agent-flow-title">{row.label}</span>
          <span className="agent-flow-separator" aria-hidden="true" />
          <span className="agent-flow-summary">{row.detail}</span>
        </div>
      ))}
    </DisclosurePanel>
  </div>
}

/**
 * What a settled turn did, as one line on the process trigger: how much of the
 * model's thinking it recorded and how many tools it called. Thinking is named
 * here because it is otherwise invisible once the run settles and folds away —
 * a reader should be able to tell that there is thinking to open. Zero parts
 * are dropped rather than printed ("0 条消息" said nothing).
 */
function turnCountsLine(activity: AssistantTurnActivity): string {
  const transcript = activity.transcript ?? []
  const thinking = transcript.filter((entry) => entry.kind === 'reasoning').length
  const toolCalls = transcript.length > 0
    ? transcript.filter((entry) => entry.kind === 'tool').length
    : activity.tools.length
  return [
    thinking > 0 ? `${thinking} 段思考` : '',
    toolCalls > 0 ? `${toolCalls} 次调用` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * The same numbers, behind one pill. The line that used to run under every answer listed the cache
 * rate four ways, four token kinds and the rate; it is reference material, so it lives in the card
 * the pill opens, together with the per-call cache detail.
 */
function TurnUsageAction({ message, onOpenUsageHistory }: { message: ChatMessage; onOpenUsageHistory?: () => void }) {
  const usage = message.usage
  if (!usage) return null
  const calls = message.cacheCalls ?? []
  const reasons = message.cacheReasons ?? []
  const callGroups = summarizeCacheCallGroups(message.cacheCalls)
  const detailLines = [
    ...calls.map((call) => [
      `#${call.requestIndex} ${call.stage} · ${cacheCallStatusLabel(call.status)}`,
      call.hitRatio === undefined ? '' : `${Math.round(call.hitRatio * 100)}%`,
      call.promptTokens === undefined ? '输入 未提供' : `输入 ${call.promptTokens}`,
      call.cachedPromptTokens === undefined ? '' : `缓存读取 ${call.cachedPromptTokens}`,
      call.uncachedPromptTokens === undefined ? '' : `未缓存 ${call.uncachedPromptTokens}`,
    ].filter(Boolean).join(' · ')),
    reasons.length > 0
      ? `主要原因：${reasons.map((entry) => `${cacheReasonLabel(entry.reason)}×${entry.count}`).join('、')}`
      : '',
  ].filter(Boolean)
  return (
    <span className="message-meta-usage" aria-label="本轮用量">
      <TurnUsageButton
        label={turnUsageLabel(message)}
        onOpenHistory={onOpenUsageHistory}
        figures={[
          ...turnUsageFigures(message),
          ...(callGroups === undefined ? [] : [
            { label: '主对话命中', value: `${Math.round((callGroups.mainConversation.hitRatio ?? 0) * 100)}%（${callGroups.mainConversation.calls} 次）` },
            { label: '辅助阶段命中', value: `${Math.round((callGroups.auxiliary.hitRatio ?? 0) * 100)}%（${callGroups.auxiliary.calls} 次）` },
          ]),
        ]}
        detail={calls.length > 0
          ? { title: `逐调用缓存明细（${calls.length}${message.cacheCallsTruncated ? '，仅最近若干次' : ''}）`, lines: detailLines }
          : undefined}
      />
    </span>
  )
}

function cacheCallStatusLabel(status: NonNullable<ChatMessage['cacheCalls']>[number]['status']): string {
  if (status === 'hit') return '命中'
  if (status === 'partial') return '部分命中'
  if (status === 'miss') return '未命中'
  if (status === 'unavailable') return '未观测'
  return '未知'
}

const CACHE_REASON_LABELS: Record<string, string> = {
  model_changed: '模型变更',
  provider_changed: '供应商变更',
  adapter_changed: '适配器变更',
  prompt_version_changed: '提示词版本变更',
  system_policy_changed: '系统策略变更',
  soul_changed: '人格设定变更',
  user_profile_changed: '用户画像变更',
  tool_schema_changed: '工具定义变更',
  memory_revision_changed: '记忆修订',
  workspace_changed: '工作区变更',
  permission_changed: '权限变更',
  session_reset: '会话重置',
  summary_compacted: '摘要压缩',
  locale_changed: '语言/时区变更',
  request_kind_changed: '请求类型变更',
  manual_clear: '手动清理',
  replayed: '重放请求',
  unknown: '未知',
}

function cacheReasonLabel(reason: string): string {
  return CACHE_REASON_LABELS[reason] ?? reason
}
