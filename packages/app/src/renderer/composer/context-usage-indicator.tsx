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
    ? `上下文${usage.source === 'local' ? '本地精确装配' : '供应商实测'}已用 ${formatTokenCount(usage.usedTokens)}，共 ${formatTokenCount(usage.maxTokens)}，${usage.percent}% 已用`
    : `${formatLocalTokenizerState(usage)}，共 ${formatTokenCount(usage.maxTokens)}`

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
              {usage.localUsedTokens !== undefined ? (
                <span className="context-usage-source" title={usage.localTokenizerId}>
                  本地精确装配 {formatTokenCount(usage.localUsedTokens)} · {formatUsageTime(usage.localCountedAt)}
                </span>
              ) : (
                <span className="context-usage-source" title={usage.localUnavailableReason}>
                  {formatLocalTokenizerState(usage)}
                </span>
              )}
              {usage.providerUsedTokens !== undefined ? (
                <span className="context-usage-source">
                  供应商实测 {formatTokenCount(usage.providerUsedTokens)} · {formatUsageTime(usage.providerReportedAt)}
                  {formatCalibrationDifference(usage.providerDifferenceTokens, usage.providerCalibrationStatus)}
                </span>
              ) : (
                <span className="context-usage-source">供应商校准待返回</span>
              )}
              <span>共 {formatTokenCount(usage.maxTokens)}</span>
              <strong>{usage.percent}% 已用</strong>
            </>
          ) : (
            <>
              <span title={usage.localUnavailableReason}>{formatLocalTokenizerState(usage)}</span>
              <strong>共 {formatTokenCount(usage.maxTokens)}</strong>
            </>
          )}
        </span>
      </span>
    </div>
  )
}


export function formatLocalTokenizerState(usage: ContextUsage): string {
  switch (usage.localTokenizerState) {
    case 'not_counted':
      return '本会话尚无本地计数'
    case 'unavailable':
      return '当前模型没有已验证的本地精确 tokenizer'
    case 'unknown':
      return '当前模型的 tokenizer 能力未登记'
    case 'exact':
      return '本地精确计数待更新'
  }
}


function formatCalibrationDifference(
  differenceTokens: number | undefined,
  status: ContextUsage['providerCalibrationStatus'],
): string {
  if (differenceTokens === undefined || status === undefined) return ''
  if (status === 'exact_match') return ' · 与本地一致'
  const sign = differenceTokens > 0 ? '+' : ''
  return ` · 校准差 ${sign}${differenceTokens}`
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
