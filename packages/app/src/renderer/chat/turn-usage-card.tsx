// One turn's usage, behind one button.
//
// The line of numbers that used to sit under every answer (cache hits, four token kinds, two stages,
// the rate) is reference material, not something to read every turn: it is now a pill that opens the
// card in the reference — the provider and model, then one row per figure, with the per-call cache
// detail inside the same card instead of a second disclosure under the message.
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clampNumber } from '../app-shell/navigation'
import type { ChatMessage } from '../chat/types'
import { useDismissOnOutside } from '../ui/presence'
import { UsageIcon } from '../ui/message-icons'

export interface UsageFigure {
  label: string
  value: string
  /** Muted rows are facts the provider did not report, not zeroes. */
  missing?: boolean
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function TurnUsageButton({
  label,
  figures,
  detail,
  onTipChange,
}: {
  /** What the pill itself says, e.g. `用量 20.7M tok`. */
  label: string
  figures: UsageFigure[]
  detail?: { title: string; lines: string[] }
  onTipChange?: (tip: null) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useDismissOnOutside(open, [panelRef], () => setOpen(false))

  useLayoutEffect(() => {
    if (!open) return
    const trigger = buttonRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const panelWidth = panelRef.current?.offsetWidth || 320
    const panelHeight = panelRef.current?.offsetHeight || 260
    const x = clampNumber(rect.left, margin, Math.max(margin, window.innerWidth - panelWidth - margin))
    const below = rect.bottom + 6
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 6)
      : below
    setPosition({ x, y })
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="turn-usage-button"
        aria-label="本轮用量与缓存命中"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          onTipChange?.(null)
          setOpen((value) => !value)
        }}
      >
        <UsageIcon />
        <span>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="turn-usage-panel"
          role="dialog"
          aria-label="本轮用量"
          style={{ left: position.x, top: position.y }}
        >
          <div className="turn-usage-panel-head">
            <span className="turn-usage-panel-head-icon" aria-hidden="true"><UsageIcon /></span>
            <strong>本轮用量</strong>
            <span className="turn-usage-panel-head-value">{label.replace(/^用量\s*/u, '')}</span>
          </div>
          <dl className="turn-usage-panel-rows">
            {figures.map((figure) => (
              <div key={figure.label} className={`turn-usage-panel-row ${figure.missing ? 'missing' : ''}`}>
                <dt>{figure.label}</dt>
                <dd>{figure.value}</dd>
              </div>
            ))}
          </dl>
          {detail && detail.lines.length > 0 && (
            <details className="turn-usage-panel-detail">
              <summary>{detail.title}</summary>
              <ul>
                {detail.lines.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            </details>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * The figures of one assistant turn, in the order the reference card lists them.
 *
 * The honesty rules the old usage line carried stay here: a cache rate is only a percentage when the
 * provider reported cache tokens for every request, otherwise it says so; an unreported figure reads
 * "未提供" rather than zero; and the rate is omitted entirely when the turn cannot time its tokens.
 */
export function turnUsageFigures(message: ChatMessage): UsageFigure[] {
  const usage = message.usage
  if (!usage) return []
  const cached = usage.cachedPromptTokens
  const requestCount = usage.requestCount ?? 0
  const cacheComplete = requestCount > 0 && usage.cacheReportedRequestCount === requestCount
  const uncached = usage.uncachedPromptTokens
    ?? (cacheComplete ? Math.max(0, usage.promptTokens - (cached ?? 0)) : undefined)
  const hitRatio = cacheComplete && usage.promptTokens > 0 && cached !== undefined
    ? cached / usage.promptTokens
    : undefined
  const rate = turnOutputRate(message)
  return [
    { label: '供应商 / 模型', value: message.modelRef ?? '供应商/模型未知' },
    {
      label: '缓存命中',
      value: hitRatio !== undefined
        ? `${Math.round(hitRatio * 100)}%`
        : usage.cacheReportedRequestCount ? '部分提供' : '未提供',
      missing: hitRatio === undefined,
    },
    { label: '未缓存输入', value: uncached === undefined ? '未提供' : `${uncached} tok`, missing: uncached === undefined },
    { label: '缓存读取', value: cached === undefined ? '未提供' : `${cached} tok`, missing: cached === undefined },
    { label: '缓存写入', value: usage.cacheWriteTokens === undefined ? '未提供' : `${usage.cacheWriteTokens} tok`, missing: usage.cacheWriteTokens === undefined },
    { label: '输出', value: `${usage.completionTokens} tok` },
    ...(usage.reasoningTokens === undefined ? [] : [{ label: '其中推理', value: `${usage.reasoningTokens} tok` }]),
    ...(message.durationMs ? [{ label: '用时', value: formatDuration(message.durationMs) }] : []),
    ...(rate === null ? [] : [{ label: '输出速率', value: `${rate.toFixed(1)} tok/s` }]),
    { label: '请求数', value: `${usage.requestCount} 次` },
    ...(usage.usageCompleteness === 'partial' ? [{ label: '完整性', value: '用量统计不完整' }] : []),
  ]
}

/**
 * Completion tokens per second, or null when the turn cannot be timed honestly.
 *
 * Two rules, both inherited from the old usage line: a partially timed turn gets no rate at all (the
 * number would look precise and would not be), and the rate prefers the provider's own timing for the
 * requests it timed, falling back to the turn's duration only when that is all we have.
 */
export function turnOutputRate(message: ChatMessage): number | null {
  const usage = message.usage
  if (!usage || usage.usageCompleteness === 'partial') return null
  const timedCount = usage.timedRequestCount ?? 0
  const timedTokens = usage.timedCompletionTokens ?? 0
  const providerMs = usage.providerDurationMs ?? 0
  if (timedCount > 0 && timedTokens > 0 && providerMs > 0) {
    return timedTokens / (providerMs / 1000)
  }
  if (!message.durationMs || message.durationMs <= 0) return null
  return usage.completionTokens / (message.durationMs / 1000)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/** The pill's own label: total tokens, which is what a reader compares between turns. */
export function turnUsageLabel(message: ChatMessage): string {
  const usage = message.usage
  if (!usage) return ''
  const total = usage.totalTokens || (usage.promptTokens + usage.completionTokens)
  return `用量 ${formatTokenCount(total)} tok`
}
