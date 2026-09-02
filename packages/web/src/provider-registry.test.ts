import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProviderRegistry } from './provider-registry.js';
import { EnvironmentSecretResolver, type SecretResolver } from './provider.js';

const ENV_NAME = 'LITTLESHEEP_WEB_TEST_KEY';
const original = process.env[ENV_NAME];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = original;
});

describe('provider registry secret and identity boundary', () => {
  it('production environment resolver accepts only $ENV_NAME references', async () => {
    process.env[ENV_NAME] = 'resolved-test-key';
    const resolver = new EnvironmentSecretResolver();
    await expect(resolver.resolve(`$${ENV_NAME}`)).resolves.toBe('resolved-test-key');
    await expect(resolver.resolve('resolved-test-key')).resolves.toBeUndefined();
    await expect(resolver.resolve('$BAD-NAME')).resolves.toBeUndefined();
  });

  it('keeps plaintext references unconfigured and performs zero provider calls', async () => {
    const fetchFn = vi.fn();
    const built = await buildProviderRegistry({
      providers: [{ id: 'search', type: 'tavily-search-v1', apiKeyRef: 'plaintext-secret' }],
      defaultProvider: 'search',
      fetchFn: fetchFn as typeof fetch,
    });
    expect(built.registry.get('search')).toBeUndefined();
    expect(built.snapshots).toEqual([expect.objectContaining({ id: 'search', status: 'unconfigured' })]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows a host-owned resolver without exposing the resolved secret in snapshots', async () => {
    const secretResolver: SecretResolver = { resolve: vi.fn(async () => 'host-owned-secret') };
    const built = await buildProviderRegistry({
      providers: [{ id: 'custom-id', type: 'tavily-search-v1', apiKeyRef: 'secret://tavily' }],
      defaultProvider: 'custom-id',
      secretResolver,
    });
    expect(built.registry.get('custom-id')?.id).toBe('custom-id');
    expect(built.snapshots).toEqual([expect.objectContaining({ id: 'custom-id', status: 'configured_unchecked' })]);
    expect(JSON.stringify(built.snapshots)).not.toContain('host-owned-secret');
  });

  it('logs only a stable code for invalid provider configuration', async () => {
    const log = vi.fn();
    const resolver: SecretResolver = { resolve: vi.fn(async () => 'host-owned-secret') };
    await buildProviderRegistry({
      providers: [{ id: 'bad', type: 'tavily-search-v1', apiKeyRef: 'secret://bad', baseURL: 'https://evil.example/search?token=secret' }],
      secretResolver: resolver,
      log,
    });
    expect(log).toHaveBeenCalledWith('warn', 'web: provider configuration failed', {
      providerId: 'bad', detailCode: 'web_provider_unavailable',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('evil.example');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });

  it('contains host resolver failures without retaining thrown secret details', async () => {
    const log = vi.fn();
    const resolver: SecretResolver = {
      resolve: vi.fn(async () => { throw new Error('vault failure included secret-value'); }),
    };
    const built = await buildProviderRegistry({
      providers: [{ id: 'search', type: 'tavily-search-v1', apiKeyRef: 'secret://search' }],
      secretResolver: resolver,
      log,
    });
    expect(built.snapshots).toEqual([expect.objectContaining({ id: 'search', status: 'unavailable' })]);
    expect(built.registry.get('search')).toBeUndefined();
    expect(JSON.stringify({ snapshots: built.snapshots, calls: log.mock.calls })).not.toContain('secret-value');
  });
});
