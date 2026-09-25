// Local App API routes for the persistent embedded-browser session.

import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { HttpError, json, type LocalAppApiRequest } from './http.js'
import type { BrowserStorageOperationResult, BrowserStorageStatus } from '../../shared/browser-control-contracts.js'
import {
  guestDiagnosticsRevision,
  listGuestDiagnostics,
  summarizeGuestDiagnostics,
} from '../embedded-browser-diagnostics.js'

export interface BrowserRouteContext {
  getBrowserStorageStatus?: () => Promise<BrowserStorageStatus>
  clearBrowserCache?: () => Promise<BrowserStorageOperationResult>
  clearBrowserData?: () => Promise<BrowserStorageOperationResult>
}

export async function routeBrowser(
  request: LocalAppApiRequest,
  context: BrowserRouteContext,
): Promise<boolean> {
  const { res, path, method, url } = request
  // What a run page reported (script errors, failed resources, load failures), so the
  // user does not have to open DevTools. The record itself is bounded and owned by
  // `../embedded-browser-diagnostics.ts`; this route only reads it.
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.browserDiagnostics) {
    const pageUrl = url.searchParams.get('url') ?? undefined
    json(res, 200, {
      entries: listGuestDiagnostics(pageUrl),
      counts: summarizeGuestDiagnostics(pageUrl),
      revision: guestDiagnosticsRevision(),
    })
    return true
  }
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.browserStatus) {
    if (!context.getBrowserStorageStatus) throw new HttpError(501, 'embedded browser session is unavailable')
    json(res, 200, await context.getBrowserStorageStatus())
    return true
  }
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.browserClearCache) {
    if (!context.clearBrowserCache) throw new HttpError(501, 'embedded browser session is unavailable')
    json(res, 200, await context.clearBrowserCache())
    return true
  }
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.browserClearData) {
    if (!context.clearBrowserData) throw new HttpError(501, 'embedded browser session is unavailable')
    json(res, 200, await context.clearBrowserData())
    return true
  }
  return false
}
