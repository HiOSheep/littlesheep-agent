// 设置 → Token 用量：跨日热力图（O6）。
//
// 这一页只画 O5 已经算好的日序列：数字不在这里求和，日期不在这里重新归日，
// 供应商／模型只来自响应里实际记录到的身份。四态（加载／无数据／不可用／失败）
// 一律走共享的 `ui/state-view.tsx`，因此"读不到"永远不会画成"没有用量"。
//
// 键盘与滚动：日期格是一个 roving-tabindex 网格，方向键移动、Home/End 到周首尾、
// Enter/Space 选中；网格自己横向滚动（`overflow-x: auto`），不把页面撑宽或困住滚动。
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { StateView, type StateViewProps } from '../ui/state-view'
import { SettingsSelect } from '../settings/select'
import { formatTokenCount } from '../chat/turn-usage-card'
import { usageDayDetail, usageHeatLevel, usageMetricValue, USAGE_METRICS, USAGE_METRIC_LABELS,
  type UsageHeatmapViewModel, type UsageMetric } from './usage-heatmap-model'
import { UsageDayPanel, UsageHeatmapLegend, usageCellAria, usageCellTitle } from './usage-heatmap-detail'
import { usageLocalDateRange } from './usage-heatmap-grid'

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

export interface UsageHeatmapPageProps {
  view: UsageHeatmapViewModel | null
  /** True while the first load has nothing to show yet. */
  firstLoad: boolean
  loading: boolean
  /** Set while the previous (still readable) year failed to refresh. */
  error: { message: string; status?: number } | null
  /**
   * Set when the surface has an answer but cannot render it as a year, for
   * example a response that does not cover the requested range.
   */
  unavailableReason: string | null
  years: readonly number[]
  year: number
  metric: UsageMetric
  provider?: string
  model?: string
  onYearChange: (year: number) => void
  onMetricChange: (metric: UsageMetric) => void
  onProviderChange: (provider?: string) => void
  onModelChange: (model?: string) => void
  onRefresh: () => void
}

