import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { CACHE_BOUNDARY_MARKER, buildSystemPromptBundle } from '@littlesheep/prompt';
import { textMessage } from '@littlesheep/types';
import { buildRunRequestCandidates } from './context-candidates.js';
import { splitSystemPromptForCache } from './system-prompt-cache-split.js';
import { makeCtx } from './tests/helpers.js';

function bundle() {
  return buildSystemPromptBundle({
    branding: DEFAULT_BRANDING,
    tools: [],
    workspace: '/tmp/ws',
    bootstrap: {},
    memoryRootIndex: 'VOLATILE_MEMORY_INDEX',
    mode: 'full',
  });
}

describe('system prompt cache split', () => {
  it('keeps the system message byte-stable and moves volatile sections out', () => {
    const split = splitSystemPromptForCache(bundle());

    expect(split.systemText).toContain('LittleSheep');
    expect(split.systemText).not.toContain(CACHE_BOUNDARY_MARKER);
    expect(split.systemText).not.toContain('VOLATILE_MEMORY_INDEX');
    // Volatile sections keep their original Context kind for contract checks.
    const memory = split.trailingSegments.find((segment) => segment.kind === 'memory_index');
    expect(memory?.text).toContain('VOLATILE_MEMORY_INDEX');
    expect(memory?.text).not.toContain(CACHE_BOUNDARY_MARKER);
  });

  it('appends trailing sections after the conversation with preserved kinds', () => {
    const split = splitSystemPromptForCache(bundle());
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const messages = [{ role: 'system' as const, content: split.systemText }];

    const withoutTrailing = buildRunRequestCandidates(ctx, 'reply', messages, { history: [] });
    expect(withoutTrailing.every((candidate) => candidate.kind !== 'memory_index')).toBe(true);

    const withTrailing = buildRunRequestCandidates(ctx, 'reply', messages, {
      history: [],
      trailingSegments: split.trailingSegments,
    });
    const last = withTrailing.at(-1);
    expect(last?.kind).toBe('memory_index');
    expect(String(last?.message.content)).toContain('VOLATILE_MEMORY_INDEX');
    expect(last!.order).toBeGreaterThan(withTrailing[withTrailing.length - 2]!.order);
  });
});
