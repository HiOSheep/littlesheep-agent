import type { BigIntStats } from 'node:fs'
import { lstat, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname, parse } from 'node:path'
import type { ToolContext } from '@littlesheep/types'
import { withPinnedWorkspaceDirectories, type PinnedDirectoryResult } from './workspace-directory-pins.js'

// Automatic P2 writes are enabled only on the Windows path where the actual
// filesystem operations are covered by the native integration tests.
export const WORKSPACE_FILE_GUARD_AVAILABLE = process.platform === 'win32'

export interface WorkspaceFileGuardInspection {
  /** True for a requested path that is or purports to be inside this workspace. */
  attemptedWorkspace: boolean
  safe: boolean
  targetPath?: string
  reason?: string
  /** Rechecks every directory identity and the target state captured by inspect. */
  revalidate(): Promise<boolean>
  /** Confirms an opened handle is the same file object captured by inspect. */
  verifyOpenedHandle(handle: FileHandle): Promise<boolean>
  /** Hold native directory handles across all filesystem access, including cleanup. */
  withPinnedDirectories<T>(operation: () => Promise<T>): Promise<PinnedDirectoryResult<T>>
}

interface PathIdentity {
  readonly path: string
  readonly exists: boolean
  readonly dev?: bigint
  readonly ino?: bigint
  readonly kind?: 'directory' | 'file' | 'other'
  readonly links?: bigint
}

/**
 * Verify a native file operation against Main's immutable workspace root.
 * This is an application path guard, not OS process confinement. It rejects
 * reparse points, then holds native directory handles and rechecks identities
 * before accessing files so ordinary directory replacement cannot redirect it.
 */
