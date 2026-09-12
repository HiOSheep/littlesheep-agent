// Runtime, provider, data-root and credential clients.

import type {
  DataRootStatus,
  ProviderDraft,
  ProviderInfo,
  RuntimePatch,
  RuntimeState,
} from '../../shared/runtime-api-contracts'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiResponseError, localApiStatusError, localApiUrl } from './common'

export async function getProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configProviders))
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { providers: ProviderInfo[] }
  return data.providers
}

/** Create or update one provider (settings page). Returns the new runtime state. */
export async function saveProvider(provider: ProviderDraft): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configProviders), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}

/** Remove a user-defined provider. Built-in presets are rejected by Main. */
export async function deleteProvider(providerId: string): Promise<RuntimeState> {
  const res = await fetch(
    localApiUrl(`${LOCAL_APP_API_ROUTES.configProviders}/${encodeURIComponent(providerId)}`),
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}

export async function getRuntime(): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runtime))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RuntimeState>
}

export async function updateRuntime(patch: RuntimePatch): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runtime), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}

export async function clearWebCache(): Promise<{ ok: boolean; cleared: boolean }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.webCache), { method: 'DELETE' })
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<{ ok: boolean; cleared: boolean }>
}

export async function checkWebProvider(): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.webProviderCheck), { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}

export async function getDataRootStatus(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRoot))
  return parseDataRootResponse(res)
}

export async function selectDataRootTarget(): Promise<string | null> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootSelect), { method: 'POST' })
  if (!res.ok) throw await localApiResponseError(res)
  const data = await res.json() as { path: string | null }
  return data.path
}

export async function requestDataRootMigration(targetDir: string): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootMigration), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDir }),
  })
  return parseDataRootResponse(res)
}

export async function cancelDataRootOperation(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootMigration), { method: 'DELETE' })
  return parseDataRootResponse(res)
}

export async function requestDataRootRollback(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootRollback), { method: 'POST' })
  return parseDataRootResponse(res)
}

export async function restartApplication(): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.applicationRestart), { method: 'POST' })
  if (!res.ok) throw await localApiResponseError(res)
}

async function parseDataRootResponse(res: Response): Promise<DataRootStatus> {
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<DataRootStatus>
}

export async function saveApiKey(envVar: string, key: string): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configApiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envVar, key }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function saveWebProvider(key: string): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configWebProvider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}
