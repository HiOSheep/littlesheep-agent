import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteAuditRecord, type MemoryWriteIntent } from '../types.js';
import { MemoryV3RepositoryLedger } from './v3-ledger.js';

describe('MemoryV3RepositoryLedger', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-ledger-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists bounded audits and recovery records across restart', async () => {
    const ledger = new MemoryV3RepositoryLedger({ dataDir, maxAuditRecords: 2 });
    await Promise.all([ledger.initialize(), ledger.initialize(), ledger.initialize()]);
    for (let index = 0; index < 3; index += 1) {
      await ledger.appendWriteAudit(writeAudit(index));
    }
    const queued = await ledger.enqueue(intent(), 'missing parent');

    const reopened = new MemoryV3RepositoryLedger({ dataDir, maxAuditRecords: 2 });
    await reopened.initialize();
    const snapshot = await reopened.snapshot();
    expect(snapshot.writeAudit.map((record) => record.id)).toEqual(['audit-1', 'audit-2']);
    expect(snapshot.recoveryQueue).toEqual([queued]);
    await reopened.removeRecovery(queued.id);
    expect((await reopened.snapshot()).recoveryQueue).toEqual([]);
  });

  it('keeps a stable storage scope while changing the public project path', async () => {
    const ledger = new MemoryV3RepositoryLedger({ dataDir });
    await ledger.initialize();
    expect(await ledger.storageScopeKey('project', 'D:/old')).toBe('D:/old');
    expect(await ledger.rebindScope('D:/old', 'D:/new')).toBe(1);
    expect(await ledger.storageScopeKey('project', 'D:/new')).toBe('D:/old');
    expect(ledger.publicScopeKey('project', 'D:/old')).toBe('D:/new');
  });

  it('persists resumable repository transactions until commit', async () => {
    const ledger = new MemoryV3RepositoryLedger({ dataDir });
    await ledger.initialize();
    const transaction = await ledger.captureTransaction('rebind:D:/old:D:/new', 'project-rebind', {
      fromPath: 'D:/old', toPath: 'D:/new',
    });
    await ledger.markTransactionStep(transaction.id, 'scope-alias');
    await ledger.markTransactionRecovery(transaction.id, 'interrupted');

    const reopened = new MemoryV3RepositoryLedger({ dataDir });
    await reopened.initialize();
    expect(await reopened.listOutstandingTransactions()).toEqual([
      expect.objectContaining({
        id: transaction.id,
        state: 'recovery',
        attempts: 1,
        completedSteps: ['scope-alias'],
      }),
    ]);
    await reopened.commitTransaction(transaction.id);
    expect(await reopened.listOutstandingTransactions()).toEqual([]);
  });
});

function writeAudit(index: number): MemoryWriteAuditRecord {
  return {
    id: `audit-${index}`,
    intentId: `intent-${index}`,
    sourceRunId: 'run',
    branch: 'long-term',
    at: `2026-07-15T09:00:0${index}.000Z`,
    decision: 'created',
    nodeId: `node-${index}`,
    reason: 'test',
  };
}

function intent(): MemoryWriteIntent {
  return {
    branch: 'long-term',
    parentNodeId: 'long-term:missing',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Queued memory',
    content: 'Queued memory content.',
    retrievalKeys: ['queued'],
    sourceRunId: 'run',
    sourceStage: 'capture',
    importance: 0.5,
    confidence: 0.5,
    reason: 'test',
  };
}
