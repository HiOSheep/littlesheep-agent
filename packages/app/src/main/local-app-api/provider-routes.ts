// @littlesheep/app - main/local-app-api/provider-routes.ts
// Model provider Local App API: list, create/update and delete providers,
// including keychain-backed API keys and user-declared model metadata.

import type { Config, ModelProvider } from '@littlesheep/config'
import { ModelProviderSchema, resolveApiKey } from '@littlesheep/config'
import type { ProviderInfo, RuntimeWebProviderCheck } from '../../shared/runtime-api-contracts.js'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import {
  deriveEnvVarName,
  deriveProviderKeyEnvVar,
  injectKeysIntoEnv,
  normalizeApiKey,
  saveApiKey,
} from '../keychain.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'
import { BUILTIN_PROVIDER_IDS, buildRuntimePayload } from './runtime-payload.js'

/** Runtime route context subset required by the provider routes. */
export interface ProviderRouteContext {
  getConfig: () => Config
  setConfig: (config: Config) => void
  workplaceDir: string
  dataDir: string
  rebuildRunner: () => Promise<void>
  updateRuntimeConfig: (config: Config) => Promise<Config | void>
  mutateRuntimeConfig?: <T>(operation: () => Promise<T>) => Promise<T>
  getWebProviderCheck?: () => RuntimeWebProviderCheck | undefined
}

export async function routeModelProviders(
  request: LocalAppApiRequest,
  context: ProviderRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request
  const mutateRuntimeConfig = context.mutateRuntimeConfig ?? (<T>(operation: () => Promise<T>) => operation())

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

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.configProviders) {
    const body = await readJson(req)
    const draft = (body?.provider ?? body) as unknown
    return mutateRuntimeConfig(async () => {
      const parsed = ModelProviderSchema.safeParse(draft)
      if (!parsed.success) {
        json(res, 400, { error: describeProviderValidationError(parsed.error.issues) })
        return true
      }
      const current = context.getConfig()
      const existing = current.providers.find((provider) => provider.id === parsed.data.id)
      let apiKey = existing?.apiKey
      if (typeof parsed.data.apiKey === 'string') {
        const requested = parsed.data.apiKey.trim()
        if (!requested) {
          // An explicit empty value clears the stored reference.
          apiKey = undefined
        } else {
          try {
            apiKey = await persistProviderApiKey(context.dataDir, parsed.data.id, requested)
          } catch (error) {
            json(res, 400, { error: (error as Error).message })
            return true
          }
        }
      }
      const provider: ModelProvider = { ...parsed.data }
      if (apiKey) provider.apiKey = apiKey
      else delete provider.apiKey
      const providers = existing
        ? current.providers.map((candidate) => (candidate.id === provider.id ? provider : candidate))
        : [...current.providers, provider]
      const applied = await context.updateRuntimeConfig({ ...current, providers }) ?? { ...current, providers }
      context.setConfig(applied)
      await context.rebuildRunner()
      json(res, 200, buildRuntimePayload(applied, context.workplaceDir, context.getWebProviderCheck?.()))
      return true
    })
  }

  if (method === 'DELETE' && path.startsWith(LOCAL_APP_API_PREFIXES.configProviders)) {
    const providerId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.configProviders)
    if (!providerId) {
      json(res, 400, { error: 'provider id is required' })
      return true
    }
    if (BUILTIN_PROVIDER_IDS.has(providerId)) {
      json(res, 400, { error: `built-in provider "${providerId}" cannot be removed` })
      return true
    }
    return mutateRuntimeConfig(async () => {
      const current = context.getConfig()
      if (!current.providers.some((provider) => provider.id === providerId)) {
        json(res, 404, { error: `provider "${providerId}" is not configured` })
        return true
      }
      const providers = current.providers.filter((provider) => provider.id !== providerId)
      const applied = await context.updateRuntimeConfig({ ...current, providers }) ?? { ...current, providers }
      context.setConfig(applied)
      await context.rebuildRunner()
      json(res, 200, buildRuntimePayload(applied, context.workplaceDir, context.getWebProviderCheck?.()))
      return true
    })
  }

  return false
}

async function persistProviderApiKey(
  dataDir: string,
  providerId: string,
  rawApiKey: string,
): Promise<string> {
  const normalized = normalizeApiKey(rawApiKey)
  if (normalized.startsWith('$')) return normalized
  const envVar = deriveProviderKeyEnvVar(providerId)
  await saveApiKey(dataDir, envVar, normalized)
  injectKeysIntoEnv({ [envVar]: normalized })
  return `$${envVar}`
}

function describeProviderValidationError(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.')
      return where ? `${where}: ${issue.message}` : issue.message
    })
    .join('; ')
}
