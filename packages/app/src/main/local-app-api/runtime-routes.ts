// Runtime, provider credentials, data-root and application lifecycle routes.

import type { Config } from '@littlesheep/config'
import { ConfigSchema, parseModelRef, resolveApiKey } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type { DurableModelRequestProjection } from '@littlesheep/types'
import type { ProviderInfo, RuntimeState, RuntimeWebProviderCheck } from '../../shared/runtime-api-contracts.js'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import {
  coerceReasoningForModelRef,
  isReasoningSupportedForModelRef,
  isRuntimeReasoning,
  type RuntimeReasoning,
} from '../../shared/model-capabilities.js'
import type { DataRootMigrationManager } from '../data-root-migration.js'
import { injectKeysIntoEnv, deriveEnvVarName, normalizeApiKey, saveApiKey } from '../keychain.js'
import { getAgentProfile, normalizeAgentProfileId } from '../modes.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'
import { routeProviderCalibration } from './provider-calibration-route.js'
export { runWebProviderCheck } from './web-provider-check.js'

export interface RuntimeRouteContext {
  getRunner: () => AgentRunner
  getConfig: () => Config
  setConfig: (config: Config) => void
  workplaceDir: string
  dataDir: string
  rebuildRunner: () => Promise<void>
  updateRuntimeConfig: (config: Config) => Promise<Config | void>
  mutateRuntimeConfig?: <T>(operation: () => Promise<T>) => Promise<T>
  dataRootManager?: DataRootMigrationManager
  selectDataRootTarget?: () => Promise<string | null>
  restartApplication?: () => void
  providerCalibrationToken?: string
  getWebProviderCheck?: () => RuntimeWebProviderCheck | undefined
  checkWebProvider?: () => Promise<RuntimeWebProviderCheck>
}

