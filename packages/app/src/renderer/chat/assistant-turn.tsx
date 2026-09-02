// Conversation rendering and execution-progress presentation.
import { memo } from 'react'
import type { WebEvidenceProjection } from '@littlesheep/types'
import type { HistoryMessage } from '../api'
import { MessageFileStrip } from '../composer/message-files'
import { InlineMarkdown, Markdown } from '../Markdown'
import { TraceCard } from '../TraceCard'
import {
  buildArtifactsFromLiveTools,
  formatMaybeDuration,
  liveStepStatusLabel,
} from './activity-model'
import { visibleActivitySteps } from './activity-visibility'
import { AgentToolRow } from './agent-tool-row'
import { MessageMeta } from './message-meta'
import type {
  AssistantTurnActivity,
  ChatMessage,
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
      <div className="message-with-meta assistant" data-message-key={messageKey}>
        <div className="message assistant">
          {message.text ? <Markdown text={message.text} /> : <span className="loading">思考中...</span>}
          {(message.trace || message.toolCalls) && (
            <TraceCard trace={message.trace} toolCalls={message.toolCalls} durationMs={message.durationMs} onOpenFile={onOpenFile} />
          )}
          {message.artifacts && message.artifacts.length > 0 && (
            <MessageFileStrip files={message.artifacts} label="产出成果" onOpenFile={onOpenFile} />
          )}
          {message.webEvidence && <WebSources evidence={message.webEvidence} />}
        </div>
        <MessageMeta role="assistant" text={message.text} timestamp={message.timestamp} />
      </div>
    )
  }

  const responseVisible = activity.status === 'running'
    || Boolean(message.text.trim() || activity.error || message.artifacts?.length)

  return (
    <section className={`assistant-turn ${activity.status}`} data-message-key={messageKey}>
      <AssistantActivityFlow activity={activity} now={now} onOpenFile={onOpenFile} />
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
              <MessageFileStrip files={message.artifacts} label="产出成果" onOpenFile={onOpenFile} />
            )}
            {message.webEvidence && <WebSources evidence={message.webEvidence} />}
          </div>
          <MessageMeta role="assistant" text={message.text} timestamp={message.timestamp} />
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
