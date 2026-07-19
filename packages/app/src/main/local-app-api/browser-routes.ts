// Local App API routes for the persistent embedded-browser session.

import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { HttpError, json, type LocalAppApiRequest } from './http.js'
import type { BrowserStorageOperationResult, BrowserStorageStatus } from '../../shared/browser-control-contracts.js'

export interface BrowserRouteContext {
  getBrowserStorageStatus?: () => Promise<BrowserStorageStatus>
  clearBrowserCache?: () => Promise<BrowserStorageOperationResult>
  clearBrowserData?: () => Promise<BrowserStorageOperationResult>
}

export async function routeBrowser(
  request: LocalAppApiRequest,
  context: BrowserRouteContext,
): Promise<boolean> {
  const { res, path, method } = request
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
