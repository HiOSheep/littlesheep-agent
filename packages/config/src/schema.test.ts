import { describe, it, expect } from 'vitest';
import { ConfigSchema } from './schema.js';
import {
  DEFAULT_CONFIG,
  selectDefaultModelForAvailableProvider,
  withProviderPresets,
} from './defaults.js';

describe('config schema', () => {
  it('parses empty object with defaults', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.version).toBe(1);
    expect(cfg.agents.defaults.harness).toBe('core-flow');
    expect(cfg.agents.defaults.reasoning).toBe('auto');
    expect(cfg.agents.defaults.profile).toBe('general');
    expect(cfg.agents.defaults.durableHarnessMode).toBe('next');
    expect(cfg.desktop.closePolicy).toBe('background-while-active');
    expect(cfg.tools.exec.approvalMode).toBe('interactive');
    expect(cfg.tools.invocationTimeoutMs).toBe(120_000);
    expect(cfg.memory.repositoryBackend).toBe('v2');
    expect(cfg.memory.treeRunTokenBudget).toBe(3200);
    expect(cfg.memory.treeBranchTokenBudget).toBe(1200);
    expect(cfg.memory.treeRootIndexMaxChars).toBe(1600);
    expect(cfg.memory.experienceWriteThreshold).toBe(0.65);
    expect(cfg.web).toEqual({
      enabled: false,
      readMode: 'public_anonymous',
      strictReadApproval: false,
      allowDomains: [],
      blockDomains: [],
      dnsResolver: 'system',
      maxQueryChars: 2_000,
      maxResults: 10,
      maxFetchesPerRun: 4,
      maxQueriesPerRun: 4,
      maxConcurrentRequests: 4,
      searchTimeoutMs: 15_000,
      fetchTimeoutMs: 20_000,
      totalTimeoutMs: 90_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxExtractedChars: 40_000,
      maxRedirects: 5,
      cache: { enabled: true, ttlSeconds: 300, maxBytes: 64 * 1024 * 1024 },
      browserFallback: 'approval_required',
      sensitiveQueryPolicy: 'approve',
      providers: [],
    });
  });

  it('accepts full config and merges defaults', () => {
    const cfg = ConfigSchema.parse({
      version: 1,
      agents: { defaults: { workspace: '/tmp/ws', model: 'openai/gpt-5.6' } },
    });
    expect(cfg.agents.defaults.workspace).toBe('/tmp/ws');
    expect(cfg.agents.defaults.reasoning).toBe('auto');
    expect(cfg.agents.defaults.profile).toBe('general');
    expect(cfg.agents.defaults.maxRecoveryAttempts).toBe(3);
    expect(cfg.tools.exec.whitelist.length).toBeGreaterThan(0);
  });

  it('accepts coding as a behavior profile', () => {
    const cfg = ConfigSchema.parse({
      agents: { defaults: { profile: 'coding' } },
    });
    expect(cfg.agents.defaults.profile).toBe('coding');
  });

  it('keeps desktop close policy separate from behavior and permission settings', () => {
    for (const closePolicy of ['always-background', 'background-while-active', 'always-quit'] as const) {
      const cfg = ConfigSchema.parse({ desktop: { closePolicy } });
      expect(cfg.desktop.closePolicy).toBe(closePolicy);
      expect(cfg.agents.defaults.profile).toBe('general');
      expect(cfg.tools.exec.approvalMode).toBe('interactive');
    }
    expect(() => ConfigSchema.parse({ desktop: { closePolicy: 'coding' } })).toThrow();
  });

  it('rejects invalid approvalMode', () => {
    expect(() =>
      ConfigSchema.parse({ tools: { exec: { approvalMode: 'invalid' } } })
    ).toThrow();
  });

  it('bounds the hosted tool invocation timeout', () => {
    expect(ConfigSchema.parse({ tools: { exec: {}, invocationTimeoutMs: 90_000 } }).tools.invocationTimeoutMs).toBe(90_000);
    expect(() => ConfigSchema.parse({ tools: { exec: {}, invocationTimeoutMs: 999 } })).toThrow();
    expect(ConfigSchema.parse({ tools: { exec: {}, invocationTimeoutMs: 2 * 60 * 60_000 } }).tools.invocationTimeoutMs).toBe(2 * 60 * 60_000);
    expect(() => ConfigSchema.parse({ tools: { exec: {}, invocationTimeoutMs: 24 * 60 * 60_000 + 1 } })).toThrow();
  });

  it('DEFAULT_CONFIG round-trips through schema', () => {
    const reparsed = ConfigSchema.parse(DEFAULT_CONFIG);
    expect(reparsed).toEqual(DEFAULT_CONFIG);
  });

  it('adds and refreshes built-in provider presets without overwriting custom providers', () => {
    const cfg = ConfigSchema.parse({
      providers: [{
        id: 'deepseek',
        baseURL: 'https://custom.local/v1',
        apiKey: '$CUSTOM_DEEPSEEK_KEY',
        models: ['custom-model'],
      }],
    });
    const withPresets = withProviderPresets(cfg);
    expect(withPresets.providers.map((p) => p.id)).toEqual(['deepseek', 'openai', 'glm']);
    expect(withPresets.providers[0]!.baseURL).toBe('https://custom.local/v1');
    expect(withPresets.providers[0]!.apiKey).toBe('$CUSTOM_DEEPSEEK_KEY');
    expect(withPresets.providers[0]!.models).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'custom-model',
    ]);
    expect(withPresets.providers[1]!.models?.slice(0, 3)).toEqual([
      'gpt-5.6',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('selects the first keyed provider when the default provider has no key', () => {
    const cfg = withProviderPresets(ConfigSchema.parse({}));
    const model = selectDefaultModelForAvailableProvider(cfg, (p) => p.id === 'deepseek');
    expect(model).toBe('deepseek/deepseek-flash');
  });

  it('repairs an unavailable default model for a keyed provider', () => {
    const cfg = ConfigSchema.parse({
      providers: [{
        id: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKey: '$DEEPSEEK_API_KEY',
        models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      }],
      agents: { defaults: { model: 'deepseek/deepseek-chat' } },
    });
    const model = selectDefaultModelForAvailableProvider(cfg, () => true);
    expect(model).toBe('deepseek/deepseek-v4-pro');
  });

  it('safety block defaults are populated', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.safety).toEqual({
      enabled: true,
      maxEntryChars: 500,
      quarantineDir: 'quarantine',
      blockInjectionPatterns: true,
      sanitizePrelude: true,
    });
  });

  it('accepts a custom safety block', () => {
    const cfg = ConfigSchema.parse({
      safety: { enabled: false, maxEntryChars: 1000 },
    });
    expect(cfg.safety.enabled).toBe(false);
    expect(cfg.safety.maxEntryChars).toBe(1000);
    expect(cfg.safety.quarantineDir).toBe('quarantine');
  });

  it('rejects non-positive maxEntryChars', () => {
    expect(() =>
      ConfigSchema.parse({ safety: { maxEntryChars: 0 } })
    ).toThrow();
  });

  it('migrates old configs to disabled web retrieval without inventing a provider', () => {
    const cfg = ConfigSchema.parse({ version: 1, providers: [] });
    expect(cfg.web.enabled).toBe(false);
    expect(cfg.web.defaultProvider).toBeUndefined();
    expect(cfg.web.providers).toEqual([]);
  });

  it('accepts bounded provider-neutral web configuration', () => {
    const cfg = ConfigSchema.parse({
      web: {
        enabled: true,
        defaultProvider: 'tavily',
        readMode: 'configured_allowlist',
        dnsResolver: 'cloudflare_doh',
        allowDomains: ['example.com'],
        maxResults: 6,
        providers: [{
          id: 'tavily',
          type: 'tavily-search-v1',
          apiKeyRef: '$TAVILY_API_KEY',
          options: { searchDepth: 'basic' },
        }],
      },
    });
    expect(cfg.web.enabled).toBe(true);
    expect(cfg.web.defaultProvider).toBe('tavily');
    expect(cfg.web.dnsResolver).toBe('cloudflare_doh');
    expect(cfg.web.providers[0]).toEqual({
      id: 'tavily',
      type: 'tavily-search-v1',
      apiKeyRef: '$TAVILY_API_KEY',
      options: { searchDepth: 'basic' },
    });
  });

  it('rejects invalid, duplicate, and over-limit web configuration', () => {
    expect(() => ConfigSchema.parse({ web: { maxResults: 21 } })).toThrow();
    expect(() => ConfigSchema.parse({ web: { maxResponseBytes: 33 * 1024 * 1024 } })).toThrow();
    expect(() => ConfigSchema.parse({ web: { dnsResolver: 'arbitrary_endpoint' } })).toThrow();
    expect(() => ConfigSchema.parse({
      web: {
        providers: [
          { id: 'same', type: 'tavily-search-v1' },
          { id: 'same', type: 'tavily-search-v1' },
        ],
      },
    })).toThrow(/duplicate web provider id/u);
    expect(() => ConfigSchema.parse({
      web: { providers: [{ id: 'UPPER CASE', type: 'adapter' }] },
    })).toThrow();
  });

  it('strips unknown web fields while preserving explicit adapter options', () => {
    const cfg = ConfigSchema.parse({
      web: {
        hiddenEndpoint: 'https://should-not-survive.example',
        providers: [{ id: 'test', type: 'fake', options: { fixture: true }, secret: 'drop-me' }],
      },
    });
    expect('hiddenEndpoint' in cfg.web).toBe(false);
    expect('secret' in cfg.web.providers[0]!).toBe(false);
    expect(cfg.web.providers[0]?.options).toEqual({ fixture: true });
  });
});
