// Conversation rendering and execution-progress presentation.
import { memo } from 'react'
import type { WebEvidenceProjection } from '@littlesheep/types'
import type { HistoryMessage } from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { ActivityGlyph } from './activity-glyph'
import { ReasoningRow } from './reasoning-row'
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
import { shortActivityText } from './task-progress-indicator'
import { MessageMeta } from './message-meta'
import type {
  AssistantTurnActivity,
  ChatMessage,
  LiveStepEvent,
  LiveToolEvent,
  TranscriptEntry,
} from './types'
import { useConversationDisplayMode } from './conversation-display'
import { activityAttentionLine, activityVerificationLine, compactTranscriptEntries } from './activity-visibility'


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
}


export const AssistantTurnMessage = memo(function AssistantTurnMessage({
  message,
  messageKey,
  now,
  workspaceRoot,
  onOpenFile,
  onOpenReview,
  onBranch,
}: AssistantTurnMessageProps) {
  const displayMode = useConversationDisplayMode()
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
            <MessageFileStrip files={message.artifacts} label="产出成果" workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
          )}
          {message.webEvidence && <WebSources evidence={message.webEvidence} />}
        </div>
        <MessageMeta
          role="assistant"
          text={message.text}
          timestamp={message.timestamp}
          onBranch={message.id && onBranch ? () => onBranch(message.id as string) : undefined}
        />
        <TurnUsageFooter message={message} />
      </div>
    )
  }

  const responseVisible = activity.status === 'running'
    || Boolean(message.text.trim() || activity.error || message.artifacts?.length)
  const compactCompleted = displayMode === 'compact' && activity.status !== 'running'

  return (
    <section className={`assistant-turn ${activity.status}`} data-message-key={messageKey}>
      {!compactCompleted && <ContextProjectionRows rows={activity.contextProjections ?? []} />}
      {(activity.transcript?.length ?? 0) > 0
        ? <AssistantTranscript transcript={activity.transcript ?? []} activity={activity} now={now} onOpenFile={onOpenFile} compact={compactCompleted} />
        : compactCompleted
          ? <LegacyActivitySummary activity={activity} />
          : <AssistantActivityFlow activity={activity} now={now} onOpenFile={onOpenFile} />}
      {responseVisible && (
        <div className="message-with-meta assistant">
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
              <MessageFileStrip files={message.artifacts} label="产出成果" workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
            )}
            {message.webEvidence && <WebSources evidence={message.webEvidence} />}
          </div>
          <MessageMeta
            role="assistant"
            text={message.text}
            timestamp={message.timestamp}
            onBranch={message.id && onBranch ? () => onBranch(message.id as string) : undefined}
          />
          <TurnUsageFooter message={message} />
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
    || previous.onOpenReview !== next.onOpenReview
    || previous.workspaceRoot !== next.workspaceRoot
    || previous.onBranch !== next.onBranch
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

  return (
    <section className={`agent-step-group ${step.status}`} data-step-id={step.stepId}>
      <div className={`agent-flow-row agent-step-row ${running ? 'is-active' : ''}`}>
        <span className={`agent-flow-glyph agent-step-glyph ${step.status}`} aria-hidden="true"><ActivityGlyph kind="step" /></span>
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

export function WebSources({ evidence }: { evidence: WebEvidenceProjection }) {
  const state = webEvidenceStateLabel(evidence)
  return (
    <section className="web-sources" aria-label="网络资料来源">
      <div className="web-sources-heading">
        <strong>来源</strong>
        <span>{state} · {evidence.citationCount} 项</span>
      </div>
      {(evidence.citations ?? []).map((citation) => (
        <a
          key={citation.id}
          className="web-source-row"
          href={citation.url}
          {...(!citation.url ? { 'aria-disabled': true, onClick: (event) => event.preventDefault() } : {})}
          title={citation.url ? `打开 ${citation.origin}` : '安全投影未保留完整链接'}
        >
          <span className="web-source-copy">
            <strong>{citation.title || citation.origin}</strong>
            <small>{sourceDomain(citation.origin)} · {sourceTime(citation.publishedAt ?? citation.fetchedAt)}</small>
          </span>
          <span className="web-source-state">
            {citation.status === 'cached' ? '缓存' : citation.status === 'blocked' ? '阻止' : citation.truncated ? '截断' : '已读取'}
          </span>
        </a>
      ))}
      {evidence.errorKinds && evidence.errorKinds.length > 0 && (
        <div className="web-source-errors" role="status">{evidence.errorKinds.map(webErrorLabel).join(' · ')}</div>
      )}
    </section>
  )
}

function sourceDomain(origin: string): string {
  try { return new URL(origin).hostname } catch { return origin }
}

function sourceTime(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value
}

export function webEvidenceStateLabel(evidence: WebEvidenceProjection): string {
  if (evidence.blocked) return '已阻止'
  if (evidence.completeness === 'none') return '无可用资料'
  if (evidence.partial || evidence.truncated) return '部分资料'
  if (evidence.cached) return '缓存资料'
  return '实时资料'
}

export function webErrorLabel(value: string): string {
  if (value === 'web_disabled') return '网络检索已关闭'
  if (value === 'web_provider_unconfigured') return '搜索服务未配置'
  if (value === 'web_provider_auth_failed') return '搜索服务认证失败'
  if (value === 'web_provider_rate_limited') return '搜索服务限流'
  if (value === 'web_provider_unavailable') return '搜索服务暂不可用'
  if (value === 'web_provider_invalid_response') return '搜索服务返回异常结果'
  if (value === 'web_invalid_query') return '检索条件无效'
  if (value === 'web_sensitive_query_blocked') return '检索内容被隐私策略阻止'
  if (value === 'web_fetch_timeout') return '页面读取超时'
  if (value === 'web_fetch_cancelled') return '页面读取已取消'
  if (value === 'web_response_too_large') return '页面内容超过读取上限'
  if (value === 'web_content_unsupported') return '页面内容格式不受支持'
  if (value === 'web_extraction_failed') return '页面正文提取失败'
  if (value === 'web_cache_unavailable') return '本地网页缓存暂不可用'
  if (value === 'web_citation_invalid') return '来源引用无法验证'
  if (value === 'web_ssrf_blocked' || value === 'web_url_invalid' || value === 'web_scheme_blocked'
    || value === 'web_dns_check_failed' || value === 'web_redirect_blocked') return '地址被安全策略阻止'
  if (value === 'web_partial') return '资料不完整'
  return '网络资料读取失败'
}

/**
 * Model transcript: thinking, tool rows, and per-turn prose in the exact order
 * the model produced them. The single durable driver owns these entries; a run
 * without a transcript falls back to the activity-step layout.
 */
export function AssistantTranscript({
  transcript,
  activity,
  now,
  onOpenFile,
  compact = false,
}: {
  transcript: TranscriptEntry[]
  activity: AssistantTurnActivity
  now: number
  onOpenFile: (path: string) => void
  compact?: boolean
}) {
  const tools = new Map(activity.tools.map((tool) => [tool.callId, tool]))
  // Compact mode folds the finished process away, never the facts that need a
  // decision or a fix: failed/denied rows and the activity-level attention line
  // stay readable (UX-16).
  const rows = compact ? compactTranscriptEntries(transcript, activity.tools) : transcript
  const attention = compact ? activityAttentionLine(activity) : null
  // The verification verdict is not a transcript row, so folding it into the compact attention
  // line cannot be its only home: normal mode reads the same fact here (UX-16).
  const verification = compact ? null : activityVerificationLine(activity)
  return (
    <div className="assistant-activity-flow assistant-transcript" role="group" aria-label="Agent 工作过程">
      {rows.map((entry) => {
        if (entry.kind === 'system') {
          return (
            <details key={entry.id} className="agent-transcript-reasoning system" data-transcript-entry={entry.id}>
              <summary className="agent-flow-row">
                <span className="agent-flow-glyph agent-reasoning-glyph" aria-hidden="true"><ActivityGlyph kind="system" /></span>
                <span className="agent-flow-title">系统提示词</span>
                <span className="agent-flow-separator" aria-hidden="true" />
                <span className="agent-flow-summary">{shortActivityText(entry.text, 200)}</span>
                <span className="agent-flow-chevron" aria-hidden="true" />
              </summary>
              <div className="agent-transcript-details">
                <Markdown text={entry.text} />
              </div>
            </details>
          )
        }
        if (entry.kind === 'reasoning') {
          return <ReasoningRow key={entry.id} id={entry.id} text={entry.text} status={entry.status} />
        }

        if (entry.kind === 'text') {
          return (
            <div key={entry.id} className="agent-transcript-prose" data-transcript-entry={entry.id}>
              <Markdown text={entry.text} />
            </div>
          )
        }
        if (entry.kind === 'preparing') {
          return (
            <div key={entry.id} className={`agent-flow-row agent-tool-preparing ${entry.status}`} data-transcript-entry={entry.id}>
              <span className="agent-flow-glyph" aria-hidden="true"><ActivityGlyph kind="step" /></span>
              <span className="agent-flow-title">准备{entry.name ? ` ${entry.name}` : '工具'}</span>
              <span className="agent-flow-separator" aria-hidden="true" />
              <span className="agent-flow-summary">已生成 {entry.receivedCharacters} 个字符参数{entry.status === 'running' ? ' · Running…' : ''}</span>
            </div>
          )
        }
        const tool = tools.get(entry.callId)
        return tool
          ? <AgentToolRow key={entry.id} tool={tool} now={now} onOpenFile={onOpenFile} />
          : null
      })}
      {!compact && <ActiveActivityStatus activity={activity} />}
      {attention && (
        <div className="agent-transcript-summary agent-transcript-attention" role="status">{attention}</div>
      )}
      {verification && (
        <div className="agent-transcript-summary" data-transcript-verification="true" role="status">{verification}</div>
      )}
      {transcriptSummary(activity, transcript) ? (
        <div className="agent-transcript-summary" data-transcript-summary="true">
          {transcriptSummary(activity, transcript)}
        </div>
      ) : null}
    </div>
  )
}

function ActiveActivityStatus({ activity }: { activity: AssistantTurnActivity }) {
  if (activity.status !== 'running') return null
  const current = [...(activity.reasoning ?? [])].reverse().find((item) => item.status === 'running' && item.source)
  if (!current) return null
  return (
    <div className="agent-flow-row agent-active-stage-row" role="status" aria-live="polite">
      <span className="agent-flow-glyph agent-active-stage-glyph" aria-hidden="true"><ActivityGlyph kind="reasoning" /></span>
      <span className="agent-flow-title">{current.source === 'model' ? '模型' : '运行时'}</span>
      <span className="agent-flow-separator" aria-hidden="true" />
      <span className="agent-flow-summary">{current.summary}</span>
    </div>
  )
}

function ContextProjectionRows({ rows }: { rows: NonNullable<AssistantTurnActivity['contextProjections']> }) {
  if (!rows.length) return null
  return <div className="assistant-context-projections">{rows.map((row) => (
    <div key={row.kind} className={`agent-flow-row context-projection-row ${row.kind}`}>
      <span className="agent-flow-glyph context-projection-glyph" aria-hidden="true"><ActivityGlyph kind={row.kind} /></span>
      <span className="agent-flow-title">{row.label}</span>
      <span className="agent-flow-separator" aria-hidden="true" />
      <span className="agent-flow-summary">{row.detail}</span>
    </div>
  ))}</div>
}

function LegacyActivitySummary({ activity }: { activity: AssistantTurnActivity }) {
  const parts = ['已思考', `${activity.tools.length} 次工具调用`, '0 条消息']
  return <div className="agent-transcript-summary" data-transcript-summary="true">{parts.join(' · ')}</div>
}

/**
 * The same numbers, behind one pill. The line that used to run under every answer listed the cache
 * rate four ways, four token kinds and the rate; it is reference material, so it lives in the card
 * the pill opens, together with the per-call cache detail.
 */
function TurnUsageFooter({ message }: { message: ChatMessage }) {
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
    <footer className="turn-usage-footer" aria-label="本轮用量">
      <TurnUsageButton
        label={turnUsageLabel(message)}
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
    </footer>
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

/**
 * Turn footer: once the turn is no longer running the process content is
 * summarised as 已思考 · N 次工具调用 · N 条消息.
 */
function transcriptSummary(activity: AssistantTurnActivity, transcript: TranscriptEntry[]): string | undefined {
  if (activity.status === 'running') return undefined
  const toolCalls = transcript.filter((entry) => entry.kind === 'tool').length
  const messages = transcript.filter((entry) => entry.kind === 'text').length
  return `已思考 · ${toolCalls} 次工具调用 · ${messages} 条消息`
}
