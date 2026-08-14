import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readWorkspaceReview,
  readWorkspaceReviewDiff,
} from './workspace-git-review.js'
import {
  parseNumstat,
  parsePorcelainBranchStatus,
  parsePorcelainStatus,
  parseUnifiedDiff,
} from './workspace-git-review-parsers.js'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('workspace Git review parsers', () => {
  it('parses staged, unstaged, untracked and renamed porcelain records', () => {
    const records = parsePorcelainStatus(Buffer.from(
      'M  staged.ts\0 M edited.ts\0?? new.ts\0R  moved.ts\0old.ts\0',
      'utf8',
    ))
    expect(records).toEqual([
      { path: 'staged.ts', code: 'M ', staged: true, unstaged: false },
      { path: 'edited.ts', code: ' M', staged: false, unstaged: true },
      { path: 'new.ts', code: '??', staged: false, unstaged: true },
      { path: 'moved.ts', oldPath: 'old.ts', code: 'R ', staged: true, unstaged: false },
    ])
  })

  it('parses branch, upstream and divergence from the status process', () => {
    expect(parsePorcelainBranchStatus(Buffer.from(
      '## feature/review...origin/feature/review [ahead 2, behind 3]\0 M edited.ts\0?? new.ts\0',
      'utf8',
    ))).toEqual({
      branch: 'feature/review',
      upstream: 'origin/feature/review',
      ahead: 2,
      behind: 3,
      detached: false,
      records: [
        { path: 'edited.ts', code: ' M', staged: false, unstaged: true },
        { path: 'new.ts', code: '??', staged: false, unstaged: true },
      ],
    })
    expect(parsePorcelainBranchStatus(Buffer.from('## No commits yet on main\0', 'utf8')))
      .toMatchObject({ branch: 'main', ahead: 0, behind: 0, detached: false })
    const detached = parsePorcelainBranchStatus(Buffer.from('## HEAD (no branch)\0', 'utf8'))
    expect(detached).toMatchObject({ ahead: 0, behind: 0, detached: true })
    expect(detached).not.toHaveProperty('branch')
  })

  it('parses normal, binary and rename numstat fields', () => {
    const records = parseNumstat(Buffer.from([
      '3\t2\tfile.ts',
      '-\t-\tasset.bin',
      '1\t0\t',
      'old.ts',
      'new.ts',
      '',
    ].join('\0'), 'utf8'))
    expect(records).toEqual([
      { path: 'file.ts', additions: 3, deletions: 2, binary: false },
      { path: 'asset.bin', additions: 0, deletions: 0, binary: true },
      { path: 'new.ts', oldPath: 'old.ts', additions: 1, deletions: 0, binary: false },
    ])
  })

  it('tracks old and new line numbers in unified hunks', () => {
    const hunks = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      '@@ -2,3 +2,4 @@',
      ' keep',
      '-before',
      '+after',
      '+extra',
      ' tail',
      '\\ No newline at end of file',
    ].join('\n'))
    expect(hunks[0]?.lines).toEqual([
      { kind: 'context', content: 'keep', oldLine: 2, newLine: 2 },
      { kind: 'deletion', content: 'before', oldLine: 3, newLine: null },
      { kind: 'addition', content: 'after', oldLine: null, newLine: 3 },
      { kind: 'addition', content: 'extra', oldLine: null, newLine: 4 },
      { kind: 'context', content: 'tail', oldLine: 4, newLine: 5 },
      { kind: 'meta', content: '\\ No newline at end of file', oldLine: null, newLine: null },
    ])
  })
})

describe('workspace Git review integration', () => {
  it('reviews staged files before the repository has its first commit', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'ls-review-unborn-git-'))
    cleanup.push(repository)
    await git(repository, ['init'])
    const target = join(repository, 'first.ts')
    await writeFile(target, 'export const first = true\n', 'utf8')
    await git(repository, ['add', 'first.ts'])

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files).toMatchObject([{
      path: 'first.ts',
      status: 'added',
      staged: true,
      unstaged: false,
    }])

    const diff = await readWorkspaceReviewDiff(repository, target)
    expect(diff.layers).toMatchObject([{ kind: 'staged', binary: false }])
    expect(diff.hunks[0]?.lines.some((line) => (
      line.kind === 'addition' && line.content === 'export const first = true'
    ))).toBe(true)
  })

  it('lists tracked and untracked changes and returns a structured file diff', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, 'tracked.txt'), 'one\nchanged\n', 'utf8')
    await mkdir(join(repository, 'src'), { recursive: true })
    await writeFile(join(repository, 'src', 'new.ts'), 'export const value = 1\n', 'utf8')

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files.map((file) => file.path)).toEqual(['src/new.ts', 'tracked.txt'])
    expect(snapshot.files.find((file) => file.path === 'src/new.ts')?.absolutePath)
      .toBe(resolve(repository, 'src', 'new.ts'))
    expect(snapshot).toMatchObject({
      countsComplete: true,
      totalFiles: 2,
      filesTruncated: false,
    })
    expect(snapshot.additions).toBeGreaterThanOrEqual(2)
    expect(snapshot.deletions).toBe(1)

    const diff = await readWorkspaceReviewDiff(repository, join(repository, 'tracked.txt'))
    expect(diff.file.status).toBe('modified')
    expect(diff.hunks.length).toBe(1)
    expect(diff.hunks[0]?.lines.some((line) => line.kind === 'addition' && line.content === 'changed')).toBe(true)
  })

  it('returns a stable non-repository state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ls-review-non-git-'))
    cleanup.push(directory)
    const snapshot = await readWorkspaceReview(directory)
    expect(snapshot.availability).toBe('not-repository')
    expect(snapshot.files).toEqual([])
  })

  it('does not classify oversized untracked text as binary', async () => {
    const repository = await createRepository()
    const largeText = join(repository, 'large.txt')
    await writeFile(largeText, `${'a'.repeat(4 * 1024 * 1024)}\nmore text\n`, 'utf8')

    const snapshot = await readWorkspaceReview(repository)
    const file = snapshot.files.find((candidate) => candidate.path === 'large.txt')
    expect(file).toMatchObject({
      binary: false,
      additions: 2,
      deletions: 0,
      countAvailable: true,
    })

    const diff = await readWorkspaceReviewDiff(repository, largeText)
    expect(diff.binary).toBe(false)
    expect(diff.hunks.length).toBeGreaterThan(0)
  })

  it('detects binary bytes beyond the untracked line-count limit', async () => {
    const repository = await createRepository()
    const content = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61)
    content[content.length - 1] = 0
    await writeFile(join(repository, 'large.bin'), content)

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.files.find((file) => file.path === 'large.bin'))
      .toMatchObject({ binary: true, additions: 0, deletions: 0 })
  })
})

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-git-'))
  cleanup.push(directory)
  await git(directory, ['init'])
  await git(directory, ['config', 'user.email', 'review@example.test'])
  await git(directory, ['config', 'user.name', 'Review Test'])
  await writeFile(join(directory, 'tracked.txt'), 'one\ntwo\n', 'utf8')
  await git(directory, ['add', 'tracked.txt'])
  await git(directory, ['commit', '-m', 'initial'])
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
