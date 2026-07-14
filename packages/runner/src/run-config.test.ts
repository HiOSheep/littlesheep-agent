import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { AgentTool } from '@littlesheep/types';
import { resolveRunConfig } from './run-config.js';

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
});
