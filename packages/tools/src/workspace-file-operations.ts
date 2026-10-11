import { constants } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { copyFile, link, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { verifyReplacementSecurity } from './workspace-file-security.js'

export type WorkspaceFileCommitResult =
  | { ok: true }
  | { ok: false; reason: 'path_changed' | 'target_exists' | 'target_changed' | 'security_unavailable' }

/**
 * Atomically create a file without replacing a concurrently-created target.
 * The temporary file lives beside the target; hard-link creation is the
 * no-replace commit primitive. Filesystems without that primitive fail closed.
 */
export async function createFileAtomically(
  targetPath: string,
  content: string,
  isPathCurrent: () => Promise<boolean>,
): Promise<WorkspaceFileCommitResult> {
  if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
  const temporaryPath = siblingTemporaryPath(targetPath)
  let temporaryExists = false
  try {
    const handle = await open(temporaryPath, 'wx')
    temporaryExists = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
    try {
      await link(temporaryPath, targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'target_exists' }
      }
      throw error
    }
    await unlink(temporaryPath).then(() => { temporaryExists = false }).catch(() => undefined)
    return { ok: true }
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * Prepare replacement bytes in a sibling file, then atomically rename over the
 * observed target. On Windows, verify the empty replacement's real security
 * descriptor before placing any content in it. Nonordinary attributes/streams
 * and mismatched ACLs fail closed. The final target remains untouched until
 * rename succeeds; no fallback to a truncating write is permitted.
 */
export async function replaceFileAtomically(
  targetPath: string,
  originalBytes: Buffer,
  content: string,
  isPathCurrent: () => Promise<boolean>,
): Promise<WorkspaceFileCommitResult> {
  if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
  const temporaryPath = siblingTemporaryPath(targetPath)
  let temporaryExists = false
  try {
    if (process.platform === 'win32') {
      const handle = await open(temporaryPath, 'wx')
      temporaryExists = true
      try {
        if (!await verifyReplacementSecurity(targetPath, temporaryPath)) {
          return { ok: false, reason: 'security_unavailable' }
        }
        if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
        if (!(await readFile(targetPath)).equals(originalBytes)) return { ok: false, reason: 'target_changed' }
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (!await verifyReplacementSecurity(targetPath, temporaryPath)) {
        return { ok: false, reason: 'security_unavailable' }
      }
      if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
      if (!(await readFile(targetPath)).equals(originalBytes)) return { ok: false, reason: 'target_changed' }
      if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
      await rename(temporaryPath, targetPath)
      temporaryExists = false
      return { ok: true }
    }
    await copyFile(targetPath, temporaryPath, constants.COPYFILE_EXCL)
    temporaryExists = true
    const original = await readFile(temporaryPath)
    if (!original.equals(originalBytes)) return { ok: false, reason: 'target_changed' }

    // POSIX copyFile creates with the process umask. Keep the original mode.
    const originalStat = await stat(targetPath)
    await chmod(temporaryPath, originalStat.mode & 0o7777)

    const handle = await open(temporaryPath, 'r+')
    try {
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
    const current = await readFile(targetPath)
    if (!current.equals(originalBytes)) return { ok: false, reason: 'target_changed' }
    if (!await isPathCurrent()) return { ok: false, reason: 'path_changed' }
    await rename(temporaryPath, targetPath)
    temporaryExists = false
    return { ok: true }
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
  }
}

function siblingTemporaryPath(targetPath: string): string {
  const directory = dirname(targetPath)
  const { name } = parse(targetPath)
  return join(directory, `.${name || 'file'}.ls-${randomUUID()}.tmp`)
}
