// @littlesheep/memory-core — atomic-write.ts
// Atomic file write: write to a temp file in the same directory, then rename
// over the target. Same-volume rename is atomic on NTFS/ext4/APFS, so readers
// never see a partially-written file.
//
// Why this exists: MEMORY.md is read on every prompt build and written by the
// `write_memory` tool. A partial write (process killed mid-write, Electron
// multi-window race, WAL crash — see project_memory.md lessons) would corrupt
// the T1 core memory. atomicWrite (tmp + rename) makes corruption impossible:
// either the old file or the new file is fully visible, never a half-written
// hybrid.
//
// Windows note: `rename` on Windows is implemented via MoveFileEx
// (MOVEFILE_REPLACE_EXISTING). When two threads race to rename different tmp
// files onto the SAME target, one rename may fail with EPERM/EACCES because
// the target is momentarily locked by the other rename. This is a documented
// Node.js quirk (nodejs/node#19077). POSIX rename is fully atomic under
// contention; Windows is not. We mitigate with a bounded retry loop: on
// EPERM/EACCES, back off briefly and try again. After RENAME_RETRIES the last
// error is rethrown. This preserves atomicity (each attempt is itself atomic)
// while making concurrent writes converge instead of failing.
//
// Trade-off: if the process crashes between write+rename, the tmp file leaks.
// Callers may sweep stale `*.tmp` files on startup (not done here — write_memory
// is low-frequency, so leakage is negligible).

import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** Max rename attempts on Windows EPERM/EACCES contention. */
const RENAME_RETRIES = 8;
/** Initial backoff in ms; doubled each attempt, capped at 50ms. */
const RENAME_BACKOFF_MS = 2;
const RENAME_BACKOFF_CAP_MS = 50;

function isRenameRetryError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === 'EPERM' || code === 'EACCES';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write `content` to `targetPath` atomically.
 *
 * Strategy:
 *   1. Write to `<target>.<6-hex-random>.tmp` (same directory — required for
 *      same-volume rename atomicity).
 *   2. `rename(tmp, target)` — atomic on all supported platforms. On Windows,
 *      retry on EPERM/EACCES (concurrent rename contention — see file header).
 *   3. On failure, best-effort delete the tmp file (ignore unlink errors).
 *
 * @throws if either the write or rename fails (after tmp cleanup).
 */
export async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    // Retry the rename on Windows contention. Each attempt is itself atomic,
    // so retrying cannot produce a corrupted hybrid — at worst a later attempt
    // overwrites an earlier one (last writer wins, which is the intended
    // semantics under concurrent writes).
    let lastErr: unknown;
    let backoff = RENAME_BACKOFF_MS;
    for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
      try {
        await rename(tmp, targetPath);
        return; // success
      } catch (err) {
        lastErr = err;
        if (!isRenameRetryError(err)) throw err; // non-retryable
        if (attempt === RENAME_RETRIES - 1) break; // last attempt failed
        await sleep(backoff);
        backoff = Math.min(backoff * 2, RENAME_BACKOFF_CAP_MS);
      }
    }
    throw lastErr;
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leak a stale tmp file.
    try {
      await unlink(tmp);
    } catch {
      // ignore — tmp may not exist (write failed before completion, or the
      // successful rename already consumed it)
    }
    throw err;
  }
}
