import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, type CompactionSummaryV2 } from '@littlesheep/types';
import type {
  CompactionCommitPrecondition,
  CompactionMemoryCandidateOutcome,
  CompactionMemoryProposal,
} from './compaction-store-codec.js';
import { SessionCompactionStore } from './compaction-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionCompactionStore', () => {
  it('retains candidate progress across reopen and closes only after every outcome is durable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-candidates');
    const item = summary({ id: 'summary-candidates' });
    const precondition: CompactionCommitPrecondition = {
      expectedPreviousSummaryId: null,
      sourceEndMessageId: item.sourceEndMessageId,
      sourceHash: item.sourceHash,
      policyVersion: 3,
      transactionKey: item.id,
    };
    const proposal: CompactionMemoryProposal = {
      version: 1,
      evidenceComplete: true,
      outcomes: [],
      candidates: ['a', 'b'].map((id) => ({
        id,
        branch: 'long-term' as const,
        parentNodeId: 'long-term:root',
        scope: 'global' as const,
        summary: `candidate-${id}`,
        content: `content-${id}`,
        retrievalKeys: [id],
        sourceMessageIds: ['message-1'],
        importance: 0.8,
        confidence: 0.8,
        reason: 'durable candidate test',
      })),
    };
    const store = new SessionCompactionStore(directory);
    await store.commit(sessionId, item, precondition, async () => undefined, proposal);

    const reopened = new SessionCompactionStore(directory);
    expect(await reopened.listPending(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: item.id },
      memoryProposal: { candidates: [{ id: 'a' }, { id: 'b' }], outcomes: [] },
    }]);
    await reopened.recordCandidateOutcome(sessionId, item.id, {
      candidateId: 'a', status: 'committed', nodeId: 'node-a', reason: 'created', updatedAt: new Date().toISOString(),
    });
    const pending = (await reopened.listPending(sessionId))[0];
    expect(pending?.version).toBe(2);
    expect(pending?.version === 2 ? pending.memoryProposal?.outcomes : undefined).toHaveLength(1);
    await reopened.recordCandidateOutcome(sessionId, item.id, {
      candidateId: 'b', status: 'rejected', reason: 'gate rejected', updatedAt: new Date().toISOString(),
    });
    expect(await reopened.listPending(sessionId)).toHaveLength(1);
    await reopened.completeMemoryProposal(sessionId, item.id);
    expect(await reopened.listPending(sessionId)).toEqual([]);
  });

  // C10A: a crash after the summary commit but before candidate settlement must stay recoverable.
  it('re-applies a committed proposal on recovery and refuses to close before every outcome is durable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-recovery');
    const item = summary({ id: 'summary-recovery' });
    const store = new SessionCompactionStore(directory);
    await store.commit(sessionId, item, preconditionFor(item), async () => undefined, proposalFor(['a', 'b']));

    const reopened = new SessionCompactionStore(directory);
    const applied: string[] = [];
    expect(await reopened.recover(sessionId, async (transaction) => {
      applied.push(transaction.summary.id);
    })).toBe(1);
    expect(applied).toEqual([item.id]);
    await expect(reopened.load(sessionId, item.id)).resolves.toEqual(item);
    expect(await reopened.listPending(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: item.id },
      summaryCommittedAt: expect.any(String),
      memoryProposal: { outcomes: [] },
    }]);

    await expect(reopened.completeMemoryProposal(sessionId, item.id))
      .rejects.toThrow('still has pending candidates');
    await reopened.recordCandidateOutcome(sessionId, item.id, outcomeFor('a'));
    await reopened.recordCandidateOutcome(sessionId, item.id, outcomeFor('b'));
    await reopened.completeMemoryProposal(sessionId, item.id);
    expect(await reopened.listPending(sessionId)).toEqual([]);
  });

  // C10A: an old writer waking up after a newer summary became active must not commit or overwrite it.
  it('quarantines an older pending proposal once a newer summary is active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-late-writer');
    const store = new SessionCompactionStore(directory);
    const older = summary({ id: 'summary-older' });
    await store.commit(sessionId, older, preconditionFor(older), async () => undefined, proposalFor(['a']));

    let activeSummaryId: string | null = null;
    const newer = summary({ id: 'summary-newer' });
    await store.commit(sessionId, newer, preconditionFor(newer, older.id), async () => {
      activeSummaryId = newer.id;
    });

    const applied: string[] = [];
    const recovered = await new SessionCompactionStore(directory).recover(sessionId, async (transaction) => {
      if (transaction.version !== 2 || transaction.precondition.expectedPreviousSummaryId !== activeSummaryId) {
        const error = new Error('Compaction predecessor changed during late recovery.');
        error.name = 'StaleCompactionError';
        throw error;
      }
      applied.push(transaction.summary.id);
      activeSummaryId = transaction.summary.id;
    });

    expect(recovered).toBe(0);
    expect(applied).toEqual([]);
    expect(activeSummaryId).toBe(newer.id);
    expect(await store.listPending(sessionId)).toEqual([]);
    await expect(failedFiles(directory, sessionId)).resolves.toHaveLength(1);
  });

  // C10A: a conflicting projection is a terminal conflict; it is isolated instead of overwriting the durable record.
  it('isolates a conflicting projection instead of overwriting the committed summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-conflict');
    const item = summary({ id: 'summary-conflict' });
    const store = new SessionCompactionStore(directory);
    await store.commit(sessionId, item, preconditionFor(item), async () => undefined);

    await expect(store.commit(
      sessionId,
      summary({ id: 'summary-conflict', summary: 'Different summary body.' }),
      preconditionFor(item),
      async () => undefined,
    )).rejects.toThrow('conflicts with existing record');

    await expect(store.load(sessionId, item.id)).resolves.toEqual(item);
    expect(await store.listPending(sessionId)).toEqual([]);
    await expect(failedFiles(directory, sessionId)).resolves.toHaveLength(1);
  });

  it('accepts bounded source run provenance and remains compatible when it is absent', async () => {
    const store = await createStore();
    const sessionId = asSessionId('session-valid');
    const withProvenance = summary({
      id: 'summary-with-provenance',
      sourceRunIds: ['run-1', 'run-2'],
      sourceRunIdsTruncated: false,
    });
    const legacyCompatible = summary({ id: 'summary-without-provenance' });

    await store.commit(sessionId, withProvenance, async () => undefined);
    await store.commit(sessionId, legacyCompatible, async () => undefined);

    await expect(store.load(sessionId, withProvenance.id)).resolves.toEqual(withProvenance);
    await expect(store.load(sessionId, legacyCompatible.id)).resolves.toEqual(legacyCompatible);
  });

  it('rejects malformed optional source run provenance when loading a projection', async () => {
    const store = await createStore();
    const sessionId = asSessionId('session-invalid');
    const invalidRuns = summary({
      id: 'summary-invalid-runs',
      sourceRunIds: [123] as unknown as string[],
    });
    const invalidTruncation = summary({
      id: 'summary-invalid-truncation',
      sourceRunIdsTruncated: 'yes' as unknown as boolean,
    });

    await store.commit(sessionId, invalidRuns, async () => undefined);
    await store.commit(sessionId, invalidTruncation, async () => undefined);

    await expect(store.load(sessionId, invalidRuns.id)).resolves.toBeUndefined();
    await expect(store.load(sessionId, invalidTruncation.id)).resolves.toBeUndefined();
  });
});

