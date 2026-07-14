// Runtime, provider credentials, data-root and application lifecycle routes.

import type { Config } from '@littlesheep/config'
import { parseModelRef, resolveApiKey } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import type { ProviderInfo, RuntimeState } from '../../shared/runtime-api-contracts.js'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import {
  coerceReasoningForModelRef,
  isReasoningSupportedForModelRef,
  isRuntimeReasoning,
  type RuntimeReasoning,
} from '../../shared/model-capabilities.js'
import type { DataRootMigrationManager } from '../data-root-migration.js'
import { injectKeysIntoEnv, deriveEnvVarName, saveApiKey } from '../keychain.js'
import { getAgentProfile, normalizeAgentProfileId } from '../modes.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'

export interface RuntimeRouteContext {
  getRunner: () => AgentRunner
  getConfig: () => Config
  setConfig: (config: Config) => void
  workplaceDir: string
  dataDir: string
  rebuildRunner: () => Promise<void>
  updateRuntimeConfig: (config: Config) => Promise<void>
  dataRootManager?: DataRootMigrationManager
  selectDataRootTarget?: () => Promise<string | null>
  restartApplication?: () => void
}

export async function routeRuntime(
  request: LocalAppApiRequest,
  context: RuntimeRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.state) {
    json(res, 200, context.getRunner().state)
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.runtime) {
    json(res, 200, buildRuntimePayload(context.getConfig(), context.workplaceDir))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.runtime) {
    const body = await readJson(req)
    const current = context.getConfig()
    const nextDefaults = { ...current.agents.defaults }

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

    const next: Config = {
      ...current,
      agents: {
        ...current.agents,
        defaults: nextDefaults,
      },
    }
    context.setConfig(next)
    await context.updateRuntimeConfig(next)
    json(res, 200, buildRuntimePayload(next, context.workplaceDir))
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
    const key = String(body.key ?? '').trim()
    if (!envVar || !key) {
      json(res, 400, { error: 'envVar and key are required' })
      return true
    }
    await saveApiKey(context.dataDir, envVar, key)
    injectKeysIntoEnv({ [envVar]: key })
    await context.rebuildRunner()
    json(res, 200, { ok: true })
    return true
  }

  return false
}

export function buildRuntimePayload(config: Config, workplaceDir: string): RuntimeState {
  return {
    model: config.agents.defaults.model,
    reasoning: coerceReasoningForModelRef(config.agents.defaults.reasoning, config.agents.defaults.model),
    profile: normalizeAgentProfileId(config.agents.defaults.profile),
    contextCompressionThresholdRatio: config.agents.defaults.contextCompressionThresholdRatio,
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
  }
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
