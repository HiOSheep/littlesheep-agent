// Load/refresh state for the usage heatmap (O6).
//
// The rules a refresh has to obey, taken from the taskbook's acceptance points:
//
//  - a failed refresh keeps the last good series on screen and adds the failure
//    beside it, instead of replacing a readable year with an error box;
//  - the series that is drawn is always remembered together with the request that
//    produced it, so a response for another range can be detected instead of
//    silently plotted as this year;
//  - `loading` distinguishes the first load (nothing to show yet) from a refresh
//    of numbers that are already readable.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderUsageDailySeries } from '@littlesheep/types'
import { getUsageDailySeries, refreshUsageProjection, usageErrorStatus, type UsageDailyQuery } from './api/usage'

export interface UsageHeatmapState {
  /** True while a request is in flight, including a refresh over cached numbers. */
  loading: boolean
  error: { message: string; status?: number } | null
  series: ProviderUsageDailySeries | null
  /** The request `series` answers; null until the first response. */
  request: UsageDailyQuery | null
}

export const EMPTY_USAGE_STATE: UsageHeatmapState = { loading: true, error: null, series: null, request: null }

export type UsageHeatmapAction =
  | { type: 'request'; query: UsageDailyQuery }
  | { type: 'loaded'; query: UsageDailyQuery; series: ProviderUsageDailySeries }
  | { type: 'failed'; error: { message: string; status?: number } }

export function usageHeatmapReducer(state: UsageHeatmapState, action: UsageHeatmapAction): UsageHeatmapState {
  if (action.type === 'request') return { ...state, loading: true, error: null }
  if (action.type === 'failed') {
    // The previous series survives: "refresh failed" is not "there is no usage".
    return { ...state, loading: false, error: action.error }
  }
  return { loading: false, error: null, series: action.series, request: action.query }
}

export function usageErrorMessage(error: unknown): { message: string; status?: number } {
  const status = usageErrorStatus(error)
  if (status === 503) return { message: 'Runtime 还没有就绪，暂时读不到用量投影。', status }
  const message = error instanceof Error ? error.message : String(error)
  return { message, ...(status === undefined ? {} : { status }) }
}

/**
 * The one hook the page uses. `refresh` re-writes the projection first (a bounded
 * server-side pass) and then reloads the series; `reload` only re-reads it.
 */
export function useUsageHeatmap(query: UsageDailyQuery) {
  const [state, setState] = useState<UsageHeatmapState>(EMPTY_USAGE_STATE)
  const queryKey = `${query.from}|${query.to}|${query.provider ?? ''}|${query.model ?? ''}`
  const queryRef = useRef(query)
  queryRef.current = query

  const load = useCallback(async (mode: 'read' | 'refresh') => {
    const current = queryRef.current
    setState((previous) => usageHeatmapReducer(previous, { type: 'request', query: current }))
    try {
      if (mode === 'refresh') await refreshUsageProjection()
      const series = await getUsageDailySeries(current)
      setState((previous) => usageHeatmapReducer(previous, { type: 'loaded', query: current, series }))
    } catch (error) {
      setState((previous) => usageHeatmapReducer(previous, { type: 'failed', error: usageErrorMessage(error) }))
    }
  }, [])

  useEffect(() => {
    void load('read')
  }, [load, queryKey])

  return {
    state,
    reload: useCallback(() => void load('read'), [load]),
    refresh: useCallback(() => void load('refresh'), [load]),
  }
}
