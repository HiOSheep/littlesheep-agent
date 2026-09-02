import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { AgentTool } from '@littlesheep/types';
import { resolveNetworkReadPolicy, resolveRunConfig } from './run-config.js';

function tool(name: string, requiresApproval = false): AgentTool {
  return { name, requiresApproval } as AgentTool;
}

describe('resolveRunConfig', () => {
  it('resolves provider, model, overrides, and tool policy once', () => {
    const resolved = resolveRunConfig({
      runId: 'run-fixed',
      config: DEFAULT_CONFIG,
      modelRef: 'openai/gpt-test',
      origin: 'app',
      profile: 'coding',
      permissionPolicyId: 'restricted',
      reasoning: 'high',
      tools: [tool('read'), tool('write', true), tool('read')],
      requireApprovalForAllTools: false,
      toolFilterApplied: true,
      cwdOverridden: true,
    });

    expect(resolved).toMatchObject({
      version: 1,
      runId: 'run-fixed',
      origin: 'app',
      behaviorModeId: 'coding',
      permissionPolicyId: 'restricted',
      provider: 'openai',
      model: 'gpt-test',
      reasoning: 'high',
      availableToolNames: ['read', 'write'],
      approvalRequiredToolNames: ['write'],
      networkPolicy: {
        version: 1,
        enabled: false,
        mode: 'disabled',
        dnsResolver: 'system',
        strictReadApproval: false,
      },
      userOverrides: {
        profile: 'coding',
        reasoning: 'high',
        permissionPolicyId: 'restricted',
        toolFilterApplied: true,
        workspaceOverridden: true,
      },
    });
  });

  it('falls back conservatively and deeply freezes the decision', () => {
    const resolved = resolveRunConfig({
      runId: 'run-fallback',
      config: DEFAULT_CONFIG,
      modelRef: 'standalone-model',
      origin: 'cli',
      tools: [tool('exec')],
      requireApprovalForAllTools: false,
      toolFilterApplied: false,
      cwdOverridden: false,
    });

    expect(resolved.provider).toBe('unknown');
    expect(resolved.model).toBe('standalone-model');
    expect(resolved.permissionPolicyId).toBe('research');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.parameters)).toBe(true);
    expect(Object.isFrozen(resolved.availableToolNames)).toBe(true);
    expect(Object.isFrozen(resolved.networkPolicy)).toBe(true);
    expect(Object.isFrozen(resolved.networkPolicy?.allowDomains)).toBe(true);
    expect(Object.isFrozen(resolved.userOverrides)).toBe(true);
    expect(() => {
      (resolved.parameters as Record<string, unknown>).changed = true;
    }).toThrow(TypeError);
  });

  it('marks every selected tool as approval-required when the adapter requests it', () => {
    const resolved = resolveRunConfig({
      runId: 'run-restricted',
      config: DEFAULT_CONFIG,
      modelRef: 'deepseek/deepseek-test',
      origin: 'channel',
      tools: [tool('read'), tool('write', true)],
      requireApprovalForAllTools: true,
      toolFilterApplied: false,
      cwdOverridden: false,
    });

    expect(resolved.permissionPolicyId).toBe('restricted');
    expect(resolved.approvalRequiredToolNames).toEqual(['read', 'write']);
  });

  it('does not advertise per-tool approvals in confirmed full access', () => {
    const resolved = resolveRunConfig({
      runId: 'run-full',
      config: DEFAULT_CONFIG,
      modelRef: 'deepseek/deepseek-test',
      origin: 'app',
      permissionPolicyId: 'full',
      tools: [tool('read'), tool('write', true), tool('exec', true)],
      requireApprovalForAllTools: false,
      toolFilterApplied: false,
      cwdOverridden: true,
    });

    expect(resolved.approvalRequiredToolNames).toEqual([]);
  });

  it('resolves an opt-in web policy and a redacted provider snapshot', () => {
    const config = {
      ...DEFAULT_CONFIG,
      web: {
        ...DEFAULT_CONFIG.web,
        enabled: true,
        defaultProvider: 'tavily',
        dnsResolver: 'cloudflare_doh' as const,
        allowDomains: ['docs.example.com'],
        providers: [{
          id: 'tavily',
          type: 'tavily-search-v1',
          apiKeyRef: '$TAVILY_API_KEY',
          options: {},
        }],
      },
    };
    const resolved = resolveRunConfig({
      runId: 'run-web',
      config,
      modelRef: 'deepseek/deepseek-test',
      origin: 'app',
      tools: [tool('web_search')],
      requireApprovalForAllTools: false,
      toolFilterApplied: false,
      cwdOverridden: false,
    });

    expect(resolved.networkPolicy).toMatchObject({
      enabled: true,
      providerId: 'tavily',
      mode: 'public_anonymous',
      dnsResolver: 'cloudflare_doh',
      allowDomains: ['docs.example.com'],
      maxQueriesPerRun: 4,
    });
    expect(resolved.webProvider).toEqual({
      id: 'tavily',
      adapterType: 'tavily-search-v1',
      status: 'configured_unchecked',
    });
    expect(JSON.stringify(resolved)).not.toContain('TAVILY_API_KEY');
  });

  it('keeps disabled and missing-provider states explicit', () => {
    const disabled = resolveNetworkReadPolicy(DEFAULT_CONFIG);
    expect(disabled).toMatchObject({ enabled: false, mode: 'disabled' });

    const configuredMissing = resolveRunConfig({
      runId: 'run-web-missing',
      config: {
        ...DEFAULT_CONFIG,
        web: { ...DEFAULT_CONFIG.web, enabled: true, defaultProvider: 'missing' },
      },
      modelRef: 'deepseek/deepseek-test',
      origin: 'test',
      tools: [],
      requireApprovalForAllTools: false,
      toolFilterApplied: false,
      cwdOverridden: false,
    });
    expect(configuredMissing.webProvider).toMatchObject({
      id: 'missing',
      status: 'unconfigured',
      detailCode: 'web_provider_unconfigured',
    });
  });
});
