import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, type CompactionSummaryV2 } from '@littlesheep/types';
import type {
  CompactionCommitPrecondition,
  CompactionMemoryProposal,
} from './compaction-store-codec.js';
import { SessionCompactionStore } from './compaction-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionCompactionStore', () => {
  it('writes current compaction transactions without a legacy proposal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-summary-only');
    const item = summary({ id: 'summary-only' });
    const store = new SessionCompactionStore(directory);
    await store.commit(sessionId, item, preconditionFor(item), async () => undefined);

    expect(await store.listPending(sessionId)).toEqual([]);
    await expect(store.load(sessionId, item.id)).resolves.toEqual(item);
  });

  it('decodes and terminates an old proposal while preserving its audit across replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-candidates');
    const item = summary({ id: 'summary-candidates' });
    const store = new SessionCompactionStore(directory);
    await seedLegacyProposal(store, directory, sessionId, item, legacyProposalFor(['a', 'b']));

    const reopened = new SessionCompactionStore(directory);
    expect(await reopened.listPending(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: item.id },
      memoryProposal: { candidates: [{ id: 'a' }, { id: 'b' }], outcomes: [] },
    }]);
    await reopened.terminateMemoryProposal(sessionId, item.id, 'retired by the running build');
    const terminated = (await reopened.listPending(sessionId))[0];
    expect(terminated?.version).toBe(2);
    const proposal = terminated?.version === 2 ? terminated.memoryProposal : undefined;
    expect(proposal?.terminatedAt).toBeTruthy();
    expect(proposal?.terminationReason).toBe('retired by the running build');
    expect(proposal?.outcomes).toHaveLength(2);
    expect(proposal?.outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);

    const terminatedAt = proposal?.terminatedAt;
    await new SessionCompactionStore(directory)
      .terminateMemoryProposal(sessionId, item.id, 'different replay reason');
    const replayed = (await reopened.listPending(sessionId))[0];
    expect(replayed?.version === 2 ? replayed.memoryProposal?.terminatedAt : undefined).toBe(terminatedAt);
    expect(replayed?.version === 2 ? replayed.memoryProposal?.terminationReason : undefined)
      .toBe('retired by the running build');
  });

  // RS-08: a transaction that was already committed before this process started must stay open. It used
  // to be re-applied on recovery, which threw and quarantined a committed summary — and with it the
  // memory proposal the runner's compatibility path was supposed to terminate.
  it('leaves an already-committed pending transaction open across recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-committed-pending');
    const item = summary({ id: 'summary-committed-pending' });
    const store = new SessionCompactionStore(directory);
    await seedLegacyProposal(store, directory, sessionId, item, legacyProposalFor(['a', 'b']));

    const reopened = new SessionCompactionStore(directory);
    expect(await reopened.recover(sessionId, async () => undefined)).toBe(1);
    expect(await reopened.listPending(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: item.id },
      summaryCommittedAt: expect.any(String),
      memoryProposal: { outcomes: [] },
    }]);
    const digest = createHash('sha256').update(String(sessionId), 'utf8').digest('hex');
    expect(await readdir(join(directory, '.compactions', digest, 'failed')).catch(() => [])).toEqual([]);
  });

  // A historical proposal with a stale predecessor stays reachable for the Runner retirement sweep.
  it('keeps an older pending proposal reachable once a newer summary is active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-late-writer');
    const store = new SessionCompactionStore(directory);
    const older = summary({ id: 'summary-older' });
    await seedLegacyProposal(store, directory, sessionId, older, legacyProposalFor(['a']));

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
    // The older transaction is not applied and does not overwrite the active summary — that is C10A.
    // It is also not quarantined any more: it still carries an un-settled memory proposal, and moving it
    // to `failed/` would put it out of reach of the runner's retirement sweep, which is the thing that
    // records why nothing was written (RS-08, measured on a real data root).
    expect(await store.listPending(sessionId)).toMatchObject([{
      version: 2,
      summary: { id: older.id },
      memoryProposal: { outcomes: [] },
    }]);
    await expect(failedFiles(directory, sessionId)).resolves.toHaveLength(0);
  });

  // A terminated historical proposal has no remaining audit work and can be isolated after conflict.
  it('quarantines a stale committed transaction after legacy proposal termination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-compaction-store-'));
    tempDirs.push(directory);
    const sessionId = asSessionId('session-late-writer-no-proposal');
    const store = new SessionCompactionStore(directory);
    const older = summary({ id: 'summary-older-clean' });
    await seedLegacyProposal(store, directory, sessionId, older, legacyProposalFor(['a']));
    // Settled: the proposal carries its termination stamp, so there is nothing left for anyone to
    // terminate and the stale transaction can be isolated as before.
    await store.terminateMemoryProposal(sessionId, older.id, 'retired by the running build');
    const newer = summary({ id: 'summary-newer-clean' });
    await store.commit(sessionId, newer, preconditionFor(newer, older.id), async () => undefined);

    const recovered = await new SessionCompactionStore(directory).recover(sessionId, async (transaction) => {
      if (transaction.version !== 2 || transaction.precondition.expectedPreviousSummaryId !== newer.id) {
        const error = new Error('Compaction predecessor changed during late recovery.');
        error.name = 'StaleCompactionError';
        throw error;
      }
    });
    expect(recovered).toBe(0);
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

async function seedLegacyProposal(
  store: SessionCompactionStore,
  directory: string,
  sessionId: ReturnType<typeof asSessionId>,
  item: CompactionSummaryV2,
  memoryProposal: CompactionMemoryProposal,
): Promise<void> {
  const precondition = preconditionFor(item, item.previousSummaryId ?? null);
  await store.commit(sessionId, item, precondition, async () => undefined);
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const pendingDir = join(directory, '.compactions', digest(String(sessionId)), 'pending');
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, `${digest(item.id)}.pending.json`), JSON.stringify({
    version: 2,
    sessionId: String(sessionId),
    summary: item,
    precondition,
    memoryProposal,
    summaryCommittedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function legacyProposalFor(ids: string[]): CompactionMemoryProposal {
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

async function failedFiles(directory: string, sessionId: string): Promise<string[]> {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  const dir = join(directory, '.compactions', digest, 'failed');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith('.failed.json'));
}