export async function routeRuntime(
  request: LocalAppApiRequest,
  context: RuntimeRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request
  const mutateRuntimeConfig = context.mutateRuntimeConfig ?? (<T>(operation: () => Promise<T>) => operation())
  if (await routeProviderCalibration(request, {
    getRunner: context.getRunner,
    getConfig: context.getConfig,
    token: context.providerCalibrationToken,
  })) return true

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.state) {
    json(res, 200, context.getRunner().state)
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.runtime) {
    json(res, 200, buildRuntimePayload(context.getConfig(), context.workplaceDir, context.getWebProviderCheck?.()))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.webProviderCheck) {
    if (!context.checkWebProvider) {
      json(res, 501, { error: 'Web provider checking is not available.' })
      return true
    }
    await context.checkWebProvider()
    json(res, 200, buildRuntimePayload(context.getConfig(), context.workplaceDir, context.getWebProviderCheck?.()))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.runtime) {
    const body = await readJson(req)
    return mutateRuntimeConfig(async () => {
      const current = context.getConfig()
      const nextDefaults = { ...current.agents.defaults }
      const nextDesktop = { ...current.desktop }
      const nextWeb = { ...current.web, cache: { ...current.web.cache } }

      if (typeof body.model === 'string' && body.model.trim()) {
        const model = body.model.trim()
        const validation = validateModelRef(current, model)
        if (validation) {
          json(res, 400, { error: validation })
          return true
        }
        nextDefaults.model = model
      }

      if (typeof body.reasoning === 'string' && body.reasoning.trim()) {
        const reasoning = body.reasoning.trim()
        if (!isReasoning(reasoning)) {
          json(res, 400, { error: `invalid reasoning value: ${reasoning}` })
          return true
        }
        if (!isReasoningSupportedForModelRef(reasoning, nextDefaults.model)) {
          json(res, 400, { error: `reasoning "${reasoning}" is not supported by model "${nextDefaults.model}"` })
          return true
        }
        nextDefaults.reasoning = reasoning
      }

      if (typeof body.profile === 'string' && body.profile.trim()) {
        const profile = body.profile.trim()
        if (!getAgentProfile(profile)) {
          json(res, 400, { error: `invalid profile value: ${profile}` })
          return true
        }
        nextDefaults.profile = normalizeAgentProfileId(profile)
      }

      nextDefaults.reasoning = coerceReasoningForModelRef(nextDefaults.reasoning, nextDefaults.model)

      if (Object.prototype.hasOwnProperty.call(body, 'workspace')) {
        const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
        nextDefaults.workspace = workspace || context.workplaceDir
      }

      if (Object.prototype.hasOwnProperty.call(body, 'contextCompressionThresholdRatio')) {
        const ratio = body.contextCompressionThresholdRatio
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.5 || ratio > 0.95) {
          json(res, 400, { error: 'contextCompressionThresholdRatio must be a number between 0.5 and 0.95' })
          return true
        }
        nextDefaults.contextCompressionThresholdRatio = ratio
      }

      if (Object.prototype.hasOwnProperty.call(body, 'durableHarnessMode')) {
        const mode = body.durableHarnessMode
        if (mode !== 'shadow' && mode !== 'next') {
          json(res, 400, { error: 'durableHarnessMode must be "shadow" or "next"' })
          return true
        }
        nextDefaults.durableHarnessMode = mode
      }

      if (Object.prototype.hasOwnProperty.call(body, 'durableHarnessSessionOverrides')) {
        const overrides = parseDurableHarnessSessionOverrides(body.durableHarnessSessionOverrides)
        if (!overrides) {
          json(res, 400, {
            error: 'durableHarnessSessionOverrides must map non-empty session ids to "shadow" or "next"',
          })
          return true
        }
        nextDefaults.durableHarnessSessionOverrides = overrides
      }

      if (Object.prototype.hasOwnProperty.call(body, 'durableHarnessOriginOverrides')) {
        const overrides = parseDurableHarnessSessionOverrides(body.durableHarnessOriginOverrides)
        if (!overrides) {
          json(res, 400, {
            error: 'durableHarnessOriginOverrides must map non-empty origins to "shadow" or "next"',
          })
          return true
        }
        nextDefaults.durableHarnessOriginOverrides = overrides
      }

      if (Object.prototype.hasOwnProperty.call(body, 'closePolicy')) {
        const closePolicy = body.closePolicy
        if (
          closePolicy !== 'always-background'
          && closePolicy !== 'background-while-active'
          && closePolicy !== 'always-quit'
        ) {
          json(res, 400, { error: 'closePolicy must be always-background, background-while-active, or always-quit' })
          return true
        }
        nextDesktop.closePolicy = closePolicy
      }

      if (Object.prototype.hasOwnProperty.call(body, 'web')) {
        const validation = applyWebPatch(nextWeb, body.web)
        if (validation) {
          json(res, 400, { error: validation })
          return true
        }
      }

      const parsed = ConfigSchema.safeParse({
        ...current,
        agents: {
          ...current.agents,
          defaults: nextDefaults,
        },
        desktop: nextDesktop,
        web: nextWeb,
      })
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid runtime configuration' })
        return true
      }
      const next: Config = parsed.data
      const applied = await context.updateRuntimeConfig(next) ?? next
      context.setConfig(applied)
      json(res, 200, buildRuntimePayload(applied, context.workplaceDir, context.getWebProviderCheck?.()))
      return true
    })
  }

  if (method === 'DELETE' && path === LOCAL_APP_API_ROUTES.webCache) {
    const cache = context.getRunner().infra.webCache
    if (cache) await cache.clear()
    json(res, 200, { ok: true, cleared: Boolean(cache), stats: cache?.stats() ?? { entries: 0, bytes: 0, hits: 0, misses: 0 } })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.cacheQuality) {
    const runner = context.getRunner()
    const store = runner.infra.cacheObservationStore
    const key = runner.infra.cacheObservationKey
    const sessionId = request.url.searchParams.get('sessionId')?.trim()
    const workspaceScope = request.url.searchParams.get('workspace')?.trim() || context.workplaceDir
    const permissionPolicyId = request.url.searchParams.get('permission')?.trim()
    const since = parseEpochMs(request.url.searchParams.get('since'))
    const until = parseEpochMs(request.url.searchParams.get('until'))
    if (!store || !key || !sessionId || !isPermissionPolicyId(permissionPolicyId)) {
      json(res, 200, { status: 'unavailable', reason: 'cache_quality_scope_unavailable' })
      return true
    }
    if ((request.url.searchParams.has('since') && since === undefined)
      || (request.url.searchParams.has('until') && until === undefined)) {
      json(res, 400, { error: 'since/until must be ISO timestamps or epoch milliseconds' })
      return true
    }
    let modelRequests: readonly DurableModelRequestProjection[] | undefined
    if (runner.infra.loadSessionModelRequests) {
      try {
        modelRequests = await runner.infra.loadSessionModelRequests(sessionId)
      } catch {
        modelRequests = undefined
      }
    }
    try {
      json(res, 200, await store.report({
        sessionId,
        workspaceScope,
        permissionPolicyId,
        key,
        ...(modelRequests ? { modelRequests } : {}),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      }))
    } catch {
      json(res, 200, { status: 'unavailable', reason: 'cache_quality_report_failed' })
    }
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.dataRoot) {
    if (!context.dataRootManager) {
      json(res, 501, { error: 'data-root management is not available' })
      return true
    }
    json(res, 200, await context.dataRootManager.status())
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.dataRootSelect) {
    if (!context.selectDataRootTarget) {
      json(res, 501, { error: 'data-root picker is not available' })
      return true
    }
    json(res, 200, { path: await context.selectDataRootTarget() })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.dataRootMigration) {
    if (!context.dataRootManager) {
      json(res, 501, { error: 'data-root management is not available' })
      return true
    }
    const body = await readJson(req)
    const targetDir = typeof body.targetDir === 'string' ? body.targetDir : ''
    json(res, 200, await context.dataRootManager.requestMigration(targetDir))
    return true
  }

  if (method === 'DELETE' && path === LOCAL_APP_API_ROUTES.dataRootMigration) {
    if (!context.dataRootManager) {
      json(res, 501, { error: 'data-root management is not available' })
      return true
    }
    json(res, 200, await context.dataRootManager.cancelPending())
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.dataRootRollback) {
    if (!context.dataRootManager) {
      json(res, 501, { error: 'data-root management is not available' })
      return true
    }
    json(res, 200, await context.dataRootManager.requestRollback())
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.applicationRestart) {
    if (!context.restartApplication) {
      json(res, 501, { error: 'application restart is not available' })
      return true
    }
    json(res, 200, { ok: true })
    setTimeout(() => context.restartApplication?.(), 80)
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.configProviders) {
    const providers: ProviderInfo[] = context.getConfig().providers.map((provider) => {
      const envVar = deriveEnvVarName(provider.apiKey)
      const source: 'env' | 'literal' | 'none' = !provider.apiKey
        ? 'none'
        : provider.apiKey.startsWith('$')
          ? 'env'
          : 'literal'
      const hasKey = envVar ? !!resolveApiKey(provider.apiKey) : false
      return {
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        envVar,
        hasKey,
        source,
      }
    })
    json(res, 200, { providers })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.configApiKey) {
    const body = await readJson(req)
    const envVar = String(body.envVar ?? '').trim()
    const key = normalizeApiKey(String(body.key ?? ''))
    if (!envVar || !key) {
      json(res, 400, { error: 'envVar and key are required' })
      return true
    }
    try {
      await saveApiKey(context.dataDir, envVar, key)
    } catch (error) {
      json(res, 400, { error: (error as Error).message })
      return true
    }
    injectKeysIntoEnv({ [envVar]: key })
    await context.rebuildRunner()
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.configWebProvider) {
    const body = await readJson(req)
    const key = normalizeApiKey(String(body.key ?? ''))
    if (!key) {
      json(res, 400, { error: 'Tavily API key is required' })
      return true
    }
    try {
      await saveApiKey(context.dataDir, 'TAVILY_API_KEY', key)
      injectKeysIntoEnv({ TAVILY_API_KEY: key })
      await mutateRuntimeConfig(async () => {
        const current = context.getConfig()
        const next = configureTavilyWeb(current)
        const applied = await context.updateRuntimeConfig(next) ?? next
        context.setConfig(applied)
        json(res, 200, buildRuntimePayload(applied, context.workplaceDir, context.getWebProviderCheck?.()))
      })
    } catch {
      json(res, 400, { error: 'Unable to configure Tavily.' })
    }
    return true
  }

  return false
}