export function UsageHeatmapPage(props: UsageHeatmapPageProps) {
  const { view, firstLoad, loading, error, unavailableReason } = props
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const activeDate = selectedDate && view?.days.has(selectedDate) ? selectedDate : null

  const dates = useMemo(
    () => (view ? usageLocalDateRange(view.range.from, view.range.to) : []),
    [view],
  )
  const monthBand = useMemo(() => usageMonthBand(view), [view])

  const moveFocus = (from: string, delta: number) => {
    const index = dates.indexOf(from)
    if (index < 0) return
    const next = dates[index + delta]
    if (!next) return
    setSelectedDate(next)
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)
    cell?.focus({ preventScroll: true })
    cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onCellKeyDown = (event: KeyboardEvent<HTMLElement>, date: string) => {
    const index = dates.indexOf(date)
    const rowStart = Math.floor(Math.max(0, index) / 7) * 7
    const moves: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
    const delta = moves[event.key]
    if (delta !== undefined) {
      event.preventDefault()
      moveFocus(date, delta)
      return
    }
    if (event.key === 'Home') { event.preventDefault(); moveFocus(date, rowStart - index) }
    if (event.key === 'End') { event.preventDefault(); moveFocus(date, rowStart + 6 - index) }
    if (event.key === 'PageUp') { event.preventDefault(); moveFocus(date, -35) }
    if (event.key === 'PageDown') { event.preventDefault(); moveFocus(date, 35) }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedDate(date)
    }
  }

  return (
    <div className="settings-module-page usage-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">模型与行为</div>
        <h2>Token 用量</h2>
        <p>按本地日历日汇总 Provider 实报的 token 用量；没有记录的日子不会当成 0。</p>
      </header>

      <div className="usage-toolbar">
        <SettingsSelect
          label="统计年份"
          value={String(props.year)}
          options={props.years.map((year) => ({ value: String(year), label: `${year} 年` }))}
          onChange={(value) => props.onYearChange(Number(value))}
        />
        <SettingsSelect
          label="统计指标"
          value={props.metric}
          options={USAGE_METRICS.map((entry) => ({ value: entry.value, label: entry.label }))}
          onChange={(value) => props.onMetricChange(value)}
        />
        {view && (
          <>
            <SettingsSelect
              label="供应商筛选"
              value={props.provider ?? ''}
              options={[{ value: '', label: '全部供应商' },
                ...view.providers.map((entry) => ({ value: entry.id, label: entry.id }))]}
              onChange={(value) => props.onProviderChange(value || undefined)}
            />
            <SettingsSelect
              label="模型筛选"
              value={props.model ?? ''}
              options={[{ value: '', label: '全部模型' },
                ...view.models.map((entry) => ({ value: entry.id, label: entry.id }))]}
              onChange={(value) => props.onModelChange(value || undefined)}
            />
          </>
        )}
        <button type="button" className="usage-refresh" onClick={props.onRefresh} disabled={loading}>
          {loading ? '正在刷新' : '刷新用量'}
        </button>
      </div>

      {view && (
        <dl className="usage-summary">
          <div><dt>总量</dt><dd>{formatTokenCount(view.totals.total)} tok</dd></div>
          <div><dt>活跃天数</dt><dd>{view.totals.activeDays} 天</dd></div>
          <div><dt>单日峰值</dt><dd>{view.totals.peak ? `${view.totals.peak.total} tok · ${view.totals.peak.date}` : '无记录'}</dd></div>
          <div><dt>请求数</dt><dd>{view.totals.requests} 次</dd></div>
        </dl>
      )}

      {error && view && (
        <p className="usage-refresh-failure" role="status">
          上次刷新失败：{error.message}（仍显示上一次成功读取的结果）
        </p>
      )}
      {view?.truncationNotice && <p className="usage-coverage-notice" role="status">{view.truncationNotice}</p>}

      {!view && firstLoad && <StateView state="loading" title="正在读取用量投影" />}
      {!view && !firstLoad && error && <StateView {...offlineState(error, props.onRefresh)} />}
      {!view && !firstLoad && !error && unavailableReason && (
        <StateView
          state="unavailable"
          title="这一年暂时画不出来"
          description="响应本身说明了它不能作为这一年的用量来读。"
          reason={unavailableReason}
          action={<button type="button" onClick={props.onRefresh}>重试</button>}
        />
      )}
      {!view && !firstLoad && !error && !unavailableReason && (
        <StateView
          state="empty"
          title="没有记录到任何用量"
          description="没有可以展示的日序列。空与 0 是两件事：这里没有数字，不是数字为零。"
          action={<button type="button" onClick={props.onRefresh}>刷新用量</button>}
        />
      )}

      {view && (
        <>
          <div className="usage-heatmap-scroll">
            <div
              className="usage-heatmap"
              role="grid"
              aria-label={`${view.year} 年${USAGE_METRIC_LABELS[view.metric]}热力图`}
              ref={gridRef}
            >
              <div className="usage-heatmap-head">
                <div className="usage-heatmap-weekdays" aria-hidden="true">
                  {WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
                </div>
                <div className="usage-heatmap-months" aria-hidden="true">
                  {monthBand.map((label, index) => <span key={index}>{label}</span>)}
                </div>
              </div>
              <div className="usage-heatmap-grid">
                {view.weeks.weeks.map((week, weekIndex) => (
                  <div className="usage-heatmap-week" role="row" key={weekIndex}>
                    {week.map((cell, slot) => {
                      if (!cell) return <span className="usage-cell-pad" key={slot} aria-hidden="true" />
                      const day = view.days.get(cell.date)
                      const detail = day ? usageDayDetail(day) : null
                      const level = day ? usageHeatLevel(usageMetricValue(day, view.metric), view.thresholds) : 0
                      const state = day ? day.state : 'missing'
                      const value = day ? usageMetricValue(day, view.metric) : 0
                      const focusable = activeDate === null ? cell.date === dates[0] : activeDate === cell.date
                      return (
                        <button
                          type="button"
                          key={cell.date}
                          data-date={cell.date}
                          data-state={state}
                          data-level={level}
                          role="gridcell"
                          tabIndex={focusable ? 0 : -1}
                          aria-label={`${cell.date} ${USAGE_METRIC_LABELS[view.metric]}${usageCellAria(state, value)}`}
                          title={usageCellTitle(cell.date, detail, state, view.metric, value)}
                          onFocus={() => setSelectedDate(cell.date)}
                          onClick={() => setSelectedDate(cell.date)}
                          onKeyDown={(event) => onCellKeyDown(event, cell.date)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <UsageHeatmapLegend view={view} />

          {activeDate && <UsageDayPanel date={activeDate} view={view} />}

          <p className="usage-statement">{view.coverage.statement}</p>
        </>
      )}
    </div>
  )
}

/**
 * The one place the failure/unavailable pair is built, so the discriminated union
 * of `StateViewProps` is satisfied by construction: `unavailable` carries the
 * reason the Runtime gave, `failure` carries the plain fact that the read failed.
 */
function offlineState(
  error: { message: string; status?: number },
  onRefresh: () => void,
): StateViewProps {
  const action = <button type="button" onClick={onRefresh}>重试</button>
  if (error.status === 503) {
    return {
      state: 'unavailable',
      title: 'Runtime 还没有就绪',
      description: '用量投影由 Runtime 提供，就绪后可以重新读取。',
      reason: error.message,
      action,
    }
  }
  return {
    state: 'failure',
    title: '读取用量失败',
    description: '读取这次用量数据没有成功，可以重试。',
    action,
  }
}

/** One label per week column: the month whose 1st-7th falls in that week. */
function usageMonthBand(view: UsageHeatmapViewModel | null): string[] {
  if (!view) return []
  const labels: string[] = new Array(view.weeks.weekCount).fill('')
  for (const cell of view.weeks.weekStarts) {
    if (cell && cell.dayOfMonth <= 7) labels[cell.week] = `${cell.month}月`
  }
  return labels
}
