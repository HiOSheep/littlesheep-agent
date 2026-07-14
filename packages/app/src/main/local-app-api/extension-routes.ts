// Plugin and external-channel control routes.

import type { Config } from '@littlesheep/config'
import { loadConfig, withProviderPresets } from '@littlesheep/config'
import type { PluginHost } from '@littlesheep/plugins'
import type { ChannelConnectionsStatus } from '../../shared/channel-control-contracts.js'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import type { PluginsStatusResponse } from '../../shared/plugin-control-contracts.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'

export interface ExtensionRouteContext {
  getPluginHost: () => PluginHost | null
  getConfig: () => Config
  setConfig: (config: Config) => void
  dataDir: string
  updateRuntimeConfig: (config: Config) => Promise<void>
}

// The desktop process owns one PluginHost. This flag only adds diagnostics for
// overlapping reload requests; PluginHost remains responsible for serialization.
let reloadInProgress = false

export async function routeExtensions(
  request: LocalAppApiRequest,
  context: ExtensionRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request
  const { getPluginHost, getConfig, setConfig } = context

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.plugins) {
    const host = getPluginHost()
    const payload: PluginsStatusResponse = {
      started: host?.started ?? false,
      allowLocalCode: getConfig().plugins.allowLocalCode,
      plugins: host?.listPlugins() ?? [],
      diagnostics: host?.diagnostics() ?? [],
    }
    json(res, 200, payload)
    return true
  }

  const pluginEnabledId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.plugins, '/enabled')
  if (method === 'POST' && pluginEnabledId !== null) {
    const host = getPluginHost()
    if (!host) {
      json(res, 503, { error: 'plugin host is not available' })
      return true
    }
    const body = await readJson(req)
    if (typeof body.enabled !== 'boolean') {
      json(res, 400, { error: 'enabled must be a boolean' })
      return true
    }
    const plugin = host.listPlugins().find((entry) => entry.id === pluginEnabledId)
    if (!plugin) {
      json(res, 404, { error: `plugin not found: ${pluginEnabledId}` })
      return true
    }
    if (plugin.enabled === body.enabled) {
      json(res, 200, { ok: true })
      return true
    }
    const current = getConfig()
    const disabled = new Set(current.plugins.disabled)
    if (body.enabled) disabled.delete(pluginEnabledId)
    else disabled.add(pluginEnabledId)
    const next: Config = {
      ...current,
      plugins: { ...current.plugins, disabled: Array.from(disabled).sort() },
    }
    setConfig(next)
    await context.updateRuntimeConfig(next)
    await host.reload()
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.pluginsLocalCode) {
    const host = getPluginHost()
    if (!host) {
      json(res, 503, { error: 'plugin host is not available' })
      return true
    }
    const body = await readJson(req)
    if (typeof body.allowed !== 'boolean') {
      json(res, 400, { error: 'allowed must be a boolean' })
      return true
    }
    const current = getConfig()
    if (current.plugins.allowLocalCode === body.allowed) {
      json(res, 200, { ok: true })
      return true
    }
    const next: Config = {
      ...current,
      plugins: { ...current.plugins, allowLocalCode: body.allowed },
    }
    setConfig(next)
    await context.updateRuntimeConfig(next)
    await host.reload()
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.pluginsReload) {
    const host = getPluginHost()
    if (!host) {
      json(res, 503, { error: 'plugin host is not available' })
      return true
    }
    const newConfig = withProviderPresets(await loadConfig({ dataDir: context.dataDir }))
    setConfig(newConfig)
    await context.updateRuntimeConfig(newConfig)
    await host.reload()
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.channelsStatus) {
    const host = getPluginHost()
    const configured: ChannelConnectionsStatus['configured'] = getConfig().channels.channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      enabled: channel.enabled,
      name: channel.name,
    }))
    const payload: ChannelConnectionsStatus = {
      started: host?.started ?? false,
      channels: (host?.listChannels() ?? []).map((channel) => ({
        type: channel.type,
        displayName: channel.displayName,
        running: channel.running,
        requiredSecrets: channel.requiredSecrets,
      })),
      configured,
      failures: host?.channelFailures() ?? [],
    }
    json(res, 200, payload)
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.channelsReload) {
    const host = getPluginHost()
    if (!host) {
      json(res, 503, { error: 'plugin host is not available' })
      return true
    }
    const requestId = Math.random().toString(36).slice(2, 8)
    const startedAt = performance.now()
    if (reloadInProgress) {
      console.warn(
        `[local-app-api] [channels:reload:${requestId}] WARNING: concurrent reload detected - another reload is in progress`,
      )
    }
    reloadInProgress = true
    try {
      const configStartedAt = performance.now()
      const newConfig = withProviderPresets(await loadConfig({ dataDir: context.dataDir }))
      console.log(
        `[local-app-api] [channels:reload:${requestId}] config loaded from disk (${(performance.now() - configStartedAt).toFixed(1)}ms)`,
      )
      setConfig(newConfig)
      await context.updateRuntimeConfig(newConfig)
      const reloadStartedAt = performance.now()
      await host.reload()
      console.log(
        `[local-app-api] [channels:reload:${requestId}] service reload complete (${(performance.now() - reloadStartedAt).toFixed(1)}ms)`,
      )
      json(res, 200, { ok: true })
      console.log(
        `[local-app-api] [channels:reload:${requestId}] total (${(performance.now() - startedAt).toFixed(1)}ms)`,
      )
      return true
    } catch (error) {
      console.error(
        `[local-app-api] [channels:reload:${requestId}] failed (${(performance.now() - startedAt).toFixed(1)}ms): ${(error as Error).message}`,
      )
      json(res, 500, { error: `reload failed: ${(error as Error).message}` })
      return true
    } finally {
      reloadInProgress = false
    }
  }

  return false
}
