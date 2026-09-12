// @littlesheep/session — lock.ts
// Process-aware file lock. Cross-platform (works on Windows + Unix).
//
// Acquire: try to create `<target>.lock` with O_EXCL. If it exists, check
// whether the owning PID is alive; if dead, steal. Poll until timeout.

import { randomUUID } from 'node:crypto';
import { open, stat, unlink, readFile } from 'node:fs/promises';
import type { LockHandle } from '@littlesheep/types';

const LOCK_SUFFIX = '.lock';
const POLL_INTERVAL_MS = 100;
/**
 * `open(path, 'wx')` creates the lock file before its owner content is
 * written. Another process can therefore observe a momentarily empty lock.
 * Only a lock older than this grace window may be treated as corrupt and
 * stolen; a fresh one is simply still being created.
 */
const LOCK_CREATION_GRACE_MS = 5_000;

interface LockFileContent {
  pid: number;
  createdAt: string;
  /** Unique per acquisition so a release can prove it still owns the file. */
  token?: string;
}

function contentOwnedBy(raw: string, owner: { pid: number; token: string }): boolean {
  try {
    const parsed = JSON.parse(raw) as Partial<LockFileContent>;
    return parsed?.pid === owner.pid && parsed?.token === owner.token;
  } catch {
    return false;
  }
}

/**
 * Remove the lock file only while it still belongs to this acquisition. A
 * concurrent stale-lock reclaimer may have replaced it, and deleting that
 * successor's file would break mutual exclusion for everyone after us.
 */
async function releaseOwnLock(lockPath: string, owner: { pid: number; token: string }): Promise<void> {
  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  if (raw !== null && !contentOwnedBy(raw, owner)) return;
  await unlink(lockPath).catch(() => {});
}

/**
 * Confirm the lock file still names this acquisition. A concurrent reclaimer
 * can delete a freshly created lock and install its own; without this
 * read-back both processes would believe they hold the lock.
 */
async function confirmOwnLock(lockPath: string, owner: { pid: number; token: string }): Promise<boolean> {
  const raw = await readFile(lockPath, 'utf8').catch(() => null);
  return raw !== null && contentOwnedBy(raw, owner);
}

/** Check if a process is alive (cross-platform). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try to steal a stale lock (owner PID is dead). */
async function tryStealStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    let content: LockFileContent;
    try {
      content = JSON.parse(raw) as LockFileContent;
    } catch {
      return stealOnlyIfAbandoned(lockPath);
    }
    if (typeof content?.pid !== 'number' || !Number.isFinite(content.pid)) {
      return stealOnlyIfAbandoned(lockPath);
    }
    if (!isProcessAlive(content.pid)) {
      // Owner is dead — steal the lock.
      await unlink(lockPath).catch(() => {});
      return true;
    }
    return false;
  } catch {
    // Unreadable lock file: only reclaim it once it is clearly abandoned.
    return stealOnlyIfAbandoned(lockPath);
  }
}

/** Reclaim a lock whose owner content is missing, but never a live creation. */
async function stealOnlyIfAbandoned(lockPath: string): Promise<boolean> {
  try {
    const details = await stat(lockPath);
    if (Date.now() - details.mtimeMs < LOCK_CREATION_GRACE_MS) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  } catch {
    // The lock disappeared; the caller can retry the exclusive create.
    return true;
  }
}

/**
 * Acquire a file-based lock for `targetPath`.
 * Polls every 100ms up to `timeoutMs`. Throws on timeout.
 */
export async function acquireLock(targetPath: string, timeoutMs: number = 60000): Promise<LockHandle> {
  const lockPath = targetPath + LOCK_SUFFIX;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const content: LockFileContent = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  };

  for (;;) {
    // Try exclusive create.
    try {
      const fd = await open(lockPath, 'wx');
      await fd.writeFile(JSON.stringify(content), 'utf8');
      await fd.close();
      if (!(await confirmOwnLock(lockPath, { pid: process.pid, token }))) {
        if (Date.now() >= deadline) {
          throw new Error(`session: lock acquire timeout for ${targetPath} (${timeoutMs}ms)`);
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      return {
        async release() {
          await releaseOwnLock(lockPath, { pid: process.pid, token });
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock exists — check if stale.
      if (await tryStealStaleLock(lockPath)) {
        continue; // retry immediately
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`session: lock acquire timeout for ${targetPath} (${timeoutMs}ms)`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** Non-blocking: try to acquire once, return null if held. */
export async function tryAcquireLock(targetPath: string): Promise<LockHandle | null> {
  const lockPath = targetPath + LOCK_SUFFIX;
  const token = randomUUID();
  const content: LockFileContent = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  };
  try {
    const fd = await open(lockPath, 'wx');
    await fd.writeFile(JSON.stringify(content), 'utf8');
    await fd.close();
    if (!(await confirmOwnLock(lockPath, { pid: process.pid, token }))) return null;
    return {
      async release() {
        await releaseOwnLock(lockPath, { pid: process.pid, token });
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    if (await tryStealStaleLock(lockPath)) {
      return tryAcquireLock(targetPath);
    }
    return null;
  }
}
