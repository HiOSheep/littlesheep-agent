// 设置 → Token 用量：连接视图模型与用量读取（O6）。
//
// 这一层只做三件事：决定请求哪一年（按 API 的区间上限收窄）、把响应转成可画的
// 视图模型、把"读不到"区分为失败／不可用／空。渲染在 `usage-heatmap-page.tsx`，
// 布局算术在 `usage-heatmap-grid.ts`，纯视图模型在 `usage-heatmap-model.ts`。
import { useMemo, useState } from 'react'
import { useUsageHeatmap } from './use-usage-heatmap'
import {
  buildUsageHeatmapView, usageInitialYear, usageSeriesMismatch, usageYearOptions,
  type UsageMetric,
} from './usage-heatmap-model'
import { usageYearWindow } from './usage-heatmap-grid'
import { UsageHeatmapPage } from './usage-heatmap-page'
import { PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS } from '@littlesheep/types'

export function SettingsUsagePage() {
  const [year, setYear] = useState(() => usageInitialYear())
  const [metric, setMetric] = useState<UsageMetric>('total')
  const [provider, setProvider] = useState<string | undefined>(undefined)
  const [model, setModel] = useState<string | undefined>(undefined)

  const window = useMemo(() => usageYearWindow(year, PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS), [year])
  const query = useMemo(() => ({
    from: window.from,
    to: window.to,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }), [window.from, window.to, provider, model])

  const { state, refresh } = useUsageHeatmap(query)

  /**
   * A remembered series is only drawn when it answers the request on screen: the
   * range in the response has to be the range that was asked for, so a payload for
   * another year can never be plotted as this one.
   */
  const mismatch = usageSeriesMismatch(state.series, window)
  const series = mismatch ? null : state.series
  const view = useMemo(
    () => (series ? buildUsageHeatmapView({ series, metric }) : null),
    [series, metric],
  )
  const years = useMemo(
    () => (series ? usageYearOptions(series, year) : [year]),
    [series, year],
  )

  return (
    <UsageHeatmapPage
      view={view}
      firstLoad={state.loading && !series}
      loading={state.loading}
      error={state.error}
      unavailableReason={mismatch}
      years={years}
      year={view?.year ?? year}
      metric={metric}
      {...(provider === undefined ? {} : { provider })}
      {...(model === undefined ? {} : { model })}
      onYearChange={setYear}
      onMetricChange={setMetric}
      onProviderChange={setProvider}
      onModelChange={setModel}
      onRefresh={refresh}
    />
  )
}
