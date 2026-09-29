// View model for the Token usage heatmap (O6): projection rows -> what is drawn.
//
// Two honesty rules shape everything here, and both come from the O5 contract
// rather than from taste:
//
//  1. A day with no recorded call (`empty`) is a different fact from a day whose
//     calls reported zero tokens (`recorded`, `total: 0`), and both differ from a
//     day whose calls reported no usage at all (`partial`). The view model keeps
//     all four states distinct; only the *colour* is shared, and the legend and
//     the per-day detail spell out which one a cell is.
//  2. The response's own bounds travel with the numbers. A truncated identity
//     facet list means the filters do not offer every recorded provider, so the
//     surface says so instead of quietly showing a short list.
import {
  PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
  PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
  PROVIDER_USAGE_DAILY_VERSION,
  type ProviderUsageDailyDay,
  type ProviderUsageDailyIdentity,
  type ProviderUsageDailySeries,
} from '@littlesheep/types'
import { usageHeatmapWeeks, usageYear, type UsageHeatmapWeeks } from './usage-heatmap-grid'

export type UsageMetric = 'total' | 'input' | 'output'

export const USAGE_METRICS: ReadonlyArray<{ value: UsageMetric; label: string }> = [
  { value: 'total', label: '总量' },
  { value: 'input', label: '输入' },
  { value: 'output', label: '输出' },
]

export const USAGE_METRIC_LABELS: Readonly<Record<UsageMetric, string>> = {
  total: '总量',
  input: '输入',
  output: '输出',
}

/** The metric labels in metric order, for surfaces that iterate them. */
export const USAGE_METRIC_LABEL_LIST: readonly string[] = USAGE_METRICS.map((entry) => entry.label)

/** 0 = nothing recorded that day, 1-5 = increasing recorded use. */
export type UsageHeatLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface UsageHeatLegendStep {
  level: UsageHeatLevel
  /** `0 tok` / `1 – 999 tok` … the numbers the colour actually stands for. */
  label: string
}

export interface UsageDayDetail {
  date: string
  state: ProviderUsageDailyDay['state']
  /** The headline the detail panel reads, already classified by state. */
  headline: string
  /** True only for a day whose calls really happened and reported nothing. */
  usageIncomplete: boolean
  requests: number
  missingResponses: number
  unreportedRequests: number
  figures: Array<{ label: string; value: number }>
}

export interface UsageHeatmapViewModel {
  year: number
  range: { from: string; to: string; days: number }
  weeks: UsageHeatmapWeeks
  /** `date -> day row`; a date the response left out is simply absent here. */
  days: Map<string, ProviderUsageDailyDay>
  metric: UsageMetric
  /** Highest metric value in this view: the top of the colour scale. */
  effectiveMax: number
  /** Thresholds between levels 1-5, recomputed whenever the view changes. */
  thresholds: [number, number, number, number]
  legend: UsageHeatLegendStep[]
  totals: ProviderUsageDailySeries['totals']
  providers: readonly ProviderUsageDailyIdentity[]
  models: readonly ProviderUsageDailyIdentity[]
  filters: { provider?: string; model?: string }
  coverage: ProviderUsageDailySeries['coverage']
  timezone: string
  /** Set when the response's own bounds admit the numbers are not the whole truth. */
  truncationNotice: string | null
  /** Set when the request asked for a bound the response does not satisfy. */
  boundNotice: string | null
}

export function usageMetricValue(day: ProviderUsageDailyDay, metric: UsageMetric): number {
  return metric === 'input' ? day.input : metric === 'output' ? day.output : day.total
}

/**
 * Split `0 … max` into five bands whose numbers are shown in the legend, so the
 * thresholds of one view are stable and explainable ("this shade means this
 * range") instead of a per-render guess. A single peak keeps the four lower
 * bands spread below it, so an ordinary day is never flattened into the top band
 * and a view with no usage at all collapses to a single band rather than
 * dividing by zero.
 */
