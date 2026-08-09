// Verifies Git index/worktree layer accounting against real temporary repositories.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview, readWorkspaceReviewDiff } from './workspace-git-review.js'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('workspace Git review layers', () => {
  it('counts staged text and binary files before the first commit', async () => {
    const repository = await createRepository(false)
    const textPath = join(repository, 'staged.txt')
    const binaryPath = join(repository, 'asset.bin')
    await writeFile(textPath, 'alpha\nbeta\n', 'utf8')
    await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await git(repository, ['add', 'staged.txt', 'asset.bin'])

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.files.find((file) => file.path === 'staged.txt')).toMatchObject({
      additions: 2,
      deletions: 0,
      staged: true,
      unstaged: false,
      binary: false,
    })
    expect(snapshot.files.find((file) => file.path === 'asset.bin')).toMatchObject({
      additions: 0,
      deletions: 0,
      staged: true,
      unstaged: false,
      binary: true,
    })

    const textDiff = await readWorkspaceReviewDiff(repository, textPath)
    expect(textDiff.layers.map((layer) => layer.kind)).toEqual(['staged'])
    expect(textDiff.layers[0]?.hunks.flatMap((hunk) => hunk.lines)
      .filter((line) => line.kind === 'addition').map((line) => line.content))
      .toEqual(['alpha', 'beta'])

    const binaryDiff = await readWorkspaceReviewDiff(repository, binaryPath)
    expect(binaryDiff.layers).toMatchObject([{ kind: 'staged', binary: true, hunks: [] }])
  })

  it('keeps both MM layers when the worktree rolls a staged edit back to HEAD', async () => {
    const repository = await createRepository(true)
    const target = join(repository, 'tracked.txt')
    await writeFile(target, 'staged\nbase\n', 'utf8')
    await git(repository, ['add', 'tracked.txt'])
    await writeFile(target, 'head\nbase\n', 'utf8')

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.files.find((file) => file.path === 'tracked.txt')).toMatchObject({
      additions: 2,
      deletions: 2,
      staged: true,
      unstaged: true,
    })

    const diff = await readWorkspaceReviewDiff(repository, target)
    expect(diff.layers.map((layer) => layer.kind)).toEqual(['staged', 'unstaged'])
    expect(changedLines(diff.layers[0])).toEqual(['-head', '+staged'])
    expect(changedLines(diff.layers[1])).toEqual(['-staged', '+head'])
  })
})

function changedLines(layer: { hunks: Array<{ lines: Array<{ kind: string; content: string }> }> } | undefined) {
  return layer?.hunks.flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === 'addition' || line.kind === 'deletion')
    .map((line) => `${line.kind === 'addition' ? '+' : '-'}${line.content}`)
}

async function createRepository(withCommit: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-layers-'))
  cleanup.push(directory)
  await git(directory, ['init'])
  await git(directory, ['config', 'user.email', 'review@example.test'])
  await git(directory, ['config', 'user.name', 'Review Test'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  if (withCommit) {
    await writeFile(join(directory, 'tracked.txt'), 'head\nbase\n', 'utf8')
    await git(directory, ['add', 'tracked.txt'])
    await git(directory, ['commit', '-m', 'initial'])
  }
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
