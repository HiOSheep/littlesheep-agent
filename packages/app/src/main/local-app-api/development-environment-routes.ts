// Local App API routes for LS-managed development environments.

import type { DevelopmentEnvironmentManager } from '../development-environments.js'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { HttpError, json, readJson, type LocalAppApiRequest } from './http.js'
import {
  DEVELOPMENT_ENVIRONMENT_IDS,
  normalizeDevelopmentEnvironmentVersion,
  type DevelopmentEnvironmentId,
} from '../../shared/development-environment-contracts.js'

export interface DevelopmentEnvironmentRouteContext {
  manager: DevelopmentEnvironmentManager
  selectSource?: (environmentId: string, version: string | null) => Promise<string | null>
}

export async function routeDevelopmentEnvironments(
  request: LocalAppApiRequest,
  context: DevelopmentEnvironmentRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.developmentEnvironments) {
    json(res, 200, await context.manager.snapshot())
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.developmentEnvironments) {
    json(res, 200, await context.manager.snapshot(true))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.developmentEnvironmentPreferences) {
    const body = await readJson(req)
    const environmentId = normalizeEnvironmentId(body.environmentId)
    if (!environmentId) throw new HttpError(400, 'environmentId is invalid')
    const version = normalizeVersionPayload(body.version)
    if (body.version !== null && body.version !== undefined && version === undefined) {
      throw new HttpError(400, 'version is invalid')
    }
    json(res, 200, await context.manager.setVersion(environmentId, version ?? null))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.developmentEnvironmentImport) {
    const body = await readJson(req)
    const environmentId = normalizeEnvironmentId(body.environmentId)
    if (!environmentId) throw new HttpError(400, 'environmentId is invalid')
    if (!context.selectSource) throw new HttpError(501, 'toolchain picker is not available')
    const version = normalizeVersionPayload(body.version)
    if (body.version !== null && body.version !== undefined && version === undefined) {
      throw new HttpError(400, 'version is invalid')
    }
    const source = await context.selectSource(environmentId, version ?? null)
    if (!source) {
      json(res, 200, await context.manager.snapshot())
      return true
    }
    json(res, 200, await context.manager.importVersion(environmentId, version ?? null, source))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.developmentEnvironmentRemove) {
    const body = await readJson(req)
    const environmentId = normalizeEnvironmentId(body.environmentId)
    if (!environmentId) throw new HttpError(400, 'environmentId is invalid')
    const version = normalizeVersionPayload(body.version)
    if (!version) throw new HttpError(400, 'version is invalid')
    json(res, 200, await context.manager.removeVersion(environmentId, version))
    return true
  }
  return false
}

function normalizeEnvironmentId(value: unknown): DevelopmentEnvironmentId | null {
  if (typeof value !== 'string') return null
  return (DEVELOPMENT_ENVIRONMENT_IDS as readonly string[]).includes(value)
    ? value as DevelopmentEnvironmentId
    : null
}

function normalizeVersionPayload(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  return normalizeDevelopmentEnvironmentVersion(value) ?? undefined
}
