// @littlesheep/app - main/local-app-api/runtime-payload.ts
// Runtime payload projection: Config -> stable RuntimeState for the Local
// App API and renderer. Kept out of the route files so runtime and provider
// routes can project state without an import cycle.

import type { Config, ModelProvider } from '@littlesheep/config'
import {
  PROVIDER_PRESETS,
  getSupportedReasoningOptions,
  resolveApiKey,
  resolveModelContextWindow,
  resolveProviderModels,
} from '@littlesheep/config'
import type { RuntimeProvider, RuntimeState, RuntimeWebProviderCheck } from '../../shared/runtime-api-contracts.js'
import { coerceReasoningForModelRef } from '../../shared/model-capabilities.js'
import { deriveEnvVarName } from '../keychain.js'
import { normalizeAgentProfileId } from '../modes.js'

export function buildRuntimePayload(config: Config, workplaceDir: string, webProviderCheck?: RuntimeWebProviderCheck): RuntimeState {
  return {
    model: config.agents.defaults.model,
    reasoning: coerceReasoningForModelRef(config.agents.defaults.reasoning, config.agents.defaults.model),
    profile: normalizeAgentProfileId(config.agents.defaults.profile),
    contextCompressionThresholdRatio: config.agents.defaults.contextCompressionThresholdRatio,
    durableHarnessMode: config.agents.defaults.durableHarnessMode,
    durableHarnessSessionOverrides: { ...config.agents.defaults.durableHarnessSessionOverrides },
    durableHarnessOriginOverrides: { ...config.agents.defaults.durableHarnessOriginOverrides },
    durableHarnessProfileOverrides: { ...config.agents.defaults.durableHarnessProfileOverrides },
    closePolicy: config.desktop.closePolicy,
    workspace: config.agents.defaults.workspace || workplaceDir,
    workplace: workplaceDir,
    providers: config.providers.map((provider) => buildRuntimeProvider(provider)),
    web: buildRuntimeWebPayload(config, webProviderCheck),
  }
}

export const BUILTIN_PROVIDER_IDS = new Set(PROVIDER_PRESETS.map((preset) => preset.id))

/** Project one configured provider into the runtime contract. */
export function buildRuntimeProvider(provider: ModelProvider): RuntimeProvider {
  const envVar = deriveEnvVarName(provider.apiKey)
  const requiresKey = !!provider.apiKey
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    baseURL: provider.baseURL,
    api: provider.api ?? 'openai-chat-completions',
    models: resolveProviderModels(provider).map((model) => {
      const capability = resolveModelContextWindow(provider.id, model.id)
      return {
        id: model.id,
        name: model.name,
        declared: model.declared,
        contextWindow: model.contextWindow ?? capability?.maxContextTokens,
        maxOutputTokens: model.maxOutputTokens ?? capability?.maxOutputTokens,
        // A declared list is the user's own statement and travels with the
        // payload, so the renderer never depends on main-process registry
        // state to know what a custom model accepts.
        reasoningOptions: model.reasoningOptions
          ? [...model.reasoningOptions]
          : [...getSupportedReasoningOptions(provider.id, model.id)],
        vision: model.vision,
      }
    }),
    headerNames: Object.keys(provider.headers ?? {}).sort(),
    envVar,
    requiresKey,
    hasKey: !requiresKey || !!resolveApiKey(provider.apiKey),
    builtin: BUILTIN_PROVIDER_IDS.has(provider.id),
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
