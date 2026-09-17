import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactionOperationStore } from './compaction-operation-store.js';
import type { SessionCompactionOperationRecord } from './session-compaction-scheduler.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(overrides: Partial<SessionCompactionOperationRecord> = {}): SessionCompactionOperationRecord {
  return {
    id: 'operation-1',
    sessionId: 'session-1',
    force: false,
    createdAt: '2026-09-16T00:00:00.000Z',
    settledAt: '2026-09-16T00:00:01.000Z',
    status: 'completed',
    result: 'compacted',
    coalescedRequests: 0,
    usage: { requestCount: 1, usageStatus: 'unavailable' },
    ...overrides,
  };
}

describe('CompactionOperationStore', () => {
  it('persists settled operations per session and survives a restart', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-compaction-ops-'));
    directories.push(rootDir);
    const store = new CompactionOperationStore(rootDir);
    await store.append(record());
    await store.append(record({ id: 'operation-2', sessionId: 'session-2', result: 'no-new-range' }));

    const reopened = new CompactionOperationStore(rootDir);
    await expect(reopened.list('session-1')).resolves.toMatchObject([{
      id: 'operation-1',
      result: 'compacted',
      usage: { requestCount: 1, usageStatus: 'unavailable' },
    }]);
    await expect(reopened.list('session-2')).resolves.toMatchObject([{ id: 'operation-2', result: 'no-new-range' }]);
    await expect(reopened.list('session-missing')).resolves.toEqual([]);
  });

  it('replaces a replayed operation id and keeps the history bounded', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-compaction-ops-'));
    directories.push(rootDir);
    const store = new CompactionOperationStore(rootDir);
    await store.append(record({ status: 'running', result: undefined }));
    await store.append(record({ status: 'completed', result: 'compacted', usage: { requestCount: 2, usageStatus: 'partial' } }));
    const records = await store.list('session-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'completed', usage: { requestCount: 2, usageStatus: 'partial' } });

    for (let index = 0; index < 60; index += 1) {
      await store.append(record({ id: `operation-${index}` }));
    }
    const bounded = await store.list('session-1');
    expect(bounded).toHaveLength(50);
    expect(bounded.at(-1)?.id).toBe('operation-59');
  });

  it('returns an empty history for an unreadable record file instead of throwing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-compaction-ops-'));
    directories.push(rootDir);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update('session-broken', 'utf8').digest('hex');
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, `${digest}.json`), '{not json', 'utf8');

    const store = new CompactionOperationStore(rootDir);
    await expect(store.list('session-broken')).resolves.toEqual([]);
  });
});