export async function inspectWorkspaceFilePath(
  requestedPath: string,
  context: ToolContext,
  operation: 'read' | 'write',
): Promise<WorkspaceFileGuardInspection> {
  const snapshot = context.permissionPolicyV2
  if (!snapshot || (snapshot.preset !== 'workspace-write' && snapshot.preset !== 'read-only')) {
    return {
      attemptedWorkspace: false,
      safe: true,
      revalidate: async () => true,
      verifyOpenedHandle: async () => true,
      withPinnedDirectories: async (operation) => ({ ok: true, value: await operation() }),
    }
  }
  const rootValue = snapshot.workspaceRoot
  if (!rootValue) {
    return {
      attemptedWorkspace: true,
      safe: false,
      reason: 'Main did not provide a trusted workspace root',
      revalidate: async () => false,
      verifyOpenedHandle: async () => false,
      withPinnedDirectories: async () => ({ ok: false, reason: 'trusted workspace root is unavailable' }),
    }
  }

  let root: string
  let target: string
  try {
    root = resolve(rootValue)
    const resolvedRoot = resolve(await realpath(root))
    if (!samePath(root, resolvedRoot)) {
      return failed('the workspace root was replaced or redirected')
    }
    target = await resolveRequestedTarget(requestedPath, context.cwd, root)
    const relativeTarget = relative(root, target)
    if (!isInside(relativeTarget)) {
      return {
        attemptedWorkspace: !isAbsolute(requestedPath),
        safe: false,
        targetPath: target,
        reason: 'the resolved path is outside the authorized workspace',
        revalidate: async () => false,
        verifyOpenedHandle: async () => false,
        withPinnedDirectories: async (operation) => isAbsolute(requestedPath)
          ? { ok: true, value: await operation() }
          : { ok: false, reason: 'the path escaped the workspace' },
      }
    }
    if (hasUnsafeWindowsSegment(relativeTarget)) {
      return failed('the path contains a Windows alias or alternate-stream component')
    }

    const targetIdentity = await capturePathIdentities(root, target)
    const protectedRoot = operation === 'write'
      ? snapshot.protectedRoots.find((candidate) => isPathInside(resolve(candidate), target))
      : undefined
    if (protectedRoot) return failed(`the target is under a protected root: ${protectedRoot}`)

    let isLeaseActive: (() => boolean) | undefined
    const revalidate = async () => {
      try {
        if (isLeaseActive && !isLeaseActive()) return false
        if (!samePath(resolve(await realpath(root)), root)) return false
        const current = await capturePathIdentities(root, target)
        return identitiesEqual(targetIdentity, current)
      } catch {
        return false
      }
    }
    const expectedTarget = targetIdentity.at(-1)
    const verifyOpenedHandle = async (handle: FileHandle) => {
      if (!expectedTarget?.exists) return false
      try {
        const stat = await handle.stat({ bigint: true })
        return stat.isFile()
          && stat.dev === expectedTarget.dev
          && stat.ino === expectedTarget.ino
      } catch {
        return false
      }
    }
    return {
      attemptedWorkspace: true,
      safe: true,
      targetPath: target,
      revalidate,
      verifyOpenedHandle,
      withPinnedDirectories: async (operation) => {
        const directories: string[] = []
        for (let cursor = dirname(target); ; cursor = dirname(cursor)) {
          directories.unshift(cursor)
          if (cursor === parse(cursor).root) break
        }
        return withPinnedWorkspaceDirectories(directories, revalidate, async (active) => {
          isLeaseActive = active
          try { return await operation() }
          finally { isLeaseActive = undefined }
        })
      },
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }

  function failed(reason: string): WorkspaceFileGuardInspection {
    return {
      attemptedWorkspace: true,
      safe: false,
      reason,
      revalidate: async () => false,
      verifyOpenedHandle: async () => false,
      withPinnedDirectories: async () => ({ ok: false, reason }),
    }
  }
}

async function resolveRequestedTarget(requestedPath: string, cwd: string, root: string): Promise<string> {
  const currentDirectory = resolve(cwd)
  let currentRealPath: string
  try {
    currentRealPath = resolve(await realpath(currentDirectory))
  } catch {
    throw new Error('the run working directory is outside or unavailable within the authorized workspace')
  }
  if (!isPathInside(root, currentRealPath)) {
    throw new Error('the run working directory is outside or unavailable within the authorized workspace')
  }
  const candidate = resolve(currentDirectory, requestedPath)
  if (!isAbsolute(requestedPath)) return resolve(currentRealPath, requestedPath)
  if (isPathInside(root, candidate)) return candidate
  if (isPathInside(currentDirectory, candidate)) {
    return resolve(currentRealPath, relative(currentDirectory, candidate))
  }
  return candidate
}

async function capturePathIdentities(root: string, target: string): Promise<PathIdentity[]> {
  const relativeTarget = relative(root, target)
  if (!isInside(relativeTarget)) throw new Error('the target escaped the workspace')
  const segments = relativeTarget ? relativeTarget.split(sep).filter(Boolean) : []
  const identities: PathIdentity[] = []
  let cursor = root

  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('the authorized workspace root is not a plain directory')
  }
  if (rootStat.dev === 0n || rootStat.ino === 0n) {
    throw new Error('the filesystem does not provide a stable workspace identity')
  }
  identities.push(identity(root, rootStat))

  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]!)
    try {
      const stat = await lstat(cursor, { bigint: true })
      if (stat.isSymbolicLink()) throw new Error(`symbolic links and junctions are not eligible for automatic file access: ${cursor}`)
      const finalSegment = index === segments.length - 1
      if (stat.dev !== rootStat.dev) throw new Error(`a path component crosses to another filesystem: ${cursor}`)
      if (stat.dev === 0n || stat.ino === 0n) throw new Error(`the filesystem does not provide a stable path identity: ${cursor}`)
      if (!finalSegment && !stat.isDirectory()) throw new Error(`a parent path is not a directory: ${cursor}`)
      if (finalSegment && !stat.isFile()) throw new Error(`the target is not a regular file: ${cursor}`)
      if (finalSegment && stat.nlink > 1n) throw new Error(`hard-linked files are not eligible for automatic access: ${cursor}`)
      if (!samePath(resolve(await realpath(cursor)), cursor)) {
        throw new Error(`a path component resolves through a reparse point: ${cursor}`)
      }
      identities.push(identity(cursor, stat))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (index !== segments.length - 1) {
        throw new Error(`parent directories must already exist for automatic file operations: ${dirname(cursor)}`)
      }
      identities.push({ path: cursor, exists: false })
    }
  }
  return identities
}

function identity(path: string, stat: BigIntStats): PathIdentity {
  return {
    path,
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    links: stat.nlink,
  }
}

function identitiesEqual(left: readonly PathIdentity[], right: readonly PathIdentity[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const current = right[index]
    return current !== undefined
      && samePath(item.path, current.path)
      && item.exists === current.exists
      && item.dev === current.dev
      && item.ino === current.ino
      && item.kind === current.kind
      && item.links === current.links
  })
}

function isInside(relativePath: string): boolean {
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function isPathInside(root: string, candidate: string): boolean {
  return isInside(relative(resolve(root), resolve(candidate)))
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function hasUnsafeWindowsSegment(relativePath: string): boolean {
  if (process.platform !== 'win32') return false
  return relativePath.split(sep).some((segment) => (
    segment.includes(':')
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  ))
}
