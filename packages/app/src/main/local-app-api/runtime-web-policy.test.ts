import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import { SearchProviderRegistry, webError } from '@littlesheep/web'
import type { SearchResponse } from '@littlesheep/types'
import { applyWebPatch, buildRuntimeWebPayload, configureTavilyWeb, runWebProviderCheck } from './runtime-routes.js'
import { WebProviderCheckCoordinator } from './web-provider-check.js'
import type { AgentRunner } from '@littlesheep/runner'

const previousKey = process.env.TAVILY_API_KEY

afterEach(() => {
  if (previousKey === undefined) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = previousKey
})

function configured(): Config {
  const config = structuredClone(DEFAULT_CONFIG)
  config.web.enabled = true
  config.web.defaultProvider = 'tavily'
  config.web.providers = [{
    id: 'tavily', type: 'tavily-search-v1', apiKeyRef: '$TAVILY_API_KEY', options: {},
  }]
  return config
}

describe('Main-owned Web runtime policy', () => {
  it('never promotes configured state to ready without a real health check', () => {
    process.env.TAVILY_API_KEY = 'test-only-key'
    expect(buildRuntimeWebPayload(configured())).toMatchObject({
      status: 'configured_unchecked', providerConfigured: true, providerId: 'tavily', dnsResolver: 'system',
    })
  })

  it('promotes only an explicit successful provider check to ready', async () => {
    process.env.TAVILY_API_KEY = 'test-only-key'
    const config = configured()
    const search = async () => ({
      version: 1 as const,
      provider: 'tavily',
      query: 'LittleSheep realtime web retrieval',
      results: [{
        rank: 1,
        title: 'Public result',
        url: 'https://example.com/',
        canonicalUrl: 'https://example.com/',
        citationId: 'web-check-result',
        sourceStatus: 'search_result' as const,
      }],
      fetchedAt: '2026-09-01T00:00:00.000Z',
      cached: false,
      partial: false,
      warnings: [],
    })
    const runner = {
      infra: { webProviders: new SearchProviderRegistry([{
        id: 'tavily',
        displayName: 'Tavily',
        capabilities: { search: true, recency: true, domains: true, language: false, citations: true },
        search,
      }]) },
    } as unknown as AgentRunner

    const check = await runWebProviderCheck(runner, config)

    expect(check).toMatchObject({ providerId: 'tavily', status: 'healthy', resultCount: 1 })
    expect(buildRuntimeWebPayload(config, check)).toMatchObject({ status: 'ready', providerCheck: check })
    expect(JSON.stringify(check)).not.toContain('test-only-key')
  })

  it('maps provider failures to a stable error kind without exposing the cause', async () => {
    process.env.TAVILY_API_KEY = 'test-only-key'
    const config = configured()
    const runner = {
      infra: { webProviders: new SearchProviderRegistry([{
        id: 'tavily',
        displayName: 'Tavily',
        capabilities: { search: true, recency: true, domains: true, language: false, citations: true },
        search: async () => { throw webError('web_provider_auth_failed', 'secret-provider-cause-token', { retryable: false }) },
      }]) },
    } as unknown as AgentRunner

    const check = await runWebProviderCheck(runner, config)

    expect(check).toMatchObject({ providerId: 'tavily', status: 'unavailable', errorKind: 'web_provider_auth_failed' })
    expect(JSON.stringify(check)).not.toContain('secret-provider-cause-token')
    expect(buildRuntimeWebPayload(config, check).status).toBe('unavailable')
  })

  it('keeps a disabled check failure-closed and performs no provider call', async () => {
    const config = configured()
    config.web.enabled = false
    const search = vi.fn()
    const runner = {
      infra: { webProviders: new SearchProviderRegistry([{
        id: 'tavily',
        displayName: 'Tavily',
        capabilities: { search: true, recency: true, domains: true, language: false, citations: true },
        search,
      }]) },
    } as unknown as AgentRunner

    const check = await runWebProviderCheck(runner, config)

    expect(check).toMatchObject({ status: 'unavailable', errorKind: 'web_disabled' })
    expect(search).not.toHaveBeenCalled()
  })

  it('keeps disabled and missing-key states explicit', () => {
    const config = configured()
    expect(buildRuntimeWebPayload(config)).toMatchObject({ status: 'unconfigured', providerConfigured: false })
    config.web.enabled = false
    expect(buildRuntimeWebPayload(config)).toMatchObject({ status: 'disabled' })
  })

  it('does not publish a stale result after a configuration invalidation', async () => {
    let resolveSearch: (value: SearchResponse) => void = () => {}
    let notifySearchStarted: () => void = () => {}
    const searchStarted = new Promise<void>((resolve) => { notifySearchStarted = resolve })
    const config = configured()
    const runner = {
      infra: { webProviders: new SearchProviderRegistry([{
        id: 'tavily',
        displayName: 'Tavily',
        capabilities: { search: true, recency: true, domains: true, language: false, citations: true },
        search: () => new Promise<SearchResponse>((resolve) => {
          resolveSearch = resolve
          notifySearchStarted()
        }),
      }]) },
    } as unknown as AgentRunner
    const coordinator = new WebProviderCheckCoordinator(() => runner, () => config)
    const pending = coordinator.check()
    await searchStarted
    coordinator.invalidate()
    resolveSearch({
      version: 1,
      provider: 'tavily',
      query: 'LittleSheep realtime web retrieval',
      results: [],
      fetchedAt: '2026-09-01T00:00:00.000Z',
      cached: false,
      partial: false,
      warnings: [],
    })
    await pending
    expect(coordinator.get()).toBeUndefined()
  })

  it('applies only allowlisted renderer fields and leaves provider authority untouched', () => {
    const config = configured()
    const error = applyWebPatch(config.web, {
      enabled: false,
      strictReadApproval: true,
      status: 'ready',
      providerConfigured: true,
      providerId: 'attacker',
      baseURL: 'https://attacker.invalid',
      providers: [{ id: 'attacker', type: 'fake' }],
    })

    expect(error).toBeNull()
    expect(config.web.enabled).toBe(false)
    expect(config.web.strictReadApproval).toBe(true)
    expect(config.web.defaultProvider).toBe('tavily')
    expect(config.web.providers).toHaveLength(1)
    expect(JSON.stringify(config.web)).not.toContain('attacker')
    expect(ConfigSchema.parse(config)).toEqual(config)
  })

  it('lets the central schema reject invalid enums and bounds', () => {
    const config = configured()
    expect(applyWebPatch(config.web, { readMode: 'anything', cacheTtlSeconds: -1 })).toBeNull()
    expect(ConfigSchema.safeParse(config).success).toBe(false)
  })

  it('allows only the fixed DNS resolver choices through the runtime patch', () => {
    const config = configured()
    expect(applyWebPatch(config.web, { dnsResolver: 'cloudflare_doh' })).toBeNull()
    expect(ConfigSchema.parse(config).web.dnsResolver).toBe('cloudflare_doh')
    expect(applyWebPatch(config.web, { dnsResolver: 'user_supplied_doh' })).toBeNull()
    expect(ConfigSchema.safeParse(config).success).toBe(false)
  })

  it('configures the fixed Tavily adapter with a secret reference only', () => {
    const config = configured()
    config.web.providers.push({ id: 'other', type: 'future-search', options: {} })
    const next = configureTavilyWeb(config)
    expect(next.web.defaultProvider).toBe('tavily')
    expect(next.web.providers).toEqual(expect.arrayContaining([
      { id: 'other', type: 'future-search', options: {} },
      { id: 'tavily', type: 'tavily-search-v1', apiKeyRef: '$TAVILY_API_KEY', options: {} },
    ]))
    expect(JSON.stringify(next)).not.toContain('test-only-key')
  })
})
