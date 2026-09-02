import { describe, expect, it } from 'vitest';
import { buildCapabilitySnapshot, workspacePermissionEvent } from './capability-snapshot.js';
import type { AgentTool } from '@littlesheep/types';

function tool(name: string): AgentTool {
  return {
    name,
    description: name,
    inputSchema: { parse: (value) => value, jsonSchema: { type: 'object' } },
    execute: async () => ({ callId: name, ok: true }),
  };
}

function snapshot(overrides: Partial<Parameters<typeof buildCapabilitySnapshot>[0]> = {}) {
  return buildCapabilitySnapshot({
    tools: [tool('write'), tool('read'), tool('read')],
    toolSources: { read: 'builtin', write: 'plugin' },
    approvalRequiredToolNames: ['write'],
    permissionPolicyId: 'research',
    workspaceAccess: 'available',
    networkEnabled: false,
    now: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  });
}

describe('Runtime capability snapshot', () => {
  it('sorts and deduplicates tools and excludes generatedAt from epoch', () => {
    const first = snapshot({ now: new Date('2026-09-02T00:00:00.000Z') });
    const second = snapshot({ now: new Date('2026-09-02T00:00:01.000Z') });
    expect(first.tools).toEqual([
      { name: 'read', status: 'available', source: 'builtin' },
      { name: 'write', status: 'approval_required', source: 'external' },
    ]);
    expect(second.epoch).toBe(first.epoch);
    expect(second.generatedAt).not.toBe(first.generatedAt);
  });

  it('changes epoch for permission, tool approval, network and provider status changes', () => {
    const base = snapshot();
    expect(snapshot({ permissionPolicyId: 'restricted' }).epoch).not.toBe(base.epoch);
    expect(snapshot({ approvalRequiredToolNames: [] }).epoch).not.toBe(base.epoch);
    expect(snapshot({ networkEnabled: true }).epoch).not.toBe(base.epoch);
    expect(snapshot({ webProvider: { id: 'tavily', adapterType: 'tavily', status: 'ready' } }).epoch).not.toBe(base.epoch);
  });

  it.each([
    ['available', 'allow'],
    ['approval_required', 'approval_required'],
    ['denied', 'deny'],
    ['unavailable', 'unavailable'],
  ] as const)('projects workspace %s as permission %s', (workspaceAccess, decision) => {
    expect(workspacePermissionEvent(snapshot({ workspaceAccess }), 'event-1')).toMatchObject({
      eventId: 'event-1',
      action: 'workspace_scan',
      decision,
      permissionPolicyId: 'research',
    });
  });

  it('never includes paths, prompt text or credentials', () => {
    const value = JSON.stringify(snapshot({ webProvider: { id: 'provider-id', adapterType: 'custom', status: 'ready' } }));
    expect(value).not.toContain('C:\\Users');
    expect(value).not.toContain('SECRET');
    expect(value).not.toContain('prompt');
  });
});
