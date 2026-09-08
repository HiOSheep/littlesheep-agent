import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import type { RuntimeMemoryKnownState } from '@littlesheep/types';
import { buildRunRequestCandidates } from './context-candidates.js';
import { ingestMemoryKnownState } from './memory-known-state.js';
import { prepareModelRequest } from './model-observability.js';
import { canonicalSerialize } from './cache-observability.js';
import { makeCtx } from './tests/helpers.js';

describe('run Memory KnownState', () => {
  it('injects bounded epistemic evidence into allowed stages and records it as memory Context', () => {
    const ctx = makeCtx();
    ingestMemoryKnownState(ctx, knownState(ctx.runId), 'execute');
    const raw: ChatRequest = {
      model: 'test',
      messages: [
        { role: 'system', content: 'verify policy' },
        { role: 'user', content: 'verify evidence' },
      ],
      max_tokens: 100,
    };
    const prepared = prepareModelRequest(
      ctx,
      'verify',
      raw,
      buildRunRequestCandidates(ctx, 'verify', raw.messages, { history: [], primaryUserKind: 'workflow_state' }),
    );

    const system = String(prepared.messages[0]?.content);
    expect(system).toContain('# Run Memory KnownState');
    expect(system).toContain('statement=suggestion; epistemic=unverified');
    expect(system).toContain('usefulness=2/1');
    expect(system).toContain('adoption never verifies it as fact');
    expect(ctx.memoryKnownState?.references[0]?.stages).toEqual(expect.arrayContaining(['execute', 'verify']));
    expect(ctx.contextSnapshots?.[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'memory_fragment', source: expect.objectContaining({ kind: 'memory' }) }),
    ]));
  });

  it('does not inject memory evidence into a call contract that forbids it', () => {
    const ctx = makeCtx();
    ingestMemoryKnownState(ctx, knownState(ctx.runId), 'execute');
    const raw: ChatRequest = {
      model: 'test',
      messages: [
        { role: 'system', content: 'classify policy' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 100,
    };
    const prepared = prepareModelRequest(
      ctx,
      'classify',
      raw,
      buildRunRequestCandidates(ctx, 'classify', raw.messages, { history: [] }),
    );
    expect(String(prepared.messages[0]?.content)).not.toContain('# Run Memory KnownState');
  });

  it('keeps injected memory evidence out of the stable cache prefix and serialized observation', () => {
    const raw: ChatRequest = {
      model: 'test',
      messages: [
        {
          role: 'system',
          content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=one',
        },
        { role: 'user', content: 'verify evidence' },
      ],
      max_tokens: 100,
    };

    const baselineCtx = makeCtx();
    prepareModelRequest(
      baselineCtx,
      'verify',
      raw,
      buildRunRequestCandidates(baselineCtx, 'verify', raw.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const baseline = baselineCtx.modelRequests?.[0]?.cacheObservation;

    const ctx = makeCtx();
    ingestMemoryKnownState(ctx, knownState(ctx.runId), 'execute');
    const prepared = prepareModelRequest(
      ctx,
      'verify',
      raw,
      buildRunRequestCandidates(ctx, 'verify', raw.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    );
    const observation = ctx.modelRequests?.[0]?.cacheObservation;

    expect(String(prepared.messages[0]?.content)).toContain('# Run Memory KnownState');
    expect(observation?.stablePrefix.fingerprint).toBe(baseline?.stablePrefix.fingerprint);
    expect(observation?.dynamicSuffix.fingerprint).not.toBe(baseline?.dynamicSuffix.fingerprint);
    expect(canonicalSerialize(observation)).not.toContain('atom-advice');
    expect(canonicalSerialize(observation)).not.toContain('# Run Memory KnownState');
  });
});

function knownState(runId: string): RuntimeMemoryKnownState {
  const at = '2026-07-15T13:00:00.000Z';
  return {
    version: 1,
    runId,
    revision: 1,
    updatedAt: at,
    references: [{
      atomId: 'atom-advice',
      atomRevision: 2,
      evidenceRefs: ['user:message-1'],
      decision: 'adopted',
      reason: 'Relevant advice was disclosed as advice.',
      envelope: {
        atomId: 'atom-advice',
        atomRevision: 2,
        branch: 'project',
        scope: 'project',
        scopeKey: 'D:/project',
        tier: 2,
        disclosureLevel: 'D2',
        statementKind: 'suggestion',
        epistemicStatus: 'unverified',
        authorityScope: { kind: 'user-self', scope: 'project', scopeKey: 'D:/project', topics: ['design'] },
        assertedBy: { kind: 'user', id: 'user' },
        evidenceRefs: ['user:message-1'],
        confidence: 0.7,
        importance: 0.8,
        verifiedUsefulness: { useful: 2, notUseful: 1, conflicts: 0, stale: 0 },
        updatedAt: at,
        retrievalPath: 'fts',
        matchReason: 'FTS matched the current project query.',
        conflict: false,
        expired: false,
        truncated: false,
      },
      stages: ['execute'],
      firstSeenAt: at,
      updatedAt: at,
      reactivatedCount: 0,
    }],
  };
}
