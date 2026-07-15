import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InjectionTier } from '../types.js';
import { MemoryAtomConflictError, MemoryAtomStore, memoryAtomContentHash } from './atom-store.js';
import type { MemoryAtom } from './contracts.js';
import { makeAtomInput, makeStoredAtom } from './test-fixtures.js';

describe('MemoryAtomStore', () => {
  let dataDir: string;
  let tick: number;
  let now: () => Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-'));
    tick = Date.parse('2026-07-15T04:00:00.000Z');
    now = () => new Date(tick += 1_000);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates, updates, archives, and restores atoms across restart', async () => {
    const store = new MemoryAtomStore({ dataDir, now });
    await store.initialize();
    const root = await store.create(makeAtomInput());
    const child = await store.create(makeAtomInput({ id: 'atom-child', parentId: root.id, title: 'Child' }));
    const updated = await store.update(child.id, child.revision, { content: 'Updated content.' });

    expect(updated.revision).toBe(2);
    expect(updated.contentHash).not.toBe(child.contentHash);
    await expect(store.update(child.id, child.revision, { title: 'Stale write' }))
      .rejects.toBeInstanceOf(MemoryAtomConflictError);
    const archived = await store.archive(child.id, updated.revision);
    const restored = await store.restore(child.id, archived.revision);

    const restarted = new MemoryAtomStore({ dataDir, now });
    const scan = await restarted.initialize();
    expect(scan.issues).toEqual([]);
    expect((await restarted.read(child.id))?.revision).toBe(restored.revision);
    expect((await restarted.read(child.id))?.status).toBe('active');
  });

  it('rejects cross-branch, cross-scope, and cyclic parents', async () => {
    const store = new MemoryAtomStore({ dataDir, now });
    await store.initialize();
    const root = await store.create(makeAtomInput());
    const child = await store.create(makeAtomInput({ id: 'atom-child', parentId: root.id }));

    await expect(store.create(makeAtomInput({
      id: 'wrong-branch', parentId: root.id, branch: 'experience', domain: 'experience',
    }))).rejects.toThrow(/same branch/i);
    await expect(store.create(makeAtomInput({
      id: 'wrong-scope', parentId: root.id, scopeKey: 'project-b',
    }))).rejects.toThrow(/same scope/i);
    await expect(store.update(root.id, root.revision, { parentId: child.id })).rejects.toThrow(/cycle/i);
  });

  it('isolates corrupt atoms and their orphaned descendants on restart', async () => {
    const store = new MemoryAtomStore({ dataDir, now });
    await store.initialize();
    const root = await store.create(makeAtomInput());
    await store.create(makeAtomInput({ id: 'atom-child', parentId: root.id }));
    await writeFile(store.pathFor(root.id, root.branch), '{broken', 'utf8');

    const restarted = new MemoryAtomStore({ dataDir, now });
    const result = await restarted.initialize();

    expect(result.issues.map((issue) => issue.category).sort()).toEqual(['corrupt', 'orphan']);
    expect(await restarted.list()).toEqual([]);
    expect(result.issues.every((issue) => issue.quarantinePath)).toBe(true);
  });

  it('scans 10,000 sharded atom files without flattening hierarchy metadata', async () => {
    const store = new MemoryAtomStore({ dataDir, now, maxScanFiles: 10_100 });
    await store.initialize();
    const total = 10_000;
    const batchSize = 200;
    for (let start = 0; start < total; start += batchSize) {
      const writes: Promise<void>[] = [];
      for (let index = start; index < Math.min(total, start + batchSize); index += 1) {
        const atom = makeStoredAtom({
          id: `scale-${String(index).padStart(5, '0')}`,
          tier: index % 2 === 0 ? InjectionTier.T2_RELEVANT : InjectionTier.T3_DETAIL,
          title: `Scale atom ${index}`,
        });
        const path = store.pathFor(atom.id, atom.branch);
        writes.push(mkdir(dirname(path), { recursive: true })
          .then(() => writeFile(path, `${JSON.stringify(atom)}\n`, 'utf8')));
      }
      await Promise.all(writes);
    }

    const restarted = new MemoryAtomStore({ dataDir, now, maxScanFiles: 10_100 });
    const result = await restarted.initialize();
    expect(result.scannedFiles).toBe(total);
    expect(result.entries).toHaveLength(total);
    expect(result.entries[0]).not.toHaveProperty('content');
    expect(result.issues).toEqual([]);
  }, 60_000);

  it('detects content tampering through the atom hash', async () => {
    const store = new MemoryAtomStore({ dataDir, now });
    await store.initialize();
    const atom = makeStoredAtom();
    const tampered: MemoryAtom = { ...atom, content: 'Changed without updating hash.' };
    const path = store.pathFor(atom.id, atom.branch);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(tampered), 'utf8');

    const result = await store.scan();
    expect(result.issues[0]?.message).toMatch(/content hash mismatch/i);
    expect(memoryAtomContentHash(tampered)).not.toBe(tampered.contentHash);
  });
});
