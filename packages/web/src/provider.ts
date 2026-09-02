import type {
  NetworkReadPolicy,
  ProviderHealth,
  SearchProviderCapabilities,
  SearchRequest,
  SearchResponse,
} from '@littlesheep/types';
import { WebRetrievalError } from './errors.js';

export interface SearchProviderContext {
  readonly signal?: AbortSignal;
  readonly policy: Readonly<NetworkReadPolicy>;
  readonly now?: () => Date;
  readonly citationIdFor?: (url: string, rank: number) => string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface SearchProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SearchProviderCapabilities;
  search(request: SearchRequest, context: SearchProviderContext): Promise<SearchResponse>;
  health?(context: SearchProviderContext): Promise<ProviderHealth>;
}

export interface WebProviderConfigLike {
  readonly id: string;
  readonly type: string;
  readonly baseURL?: string;
  readonly apiKeyRef?: string;
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SecretResolver {
  resolve(reference: string | undefined): Promise<string | undefined>;
}

export class EnvironmentSecretResolver implements SecretResolver {
  async resolve(reference: string | undefined): Promise<string | undefined> {
    if (!reference) return undefined;
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(reference.trim());
    if (!match) return undefined;
    return process.env[match[1]!];
  }
}

export interface ProviderRegistry {
  get(providerId?: string): SearchProvider | undefined;
  list(): readonly SearchProvider[];
  health(providerId?: string, context?: SearchProviderContext): Promise<ProviderHealth>;
}

export class SearchProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();

  constructor(providers: readonly SearchProvider[] = []) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`web: duplicate search provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
  }

  get(providerId?: string): SearchProvider | undefined {
    if (providerId) return this.providers.get(providerId);
    return this.providers.values().next().value as SearchProvider | undefined;
  }

  list(): readonly SearchProvider[] {
    return [...this.providers.values()];
  }

  async health(providerId?: string, context?: SearchProviderContext): Promise<ProviderHealth> {
    const provider = this.get(providerId);
    const now = (context?.now ?? (() => new Date()))().toISOString();
    if (!provider) {
      return {
        providerId: providerId ?? 'unknown',
        status: 'unconfigured',
        checkedAt: now,
        errorKind: 'web_provider_unconfigured',
      };
    }
    if (!provider.health) {
      return { providerId: provider.id, status: 'healthy', checkedAt: now };
    }
    try {
      return await provider.health({
        ...(context ?? { policy: disabledPolicy() }),
        policy: context?.policy ?? disabledPolicy(),
      });
    } catch (error) {
      const webError = error instanceof WebRetrievalError ? error : undefined;
      return {
        providerId: provider.id,
        status: 'unavailable',
        checkedAt: now,
        ...(webError?.kind ? { errorKind: webError.kind } : { errorKind: 'web_provider_unavailable' as const }),
        detail: 'provider health check failed',
      };
    }
  }
}

function disabledPolicy(): NetworkReadPolicy {
  return {
    version: 1,
    enabled: false,
    mode: 'disabled',
    allowDomains: [],
    blockDomains: [],
    strictReadApproval: false,
    maxResults: 1,
    maxQueryChars: 500,
    maxQueriesPerRun: 0,
    maxFetchesPerRun: 0,
    maxConcurrentRequests: 1,
    searchTimeoutMs: 1_000,
    fetchTimeoutMs: 1_000,
    totalTimeoutMs: 1_000,
    maxResponseBytes: 1_024,
    maxExtractedChars: 1_000,
    maxRedirects: 0,
    cacheEnabled: false,
    cacheTtlSeconds: 0,
    cacheMaxBytes: 0,
    browserFallback: 'disabled',
    sensitiveQueryPolicy: 'deny',
  };
}
