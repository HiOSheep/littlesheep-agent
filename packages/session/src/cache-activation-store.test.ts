import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asSessionId,
  atomicActivationSignalsFromEvidence,
  computeAtomicActivation,
  type AtomicActivationEvidence,
  type CompactionSummaryV2,
} from '@littlesheep/types';
import { SessionCompactionStore } from './compaction-store.js';
import { SessionManager } from './manager.js';

const roots: string[] = [];
const SESSION_ID = asSessionId('session-activation');
const START = '2026-01-01T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session semantic-cache activation', () => {
  it('persists bounded useful feedback, survives restart, and decays lazily', async () => {
    const root = await createRoot();
    const store = new SessionCompactionStore(root);
    const summary = makeSummary('summary-one');
    await store.commit(SESSION_ID, summary, async () => undefined);
    for (let index = 0; index < 16; index += 1) {
      await store.recordActivation(SESSION_ID, summary.id, {
        id: `run-${index}`,
        outcome: 'useful',
        verified: index % 2 === 0,
        observedAt: new Date(Date.parse(START) + index * 60_000).toISOString(),
      });
    }

    expect(await store.activationOverview('2026-01-01T01:00:00.000Z')).toEqual({
      high: 1,
      medium: 0,
      low: 0,
    });
    const evidence = await store.loadActivation(SESSION_ID, summary.id);
    expect(evidence).toMatchObject({ useful: 16, verifiedUseful: 8 });
    expect(evidence?.recentEventIds).toHaveLength(16);
    const hysteresisAt = findActivationDate(evidence!, START, 0.61, 0.66);
    expect(await store.activationOverview(hysteresisAt)).toEqual({ high: 1, medium: 0, low: 0 });

    const restarted = new SessionCompactionStore(root);
    expect(await restarted.activationOverview(hysteresisAt)).toEqual({ high: 0, medium: 1, low: 0 });
    expect(await restarted.activationOverview('2027-01-01T01:00:00.000Z')).toEqual({
      high: 0,
      medium: 0,
      low: 1,
    });
  });

  it('deduplicates concurrent feedback and prunes superseded summary activation', async () => {
    const root = await createRoot();
    const store = new SessionCompactionStore(root);
    const first = makeSummary('summary-first');
    await store.commit(SESSION_ID, first, async () => undefined);
    await Promise.all(Array.from({ length: 12 }, () => store.recordActivation(SESSION_ID, first.id, {
      id: 'same-run',
      outcome: 'useful',
      verified: true,
      observedAt: START,
    })));
    expect(await store.loadActivation(SESSION_ID, first.id)).toMatchObject({
      useful: 1,
      verifiedUseful: 1,
      recentEventIds: ['same-run'],
    });

    const second = makeSummary('summary-second', first.id);
    await store.commit(SESSION_ID, second, async () => undefined);
    expect(await store.loadActivation(SESSION_ID, first.id)).toBeUndefined();
    expect(await store.activationOverview(START)).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it('removes compaction and activation sidecars when a session is deleted', async () => {
    const root = await createRoot();
    const manager = new SessionManager({ sessionsDir: root });
    const session = await manager.create();
    const summary = makeSummary('summary-delete');
    await manager.commitCompaction(session.id, summary);
    await manager.recordCompactionActivation(session.id, summary.id, {
      id: 'delete-run',
      outcome: 'useful',
      verified: true,
      observedAt: START,
    });

    await manager.delete(session.id);

    expect(await manager.loadCompactionProjection(session.id, summary.id)).toBeUndefined();
    expect(await manager.loadCompactionActivation(session.id, summary.id)).toBeUndefined();
    expect(await manager.semanticCacheActivationOverview(START)).toEqual({ high: 0, medium: 0, low: 0 });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-cache-activation-'));
  roots.push(root);
  return root;
}

function makeSummary(id: string, previousSummaryId?: string): CompactionSummaryV2 {
  return {
    version: 2,
    id,
    collapsedCount: 4,
    summary: `Summary ${id}`,
    compactedAt: START,
    sourceStartMessageId: 'message-1',
    sourceEndMessageId: 'message-4',
    sourceStartAt: START,
    sourceEndAt: START,
    previousSummaryId,
    cache: {
      version: 1,
      namespace: 'session-summary',
      dataClass: 'semantic',
      compressionDepth: previousSummaryId ? 2 : 1,
      disclosureLevel: 'D1',
      vectorClass: 'semantic-cache',
      sourceRefs: ['session:messages:1..4'],
      contentHash: 'a'.repeat(64),
      createdAt: START,
    },
    sourceRanges: [{
      messageCount: 4,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-4',
      sourceStartAt: START,
      sourceEndAt: START,
      sourceHash: 'b'.repeat(64),
    }],
    sourceSummaryIds: previousSummaryId ? [previousSummaryId] : [],
    mergedSummaryCount: previousSummaryId ? 2 : 1,
    sourceHash: 'b'.repeat(64),
    lineageHash: 'c'.repeat(64),
  };
}

function findActivationDate(
  evidence: AtomicActivationEvidence,
  createdAt: string,
  minimum: number,
  maximum: number,
): string {
  for (let day = 1; day <= 365; day += 1) {
    const at = new Date(Date.parse(createdAt) + day * 86_400_000).toISOString();
    const score = computeAtomicActivation(
      atomicActivationSignalsFromEvidence(evidence, createdAt),
      at,
    ).score;
    if (score >= minimum && score < maximum) return at;
  }
  throw new Error(`No activation date found between ${minimum} and ${maximum}.`);
}