export function buildRuntimePayload(config: Config, workplaceDir: string, webProviderCheck?: RuntimeWebProviderCheck): RuntimeState {
  return {
    model: config.agents.defaults.model,
    reasoning: coerceReasoningForModelRef(config.agents.defaults.reasoning, config.agents.defaults.model),
    profile: normalizeAgentProfileId(config.agents.defaults.profile),
    contextCompressionThresholdRatio: config.agents.defaults.contextCompressionThresholdRatio,
    durableHarnessMode: config.agents.defaults.durableHarnessMode,
    durableHarnessSessionOverrides: { ...config.agents.defaults.durableHarnessSessionOverrides },
    durableHarnessOriginOverrides: { ...config.agents.defaults.durableHarnessOriginOverrides },
    closePolicy: config.desktop.closePolicy,
    workspace: config.agents.defaults.workspace || workplaceDir,
    workplace: workplaceDir,
    providers: config.providers.map((provider) => {
      const envVar = deriveEnvVarName(provider.apiKey)
      const requiresKey = !!provider.apiKey
      const hasKey = !requiresKey || !!resolveApiKey(provider.apiKey)
      return {
        id: provider.id,
        name: provider.name ?? provider.id,
        baseURL: provider.baseURL,
        models: provider.models ?? [],
        envVar,
        requiresKey,
        hasKey,
      }
    }),
    web: buildRuntimeWebPayload(config, webProviderCheck),
  }
}

