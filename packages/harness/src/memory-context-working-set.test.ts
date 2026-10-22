import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { makeCtx } from './tests/helpers.js';
import { buildRunRequestCandidates } from './context-candidates.js';
import { canonicalSerialize } from './cache-observability.js';
import { prepareModelRequest } from './model-observability.js';
import { ingestMemoryContextToolResult } from './memory-context-working-set.js';

describe('run memory context working set', () => {
  it('keeps released atom content in the dynamic suffix and explains the cache change', () => {
    const ctx = makeCtx();
    ctx.memoryContextWorkingSet = {
      revision: 1,
      activeAtomIds: ['atom-a'],
      releasedAtomIds: [],
      activeCallByAtom: { 'atom-a': 'initial' },
      callAtomIds: { initial: ['atom-a'] },
      updatedAt: '2026-09-09T00:00:00.000Z',
    };

    const firstRaw = cacheRequest();
    const first = prepareModelRequest(
      ctx,
      'reply',
      firstRaw,
      buildRunRequestCandidates(ctx, 'reply', firstRaw.messages, { history: [] }),
    );
    const firstObservation = ctx.modelRequests?.[0]?.cacheObservation;
    expect(String(first.messages[0]?.content)).toContain('secret initial atom');

    ingestMemoryContextToolResult(ctx, 'release-1', {
      callId: 'release-1',
      ok: true,
      output: '',
      meta: { memoryReleasedAtomIds: ['atom-a'] },
    });
    const secondRaw = cacheRequest();
    const second = prepareModelRequest(
      ctx,
      'reply',
      secondRaw,
      buildRunRequestCandidates(ctx, 'reply', secondRaw.messages, { history: [] }),
    );
    const secondObservation = ctx.modelRequests?.[1]?.cacheObservation;

    // Append-only release: the earlier system text is preserved byte for byte
    // and the runtime appends an authoritative release note instead of
    // rewriting history (which would invalidate the Provider's prefix cache).
    expect(String(second.messages[0]?.content)).toContain('secret initial atom');
    expect(second.messages.map((message) => String(message.content)).join('\n')).toContain('# Released Memory');
    expect(secondObservation?.stablePrefix.fingerprint).toBe(firstObservation?.stablePrefix.fingerprint);
    expect(secondObservation?.dynamicSuffix.fingerprint).not.toBe(firstObservation?.dynamicSuffix.fingerprint);
    expect(secondObservation?.invalidationReasons).toContain('memory_revision_changed');
    expect(canonicalSerialize(secondObservation)).not.toContain('secret initial atom');
    expect(canonicalSerialize(secondObservation)).not.toContain('atom-a');
  });
});

function cacheRequest(): ChatRequest {
  const initial = [
    '# Initially Selected Memory Atoms',
    '',
    '<!-- littlesheep-memory-atom:start atom-a -->',
    '## [atom-a] T2 - selected',
    'secret initial atom',
    '<!-- littlesheep-memory-atom:end atom-a -->',
  ].join('\n');
  return {
    model: 'test',
    messages: [
      {
        role: 'system',
        content: `Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\n${initial}`,
      },
      { role: 'user', content: 'continue' },
    ],
    max_tokens: 100,
  };
}