export function usageHeatThresholds(max: number): [number, number, number, number] {
  if (!Number.isFinite(max) || max <= 0) return [0, 0, 0, 0]
  const band = max / 5
  return [band, band * 2, band * 3, band * 4]
}

export function usageHeatLevel(value: number, thresholds: readonly [number, number, number, number]): UsageHeatLevel {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  if (value <= thresholds[3]) return 4
  return 5
}

export function usageHeatLegend(thresholds: readonly [number, number, number, number]): UsageHeatLegendStep[] {
  const [first, second, third, fourth] = thresholds
  if (fourth <= 0) return [{ level: 0, label: '本视图没有实报用量' }]
  return [
    { level: 1, label: `1 – ${formatThreshold(first)}` },
    { level: 2, label: `${formatThreshold(first + 1)} – ${formatThreshold(second)}` },
    { level: 3, label: `${formatThreshold(second + 1)} – ${formatThreshold(third)}` },
    { level: 4, label: `${formatThreshold(third + 1)} – ${formatThreshold(fourth)}` },
    { level: 5, label: `${formatThreshold(fourth + 1)} 以上` },
  ]
}

function formatThreshold(value: number): string {
  return String(Math.round(value))
}

/**
 * Which calendar year the view starts on.
 *
 * The projection's own `updatedAt` is used when the caller has one, because it
 * is the only year-shaped fact available before the first response; the surface
 * then follows the year the response actually covers.
 */
export function usageInitialYear(now: Date = new Date()): number {
  return usageYear(now.toISOString().slice(0, 10)) ?? 1970
}

/**
 * Years offered by the selector: those with a recorded attempt (from the
 * projection's own attempt bounds, never from the queried range) plus the year
 * on screen. The current year is deliberately not invented here - the window
 * itself shows the current year as `future` cells.
 */
export function usageYearOptions(series: ProviderUsageDailySeries, selected: number): number[] {
  const years = new Set<number>([selected])
  for (const instant of [series.coverage.firstAttemptAt, series.coverage.lastAttemptAt]) {
    if (!instant) continue
    const parsed = Date.parse(instant)
    if (Number.isFinite(parsed)) years.add(new Date(parsed).getUTCFullYear())
  }
  return [...years].sort((left, right) => right - left)
}

/**
 * A response is only rendered when it answers the question that was asked: the
 * right contract version, the requested range, and no row outside it or beyond
 * the documented day bound. Failing closed here is what keeps a stale or
 * mismatched payload from being drawn as if it were this year's usage.
 *
 * The number of rows is deliberately *not* required to equal the number of days
 * in the range: the contract bounds `days.length` rather than promising one row
 * per date, and a consumer that demanded the full set would reject a valid
 * response. What must hold is that no row escapes the requested range - that is
 * the property the calendar depends on.
 */
export function usageSeriesMismatch(
  series: ProviderUsageDailySeries | null,
  expected: { from: string; to: string },
): string | null {
  if (!series) return '还没有收到用量数据'
  if (series.version !== PROVIDER_USAGE_DAILY_VERSION) {
    return `用量数据版本 ${String(series.version)} 不是本界面支持的 ${PROVIDER_USAGE_DAILY_VERSION}`
  }
  if (series.range.from !== expected.from || series.range.to !== expected.to) {
    return `用量数据覆盖 ${series.range.from} 至 ${series.range.to}，不是请求的 ${expected.from} 至 ${expected.to}`
  }
  if (series.range.days > PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS) {
    return `用量数据超过 ${PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS} 天上限`
  }
  if (!Array.isArray(series.days)) return '用量数据没有包含日序列'
  if (series.days.length > series.range.days) {
    return `用量数据包含 ${series.days.length} 天，多于声明的 ${series.range.days} 天`
  }
  const outside = series.days.find((day) => day.date < series.range.from || day.date > series.range.to)
  if (outside) return `用量数据包含区间外的日期 ${outside.date}`
  return null
}

