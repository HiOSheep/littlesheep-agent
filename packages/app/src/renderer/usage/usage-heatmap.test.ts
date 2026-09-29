// O6 checks for the Token usage heatmap.
//
// The point of this file is to fail against the plausible wrong heatmap:
//
//  - a view that treats a day the projection has no row for as "0 tokens"
//    (the API's `state: 'empty'` vs `recorded, total: 0` distinction),
//  - a view that flattens "no events", "future" and "calls happened but reported
//    no usage" into one grey cell,
//  - a view that ignores the response's own bounds and draws a truncated facet
//    list as if it were the whole list,
//  - a view that silently plots a response for another range, and
//  - a colour scale where one peak makes every other day indistinguishable.
//
// Markup is asserted against `renderToStaticMarkup` of the real component, so the
// tests read what a user would get, not a private helper.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import {
  PROVIDER_USAGE_DAILY_DEFAULT_RANGE_DAYS,
  PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
  PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
  PROVIDER_USAGE_DAILY_VERSION,
  type ProviderUsageDailyDay,
  type ProviderUsageDailySeries,
} from '@littlesheep/types'
import { usageHeatmapWeeks, usageDayNumber, usageLocalDateRange, usageRangeDays, usageWeekday, usageYearWindow } from './usage-heatmap-grid'
import {
  buildUsageHeatmapView, usageDayDetail, usageHeatLevel, usageHeatLegend, usageHeatThresholds,
  usageMetricValue, usageSeriesMismatch, usageTruncationNotice, usageYearOptions,
} from './usage-heatmap-model'
import { EMPTY_USAGE_STATE, usageHeatmapReducer } from './use-usage-heatmap'
import { UsageHeatmapPage } from './usage-heatmap-page'

const DAY_MS = 86_400_000

// The test transform uses the classic JSX runtime, so components need React in scope.
vi.stubGlobal('React', React)

function range(from: string, to: string): string[] {
  const dates: string[] = []
  for (let day = Date.parse(`${from}T00:00:00.000Z`); day <= Date.parse(`${to}T00:00:00.000Z`); day += DAY_MS) {
    dates.push(new Date(day).toISOString().slice(0, 10))
  }
  return dates
}

function day(date: string, state: ProviderUsageDailyDay['state'], total = 0, requests = 0): ProviderUsageDailyDay {
  return {
    date, state, requests, total,
    input: Math.round(total * 0.8),
    output: Math.round(total * 0.2),
    cached: 0, reasoning: 0, missingResponses: 0, unreportedRequests: 0,
  }
}

function seriesOf(from: string, to: string, days: ProviderUsageDailyDay[]): ProviderUsageDailySeries {
  const dates = range(from, to)
  // A date with no row in `days` stays absent: the API reports `empty` rows for
  // days it looked at, and this fixture is about the days it did not report.
  const all = days.filter((entry) => dates.includes(entry.date))
  const total = all.reduce((sum, entry) => sum + entry.total, 0)
  return {
    version: PROVIDER_USAGE_DAILY_VERSION,
    timezone: 'Asia/Shanghai',
    range: { from, to, days: dates.length },
    bounds: {
      maxRangeDays: PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS,
      maxIdentities: PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
      identitiesTruncated: false,
    },
    filters: {},
    days: all,
    totals: {
      total,
      input: all.reduce((sum, entry) => sum + entry.input, 0),
      output: all.reduce((sum, entry) => sum + entry.output, 0),
      cached: 0,
      reasoning: 0,
      requests: all.reduce((sum, entry) => sum + entry.requests, 0),
      activeDays: all.filter((entry) => entry.requests > 0).length,
    },
    identities: {
      providers: [{ id: 'deepseek', requests: 2, total }],
      models: [{ id: 'deepseek-chat', requests: 2, total }],
    },
    coverage: {
      timezone: 'Asia/Shanghai',
      timezoneSource: 'system',
      indexedRuns: 3, indexedSessions: 1, attempts: 2,
      missingResponses: 0, unreportedRequests: 0, unreadableRuns: 0,
      modes: { next: 3, shadow: 0, unknown: 0 }, duplicateAttempts: 0,
      projectionBuilt: true, stale: false, retainedAfterDeleteSessions: 0,
      backfill: { status: 'complete', partitions: 3, processed: 3, indexed: 3, failed: 0 },
      statement: '统计时区 Asia/Shanghai（默认系统时区）；本区间 2 天有实报调用，其余日期没有记录（不是 0）',
    },
  }
}

