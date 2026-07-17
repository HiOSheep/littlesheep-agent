import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, type CompactionSummaryV2 } from '@littlesheep/types';
import { SessionCompactionStore } from './compaction-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SessionCompactionStore', () => {
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
