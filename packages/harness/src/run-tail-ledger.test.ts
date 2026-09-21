// The append-only tail ledger: a fact is written once, and a change is a new
// appended entry rather than a rewrite of an earlier one. A→B→A must therefore
// produce two distinct entries; a text-dedup ledger would drop the second one
// and leave the model reading the stale state.
import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import type { RunContext } from '@littlesheep/types';
import { RunTailLedger, renderTailEntries } from './run-tail-ledger.js';
import { makeCtx } from './tests/helpers.js';

function withKnownStateRevision(ctx: RunContext, revision: number): RunContext {
  ctx.memoryKnownState = {
    version: 1,
    runId: ctx.runId,
    revision,
    updatedAt: `2026-09-21T00:00:0${revision}.000Z`,
    references: [{
      atomId: 'atom-1',
      atomRevision: 1,
      decision: 'adopted',
      reason: 'revision probe',
      stages: ['execute'],
      firstSeenAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      reactivatedCount: 0,
      envelope: {
        atomId: 'atom-1',
        atomRevision: 1,
        branch: 'projects',
        scope: 'project',
        tier: 2,
        disclosureLevel: 'D2',
        statementKind: 'fact',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'project', scope: 'project', topics: [] },
        assertedBy: { kind: 'user' },
        evidenceRefs: [],
        sourceRefs: [],
        confidence: 0.9,
        importance: 0.5,
        updatedAt: '2026-09-21T00:00:00.000Z',
        retrievalPath: 'hierarchy',
        matchReason: 'probe',
        conflict: false,
        expired: false,
        truncated: false,
      },
    }],
  };
  return ctx;
}

describe('RunTailLedger', () => {
  it('sends the runtime facts once and then adds nothing for an unchanged run', () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const ledger = new RunTailLedger();

    const first = ledger.update(ctx);
    const second = ledger.update(ctx);

    expect(first.messages).toHaveLength(1);
    expect(String(first.messages[0]?.content)).toContain('# Runtime Facts');
    expect(second.messages).toEqual([]);
  });

  it('appends a changed KnownState instead of rewriting the earlier entry', () => {
    const ctx = withKnownStateRevision(makeCtx({ inbound: textMessage('user', 'hello') }), 1);
    const ledger = new RunTailLedger();

    const first = ledger.update(ctx);
    withKnownStateRevision(ctx, 2);
    const second = ledger.update(ctx);
    // Same revision, same bytes: nothing is re-sent.
    const third = ledger.update(ctx);

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(1);
    expect(String(second.messages[0]?.content)).toContain('revision: 2');
    expect(third.messages).toEqual([]);
    expect(first.messages.map((message) => String(message.content)).join('\n'))
      .toContain('revision: 1');
  });

  it('records each memory transition as a new appended entry', () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const ledger = new RunTailLedger();
    // One call activated both atoms, so releasing either one is a real change.
    const setAtoms = (active: string[]) => {
      ctx.memoryContextWorkingSet = {
        revision: active.length,
        activeAtomIds: active,
        releasedAtomIds: [],
        activeCallByAtom: Object.fromEntries(active.map((atomId) => [atomId, 'call-1'])),
        callAtomIds: { 'call-1': ['atom-a', 'atom-b'] },
        updatedAt: '2026-09-21T00:00:00.000Z',
      };
    };

    const start = ledger.update(ctx);
    setAtoms(['atom-a']);
    const afterA = ledger.update(ctx);
    setAtoms(['atom-b']);
    const afterB = ledger.update(ctx);
    setAtoms(['atom-b']);
    const unchanged = ledger.update(ctx);

    // The first projection carries both atoms as released, then each change
    // appends its own note: atom-b released, then atom-a released. The earlier
    // messages are never rewritten, so every request stays a prefix of the next
    // one even when the active atom returns to a value it had before.
    expect(start.messages.map((message) => String(message.content)).join('\n'))
      .not.toContain('Released Memory');
    expect(String(afterA.messages[0]?.content)).toContain('released_atoms: atom-b');
    expect(String(afterB.messages[0]?.content)).toContain('released_atoms: atom-a');
    expect(unchanged.messages).toEqual([]);
  });

  it('includes the prompt sections the tail owns and skips the stable ones', () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const segments = [
      {
        id: 'identity',
        order: 0,
        text: 'identity',
        kind: 'system_prompt' as const,
        source: { kind: 'prompt' as const, id: 'identity' },
        priority: 100,
        required: true,
        sensitive: true,
        scope: 'global' as const,
      },
      {
        id: 'retrieval-intent-contract',
        order: 1,
        text: 'Runtime retrieval intent: none.',
        kind: 'workflow_state' as const,
        source: { kind: 'workflow' as const, id: 'retrieval-intent-contract' },
        priority: 95,
        required: true,
        sensitive: true,
        scope: 'run' as const,
        placement: 'trailing' as const,
      },
    ];

    const ids = renderTailEntries(ctx, segments).map((entry) => entry.id);

    expect(ids).toContain('runtime-facts');
    expect(ids).toContain('retrieval-intent-contract');
    expect(ids).not.toContain('identity');
  });
});
