// UX-28 item 5: the review limits have to be *visible*. A capped list, a capped layer and
// an incomplete count all say so instead of quietly reporting less than what exists.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview, readWorkspaceReviewDiff } from './workspace-git-review'

const run = promisify(execFile)
const cleanup: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-limits-'))
  cleanup.push(directory)
  await git(directory, ['init', '--initial-branch=main'])
  await git(directory, ['config', 'user.email', 'review@example.test'])
  await git(directory, ['config', 'user.name', 'Review Test'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  return directory
}

describe('workspace Git review limits', () => {
  it('caps a very large file list and says how many exist', async () => {
    const repository = await createRepository()
    await git(repository, ['commit', '--allow-empty', '-m', 'initial'])
    // 2,100 untracked files: past the 2,000-file review cap.
    const total = 2_100
    await Promise.all(Array.from({ length: total }, (_unused, index) => (
      writeFile(join(repository, `file-${String(index).padStart(4, '0')}.txt`), 'x\n', 'utf8')
    )))

    const snapshot = await readWorkspaceReview(repository)

    expect(snapshot.filesTruncated).toBe(true)
    expect(snapshot.files.length).toBe(2_000)
    expect(snapshot.totalFiles).toBe(total)
    // The summary totals only cover the files that were listed, so they are marked
    // incomplete rather than passed off as the totals of the whole change set.
    expect(snapshot.countsComplete).toBe(false)
    expect(snapshot.additions).toBe(snapshot.files.reduce((total, file) => total + file.additions, 0))
  }, 120_000)

  it('caps a very long layer and names the limit in the notice', async () => {
    const repository = await createRepository()
    const target = join(repository, 'long.txt')
    await writeFile(target, `${Array.from({ length: 1_000 }, (_unused, index) => `line ${index}`).join('\n')}\n`, 'utf8')
    await git(repository, ['add', 'long.txt'])
    await git(repository, ['commit', '-m', 'initial'])
    // 6,000 changed lines in one layer: past the 5,000-line cap.
    await writeFile(target, `${Array.from({ length: 7_000 }, (_unused, index) => `changed ${index}`).join('\n')}\n`, 'utf8')

    const diff = await readWorkspaceReviewDiff(repository, target)
    const unstaged = diff.layers.find((layer) => layer.kind === 'unstaged')

    expect(unstaged?.truncated).toBe(true)
    expect(unstaged?.notice).toContain('5000')
    expect(unstaged?.hunks.length).toBeGreaterThan(0)
  }, 120_000)
})
