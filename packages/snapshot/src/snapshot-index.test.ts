// @littlesheep/snapshot — snapshot-index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SnapshotIndex,
  windowsSafeId,
  DEFAULT_MAX_SNAPSHOTS,
  type SnapshotEntry,
} from './snapshot-index.js';

let dir: string;
let index: SnapshotIndex;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snap-idx-'));
  index = new SnapshotIndex({ snapshotDir: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    id: overrides.id ?? 'test-id',
    tier: overrides.tier ?? 'long-term',
    date: overrides.date,
    operation: overrides.operation ?? 'write',
    beforeFile: overrides.beforeFile ?? 'long-term/test-id.md',
    ts: overrides.ts ?? '2026-06-30T10:00:00.000Z',
  };
}

describe('SnapshotIndex', () => {
  it('windowsSafeId replaces : and . with -', () => {
    expect(windowsSafeId('2026-06-30T10:00:00.000Z')).toBe('2026-06-30T10-00-00-000Z');
  });

  it('DEFAULT_MAX_SNAPSHOTS is 50', () => {
    expect(DEFAULT_MAX_SNAPSHOTS).toBe(50);
  });

  it('list returns [] when index missing', async () => {
    expect(await index.list()).toEqual([]);
  });

  it('add + list round-trip', async () => {
    await index.add(makeEntry({ id: 'a' }));
    const list = await index.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('a');
  });

  it('listNewestFirst sorts newest-first by ts', async () => {
    await index.add(makeEntry({ id: 'old', ts: '2026-06-01T00:00:00.000Z' }));
    await index.add(makeEntry({ id: 'new', ts: '2026-06-30T00:00:00.000Z' }));
    const sorted = await index.listNewestFirst();
    expect(sorted[0]?.id).toBe('new');
    expect(sorted[1]?.id).toBe('old');
  });

  it('getLatest returns newest, filtered by tier/date', async () => {
    await index.add(makeEntry({ id: 'lt1', tier: 'long-term', ts: '2026-06-01T00:00:00.000Z' }));
    await index.add(makeEntry({ id: 'lt2', tier: 'long-term', ts: '2026-06-30T00:00:00.000Z' }));
    await index.add(makeEntry({ id: 'd1', tier: 'daily', date: '2026-06-15', ts: '2026-06-15T00:00:00.000Z' }));
    expect((await index.getLatest())?.id).toBe('lt2');
    expect((await index.getLatest('daily'))?.id).toBe('d1');
    expect((await index.getLatest('daily', '2026-06-15'))?.id).toBe('d1');
    expect(await index.getLatest('daily', '1999-01-01')).toBeNull();
  });

  it('get by id returns entry or null', async () => {
    await index.add(makeEntry({ id: 'findme' }));
    expect((await index.get('findme'))?.id).toBe('findme');
    expect(await index.get('nope')).toBeNull();
  });

  it('maxSnapshots prunes oldest + deletes its content file', async () => {
    const small = new SnapshotIndex({ snapshotDir: dir, maxSnapshots: 2 });
    mkdirSync(join(dir, 'long-term'), { recursive: true });
    const e1 = makeEntry({ id: 'e1', ts: '2026-06-01T00:00:00.000Z', beforeFile: 'long-term/e1.md' });
    const e2 = makeEntry({ id: 'e2', ts: '2026-06-02T00:00:00.000Z', beforeFile: 'long-term/e2.md' });
    const e3 = makeEntry({ id: 'e3', ts: '2026-06-03T00:00:00.000Z', beforeFile: 'long-term/e3.md' });
    writeFileSync(join(dir, 'long-term/e1.md'), 'before-e1');
    writeFileSync(join(dir, 'long-term/e2.md'), 'before-e2');
    writeFileSync(join(dir, 'long-term/e3.md'), 'before-e3');
    await small.add(e1);
    await small.add(e2);
    await small.add(e3); // prunes e1 (oldest)
    const list = await small.list();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.id === 'e1')).toBeUndefined();
    expect(list.find((e) => e.id === 'e3')).toBeDefined();
    // e1's content file deleted; e2/e3 remain
    expect(existsSync(join(dir, 'long-term/e1.md'))).toBe(false);
    expect(existsSync(join(dir, 'long-term/e2.md'))).toBe(true);
  });

  it('readContent returns the content file', async () => {
    mkdirSync(join(dir, 'long-term'), { recursive: true });
    writeFileSync(join(dir, 'long-term/test-id.md'), 'the before content');
    await index.add(makeEntry());
    const entry = await index.get('test-id');
    expect(entry).not.toBeNull();
    if (entry) {
      expect(await index.readContent(entry)).toBe('the before content');
    }
  });

  it('readContent throws if file missing', async () => {
    await index.add(makeEntry());
    const entry = await index.get('test-id');
    expect(entry).not.toBeNull();
    if (entry) {
      await expect(index.readContent(entry)).rejects.toThrow(/content file missing/);
    }
  });

  it('corrupt index returns []', async () => {
    writeFileSync(join(dir, 'index.json'), 'not json{');
    expect(await index.list()).toEqual([]);
  });

  it('directory getter returns snapshotDir', () => {
    expect(index.directory).toBe(dir);
  });
});
