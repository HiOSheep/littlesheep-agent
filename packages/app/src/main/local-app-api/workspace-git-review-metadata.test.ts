// UX-28 item 3: a change with no text hunk (a pure rename) is still a change, and the
// counts stay the sum of the layers rather than a net figure.
import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview, readWorkspaceReviewDiff } from './workspace-git-review'

const run = promisify(execFile)
const cleanup: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-meta-'))
  cleanup.push(directory)
  await git(directory, ['init', '--initial-branch=main'])
  await git(directory, ['config', 'user.email', 'review@example.test'])
  await git(directory, ['config', 'user.name', 'Review Test'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(directory, 'tracked.txt'), 'head\nbase\n', 'utf8')
  await git(directory, ['add', 'tracked.txt'])
  await git(directory, ['commit', '-m', 'initial'])
  return directory
}

describe('workspace Git review metadata-only changes', () => {
  it('lists a pure rename as a renamed file with no text hunks', async () => {
    const repository = await createRepository()
    await rename(join(repository, 'tracked.txt'), join(repository, 'renamed.txt'))
    await git(repository, ['add', '-A'])

    const snapshot = await readWorkspaceReview(repository)
    const file = snapshot.files.find((candidate) => candidate.path === 'renamed.txt')

    expect(file).toMatchObject({
      path: 'renamed.txt',
      oldPath: 'tracked.txt',
      status: 'renamed',
      staged: true,
      unstaged: false,
      additions: 0,
      deletions: 0,
    })

    const diff = await readWorkspaceReviewDiff(repository, join(repository, 'renamed.txt'))
    // The layer must exist — a rename is a change even though Git prints no `@@` hunk —
    // and it must carry the old path somewhere the view can show.
    const staged = diff.layers.find((layer) => layer.kind === 'staged')
    expect(staged?.hunks).toEqual([])
    // The rename is shown as metadata rather than as "a format other than a plain diff".
    expect(staged?.metadata).toEqual(expect.arrayContaining([
      { key: 'rename from', value: 'tracked.txt' },
      { key: 'rename to', value: 'renamed.txt' },
    ]))
    expect(staged?.notice).toBeUndefined()
  })

  it('reports a mode change as metadata when the platform records one', async () => {
    const repository = await createRepository()
    await git(repository, ['update-index', '--chmod=+x', 'tracked.txt'])

    const snapshot = await readWorkspaceReview(repository)
    const file = snapshot.files.find((candidate) => candidate.path === 'tracked.txt')
    const diff = await readWorkspaceReviewDiff(repository, join(repository, 'tracked.txt'))
    const staged = diff.layers.find((layer) => layer.kind === 'staged')
    const keys = (staged?.metadata ?? []).map((entry) => entry.key)

    // Windows can record the executable bit in the index even though the working tree has
    // no such bit; either Git reports the mode change (then it must be metadata) or the
    // index refuses it (then the file is simply unchanged). Both are honest outcomes.
    if (file === undefined) {
      expect(keys).toEqual([])
    } else {
      expect(keys).toContain('new mode')
      expect(staged?.notice).toBeUndefined()
    }
  })

  it('counts both layers rather than their net effect', async () => {
    const repository = await createRepository()
    const target = join(repository, 'tracked.txt')
    // Stage a change, then put the worktree back to HEAD: the *net* difference is zero,
    // but both layers are real and the counts have to be their sum (UX-28 item 3).
    await writeFile(target, 'staged\nbase\n', 'utf8')
    await git(repository, ['add', 'tracked.txt'])
    await writeFile(target, 'head\nbase\n', 'utf8')

    const snapshot = await readWorkspaceReview(repository)
    const file = snapshot.files.find((candidate) => candidate.path === 'tracked.txt')

    expect(file).toMatchObject({ staged: true, unstaged: true, additions: 2, deletions: 2 })
    expect(file?.additions).not.toBe(0)
    expect(snapshot.additions).toBe(2)
    expect(snapshot.deletions).toBe(2)
  })
})
