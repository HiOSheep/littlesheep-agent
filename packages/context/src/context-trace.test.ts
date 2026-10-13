import { describe, expect, it } from 'vitest';
import type { ContextSnapshot } from '@littlesheep/types';
import { ContextEngine } from './engine.js';
import { buildContextTrace } from './context-trace.js';

function evidence() {
  return new ContextEngine().prepare({
    runId: 'private-run', sessionId: 'private-session', stage: 'execute', requestIndex: 1,
    request: { model: 'test/model', messages: [{ role: 'user', content: 'PRIVATE_BODY' }] },
  });
}

describe('Context Trace privacy and evidence boundaries', () => {
  it('marks unknown character sizes unavailable instead of presenting a measured zero', () => {
    const prepared = evidence();
    const snapshot = structuredClone(prepared.contextSnapshot);
    snapshot.items[0]!.characterCount = undefined;
    const trace = buildContextTrace(snapshot, prepared.modelRequestSnapshot)!;
    expect(trace.sources[0]!.includedCharactersUnavailable).toBe(true);
  });
  it('projects counts without leaking text, source paths, ids, hashes or reasons', () => {
    const prepared = evidence();
    const snapshot = structuredClone(prepared.contextSnapshot);
    snapshot.items[0]!.source = { kind: 'message', path: 'PRIVATE_PATH', id: 'PRIVATE_ID' };
    snapshot.items[0]!.contentRef = 'PRIVATE_REF';
    const trace = buildContextTrace(snapshot, prepared.modelRequestSnapshot)!;
    expect(trace.messageCount).toBe(1);
    expect(trace.sources.reduce((n, s) => n + s.includedCharacters, 0)).toBe(12);
    const serialized = JSON.stringify(trace);
    for (const secret of ['PRIVATE', 'private-run', 'private-session', snapshot.items[0]!.contentHash!]) {
      expect(serialized).not.toContain(secret);
    }
    expect(trace.tokens).toEqual({ local: { status: 'unavailable' }, provider: { status: 'unavailable' } });
    expect(trace.coverage.sourceTokens).toBe('unavailable');
  });

  it('rejects cross-run/session/model joins and missing legacy links', () => {
    const { contextSnapshot: snapshot, modelRequestSnapshot: request } = evidence();
    for (const patch of [{ runId: 'other' }, { sessionId: 'other' }, { model: 'other' },
      { provider: 'other' }, { contextSnapshotId: undefined }]) {
      expect(buildContextTrace(snapshot, { ...request, ...patch })).toBeUndefined();
    }
  });

  it('fails closed on unknown source enums and reports incomplete coverage', () => {
    const { contextSnapshot, modelRequestSnapshot } = evidence();
    const snapshot = structuredClone(contextSnapshot);
    snapshot.items.push({ ...snapshot.items[0]!, kind: 'PRIVATE_UNKNOWN' } as unknown as ContextSnapshot['items'][number]);
    snapshot.itemsTruncated = true;
    const request = { ...modelRequestSnapshot, toolsTruncated: true, messagesTruncated: true };
    const trace = buildContextTrace(snapshot, request)!;
    expect(trace.coverage).toMatchObject({ items: 'partial', tools: 'partial', messages: 'partial', rejectedItems: 1 });
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_UNKNOWN');
  });

  it('keeps provider, local and cache subsets distinct; missing cache stays unknown', () => {
    const { contextSnapshot, modelRequestSnapshot } = evidence();
    const snapshot = structuredClone(contextSnapshot);
    snapshot.providerUsage = {
      version: 1, source: 'provider', provider: snapshot.provider, model: snapshot.model,
      promptTokens: 6000, completionTokens: 20, totalTokens: 6020, cachedPromptTokens: 5000,
      cacheWriteTokens: 9000, reasoningTokens: 21, reportedAt: 'PRIVATE_DATE',
    };
    const trace = buildContextTrace(snapshot, modelRequestSnapshot)!;
    expect(trace.tokens.provider).toEqual({ status: 'reported', promptTokens: 6000, completionTokens: 20,
      cachedPromptTokens: 5000, uncachedPromptTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined });
    expect(trace.tokens.local.status).toBe('unavailable');
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_DATE');
    // Caller-owned evidence and request are never mutated.
    expect(snapshot.providerUsage.cacheWriteTokens).toBe(9000);
  });
});
