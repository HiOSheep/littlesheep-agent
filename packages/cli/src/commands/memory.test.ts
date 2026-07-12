// @littlesheep/cli — commands/memory.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@littlesheep/memory-core';
import { SnapshotMemoryStore, SnapshotIndex } from '@littlesheep/snapshot';
import {
  parseMemoryRollbackFlags,
  runMemoryRollback,
} from './memory.js';

let dataRoot: string;
let backupsDir: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'rollback-'));
  backupsDir = join(dataRoot, 'backups');
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

/** Write via SnapshotMemoryStore + wait for the snapshot to land in the index. */
async function writeAndSnapshot(
  store: SnapshotMemoryStore,
  fn: 'writeLongTerm' | 'appendLongTerm',
  content: string,
): Promise<void> {
  await store[fn](content);
  // Fire-and-forget snapshot: poll until it lands.
  const start = Date.now();
  while (Date.now() - start < 1000) {
    const list = await store.snapshots.list();
    if (list.length > 0 && (await store.snapshots.getLatest()) !== null) {
      // verify the newest reflects this write (count increased)
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForCount(idx: SnapshotIndex, count: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 1000) {
    const list = await idx.list();
    if (list.length >= count) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${count} snapshots`);
}

describe('parseMemoryRollbackFlags', () => {
  it('parses --list', () => {
    expect(parseMemoryRollbackFlags(['--list'])).toEqual({ list: true });
  });

  it('parses --last', () => {
    expect(parseMemoryRollbackFlags(['--last'])).toEqual({ last: true });
  });

  it('parses --last-long-term', () => {
    expect(parseMemoryRollbackFlags(['--last-long-term'])).toEqual({ lastLongTerm: true });
  });

  it('parses --to <id> and --to=<id>', () => {
    expect(parseMemoryRollbackFlags(['--to', 'abc']).to).toBe('abc');
    expect(parseMemoryRollbackFlags(['--to=abc']).to).toBe('abc');
  });

  it('parses --last-daily <date> and --last-daily=<date>', () => {
    expect(parseMemoryRollbackFlags(['--last-daily', '2026-06-30']).lastDaily).toBe('2026-06-30');
    expect(parseMemoryRollbackFlags(['--last-daily=2026-06-30']).lastDaily).toBe('2026-06-30');
  });

  it('parses --yes and -y', () => {
    expect(parseMemoryRollbackFlags(['--yes']).yes).toBe(true);
    expect(parseMemoryRollbackFlags(['-y']).yes).toBe(true);
  });

  it('ignores unknown flags', () => {
    expect(parseMemoryRollbackFlags(['--bogus'])).toEqual({});
  });
});

describe('runMemoryRollback', () => {
  /** Pre-populate: write V1, -V2, -V3 to MEMORY.md via SnapshotMemoryStore. */
  async function seedThreeVersions(
    store: SnapshotMemoryStore,
  ): Promise<void> {
    await writeAndSnapshot(store, 'writeLongTerm', 'V1');
    await waitForCount(store.snapshots, 1);
    await writeAndSnapshot(store, 'appendLongTerm', '-V2');
    await waitForCount(store.snapshots, 2);
    await writeAndSnapshot(store, 'appendLongTerm', '-V3');
    await waitForCount(store.snapshots, 3);
  }

  it('--list prints all snapshots newest-first', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);

    const lines: string[] = [];
    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { list: true },
      out: (m) => lines.push(m),
    });
    const out = lines.join('');
    expect(out).toContain('Snapshots (newest first)');
    expect(out).toContain('long-term');
    expect(out).toContain('(3 total)');
  });

  it('--list with no snapshots reports none', async () => {
    const lines: string[] = [];
    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { list: true },
      out: (m) => lines.push(m),
    });
    expect(lines.join('')).toContain('No snapshots found');
  });

  it('--last restores the most recent write (long-term)', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);
    // MEMORY.md: writeLongTerm('V1') + appendLongTerm('-V2') + appendLongTerm('-V3').
    // appendLongTerm writes text+'\n', so content = "V1-V2\n-V3\n".
    expect(await base.readLongTerm()).toBe('V1-V2\n-V3\n');

    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { last: true, yes: true },
    });
    // --last restores before of #3 = "V1-V2\n"
    expect(await base.readLongTerm()).toBe('V1-V2\n');
  });

  it('--last-long-term restores only the long-term latest', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);

    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { lastLongTerm: true, yes: true },
    });
    // before of #3 = "V1-V2\n" (appendLongTerm added trailing \n)
    expect(await base.readLongTerm()).toBe('V1-V2\n');
  });

  it('--last-daily <date> restores a daily file', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    // write daily twice. appendDaily prepends "- " + text + "\n".
    // writeDaily('D1') → "D1"; appendDaily('-D2') → "D1" + "- -D2\n" = "D1- -D2\n".
    await store.writeDaily('2026-06-30', 'D1');
    await waitForCount(store.snapshots, 1);
    await store.appendDaily('2026-06-30', '-D2');
    await waitForCount(store.snapshots, 2);
    expect(await base.readDaily('2026-06-30')).toBe('D1- -D2\n');

    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { lastDaily: '2026-06-30', yes: true },
    });
    // before of the append was "D1"
    expect(await base.readDaily('2026-06-30')).toBe('D1');
  });

  it('--to <id> restores a specific snapshot', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);
    // Grab the second-newest (before="V1")
    const newest = await store.snapshots.listNewestFirst();
    const target = newest[1]; // #2: before="V1"
    expect(target).toBeDefined();

    await runMemoryRollback({
      dataRoot,
      backupsDir,
      flags: { to: target!.id, yes: true },
    });
    expect(await base.readLongTerm()).toBe('V1');
  });

  it('rollback is reversible (undo via another --last)', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);
    const original = await base.readLongTerm(); // "V1-V2\n-V3\n"

    // Roll back once → before of #3 = "V1-V2\n"
    await runMemoryRollback({
      dataRoot, backupsDir, flags: { last: true, yes: true },
    });
    expect(await base.readLongTerm()).toBe('V1-V2\n');
    // wait for the rollback's own snapshot to land
    await waitForCount(store.snapshots, 4);

    // Roll back again → restores before of the rollback = original seed
    await runMemoryRollback({
      dataRoot, backupsDir, flags: { last: true, yes: true },
    });
    expect(await base.readLongTerm()).toBe(original);
  });

  it('no flags prints usage + sets exitCode 2', async () => {
    const errLines: string[] = [];
    const before = process.exitCode;
    await runMemoryRollback({
      dataRoot, backupsDir, flags: {},
      err: (m) => errLines.push(m),
    });
    expect(errLines.join('')).toContain('Usage:');
    expect(process.exitCode).toBe(2);
    process.exitCode = before;
  });

  it('--to with bad id reports no match + exitCode 1', async () => {
    const errLines: string[] = [];
    const before = process.exitCode;
    await runMemoryRollback({
      dataRoot, backupsDir, flags: { to: 'nonexistent', yes: true },
      err: (m) => errLines.push(m),
    });
    expect(errLines.join('')).toContain('No matching snapshot');
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });

  it('confirm=false aborts the rollback', async () => {
    const base = new MemoryStore({ rootDir: dataRoot });
    const store = new SnapshotMemoryStore(base, { snapshotDir: backupsDir });
    await seedThreeVersions(store);

    const outLines: string[] = [];
    await runMemoryRollback({
      dataRoot, backupsDir,
      flags: { last: true },
      confirm: async () => false,
      out: (m) => outLines.push(m),
    });
    expect(outLines.join('')).toContain('Aborted');
    // file unchanged: seed content = "V1-V2\n-V3\n"
    expect(await base.readLongTerm()).toBe('V1-V2\n-V3\n');
  });
});