/**
 * July–August 2026 with three different "no tokens here" facts at once:
 *  - `2026-07-02` is an `empty` row: the projection looked at the day and found
 *    no recorded call (this is the response's own fact, not a missing row),
 *  - `2026-07-04` is a `recorded` row whose reported usage really is zero,
 *  - every other date in the range has no row at all, which is the state a
 *    consumer must not silently turn into a zero day.
 */
const JULY = seriesOf('2026-07-01', '2026-08-31', [
  day('2026-07-01', 'recorded', 1000, 1),
  day('2026-07-02', 'empty'),
  day('2026-07-03', 'recorded', 120, 2),
  day('2026-07-04', 'recorded', 0, 1),
  day('2026-07-05', 'partial', 40, 1),
  day('2026-07-06', 'future'),
])

function render(overrides: Record<string, unknown> = {}): string {
  const props = {
    view: buildUsageHeatmapView({ series: JULY, metric: 'total' as const }),
    firstLoad: false,
    loading: false,
    error: null,
    unavailableReason: null,
    years: [2026, 2025],
    year: 2026,
    metric: 'total' as const,
    onYearChange: () => undefined,
    onMetricChange: () => undefined,
    onProviderChange: () => undefined,
    onModelChange: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(createElement(UsageHeatmapPage, props as never))
}

function cellMarkup(html: string, date: string): string {
  const match = html.match(new RegExp(`<button[^>]*data-date="${date}"[^>]*>`, 'u'))
  if (!match) throw new Error(`no cell rendered for ${date}`)
  return match[0]
}

describe('usage heatmap calendar layout', () => {
  it('covers every day of the requested range exactly once', () => {
    expect(usageRangeDays('2026-01-01', '2026-12-31')).toBe(365)
    expect(usageRangeDays('2024-01-01', '2024-12-31')).toBe(366)
    expect(usageRangeDays('2026-03-01', '2026-02-01')).toBe(0)
    expect(usageRangeDays('2026-02-31', '2026-03-01')).toBe(0)
    expect(usageLocalDateRange('2026-07-01', '2026-07-03')).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('lays a year out as Monday-based weeks with aligned weekday rows', () => {
    const layout = usageHeatmapWeeks('2026-01-01', '2026-12-31')
    const cells = layout.weeks.flat().filter((cell) => cell !== null)
    expect(cells).toHaveLength(365)
    expect(new Set(cells.map((cell) => cell.date)).size).toBe(365)
    for (const week of layout.weeks) expect(week).toHaveLength(7)
    // 2026-01-01 is a Thursday: Monday 0 … Thursday 3, so the year opens with 3 pads.
    expect(layout.weeks[0]!.slice(0, 3)).toEqual([null, null, null])
    expect(layout.weeks[0]![3]!.date).toBe('2026-01-01')
    // Weekday and column agree for every cell, across the leap day too.
    for (const cell of cells) {
      expect(cell.weekday, cell.date).toBe(usageWeekday(usageDayNumber(cell.date)!))
    }
    expect(usageHeatmapWeeks('2024-01-01', '2024-12-31').weeks.flat().filter(Boolean)).toHaveLength(366)
  })

  it('keeps the requested year inside the API range bound', () => {
    expect(usageYearWindow(2026, PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    // A window that would exceed the bound is narrowed instead of being sent.
    expect(usageYearWindow(2026, 100)).toEqual({ from: '2026-01-01', to: '2026-04-10' })
    const window = usageYearWindow(2026, PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS)
    expect(usageRangeDays(window.from, window.to)).toBeLessThanOrEqual(PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS)
    expect(PROVIDER_USAGE_DAILY_DEFAULT_RANGE_DAYS).toBeLessThanOrEqual(PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS)
  })
})

describe('usage heatmap colour scale', () => {
  it('spreads the four lower bands under a single peak instead of flattening them', () => {
    // A realistic year: one enormous day, then ordinary days spread below it.
    const max = 1_000_000
    const thresholds = usageHeatThresholds(max)
    const levels = [5_000, 150_000, 300_000, 600_000, max].map((value) => usageHeatLevel(value, thresholds))
    expect(levels).toEqual([1, 1, 2, 3, 5])
    expect(new Set(levels).size).toBe(4)
    // Every shade below the peak is genuinely reachable, so one peak cannot make
    // the rest of the year indistinguishable from itself.
    const spread = [1, 250_000, 450_000, 650_000, 900_000].map((value) => usageHeatLevel(value, thresholds))
    expect([...new Set(spread)].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5])
    expect(usageHeatLevel(0, thresholds)).toBe(0)
  })

  it('collapses to a single band when nothing was recorded', () => {
    const thresholds = usageHeatThresholds(0)
    expect(thresholds).toEqual([0, 0, 0, 0])
    expect(usageHeatLevel(0, thresholds)).toBe(0)
    expect(usageHeatLegend(thresholds)).toEqual([{ level: 0, label: '本视图没有实报用量' }])
  })

  it('states the numeric range each shade stands for', () => {
    const legend = usageHeatLegend(usageHeatThresholds(1000))
    expect(legend.map((step) => step.level)).toEqual([1, 2, 3, 4, 5])
    expect(legend[0]!.label).toBe('1 – 200')
    expect(legend[4]!.label).toBe('801 以上')
    const starts = legend.map((step) => Number(step.label.split(' ')[0]!.replace('以上', '')))
    expect([...starts].sort((left, right) => left - right)).toEqual(starts)
  })
})

describe('usage heatmap honesty rules', () => {
  it('distinguishes an absent row from a zero-valued recorded day', () => {
    const view = buildUsageHeatmapView({ series: JULY, metric: 'total' })
    // A date the response never mentioned is not in the view at all ...
    expect(view.days.get('2026-07-10')).toBeUndefined()
    expect(view.days.size).toBe(6)
    // ... an `empty` row is, and says so ...
    expect(view.days.get('2026-07-02')).toMatchObject({ state: 'empty', requests: 0 })
    // ... and a recorded day that really reported zero is a third fact.
    expect(usageMetricValue(view.days.get('2026-07-04')!, 'total')).toBe(0)
    expect(view.days.get('2026-07-04')!.state).toBe('recorded')
    expect(view.range.days).toBe(62)
    expect(view.effectiveMax).toBe(1000)
  })

  it('keeps empty, future, partial and recorded as four different facts', () => {
    const view = buildUsageHeatmapView({ series: JULY, metric: 'total' })
    expect(usageDayDetail(view.days.get('2026-07-02')!).headline).toContain('不是 0')
    expect(usageDayDetail(view.days.get('2026-07-02')!).state).toBe('empty')
    expect(usageDayDetail(view.days.get('2026-07-06')!).state).toBe('future')
    expect(usageDayDetail(view.days.get('2026-07-05')!).usageIncomplete).toBe(true)
    expect(usageDayDetail(view.days.get('2026-07-04')!).usageIncomplete).toBe(false)
    expect(usageDayDetail(view.days.get('2026-07-04')!).headline).toBe('有实报调用')
  })

  it('reports a truncated facet list as truncated, not as the whole list', () => {
    const truncated: ProviderUsageDailySeries = { ...JULY, bounds: { ...JULY.bounds, identitiesTruncated: true } }
    expect(usageTruncationNotice(truncated)).toContain(`最高的 ${PROVIDER_USAGE_DAILY_MAX_IDENTITIES} 个`)
    expect(usageTruncationNotice(JULY)).toBeNull()
  })

  it('refuses to plot a response that does not answer the request', () => {
    expect(usageSeriesMismatch(JULY, { from: '2026-07-01', to: '2026-08-31' })).toBeNull()
    expect(usageSeriesMismatch(JULY, { from: '2026-01-01', to: '2026-12-31' })).toContain('不是请求的')
    expect(usageSeriesMismatch({ ...JULY, version: 2 as typeof JULY.version }, { from: '2026-07-01', to: '2026-08-31' }))
      .toContain('版本')
    // A row outside the requested range is refused rather than plotted.
    expect(usageSeriesMismatch(
      { ...JULY, days: [...JULY.days, day('2026-09-01', 'recorded', 5, 1)] },
      { from: '2026-07-01', to: '2026-08-31' },
    )).toContain('区间外')
    expect(usageSeriesMismatch(
      { ...JULY, range: { ...JULY.range, days: 2 } },
      { from: '2026-07-01', to: '2026-08-31' },
    )).toContain('多于声明的')
    expect(usageSeriesMismatch(null, { from: '2026-07-01', to: '2026-08-31' })).toContain('还没有收到')
    // A short (but in-range) series is a valid response: the contract bounds the
    // row count instead of promising one row per date.
    expect(usageSeriesMismatch(
      { ...JULY, days: JULY.days.slice(0, 2) },
      { from: '2026-07-01', to: '2026-08-31' },
    )).toBeNull()
  })

  it('offers only years the projection actually mentions', () => {
    const withBounds: ProviderUsageDailySeries = {
      ...JULY,
      coverage: {
        ...JULY.coverage,
        firstAttemptAt: '2025-12-30T02:00:00.000Z',
        lastAttemptAt: '2026-07-03T02:00:00.000Z',
      },
    }
    expect(usageYearOptions(withBounds, 2026)).toEqual([2026, 2025])
    expect(usageYearOptions(JULY, 2026)).toEqual([2026])
  })
})

describe('usage heatmap refresh state', () => {
  it('keeps the last good series when a refresh fails', () => {
    const loaded = usageHeatmapReducer(EMPTY_USAGE_STATE, {
      type: 'loaded', query: { from: '2026-01-01', to: '2026-12-31' }, series: JULY,
    })
    const failed = usageHeatmapReducer(loaded, { type: 'failed', error: { message: 'boom', status: 500 } })
    expect(failed.series).toBe(JULY)
    expect(failed.loading).toBe(false)
    expect(failed.error?.message).toBe('boom')
    const renewed = usageHeatmapReducer(failed, { type: 'request', query: { from: '2026-01-01', to: '2026-12-31' } })
    expect(renewed.series).toBe(JULY)
    expect(renewed.error).toBeNull()
  })
})

describe('usage heatmap surface', () => {
  it('draws the cell state the projection reported, not one grey grid', () => {
    const html = render()
    expect(cellMarkup(html, '2026-07-01')).toContain('data-state="recorded"')
    expect(cellMarkup(html, '2026-07-01')).toContain('data-level="5"')
    expect(cellMarkup(html, '2026-07-04')).toContain('data-state="recorded"')
    expect(cellMarkup(html, '2026-07-04')).toContain('data-level="0"')
    expect(cellMarkup(html, '2026-07-02')).toContain('data-state="empty"')
    expect(cellMarkup(html, '2026-07-05')).toContain('data-state="partial"')
    expect(cellMarkup(html, '2026-07-06')).toContain('data-state="future"')
    // A date with no row in the response is drawn as "not covered", not as a zero day.
    expect(cellMarkup(html, '2026-07-10')).toContain('data-state="missing"')
    expect(cellMarkup(html, '2026-07-10')).not.toContain('tok')
    // An `empty` row says a call was looked for and not found; it has no token figure either.
    expect(cellMarkup(html, '2026-07-02')).toContain('data-state="empty"')
    expect(cellMarkup(html, '2026-07-02')).not.toContain('tok')
    expect(cellMarkup(html, '2026-07-02')).toContain('不是 0')
    // The recorded zero day is the only one of the three with a token figure.
    expect(cellMarkup(html, '2026-07-04')).toContain('总量 0 tok')
  })

  it('keeps the legend, the grid roles and the roving tabindex addressable', () => {
    const html = render()
    expect(html).toContain('role="grid"')
    expect(html).toContain('role="gridcell"')
    expect(html).toContain('1 – 200')
    expect(html).toContain('801 以上')
    expect(html).toContain('无记录（不是 0 用量）')
    expect(html).toContain('未来日期')
    expect(html).toContain('部分记录（有调用但未报 usage）')
    expect(html.match(/data-date="[^"]+"[^>]*tabindex="0"/gu)).toHaveLength(1)
    expect(html).toContain('aria-label="2026 年总量热力图"')
  })

  it('keeps a readable year on screen when only the refresh failed', () => {
    const html = render({ error: { message: 'Runtime 还没有就绪，暂时读不到用量投影。', status: 503 } })
    expect(html).toContain('usage-refresh-failure')
    expect(html).toContain('仍显示上一次成功读取的结果')
    expect(html).not.toContain('state-view')
    expect(html).toContain('data-date="2026-07-01"')
  })

  it('uses the shared four-state view when there is nothing to draw', () => {
    const loading = render({ view: null, firstLoad: true, loading: true })
    expect(loading).toContain('data-state="loading"')
    const failure = render({ view: null, loading: false, error: { message: 'read failed', status: 500 } })
    expect(failure).toContain('data-state="failure"')
    const unavailable = render({
      view: null, loading: false,
      error: { message: 'Runtime 还没有就绪，暂时读不到用量投影。', status: 503 },
    })
    expect(unavailable).toContain('data-state="unavailable"')
    expect(unavailable).toContain('state-view-reason')
    const empty = render({ view: null, loading: false })
    expect(empty).toContain('data-state="empty"')
    expect(empty).not.toContain('state-view-reason')
    const mismatch = render({ view: null, loading: false, unavailableReason: '用量数据版本 2 不是本界面支持的 1' })
    expect(mismatch).toContain('state-view-reason')
    expect(mismatch).toContain('用量数据版本 2')
  })
})
