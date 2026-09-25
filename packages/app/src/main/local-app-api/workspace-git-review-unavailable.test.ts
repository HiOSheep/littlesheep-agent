// UX-28 item 1 at machine level: the two failure kinds that can be reproduced here for real
// rather than classified from a string in a unit test.
//
// - No Git executable: `PATH` is emptied of Git and the module is re-imported, so the same
//   resolution the app performs runs and fails.
// - Permission refusal: an ACL deny on `.git/index` (allowed for one's own files, no
//   elevation) makes Git itself refuse with "Permission denied".
//
// Dubious ownership is *not* reproduced: on this machine it needs a directory owned by
// another account, and Git for Windows ignores GIT_TEST_ASSUME_DIFFERENT_OWNER (measured),
// so that kind stays unit-level.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWorkspaceReview } from './workspace-git-review'

const run = promisify(execFile)
const cleanup: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-unavailable-'))
  cleanup.push(directory)
  await git(directory, ['init', '--initial-branch=main'])
  await git(directory, ['config', 'user.email', 'unavailable@example.test'])
  await git(directory, ['config', 'user.name', 'Unavailable Test'])
  await writeFile(join(directory, 'tracked.txt'), 'head\n', 'utf8')
  await git(directory, ['add', 'tracked.txt'])
  await git(directory, ['commit', '-m', 'base'])
  return directory
}


/** The user's global Git configuration as text, or a marker when it does not exist. */
async function globalConfigText(): Promise<string> {
  try {
    const { stdout } = await run('git', ['config', '--global', '--list'], { windowsHide: true })
    return stdout
  } catch {
    return '<no global config>'
  }
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('workspace Git review when Git cannot do the read', () => {
  it('reports Git as unavailable when no executable can be resolved from PATH', async () => {
    const repository = await createRepository()
    const emptyPathEntry = await mkdtemp(join(tmpdir(), 'ls-review-no-git-'))
    cleanup.push(emptyPathEntry)
    const originalPath = process.env.PATH
    process.env.PATH = emptyPathEntry
    // The app caches the resolved executable, so the failing resolution needs a fresh module.
    vi.resetModules()
    try {
      const fresh = await import('./workspace-git-review')
      const snapshot = await fresh.readWorkspaceReview(repository)

      expect(snapshot.availability).toBe('git-unavailable')
      expect(snapshot.files).toEqual([])
      expect(snapshot.message).toBeTruthy()
    } finally {
      process.env.PATH = originalPath
      vi.resetModules()
    }
  }, 30_000)

  it('reports a permission refusal as a permission problem, not as a missing repository', async () => {
    const repository = await createRepository()
    const index = join(repository, '.git', 'index')
    const account = process.env.USERNAME ?? process.env.USER ?? ''
    await run('icacls', [index, '/deny', `${account}:(R)`], { windowsHide: true })
    try {
      // The refusal happens after the repository resolves — `rev-parse` does not read the
      // index — which is why the classification is applied to the whole read.
      const snapshot = await readWorkspaceReview(repository)

      expect(snapshot.availability).toBe('permission-denied')
      expect(snapshot.message).not.toContain('不是 Git 仓库')
      expect(snapshot.files).toEqual([])
    } finally {
      await run('icacls', [index, '/remove:d', account], { windowsHide: true }).catch(() => undefined)
    }
    // Restoring the ACL puts the repository back in working order.
    expect((await git(repository, ['status', '--porcelain'])).trim()).toBe('')
  }, 30_000)
})

describe('workspace Git review leaves the user configuration alone', () => {
  it('does not add a safe.directory entry (or anything else) to the global config', async () => {
    const repository = await createRepository()
    // A damaged repository is exactly the case where "just add it to safe.directory" is the
    // tempting shortcut; the product must explain instead of editing the user's config.
    await writeFile(join(repository, '.git', 'index'), 'garbage that is not an index\n', 'utf8')
    const before = await globalConfigText()
    const snapshot = await readWorkspaceReview(repository)
    const after = await globalConfigText()

    expect(snapshot.availability).toBe('corrupt-repository')
    expect(after).toBe(before)
    expect(after).not.toContain(repository.replace(/\\/gu, '/'))
  }, 30_000)
})