export function buildRuntimeWebPayload(config: Config, webProviderCheck?: RuntimeWebProviderCheck): RuntimeState['web'] {
  const provider = config.web.defaultProvider
    ? config.web.providers.find((candidate) => candidate.id === config.web.defaultProvider)
    : undefined
  const providerConfigured = Boolean(provider && (!provider.apiKeyRef || resolveApiKey(provider.apiKeyRef)))
  const status = !config.web.enabled || config.web.readMode === 'disabled'
    ? 'disabled' as const
    : !providerConfigured
      ? 'unconfigured' as const
      : webProviderCheck?.providerId !== config.web.defaultProvider || !webProviderCheck
        ? 'configured_unchecked' as const
        : webProviderCheck.status === 'healthy'
          ? 'ready' as const
          : webProviderCheck.status
  return {
    enabled: config.web.enabled,
    status,
    ...(config.web.defaultProvider ? { providerId: config.web.defaultProvider } : {}),
    providerConfigured,
    readMode: config.web.readMode,
    dnsResolver: config.web.dnsResolver,
    strictReadApproval: config.web.strictReadApproval,
    allowDomains: [...config.web.allowDomains],
    blockDomains: [...config.web.blockDomains],
    cacheEnabled: config.web.cache.enabled,
    cacheTtlSeconds: config.web.cache.ttlSeconds,
    cacheMaxBytes: config.web.cache.maxBytes,
    browserFallback: config.web.browserFallback,
    sensitiveQueryPolicy: config.web.sensitiveQueryPolicy,
    ...(webProviderCheck?.providerId === config.web.defaultProvider ? { providerCheck: webProviderCheck } : {}),
    egress: ['query_to_search_provider', 'url_to_target_site', 'evidence_to_current_llm_provider'],
  }
}


