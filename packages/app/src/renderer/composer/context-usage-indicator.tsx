// Task composer controls, attachments, runtime selection, and sizing.
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
  const usagePercent = usage.available ? Math.max(0, Math.min(100, usage.percent)) : 0
  const cache = usage.sessionCache
  const cacheLabel = formatSessionCache(cache)
  const ariaLabel = !windowKnown
    ? '当前模型的上下文窗口尚未登记'
    : usage.available
    ? `上下文已用 ${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.maxTokens)}，${usage.percent}% 已用`
    : `${formatLocalTokenizerState(usage)}，共 ${formatTokenCount(usage.maxTokens)}`

  return (
    <div
      className={`context-usage composer-tab-control tone-${tone}`}
      role="status"
      tabIndex={0}
      aria-label={cacheLabel ? `${ariaLabel}；${cacheLabel}` : ariaLabel}
    >
      <svg className="context-usage-ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="context-usage-ring-track" cx="8" cy="8" r="6.5" />
        <circle
          className="context-usage-ring-progress"
          cx="8"
          cy="8"
          r="6.5"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - usagePercent}
          transform="rotate(-90 8 8)"
        />
      </svg>
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
              <span>已用 {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.maxTokens)}</span>
              <strong>{usage.percent}% 已用</strong>
            </>
          ) : (
            <>
              <span title={usage.localUnavailableReason}>{formatLocalTokenizerState(usage)}</span>
              <strong>共 {formatTokenCount(usage.maxTokens)}</strong>
            </>
          )}
        </span>
        {cacheLabel ? (
          <span className="context-usage-popover" aria-hidden="true">
            <span className="context-usage-title">会话累计缓存命中：</span>
            <span>
              缓存读取 {formatTokenCount(cache!.cachedTokens)} / 输入 {formatTokenCount(cache!.inputTokens)}
            </span>
            <strong>{cache!.hitPercent === undefined ? '不可用' : `${cache!.hitPercent.toFixed(1)}%`}</strong>
          </span>
        ) : null}
      </span>
    </div>
  )
}


/**
 * The session-cumulative cache line, or undefined when the session reported no
 * usage. The value is exact; only the display rounds.
 */
export function formatSessionCache(
  cache: ContextUsage['sessionCache'],
): string | undefined {
  if (!cache) return undefined
  const percent = cache.hitPercent === undefined ? '不可用' : `${cache.hitPercent.toFixed(1)}%`
  const partial = cache.requestsWithoutUsage > 0 ? `（${cache.requestsWithoutUsage} 个请求 usage 未上报）` : ''
  return `会话累计缓存命中 ${percent}${partial}`
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


export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value : value.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}
