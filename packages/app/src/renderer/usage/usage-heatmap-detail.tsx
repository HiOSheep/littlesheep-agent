// Token 用量热力图（O6）：图例与每日详情。
//
// 图例与详情是"颜色代表什么"和"这一天到底是什么事实"的答案，因此单独成文件：
// 它们必须能说清 `empty`（没有记录到调用）、`missing`（投影没有这一行）、`future`
// 和 `partial`（有调用但未报 usage）四种状态，而不是把它们都读成 0。
import { formatTokenCount } from '../chat/turn-usage-card'
import {
  usageDayDetail, USAGE_METRIC_LABELS,
  type UsageHeatmapViewModel, type UsageMetric,
} from './usage-heatmap-model'

/** The colour scale plus the three states that share no shade with it. */
export function UsageHeatmapLegend({ view }: { view: UsageHeatmapViewModel }) {
  return (
    <div className="usage-legend" aria-label="色阶图例">
      <div className="usage-legend-scale">{view.effectiveMax > 0 ? <><span>少</span>{view.legend.map((step) => <span className="usage-legend-item" key={step.level} title={`${step.label} tok`}><i data-level={step.level} aria-hidden="true" /><span className="visually-hidden">{step.label}</span></span>)}<span>多</span></> : <span>尚无实报用量</span>}</div>
      <div className="usage-legend-states">
        <span className="usage-legend-item" title="无记录（不是 0 用量）"><i data-state="empty" aria-hidden="true" />无记录</span>
        <span className="usage-legend-item" title="投影未覆盖的日期"><i data-state="missing" aria-hidden="true" />未覆盖</span>
        <span className="usage-legend-item"><i data-state="future" aria-hidden="true" />未来日期</span>
        <span className="usage-legend-item" title="部分记录（有调用但未报 usage）"><i data-state="partial" aria-hidden="true" />部分记录</span>
      </div>
      <details className="usage-legend-details"><summary>查看色阶范围</summary><div>{view.legend.map(step => <span className="usage-legend-item" key={step.level}><i data-level={step.level} aria-hidden="true" />{step.label} tok</span>)}<span className="usage-legend-item"><i data-level="0" aria-hidden="true" />实报 0 tok</span></div></details>
    </div>
  )
}

/**
 * The exact figures of the day the reader is standing on. The state sentence comes
 * first because it decides how the figures may be read: a `partial` day's numbers
 * are what was reported, not the day's whole consumption, and a day with no row is
 * not a zero day.
 */
export function UsageDayPanel({ date, view }: { date: string; view: UsageHeatmapViewModel }) {
  const day = view.days.get(date)
  const detail = day ? usageDayDetail(day) : null
  return (
    <section className="usage-day-panel" aria-label="每日详情" role="status">
      <header>
        <strong>{date}</strong>
        <span data-state={day ? day.state : 'missing'}>
          {detail ? detail.headline : '投影未覆盖这一天（不是 0 用量）'}
        </span>
      </header>
      {detail && (day?.state === 'recorded' || day?.state === 'partial') ? (
        <>
          <dl>
            {detail.figures.map((figure) => (
              <div key={figure.label}><dt>{figure.label}</dt><dd>{figure.value.toLocaleString()} <span>tok</span></dd></div>
            ))}
            <div><dt>去重后请求</dt><dd>{detail.requests} 次</dd></div>
            {detail.missingResponses > 0 && <div><dt>响应未报 usage</dt><dd>{detail.missingResponses} 次</dd></div>}
            {detail.unreportedRequests > 0 && <div><dt>请求无响应</dt><dd>{detail.unreportedRequests} 次</dd></div>}
          </dl>
          {detail.usageIncomplete && (
            <p className="usage-day-partial">
              这一天的部分请求没有实报 usage，因此上面的数字是已报告部分，不是当天全部消耗。
            </p>
          )}
        </>
      ) : (
        <p>{day?.state === 'empty' ? '这一天没有调用记录，用量未知。' : day?.state === 'future' ? '这一天尚未发生，没有用量数据。' : '这一天的日期在请求区间里，但投影没有为它返回任何行；它既不是 0 用量，也不是一次失败。'}</p>
      )}
    </section>
  )
}

/** The day cell's accessible name, one sentence per state. */
export function usageCellAria(state: string, value: number): string {
  if (state === 'future') return '：未来日期'
  if (state === 'missing') return '：投影未覆盖（不是 0 用量）'
  if (state === 'empty') return '：没有记录到调用（不是 0 用量）'
  if (state === 'partial') return `：部分记录 ${value} tok（有调用未报 usage）`
  return `${value} tok`
}

/**
 * The hover text. A day with no recorded call gets no token figure at all - "0
 * tok" beside "no call was recorded" is exactly the flattening this page exists
 * to avoid, and a tooltip is where it would mislead most.
 */
export function usageCellTitle(
  date: string,
  detail: ReturnType<typeof usageDayDetail> | null,
  state: string,
  metric: UsageMetric,
  value: number,
): string {
  if (!detail || state === 'empty') return `${date}｜${detail ? detail.headline : '投影未覆盖（不是 0 用量）'}`
  return `${date}｜${detail.headline}｜${USAGE_METRIC_LABELS[metric]} ${formatTokenCount(value)} tok`
}
