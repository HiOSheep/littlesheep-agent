import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';
import { buildSharedPromptHead, sharedPromptHeadPrefixLength } from './shared-head.js';

function tool(name: string): AgentTool {
  return {
    name,
    description: `Use ${name}`,
    inputSchema: { parse: (x: unknown) => x },
    execute: async () => ({ callId: '', ok: true, output: '' }),
  };
}

function longestCommonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

describe('shared prompt head', () => {
  it('is byte-identical for every stage that shares a tool set', () => {
    const base = { branding: DEFAULT_BRANDING, workspace: '/tmp/ws', timezone: 'UTC' };
    const tools = [tool('read'), tool('grep')];

    const reply = buildSharedPromptHead({ ...base, tools });
    const execute = buildSharedPromptHead({ ...base, tools });

    expect(reply).toBe(execute);
    expect(longestCommonPrefix(reply, execute)).toBe(reply.length);
  });

  it('shares everything above the tool list when stages expose different tools', () => {
    const base = { branding: DEFAULT_BRANDING, workspace: '/tmp/ws', timezone: 'UTC' };
    const readOnly = buildSharedPromptHead({ ...base, tools: [tool('read')] });
    const full = buildSharedPromptHead({ ...base, tools: [tool('read'), tool('grep'), tool('write')] });

    // Measured on the previous layout the whole cross-stage head was 293 bytes
    // (identity only); the shared head must stay well above that.
    expect(longestCommonPrefix(readOnly, full)).toBeGreaterThanOrEqual(sharedPromptHeadPrefixLength(base));
    expect(sharedPromptHeadPrefixLength(base)).toBeGreaterThan(1_500);
  });
});
