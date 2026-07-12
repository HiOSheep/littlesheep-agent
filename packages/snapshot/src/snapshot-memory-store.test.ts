// @littlesheep/snapshot — snapshot-memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStoreLike } from '@littlesheep/types';
import { SnapshotMemoryStore } from './snapshot-memory-store.js';
import { SnapshotIndex, type SnapshotEntry } from './snapshot-index.js';

/** In-memory MemoryStoreLike mock with inspectable state. */
class MockStore implements MemoryStoreLike {
  readonly longTermPath = '/mock/MEMORY.md';
  readonly dailyDirPath = '/mock/memory';
  longTerm = 'ORIGINAL-LT';
  daily = new Map<string, string>();
  calls = { writeLongTerm: 0, appendLongTerm: 0, writeDaily: 0, appendDaily: 0 };
  readLongTerm(): Promise<string> { return Promise.resolve(this.longTerm); }
  writeLongTerm(c: string): Promise<void> { this.calls.writeLongTerm++; this.longTerm = c; return Promise.resolve(); }
  appendLongTerm(t: string): Promise<void> { this.calls.appendLongTerm++; this.longTerm += t; return Promise.resolve(); }
  dailyFile(d: string): string { return `/mock/memory/${d}.md`; }
  readDaily(d: string): Promise<string> { return Promise.resolve(this.daily.get(d) ?? ''); }
  appendDaily(d: string, t: string): Promise<void> {
    this.calls.appendDaily++;
    this.daily.set(d, (this.daily.get(d) ?? '') + t);
    return Promise.resolve();
  }
  writeDaily(d: string, c: string): Promise<void> { this.calls.writeDaily++; this.daily.set(d, c); return Promise.resolve(); }
  listDailyDates(): Promise<string[]> { return Promise.resolve([...this.daily.keys()]); }
  today(): string { return '2026-06-30'; }
}

/** A SnapshotIndex whose add() always rejects for failure isolation tests. */
class FailingIndex extends SnapshotIndex {
  override async add(_entry: SnapshotEntry): Promise<void> {
    throw new Error('index boom');
  }
}

let dir: string;
let snapshotDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snap-store-'));
  snapshotDir = join(dir, 'backups');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Poll until the index has at least `count` entries (fire-and-forget timing). */
async function waitForSnapshots(idx: SnapshotIndex, count: number, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await idx.list();
    if (list.length >= count) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${count} snapshots`);
}

describe('SnapshotMemoryStore', () => {
  it('writeLongTerm captures before-content + forwards write', async () => {
    const mock = new MockStore();
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    await store.writeLongTerm('NEW-LT');
    expect(mock.longTerm).toBe('NEW-LT');
    expect(mock.calls.writeLongTerm).toBe(1);
    await waitForSnapshots(store.snapshots, 1);
    const latest = await store.snapshots.getLatest('long-term');
    expect(latest).not.toBeNull();
    expect(latest?.operation).toBe('write');
    expect(latest?.tier).toBe('long-term');
    if (latest) {
      expect(await store.snapshots.readContent(latest)).toBe('ORIGINAL-LT');
    }
  });

  it('appendLongTerm captures before + forwards append', async () => {
    const mock = new MockStore();
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    await store.appendLongTerm('-appended');
    expect(mock.longTerm).toBe('ORIGINAL-LT-appended');
    expect(mock.calls.appendLongTerm).toBe(1);
    await waitForSnapshots(store.snapshots, 1);
    const latest = await store.snapshots.getLatest('long-term');
    expect(latest?.operation).toBe('append');
    if (latest) {
      expect(await store.snapshots.readContent(latest)).toBe('ORIGINAL-LT');
    }
  });

  it('writeDaily/appendDaily capture before with date', async () => {
    const mock = new MockStore();
    mock.daily.set('2026-06-30', 'ORIGINAL-DAILY');
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    await store.writeDaily('2026-06-30', 'NEW-DAILY');
    await waitForSnapshots(store.snapshots, 1);
    let latest = await store.snapshots.getLatest('daily', '2026-06-30');
    expect(latest?.tier).toBe('daily');
    expect(latest?.date).toBe('2026-06-30');
    expect(latest?.operation).toBe('write');
    if (latest) {
      expect(await store.snapshots.readContent(latest)).toBe('ORIGINAL-DAILY');
    }
    // append → before is now 'NEW-DAILY'
    await store.appendDaily('2026-06-30', '-more');
    await waitForSnapshots(store.snapshots, 2);
    latest = await store.snapshots.getLatest('daily', '2026-06-30');
    expect(latest?.operation).toBe('append');
    if (latest) {
      expect(await store.snapshots.readContent(latest)).toBe('NEW-DAILY');
    }
  });

  it('readers pass-through to inner', async () => {
    const mock = new MockStore();
    mock.daily.set('2026-06-29', 'daily-content');
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    expect(await store.readLongTerm()).toBe('ORIGINAL-LT');
    expect(await store.readDaily('2026-06-29')).toBe('daily-content');
    expect(await store.listDailyDates()).toEqual(['2026-06-29']);
    expect(store.dailyFile('2026-06-29')).toBe('/mock/memory/2026-06-29.md');
    expect(store.today()).toBe('2026-06-30');
    expect(store.longTermPath).toBe('/mock/MEMORY.md');
    expect(store.dailyDirPath).toBe('/mock/memory');
  });

  it('snapshot persist failure does not block write', async () => {
    const mock = new MockStore();
    const badIndex = new FailingIndex({ snapshotDir });
    const store = new SnapshotMemoryStore(mock, { snapshotDir, index: badIndex });
    // write must succeed despite snapshot persist throwing
    await store.writeLongTerm('STILL-WRITTEN');
    expect(mock.longTerm).toBe('STILL-WRITTEN');
    expect(mock.calls.writeLongTerm).toBe(1);
  });

  it('first write (empty prior file) captures empty before', async () => {
    const mock = new MockStore();
    mock.longTerm = ''; // simulate missing/empty file
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    await store.writeLongTerm('FIRST');
    await waitForSnapshots(store.snapshots, 1);
    const latest = await store.snapshots.getLatest('long-term');
    if (latest) {
      expect(await store.snapshots.readContent(latest)).toBe('');
    }
  });

  it('snapshots getter exposes the index', () => {
    const mock = new MockStore();
    const store = new SnapshotMemoryStore(mock, { snapshotDir });
    expect(store.snapshots).toBeInstanceOf(SnapshotIndex);
    expect(store.snapshots.directory).toBe(snapshotDir);
  });
});
