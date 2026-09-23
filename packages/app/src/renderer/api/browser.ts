// Persistent embedded-browser session controls used by Settings.

import type {
  BrowserStorageOperationResult,
  BrowserStorageStatus,
} from '../../shared/browser-control-contracts'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiFetch, localApiResponseError, localApiStatusError } from './common'

export type { BrowserStorageOperationResult, BrowserStorageStatus } from '../../shared/browser-control-contracts'

export async function getBrowserStorageStatus(): Promise<BrowserStorageStatus> {
  const response = await localApiFetch(LOCAL_APP_API_ROUTES.browserStatus)
  if (!response.ok) throw localApiStatusError(response.status)
  return response.json() as Promise<BrowserStorageStatus>
}

export async function clearBrowserCache(): Promise<BrowserStorageOperationResult> {
  const response = await localApiFetch(LOCAL_APP_API_ROUTES.browserClearCache, { method: 'POST' })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<BrowserStorageOperationResult>
}

export async function clearBrowserData(): Promise<BrowserStorageOperationResult> {
  const response = await localApiFetch(LOCAL_APP_API_ROUTES.browserClearData, { method: 'POST' })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<BrowserStorageOperationResult>
}
