import { describe, expect, it } from 'vitest';
import { asSessionId } from '@littlesheep/types';
import type {
  ContextItemKind,
  ContextSnapshot,
  ContextSnapshotItem,
  ModelMessageShape,
  ModelRequestSnapshot,
} from '@littlesheep/types';
import { diffContextSnapshots, diffModelRequestSnapshots } from './request-prefix-diff.js';

const SECRET = 'PRIVATE-SECRET-BODY';

function item(
  id: string,
  kind: ContextItemKind,
  hash: string,
  overrides: Partial<ContextSnapshotItem> = {},
): ContextSnapshotItem {
  return {
    id,
    kind,
    scope: 'run',
    source: { kind: 'message', id: `${id}-source`, path: `C:/private/${SECRET}.txt` },
    priority: 1,
    required: false,
    sensitive: false,
    createdAt: '2026-09-16T00:00:00.000Z',
    contentType: 'text',
    contentHash: hash,
    characterCount: 12,
    disposition: 'included',
    contentRef: `private://${SECRET}`,
    ...overrides,
  };
}

function snapshot(id: string, items: ContextSnapshotItem[]): ContextSnapshot {
  return {
    version: 1,
    id,
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    provider: 'openai',
    model: 'gpt-test',
    createdAt: '2026-09-16T00:00:00.000Z',
    budget: { status: 'known', maxContextTokens: 8_000, reservedOutputTokens: 1_000, availablePromptTokens: 7_000, compressionThresholdRatio: 0.8 },
    items,
    totalItemCount: items.length,
    itemsTruncated: false,
    compressionRecommended: false,
  };
}

function message(role: ModelMessageShape['role'], hash: string, overrides: Partial<ModelMessageShape> = {}): ModelMessageShape {
  return { role, contentKind: 'text', characterCount: 20, contentHash: hash, toolCallCount: 0, ...overrides };
}

function requestSnapshot(id: string, overrides: Partial<ModelRequestSnapshot> = {}): ModelRequestSnapshot {
  return {
    version: 1,
    id,
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    stage: 'execute',
    requestIndex: 1,
    provider: 'openai',
    model: 'gpt-test',
    createdAt: '2026-09-16T00:00:00.000Z',
    messages: [message('system', 'hash-system'), message('user', 'hash-user')],
    totalMessageCount: 2,
    messagesTruncated: false,
    toolNames: ['read', 'grep'],
    totalToolCount: 2,
    toolsTruncated: false,
    stream: false,
    payloadHash: 'payload-1',
    ...overrides,
  };
}

describe('diffContextSnapshots', () => {
  it('reports an identical prefix without inventing changes', () => {
    const before = snapshot('a', [
      item('system', 'system_prompt', 'h1'),
      item('summary', 'summary_memory', 'h2'),
      item('history', 'recent_message', 'h3'),
    ]);
    const after = snapshot('b', [
      item('system', 'system_prompt', 'h1'),
      item('summary', 'summary_memory', 'h2'),
      item('history', 'recent_message', 'h3'),
    ]);

    const diff = diffContextSnapshots(before, after);
    expect(diff).toMatchObject({ identical: true, stablePrefixLength: 3, changedReasons: [] });
    expect(diff.segments.every((segment) => segment.change === 'unchanged')).toBe(true);
  });

  it('classifies system-prompt, summary and history changes by reason', () => {
    const before = snapshot('a', [
      item('system', 'system_prompt', 'h1'),
      item('summary', 'summary_memory', 'h2'),
      item('history', 'recent_message', 'h3'),
    ]);
    const after = snapshot('b', [
      item('system', 'system_prompt', 'h1-changed'),
      item('summary', 'summary_memory', 'h2-changed'),
      item('history', 'recent_message', 'h3'),
    ]);

    const diff = diffContextSnapshots(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.changedReasons).toEqual(['summary_memory', 'system_prompt']);
    expect(diff.stablePrefixLength).toBe(0);
    expect(diff.firstChangeKey).toBe('system_prompt\u0000system');
    expect(diff.segments[0]).toMatchObject({ change: 'changed', fromHash: 'h1', toHash: 'h1-changed' });
  });

  it('separates added, removed and budget-omitted segments', () => {
    const before = snapshot('a', [
      item('system', 'system_prompt', 'h1'),
      item('memory', 'memory_fragment', 'h2'),
    ]);
    const after = snapshot('b', [
      item('system', 'system_prompt', 'h1'),
      item('runtime', 'runtime_event', 'h4'),
      item('knowledge', 'project_knowledge', 'h5', { disposition: 'omitted', omissionReason: 'budget' }),
    ]);

    const diff = diffContextSnapshots(before, after);
    const byKey = new Map(diff.segments.map((segment) => [segment.key, segment]));
    expect(byKey.get('memory_fragment\u0000memory')).toMatchObject({ change: 'removed', reason: 'memory' });
    expect(byKey.get('runtime_event\u0000runtime')).toMatchObject({ change: 'added', reason: 'runtime_fact' });
    expect(byKey.get('project_knowledge\u0000knowledge')).toMatchObject({
      change: 'added',
      reason: 'project_knowledge',
      toDisposition: 'omitted',
    });
    expect(diff.changedReasons).toEqual(['memory', 'project_knowledge', 'runtime_fact']);
  });

  it('never exports prompt bodies, source paths or content refs', () => {
    const before = snapshot('a', [item('system', 'system_prompt', 'h1')]);
    const after = snapshot('b', [item('system', 'system_prompt', 'h2')]);

    const serialized = JSON.stringify(diffContextSnapshots(before, after));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('private://');
    expect(serialized).not.toContain('C:/private');
  });
});

describe('diffModelRequestSnapshots', () => {
  it('reports message, tool and policy changes separately', () => {
    const before = requestSnapshot('a');
    const after = requestSnapshot('b', {
      messages: [message('system', 'hash-system'), message('user', 'hash-user-2'), message('assistant', 'hash-assistant')],
      toolNames: ['read', 'write'],
      toolChoice: 'required',
      temperature: 0.2,
      payloadHash: 'payload-2',
    });

    const diff = diffModelRequestSnapshots(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.payloadChanged).toBe(true);
    expect(diff.reasons).toEqual(['history', 'policy', 'tools']);
    expect(diff.messageChanges).toEqual([
      { index: 1, role: 'user', change: 'changed', reason: 'history' },
      { index: 2, role: 'assistant', change: 'added', reason: 'history' },
    ]);
    expect(diff.tools).toEqual({ added: ['write'], removed: ['grep'] });
    expect(diff.policyFields).toEqual(['toolChoice', 'temperature']);
  });

  it('treats identical requests as identical even when ids differ', () => {
    const diff = diffModelRequestSnapshots(requestSnapshot('a'), requestSnapshot('b'));
    expect(diff).toMatchObject({ identical: true, payloadChanged: false, reasons: [], policyFields: [] });
    expect(diff.messageChanges).toEqual([]);
    expect(diff.tools).toEqual({ added: [], removed: [] });
  });

  it('flags a payload-only change without pretending messages changed', () => {
    const diff = diffModelRequestSnapshots(
      requestSnapshot('a'),
      requestSnapshot('b', { payloadHash: 'payload-2' }),
    );
    expect(diff.payloadChanged).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.messageChanges).toEqual([]);
    expect(diff.reasons).toEqual([]);
  });
});