async function createStore(): Promise<SessionCompactionStore> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
  tempDirs.push(directory);
  return new SessionCompactionStore(directory);
}

function summary(overrides: Partial<CompactionSummaryV2> = {}): CompactionSummaryV2 {
  return {
    version: 2,
    id: 'summary-1',
    collapsedCount: 1,
    summary: 'Bounded session summary.',
    compactedAt: '2026-07-17T12:00:00.000Z',
    sourceStartMessageId: 'message-1',
    sourceEndMessageId: 'message-1',
    sourceStartAt: '2026-07-17T11:59:00.000Z',
    sourceEndAt: '2026-07-17T11:59:00.000Z',
    cache: {
      version: 1,
      namespace: 'session-summary',
      dataClass: 'semantic',
      compressionDepth: 1,
      disclosureLevel: 'D1',
      vectorClass: 'semantic-cache',
      sourceRefs: ['session:session-valid:messages:message-1..message-1'],
      contentHash: 'a'.repeat(64),
      createdAt: '2026-07-17T12:00:00.000Z',
    },
    sourceRanges: [{
      messageCount: 1,
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-1',
      sourceStartAt: '2026-07-17T11:59:00.000Z',
      sourceEndAt: '2026-07-17T11:59:00.000Z',
      sourceHash: 'b'.repeat(64),
    }],
    sourceSummaryIds: [],
    mergedSummaryCount: 1,
    sourceHash: 'b'.repeat(64),
    lineageHash: 'c'.repeat(64),
    ...overrides,
  };
}

function preconditionFor(
  item: CompactionSummaryV2,
  expectedPreviousSummaryId: string | null = null,
): CompactionCommitPrecondition {
  return {
    expectedPreviousSummaryId,
    sourceEndMessageId: item.sourceEndMessageId,
    sourceHash: item.sourceHash,
    policyVersion: 3,
    transactionKey: `key:${item.id}`,
  };
}

function proposalFor(ids: string[]): CompactionMemoryProposal {
  return {
    version: 1,
    evidenceComplete: true,
    outcomes: [],
    candidates: ids.map((id) => ({
      id,
      branch: 'long-term' as const,
      parentNodeId: 'long-term:root',
      scope: 'global' as const,
      summary: `candidate-${id}`,
      content: `content-${id}`,
      retrievalKeys: [id],
      sourceMessageIds: ['message-1'],
      importance: 0.8,
      confidence: 0.8,
      reason: 'durable candidate test',
    })),
  };
}

function outcomeFor(candidateId: string): CompactionMemoryCandidateOutcome {
  return {
    candidateId,
    status: 'committed',
    nodeId: `node-${candidateId}`,
    reason: 'created',
    updatedAt: new Date().toISOString(),
  };
}

async function failedFiles(directory: string, sessionId: string): Promise<string[]> {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  const dir = join(directory, '.compactions', digest, 'failed');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith('.failed.json'));
}
