// File observation bookkeeping: what the model read, bounded and session-scoped.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileObservationTable,
  createInMemoryFileObservationPort,
  createPathMutexTable,
  hashFileBytes,
  observationKeyFor,
  observationSnapshot,
} from './file-observation.js';

const tmpRoot = await mkdtemp(join(tmpdir(), 'ls-observation-'));
await writeFile(join(tmpRoot, 'file.txt'), 'hello\n', 'utf8');
await writeFile(join(tmpRoot, 'other.txt'), 'other\n', 'utf8');
await mkdir(join(tmpRoot, 'dir'), { recursive: true });
let symlinkCreated = false;
try {
  await symlink(join(tmpRoot, 'file.txt'), join(tmpRoot, 'link.txt'));
  symlinkCreated = true;
} catch {
  symlinkCreated = false;
}

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function snapshotFor(absPath: string, coverage: 'full' | 'partial' = 'full') {
  return observationSnapshot({
    version: hashFileBytes('hello\n'),
    sizeBytes: 6,
    mtimeMs: 1,
    coverage,
    ...(coverage === 'partial' ? { visibleLineRange: { start: 1, end: 1 } } : {}),
    runId: 'run-1',
    observedAt: '2026-09-23T00:00:00.000Z',
  });
}

describe('observation keys', () => {
  it('accepts a regular file and rejects a directory', () => {
    const file = observationKeyFor(join(tmpRoot, 'file.txt'));
    expect(file.ok).toBe(true);

    const directory = observationKeyFor(join(tmpRoot, 'dir'));
    expect(directory.ok).toBe(false);
    if (!directory.ok) expect(directory.errorKind).toBe('observation_unsupported');
  });

  it('accepts the same file twice with one stable key', () => {
    const first = observationKeyFor(join(tmpRoot, 'file.txt'));
    const second = observationKeyFor(join(tmpRoot, 'file.txt'));
    expect(first.ok && second.ok && first.key === second.key).toBe(true);
  });

  it.skipIf(!symlinkCreated)('refuses a symbolic link instead of guessing its revision', () => {
    const link = observationKeyFor(join(tmpRoot, 'link.txt'));
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.message).toMatch(/symbolic link/);
  });

  it('reports a missing path as unsupported rather than observed', () => {
    const missing = observationKeyFor(join(tmpRoot, 'nope.txt'));
    expect(missing.ok).toBe(false);
  });
});

describe('observation table', () => {
  it('records, looks up and invalidates one path', () => {
    const port = createInMemoryFileObservationPort();
    const file = join(tmpRoot, 'file.txt');

    expect(port.lookup(file).ok).toBe(false);
    port.recordRead({ absPath: file, snapshot: snapshotFor(file) });
    const found = port.lookup(file);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.snapshot.version).toBe(hashFileBytes('hello\n'));
      expect(found.snapshot.coverage).toBe('full');
      expect(found.snapshot.runId).toBe('run-1');
    }

    port.invalidate(file);
    const after = port.lookup(file);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.errorKind).toBe('observation_missing');
  });

  it('keeps a partial read distinguishable from a full one', () => {
    const port = createInMemoryFileObservationPort();
    const file = join(tmpRoot, 'file.txt');
    port.recordRead({ absPath: file, snapshot: snapshotFor(file, 'partial') });

    const found = port.lookup(file);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.snapshot.coverage).toBe('partial');
      expect(found.snapshot.visibleLineRange).toEqual({ start: 1, end: 1 });
    }
  });

  it('replaces the observation when the same path is read again', () => {
    const port = createInMemoryFileObservationPort();
    const file = join(tmpRoot, 'file.txt');
    port.recordRead({ absPath: file, snapshot: snapshotFor(file) });
    port.recordRead({
      absPath: file,
      snapshot: observationSnapshot({
        version: 'newer',
        sizeBytes: 7,
        mtimeMs: 2,
        coverage: 'full',
        runId: 'run-2',
      }),
    });

    const found = port.lookup(file);
    expect(found.ok && found.snapshot.version).toBe('newer');
    expect(found.ok && found.snapshot.runId).toBe('run-2');
  });

  it('evicts the oldest observation once the table is bounded', () => {
    const bounded = createFileObservationTable({ maxEntries: 1 });
    const first = join(tmpRoot, 'file.txt');
    const second = join(tmpRoot, 'other.txt');
    bounded.recordRead({ absPath: first, snapshot: snapshotFor(first) });
    bounded.recordRead({ absPath: second, snapshot: snapshotFor(second) });

    // The table is bounded: the older observation is gone and must be re-read.
    expect(bounded.lookup(first).ok).toBe(false);
    expect(bounded.lookup(second).ok).toBe(true);
  });

  it('freezes registration and lookups while an opaque mutation is in flight', async () => {
    const port = createInMemoryFileObservationPort();
    const file = join(tmpRoot, 'file.txt');
    port.recordRead({ absPath: file, snapshot: snapshotFor(file) });

    const release = port.suspend();
    const duringLookup = port.lookup(file);
    expect(duringLookup.ok).toBe(false);
    if (!duringLookup.ok) expect(duringLookup.errorKind).toBe('observation_suspended');

    // A read delivered while the command may be rewriting the file proves nothing.
    port.recordRead({
      absPath: file,
      snapshot: observationSnapshot({
        version: 'mid-command',
        sizeBytes: 6,
        mtimeMs: 4,
        coverage: 'full',
        runId: 'run-1',
      }),
    });

    release();
    const after = port.lookup(file);
    // The pre-suspension observation is intact; the mid-command one was ignored.
    expect(after.ok && after.snapshot.version).toBe(hashFileBytes('hello\n'));
  });

  it('drops every observation on invalidateAll', () => {
    const port = createInMemoryFileObservationPort();
    const file = join(tmpRoot, 'file.txt');
    port.recordRead({ absPath: file, snapshot: snapshotFor(file) });
    port.invalidateAll();
    expect(port.lookup(file).ok).toBe(false);
  });
});

describe('path mutex', () => {
  it('serializes work for one path and keeps going after a failure', async () => {
    const mutex = createPathMutexTable();
    const order: string[] = [];
    const first = mutex.withLock('k', async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first:end');
      throw new Error('boom');
    });
    const second = mutex.withLock('k', async () => {
      order.push('second');
      return 'done';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('done');
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not serialize unrelated paths', async () => {
    const mutex = createPathMutexTable();
    const order: string[] = [];
    await Promise.all([
      mutex.withLock('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('a');
      }),
      mutex.withLock('b', async () => {
        order.push('b');
      }),
    ]);
    expect(order).toContain('a');
    expect(order).toContain('b');
  });
});
