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
    expect(cfg.desktop.closePolicy).toBe('background-while-active');
    expect(cfg.tools.exec.approvalMode).toBe('interactive');
    expect(cfg.tools.invocationTimeoutMs).toBe(120_000);
    expect(cfg.memory.preludeDays).toBe(3);
    expect(cfg.memory.repositoryBackend).toBe('v2');
    expect(cfg.memory.treeRunTokenBudget).toBe(3200);
    expect(cfg.memory.treeBranchTokenBudget).toBe(1200);
    expect(cfg.memory.treeRootIndexMaxChars).toBe(1600);
    expect(cfg.memory.experienceWriteThreshold).toBe(0.65);
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
    expect(() => ConfigSchema.parse({ tools: { exec: {}, invocationTimeoutMs: 30 * 60_000 + 1 } })).toThrow();
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
    expect(model).toBe('deepseek/deepseek-v4-pro');
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
});