/** Add the fixed MVP adapter while keeping the credential out of Config. */
export function configureTavilyWeb(config: Config): Config {
  return ConfigSchema.parse({
    ...config,
    web: {
      ...config.web,
      defaultProvider: 'tavily',
      providers: [
        ...config.web.providers.filter((provider) => provider.id !== 'tavily'),
        { id: 'tavily', type: 'tavily-search-v1', apiKeyRef: '$TAVILY_API_KEY', options: {} },
      ],
    },
  })
}

export function applyWebPatch(target: Config['web'], value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'web must be an object'
  const patch = value as Record<string, unknown>
  for (const key of ['enabled', 'strictReadApproval', 'cacheEnabled'] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (typeof patch[key] !== 'boolean') return `${key} must be boolean`
  }
  if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled
  if (typeof patch.strictReadApproval === 'boolean') target.strictReadApproval = patch.strictReadApproval
  if (typeof patch.cacheEnabled === 'boolean') target.cache.enabled = patch.cacheEnabled
  if (Object.prototype.hasOwnProperty.call(patch, 'readMode')) target.readMode = patch.readMode as Config['web']['readMode']
  if (Object.prototype.hasOwnProperty.call(patch, 'dnsResolver')) target.dnsResolver = patch.dnsResolver as Config['web']['dnsResolver']
  if (Object.prototype.hasOwnProperty.call(patch, 'browserFallback')) target.browserFallback = patch.browserFallback as Config['web']['browserFallback']
  if (Object.prototype.hasOwnProperty.call(patch, 'sensitiveQueryPolicy')) target.sensitiveQueryPolicy = patch.sensitiveQueryPolicy as Config['web']['sensitiveQueryPolicy']
  if (Object.prototype.hasOwnProperty.call(patch, 'allowDomains')) target.allowDomains = patch.allowDomains as string[]
  if (Object.prototype.hasOwnProperty.call(patch, 'blockDomains')) target.blockDomains = patch.blockDomains as string[]
  if (Object.prototype.hasOwnProperty.call(patch, 'cacheTtlSeconds')) target.cache.ttlSeconds = patch.cacheTtlSeconds as number
  if (Object.prototype.hasOwnProperty.call(patch, 'cacheMaxBytes')) target.cache.maxBytes = patch.cacheMaxBytes as number
  return null
}

export function resolveReasoning(
  body: Record<string, unknown>,
  config: Config,
): Config['agents']['defaults']['reasoning'] {
  const value = typeof body.reasoning === 'string' ? body.reasoning : ''
  const requested = isReasoning(value) ? value : config.agents.defaults.reasoning
  return coerceReasoningForModelRef(requested, config.agents.defaults.model)
}

function validateModelRef(config: Config, modelRef: string): string | null {
  let providerId: string
  let model: string
  try {
    const parsed = parseModelRef(modelRef)
    providerId = parsed.provider
    model = parsed.model
  } catch (error) {
    return (error as Error).message
  }
  const provider = config.providers.find((entry) => entry.id === providerId)
  if (!provider) return `unknown provider: ${providerId}`
  if (provider.models && provider.models.length > 0 && !provider.models.includes(model)) {
    return `model "${model}" is not listed for provider "${providerId}"`
  }
  if (provider.apiKey && !resolveApiKey(provider.apiKey)) {
    return `provider "${provider.name ?? provider.id}" has no API key yet`
  }
  return null
}

function isReasoning(value: string): value is RuntimeReasoning {
  return isRuntimeReasoning(value)
}

function isPermissionPolicyId(value: string | undefined): value is 'full' | 'research' | 'restricted' {
  return value === 'full' || value === 'research' || value === 'restricted'
}

function parseDurableHarnessSessionOverrides(value: unknown): Record<string, 'shadow' | 'next'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 256) return null
  const result: Record<string, 'shadow' | 'next'> = {}
  for (const [key, mode] of entries) {
    const sessionId = key.trim()
    if (!sessionId || sessionId.length > 256) return null
    if (mode !== 'shadow' && mode !== 'next') return null
    result[sessionId] = mode
  }
  return result
}

function parseEpochMs(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) {
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}
