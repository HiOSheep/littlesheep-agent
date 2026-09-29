// Renderer client for the bounded cross-day usage API (O5 routes, O6 consumer).
//
// Thin on purpose: it builds the query from an explicit date range and identity
// filter, and it never recomputes a total - the series arrives already summed and
// already bounded, and this module does not second-guess it.
import type { ProviderUsageDailySeries } from '@littlesheep/types'
import { LOCAL_APP_API_ROUTES } from '../../../shared/local-app-api-routes'
import { localApiFetch, localApiResponseError } from '../../api/common'

export interface UsageDailyQuery {
  from: string
  to: string
  provider?: string
  model?: string
}

/**
 * The timezone is deliberately not sent: the API's own default is the Runtime's
 * system timezone, and the response reports which one it used. Sending a
 * renderer-side guess would make a day's meaning depend on two clocks.
 */
export function usageDailyPath(query: UsageDailyQuery): string {
  const params = new URLSearchParams({ from: query.from, to: query.to })
  if (query.provider) params.set('provider', query.provider)
  if (query.model) params.set('model', query.model)
  return `${LOCAL_APP_API_ROUTES.usageDaily}?${params.toString()}`
}

export async function getUsageDailySeries(query: UsageDailyQuery): Promise<ProviderUsageDailySeries> {
  const res = await localApiFetch(usageDailyPath(query))
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<ProviderUsageDailySeries>
}

/** One bounded incremental update of the projection. */
export async function refreshUsageProjection(): Promise<void> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.usageRefresh, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw await localApiResponseError(res)
}

/** The status code of a failed Local App API call, when it has one. */
export function usageErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status
  return undefined
}
