// Renderer client for LS-managed development environment settings.

import type {
  DevelopmentEnvironmentPreferencePatch,
  DevelopmentEnvironmentSnapshot,
} from '../../shared/development-environment-contracts'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiResponseError, localApiStatusError, localApiUrl } from './common'

export type {
  DevelopmentEnvironmentId,
  DevelopmentEnvironmentInfo,
  DevelopmentEnvironmentPreferencePatch,
  DevelopmentEnvironmentSnapshot,
  DevelopmentEnvironmentSource,
  DevelopmentEnvironmentState,
} from '../../shared/development-environment-contracts'

export async function getDevelopmentEnvironments(force = false): Promise<DevelopmentEnvironmentSnapshot> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.developmentEnvironments), {
    method: force ? 'POST' : 'GET',
  })
  if (!response.ok) throw localApiStatusError(response.status)
  return response.json() as Promise<DevelopmentEnvironmentSnapshot>
}

export async function saveDevelopmentEnvironmentPreference(
  patch: DevelopmentEnvironmentPreferencePatch,
): Promise<DevelopmentEnvironmentSnapshot> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.developmentEnvironmentPreferences), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<DevelopmentEnvironmentSnapshot>
}

export async function importDevelopmentEnvironment(
  patch: DevelopmentEnvironmentPreferencePatch,
): Promise<DevelopmentEnvironmentSnapshot> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.developmentEnvironmentImport), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<DevelopmentEnvironmentSnapshot>
}

export async function removeDevelopmentEnvironment(
  patch: DevelopmentEnvironmentPreferencePatch,
): Promise<DevelopmentEnvironmentSnapshot> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.developmentEnvironmentRemove), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<DevelopmentEnvironmentSnapshot>
}
