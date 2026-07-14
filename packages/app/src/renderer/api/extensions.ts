// Optional plugin and external-channel control clients.

import type { ChannelConnectionsStatus } from '../../shared/channel-control-contracts'
import type { PluginsStatusResponse } from '../../shared/plugin-control-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import { localApiStatusError, localApiUrl } from './common'

export async function getChannelConnectionsStatus(): Promise<ChannelConnectionsStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.channelsStatus))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ChannelConnectionsStatus>
}

export async function reloadChannelConnections(): Promise<{ ok: boolean }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.channelsReload), { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ ok: boolean }>
}

export async function getPluginsStatus(): Promise<PluginsStatusResponse> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.plugins))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<PluginsStatusResponse>
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.plugins, pluginId, '/enabled')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function setLocalPluginCodeAllowed(allowed: boolean): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.pluginsLocalCode), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function reloadPlugins(): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.pluginsReload), { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}
