import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { makeCtx } from './tests/helpers.js';
import {
  applyMemoryContextWorkingSet,
  ingestMemoryContextToolResult,
} from './memory-context-working-set.js';

describe('run memory context working set', () => {
  it('removes released atom sections and keeps retained atoms in the next model request', () => {
    const ctx = makeCtx();
    ingestMemoryContextToolResult(ctx, 'expand-1', {
      callId: 'expand-1', ok: true, output: '', meta: { memoryFragmentIds: ['atom-a', 'atom-b'] },
    });
    ingestMemoryContextToolResult(ctx, 'release-1', {
      callId: 'release-1', ok: true, output: '', meta: { memoryReleasedAtomIds: ['atom-a'] },
    });
    const prepared = applyMemoryContextWorkingSet(ctx, request('expand-1', renderedResult()));
    const payload = JSON.parse(String(prepared.request.messages[1]?.content)) as { output: string };

    expect(payload.output).not.toContain('secret atom A');
    expect(payload.output).toContain('retained atom B');
    expect(payload.output).toContain('1 memory atom section(s) released');
    expect(ctx.memoryContextWorkingSet).toMatchObject({
      activeAtomIds: ['atom-b'],
      releasedAtomIds: ['atom-a'],
    });
  });

  it('assigns a re-added atom to the newest tool call so stale copies stay suppressed', () => {
    const ctx = makeCtx();
    ingestMemoryContextToolResult(ctx, 'expand-old', {
      callId: 'expand-old', ok: true, output: '', meta: { memoryFragmentIds: ['atom-a'] },
    });
    ingestMemoryContextToolResult(ctx, 'release', {
      callId: 'release', ok: true, output: '', meta: { memoryReleasedAtomIds: ['atom-a'] },
    });
    ingestMemoryContextToolResult(ctx, 'expand-new', {
      callId: 'expand-new', ok: true, output: '', meta: { memoryFragmentIds: ['atom-a'] },
    });
    const requestValue: ChatRequest = {
      model: 'test',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'tool', tool_call_id: 'expand-old', content: JSON.stringify({ output: renderedResult() }) },
        { role: 'tool', tool_call_id: 'expand-new', content: JSON.stringify({ output: renderedResult() }) },
      ],
    };
    const prepared = applyMemoryContextWorkingSet(ctx, requestValue).request;
    const oldOutput = (JSON.parse(String(prepared.messages[1]?.content)) as { output: string }).output;
    const newOutput = (JSON.parse(String(prepared.messages[2]?.content)) as { output: string }).output;

    expect(oldOutput).not.toContain('secret atom A');
    expect(newOutput).toContain('secret atom A');
    expect(ctx.memoryContextWorkingSet?.releasedAtomIds).not.toContain('atom-a');
  });

  it('removes a released initial atom from both the system message and its source segment', () => {
    const ctx = makeCtx();
    ctx.memoryContextWorkingSet = {
      revision: 2,
      activeAtomIds: [],
      releasedAtomIds: ['atom-a'],
      activeCallByAtom: {},
      callAtomIds: { initial: ['atom-a'] },
      updatedAt: '2026-07-16T02:00:00.000Z',
    };
    const initial = [
      '# Initially Selected Memory Atoms',
      '',
      '<!-- littlesheep-memory-atom:start atom-a -->',
      '## [atom-a] T2 - selected',
      'secret initial atom',
      '<!-- littlesheep-memory-atom:end atom-a -->',
    ].join('\n');
    const requestValue: ChatRequest = {
      model: 'test',
      messages: [{ role: 'system', content: `stable\n\n${initial}\n\n---\n\n# Required Policy\nkeep this policy` }],
    };
    const candidate = {
      id: 'system', order: 0, message: requestValue.messages[0]!, kind: 'system_prompt' as const,
      source: { kind: 'prompt' as const, id: 'system' }, priority: 100, required: true, sensitive: true,
      segments: [{
        id: 'initial', order: 1, text: initial, kind: 'memory_fragment' as const,
        source: { kind: 'memory' as const, id: 'initial-selection' }, priority: 92,
        required: false, sensitive: true, scope: 'run' as const,
      }],
    };
    const prepared = applyMemoryContextWorkingSet(ctx, requestValue, [candidate]);

    expect(String(prepared.request.messages[0]?.content)).not.toContain('secret initial atom');
    expect(String(prepared.request.messages[0]?.content)).toContain('keep this policy');
    expect(prepared.candidates?.[0]?.segments?.[0]?.text).not.toContain('secret initial atom');
  });
});

function request(callId: string, output: string): ChatRequest {
  return {
    model: 'test',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'tool', tool_call_id: callId, content: JSON.stringify({ ok: true, output }) },
    ],
  };
}

function renderedResult(): string {
  return [
    '# Memory Expansion',
    'Budget: 20/100 tokens.',
    '',
    '<!-- littlesheep-memory-atom:start atom-a -->',
    '## [atom-a] T2 - selected',
    'secret atom A',
    '<!-- littlesheep-memory-atom:end atom-a -->',
    '',
    '<!-- littlesheep-memory-atom:start atom-b -->',
    '## [atom-b] T2 - selected',
    'retained atom B',
    '<!-- littlesheep-memory-atom:end atom-b -->',
  ].join('\n');
}
