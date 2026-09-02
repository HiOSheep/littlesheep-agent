import type { ProviderHealth, SearchProviderCapabilities, WebProviderRuntimeSnapshot } from '@littlesheep/types';
import { EnvironmentSecretResolver, SearchProviderRegistry, type SearchProvider, type SecretResolver, type WebProviderConfigLike } from './provider.js';
import { TavilySearchProvider } from './providers/tavily.js';

export interface BuildProviderRegistryOptions {
  readonly providers?: readonly WebProviderConfigLike[];
  readonly defaultProvider?: string;
  readonly secretResolver?: SecretResolver;
  readonly fetchFn?: typeof fetch;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface BuiltProviderRegistry {
  readonly registry: SearchProviderRegistry;
  readonly defaultProvider?: string;
  readonly snapshots: readonly WebProviderRuntimeSnapshot[];
}

/** Construct only explicitly configured adapters. Missing keys never trigger a request. */
export async function buildProviderRegistry(options: BuildProviderRegistryOptions = {}): Promise<BuiltProviderRegistry> {
  const resolver = options.secretResolver ?? new EnvironmentSecretResolver();
  const providers: SearchProvider[] = [];
  const snapshots: WebProviderRuntimeSnapshot[] = [];
  for (const config of options.providers ?? []) {
    if (config.type !== 'tavily-search-v1') {
      snapshots.push({ id: config.id, adapterType: config.type, status: 'unavailable', detailCode: 'web_provider_unconfigured' });
      options.log?.('warn', 'web: unsupported provider adapter', { providerId: config.id, adapterType: config.type });
      continue;
    }
    let key: string | undefined;
    try {
      key = await resolver.resolve(config.apiKeyRef);
    } catch {
      snapshots.push({ id: config.id, adapterType: config.type, status: 'unavailable', detailCode: 'web_provider_unavailable' });
      options.log?.('warn', 'web: provider secret resolution failed', { providerId: config.id, detailCode: 'web_provider_unavailable' });
      continue;
    }
    if (!key?.trim()) {
      snapshots.push({ id: config.id, adapterType: config.type, status: 'unconfigured', detailCode: 'web_provider_unconfigured' });
      continue;
    }
    try {
      const provider = new TavilySearchProvider({
        providerId: config.id,
        apiKey: key,
        baseURL: config.baseURL,
        fetchFn: options.fetchFn,
      });
      providers.push(provider);
      snapshots.push({
        id: config.id,
        adapterType: config.type,
        status: 'configured_unchecked',
        capabilities: provider.capabilities,
      });
    } catch (error) {
      snapshots.push({ id: config.id, adapterType: config.type, status: 'unavailable', detailCode: 'web_provider_unavailable' });
      options.log?.('warn', 'web: provider configuration failed', { providerId: config.id, detailCode: 'web_provider_unavailable' });
    }
  }
  return {
    registry: new SearchProviderRegistry(providers),
    ...(options.defaultProvider ? { defaultProvider: options.defaultProvider } : {}),
    snapshots,
  };
}

export function providerSnapshot(
  id: string,
  adapterType: string,
  status: WebProviderRuntimeSnapshot['status'],
  capabilities?: SearchProviderCapabilities,
  detailCode?: WebProviderRuntimeSnapshot['detailCode'],
): WebProviderRuntimeSnapshot {
  return {
    id,
    adapterType,
    status,
    ...(capabilities ? { capabilities } : {}),
    ...(detailCode ? { detailCode } : {}),
  };
}

export async function checkProviderHealth(
  registry: SearchProviderRegistry,
  providerId: string | undefined,
  context: Parameters<NonNullable<SearchProvider['health']>>[0],
): Promise<ProviderHealth> {
  return registry.health(providerId, context);
}
