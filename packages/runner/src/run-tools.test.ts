import { describe, expect, it } from 'vitest';
import type { AgentTool, ToolRegistration } from '@littlesheep/types';
import { resolveRunTools } from './run-tools.js';

describe('resolveRunTools', () => {
  it('preserves registered sources and marks ephemeral tools as run-scoped', () => {
    const registered: ToolRegistration[] = [{ tool: tool('plugin'), source: 'plugin:test' }];

    const resolved = resolveRunTools(registered, { additionalTools: [tool('attachment')] });

    expect(resolved.sources).toEqual({ plugin: 'plugin:test', attachment: 'run-scoped' });
    expect(resolved.tools.map((item) => item.name)).toEqual(['plugin', 'attachment']);
    expect(registered).toHaveLength(1);
  });

  it('applies filters and approval overrides without losing source metadata', () => {
    const resolved = resolveRunTools([
      { tool: tool('keep'), source: 'builtin' },
      { tool: tool('drop'), source: 'plugin:drop' },
    ], {
      filter: (candidate) => candidate.name === 'keep',
      requireApprovalForAllTools: true,
    });

    expect(resolved.sources).toEqual({ keep: 'builtin' });
    expect(resolved.tools[0]).toMatchObject({ name: 'keep', requiresApproval: true });
  });

  it('rejects additional tool name conflicts', () => {
    expect(() => resolveRunTools([
      { tool: tool('same'), source: 'builtin' },
    ], { additionalTools: [tool('same')] })).toThrow(/conflicts/);
  });
});

function tool(name: string): AgentTool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { parse: (input) => input },
    execute: async () => ({ callId: '', ok: true }),
  };
}