export function buildUsageHeatmapView(input: {
  series: ProviderUsageDailySeries
  metric: UsageMetric
}): UsageHeatmapViewModel {
  const { series, metric } = input
  const effectiveMax = series.days.reduce((max, day) => Math.max(max, usageMetricValue(day, metric)), 0)
  const thresholds = usageHeatThresholds(effectiveMax)
  const days = new Map(series.days.map((day) => [day.date, day]))
  return {
    year: usageYear(series.range.from) ?? 0,
    range: { from: series.range.from, to: series.range.to, days: series.range.days },
    weeks: usageHeatmapWeeks(series.range.from, series.range.to),
    days,
    metric,
    effectiveMax,
    thresholds,
    legend: usageHeatLegend(thresholds),
    totals: series.totals,
    providers: series.identities.providers,
    models: series.identities.models,
    filters: series.filters,
    coverage: series.coverage,
    timezone: series.timezone,
    truncationNotice: usageTruncationNotice(series),
    boundNotice: null,
  }
}

/**
 * What the response's own bounds say, in the user's words. The facet lists are
 * described by what they are - the top N recorded identities - so a truncated
 * list is never read as "these are all the providers you have used".
 */
export function usageTruncationNotice(series: ProviderUsageDailySeries): string | null {
  const parts: string[] = []
  if (series.bounds.identitiesTruncated) {
    const cap = Math.min(series.bounds.maxIdentities, PROVIDER_USAGE_DAILY_MAX_IDENTITIES)
    parts.push(`供应商／模型筛选只列出用量最高的 ${cap} 个已记录身份（接口上限 ${series.bounds.maxIdentities}），不是全部`)
  }
  if (series.coverage.missingResponses > 0 || series.coverage.unreportedRequests > 0) {
    parts.push(`覆盖不完整：${series.coverage.missingResponses} 个响应未报 usage、${series.coverage.unreportedRequests} 个请求无响应`)
  }
  if (series.coverage.unreadableRuns > 0) parts.push(`${series.coverage.unreadableRuns} 个 run 无法重放，未计入`)
  if (series.coverage.stale) parts.push('最近一次更新失败，显示的是上一次成功保存的投影')
  if (!series.coverage.projectionBuilt) parts.push('尚未建立用量投影，请先刷新或回填')
  return parts.length > 0 ? parts.join('；') : null
}

/** Per-day facts for the detail panel, classified by the state the API reported. */
export function usageDayDetail(day: ProviderUsageDailyDay): UsageDayDetail {
  const headlines: Record<ProviderUsageDailyDay['state'], string> = {
    recorded: '有实报调用',
    partial: '有调用，但部分请求没有实报 usage',
    empty: '没有记录到调用（不是 0 用量）',
    future: '未来日期，还没有发生',
  }
  return {
    date: day.date,
    state: day.state,
    headline: headlines[day.state],
    usageIncomplete: day.state === 'partial',
    requests: day.requests,
    missingResponses: day.missingResponses,
    unreportedRequests: day.unreportedRequests,
    figures: [
      { label: '总量', value: day.total },
      { label: '输入', value: day.input },
      { label: '输出', value: day.output },
      { label: '缓存读取', value: day.cached },
      { label: '推理', value: day.reasoning },
    ],
  }
}

/** The data attribute each cell carries, so CSS and tests read the same fact. */
export function usageDayStateAttribute(day: ProviderUsageDailyDay | undefined): ProviderUsageDailyDay['state'] | 'missing' {
  return day ? day.state : 'missing'
}

/** A one-line description of the day for its accessible name. */
export function usageDayCellLabel(day: ProviderUsageDailyDay | undefined, metric: UsageMetric): string {
  if (!day) return `${USAGE_METRIC_LABELS[metric]}：无记录（不是 0）`
  const value = usageMetricValue(day, metric)
  if (day.state === 'future') return '未来日期'
  if (day.state === 'empty') return `${USAGE_METRIC_LABELS[metric]}：没有记录到调用（不是 0）`
  const prefix = day.state === 'partial' ? '部分记录' : '已记录'
  return `${prefix}${USAGE_METRIC_LABELS[metric]} ${value} tok，${day.requests} 次调用`
}
