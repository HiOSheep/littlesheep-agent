// Task composer controls, attachments, runtime selection, and sizing.
import { type CSSProperties } from 'react'
import {
  type RuntimeState
} from '../api'
import {
  type ContextUsage
} from '../context-usage'


export type RuntimeProvider = RuntimeState['providers'][number]


export function ContextUsageIndicator({ usage }: { usage: ContextUsage }) {
  const windowKnown = usage.maxTokens > 0
  const tone = usage.available && usage.percent >= 90 ? 'danger' : usage.available && usage.percent >= 70 ? 'warning' : 'normal'
  const style = {
    '--context-usage-angle': `${usage.available ? Math.max(0, Math.min(100, usage.percent)) * 3.6 : 0}deg`,
  } as CSSProperties
  const ariaLabel = !windowKnown
    ? '当前模型的上下文窗口尚未登记'
    : usage.available
    ? `上下文${usage.source === 'provider' ? '供应商实测' : '本地精确装配'}已用 ${formatTokenCount(usage.usedTokens)}，共 ${formatTokenCount(usage.maxTokens)}，${usage.percent}% 已用`
    : `上下文真实用量待模型供应商返回，共 ${formatTokenCount(usage.maxTokens)}`

  return (
    <div
      className={`context-usage tone-${tone}`}
      style={style}
      role="status"
      tabIndex={0}
      aria-label={ariaLabel}
    >
      <span className="context-usage-ring" aria-hidden="true" />
      <span className="context-usage-popover-shell">
        <span className="context-usage-popover" aria-hidden="true">
          <span className="context-usage-title">上下文窗口：</span>
          {!windowKnown ? (
            <>
              <span>当前模型的上下文窗口尚未登记</span>
              <strong>不可用</strong>
            </>
          ) : usage.available ? (
            <>
              {usage.providerUsedTokens !== undefined ? (
                <span className="context-usage-source">
                  供应商实测 {formatTokenCount(usage.providerUsedTokens)} · {formatUsageTime(usage.providerReportedAt)}
                </span>
              ) : (
                <span className="context-usage-source">供应商实测待返回</span>
              )}
              {usage.localUsedTokens !== undefined ? (
                <span className="context-usage-source" title={usage.localTokenizerId}>
                  本地精确装配 {formatTokenCount(usage.localUsedTokens)} · {formatUsageTime(usage.localCountedAt)}
                </span>
              ) : (
                <span className="context-usage-source" title={usage.localUnavailableReason}>
                  本地精确计数不可用
                </span>
              )}
              <span>共 {formatTokenCount(usage.maxTokens)}</span>
              <strong>{usage.percent}% 已用</strong>
            </>
          ) : (
            <>
              <span>等待模型供应商返回真实用量</span>
              <strong>共 {formatTokenCount(usage.maxTokens)}</strong>
            </>
          )}
        </span>
      </span>
    </div>
  )
}


export function formatUsageTime(value: string | undefined): string {
  if (!value) return '本轮'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '本轮'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}


export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value : value.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}
