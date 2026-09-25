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

export type BrowserDiagnosticKind = 'script' | 'resource' | 'navigation' | 'console'

export interface BrowserDiagnosticEntry {
  kind: BrowserDiagnosticKind
  message: string
  url: string
  sourceId: string
  lineNumber: number
  at: string
}

export interface BrowserDiagnostics {
  entries: BrowserDiagnosticEntry[]
  counts: Record<BrowserDiagnosticKind, number>
  revision: number
}

/**
 * What a page in the embedded browser reported (script errors, failed resources,
 * load failures). UX-26: running a page must be diagnosable without DevTools.
 */
export async function getBrowserDiagnostics(url: string): Promise<BrowserDiagnostics> {
  const query = new URLSearchParams({ url })
  const response = await localApiFetch(`${LOCAL_APP_API_ROUTES.browserDiagnostics}?${query}`)
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<BrowserDiagnostics>
}
