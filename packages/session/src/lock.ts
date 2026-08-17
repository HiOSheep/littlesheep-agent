// @littlesheep/session — lock.ts
// Process-aware file lock. Cross-platform (works on Windows + Unix).
//
// Acquire: try to create `<target>.lock` with O_EXCL. If it exists, check
// whether the owning PID is alive; if dead, steal. Poll until timeout.

import { open, unlink, readFile } from 'node:fs/promises';
import type { LockHandle } from '@littlesheep/types';

const LOCK_SUFFIX = '.lock';
const POLL_INTERVAL_MS = 100;

interface LockFileContent {
  pid: number;
  createdAt: string;
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
    const content = JSON.parse(raw) as LockFileContent;
    if (!isProcessAlive(content.pid)) {
      // Owner is dead — steal the lock.
      await unlink(lockPath).catch(() => {});
      return true;
    }
    return false;
  } catch {
    // Corrupt lock file — remove it.
    await unlink(lockPath).catch(() => {});
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
  const content: LockFileContent = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  for (;;) {
    // Try exclusive create.
    try {
      const fd = await open(lockPath, 'wx');
      await fd.writeFile(JSON.stringify(content), 'utf8');
      await fd.close();
      return {
        async release() {
          await unlink(lockPath).catch(() => {});
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
  const content: LockFileContent = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  try {
    const fd = await open(lockPath, 'wx');
    await fd.writeFile(JSON.stringify(content), 'utf8');
    await fd.close();
    return {
      async release() {
        await unlink(lockPath).catch(() => {});
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
