import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import type { RunContext } from '@littlesheep/types';
import { appendMemoryReleaseNotes } from './memory-context-working-set.js';

function ctxWithWorkingSet(): RunContext {
  return {
    runId: 'run-release',
    memoryContextWorkingSet: {
      callAtomIds: { initial: ['atom-keep', 'atom-released'], 'call-1': ['atom-active'] },
      activeCallByAtom: { 'atom-keep': 'initial', 'atom-active': 'call-1' },
    },
  } as unknown as RunContext;
}

function requestWithHistory(): ChatRequest {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: '# Identity\n\nstable head\n\n## [atom-released] old evidence text' },
      { role: 'user', content: 'continue' },
      { role: 'tool', tool_call_id: 'call-1', content: '{"output":"## [atom-released] tool text"}' },
    ],
  };
}

describe('append-only memory release', () => {
  it('keeps earlier text byte-identical and appends one release note', () => {
    const request = requestWithHistory();
    const before = request.messages.map((message) => String(message.content));

    const result = appendMemoryReleaseNotes(ctxWithWorkingSet(), request, []);

    // The Provider prefix survives: nothing earlier was rewritten.
    expect(result.request.messages.slice(0, before.length).map((message) => String(message.content))).toEqual(before);
    expect(result.request.messages).toHaveLength(before.length + 1);
    const note = String(result.request.messages.at(-1)?.content);
    expect(note).toContain('released_atoms: atom-released');
    expect(note).toContain('do not cite it');
    expect(note).toContain('append-only');
    expect(result.candidates?.at(-1)).toMatchObject({ kind: 'memory_fragment', required: true });
  });

  it('adds nothing when no atom was released', () => {
    const ctx = {
      runId: 'run-release',
      memoryContextWorkingSet: {
        callAtomIds: { initial: ['atom-keep'] },
        activeCallByAtom: { 'atom-keep': 'initial' },
      },
    } as unknown as RunContext;
    const request = requestWithHistory();

    const result = appendMemoryReleaseNotes(ctx, request);

    expect(result.request).toBe(request);
  });
});
