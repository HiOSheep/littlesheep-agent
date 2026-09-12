// A file lock created with `open(path, 'wx')` is momentarily empty before its
// owner content is written. Treating that window as a corrupt lock let two
// processes hold the same lock at once, which produced duplicate durable event
// cursors — so the reclamation rules are pinned here.
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryAcquireLock } from './lock.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newTarget(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-lock-'));
  roots.push(root);
  return join(root, 'resource');
}

describe('file lock reclamation', () => {
  it('never steals a lock that is still being created', async () => {
    const target = await newTarget();
    await writeFile(`${target}.lock`, '', 'utf8');
    await expect(tryAcquireLock(target)).resolves.toBeNull();
    // The in-progress creation is left alone for its real owner to finish.
    await expect(stat(`${target}.lock`)).resolves.toBeTruthy();
  });

  it('reclaims an abandoned lock once it is older than the creation window', async () => {
    const target = await newTarget();
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const handle = await tryAcquireLock(target);
    expect(handle).not.toBeNull();
    await handle?.release();
  });

  it('keeps a lock owned by a live process and reclaims one owned by a dead pid', async () => {
    const target = await newTarget();
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    await expect(tryAcquireLock(target)).resolves.toBeNull();

    const dead = await newTarget();
    await writeFile(`${dead}.lock`, JSON.stringify({ pid: 999_999_999, createdAt: new Date().toISOString() }), 'utf8');
    const handle = await tryAcquireLock(dead);
    expect(handle).not.toBeNull();
    await handle?.release();
  });

  it('does not delete a lock file that a successor now owns', async () => {
    const target = await newTarget();
    const lockPath = `${target}.lock`;
    const handle = await tryAcquireLock(target);
    expect(handle).not.toBeNull();
    // Another worker reclaimed the lock while this one still believed it held it.
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: 'successor' }), 'utf8');
    await handle?.release();
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ token: 'successor' });
  });
});
