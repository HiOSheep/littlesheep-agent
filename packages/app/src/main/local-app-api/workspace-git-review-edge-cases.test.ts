// Covers path, scope, truncation, unknown-count, and cancellation review boundaries.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview, readWorkspaceReviewDiff } from './workspace-git-review.js'
import {
  parsePorcelainStatus,
  scopeStatusRecord,
  toWorkspaceRelativePath,
} from './workspace-git-review-parsers.js'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('workspace Git review edge cases', () => {
  it('preserves a POSIX backslash filename alongside slash directory separators', () => {
    const record = parsePorcelainStatus(Buffer.from(' M scope/name\\part.txt\0', 'utf8'))[0]
    expect(record?.path).toBe('scope/name\\part.txt')
    const scoped = record ? scopeStatusRecord(record, 'scope/') : null
    expect(scoped).not.toBeNull()
    expect(toWorkspaceRelativePath(scoped?.path ?? '', 'scope/')).toBe('name\\part.txt')
  })

  it('projects renames entering and leaving a subdirectory workspace as add and delete', async () => {
    const repository = await createRepository()
    const workspace = join(repository, 'inside')
    await mkdir(workspace)
    await mkdir(join(repository, 'outside'))
    await writeFile(join(repository, 'outside', 'enter.txt'), 'enter-only\n', 'utf8')
    await writeFile(join(workspace, 'leave.txt'), 'leave-only\n', 'utf8')
    await git(repository, ['add', '.'])
    await git(repository, ['commit', '-m', 'scope fixtures'])
    await git(repository, ['mv', 'outside/enter.txt', 'inside/entered.txt'])
    await git(repository, ['mv', 'inside/leave.txt', 'outside/left.txt'])

    const snapshot = await readWorkspaceReview(workspace)
    expect(snapshot.files.map(({ path, oldPath, status }) => ({ path, oldPath, status }))).toEqual([
      { path: 'entered.txt', oldPath: undefined, status: 'added' },
      { path: 'leave.txt', oldPath: undefined, status: 'deleted' },
    ])
    expect((await readWorkspaceReviewDiff(workspace, join(workspace, 'entered.txt'))).layers)
      .toMatchObject([{ kind: 'staged', binary: false }])
    expect((await readWorkspaceReviewDiff(workspace, join(workspace, 'leave.txt'))).layers)
      .toMatchObject([{ kind: 'staged', binary: false }])
  })

  it('caps the visible file list and marks aggregate counts incomplete', async () => {
    const repository = await createRepository()
    const fileCount = 2_001
    for (let offset = 0; offset < fileCount; offset += 100) {
      await Promise.all(Array.from(
        { length: Math.min(100, fileCount - offset) },
        (_, index) => writeFile(join(repository, `change-${String(offset + index).padStart(4, '0')}.txt`), ''),
      ))
    }

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.files).toHaveLength(2_000)
    expect(snapshot.totalFiles).toBe(fileCount)
    expect(snapshot.filesTruncated).toBe(true)
    expect(snapshot.countsComplete).toBe(false)
  }, 30_000)

  it('marks oversized sampled text counts as unknown', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, 'oversized.txt'), Buffer.alloc(9 * 1024 * 1024, 0x61))

    const snapshot = await readWorkspaceReview(repository)
    expect(snapshot.files.find((file) => file.path === 'oversized.txt')).toMatchObject({
      additions: 0,
      deletions: 0,
      binary: false,
      countAvailable: false,
    })
    expect(snapshot.countsComplete).toBe(false)
  }, 15_000)

  it('caps rendered diff lines and reports truncation', async () => {
    const repository = await createRepository()
    const target = join(repository, 'many-lines.txt')
    await writeFile(target, `${Array.from({ length: 5_100 }, (_, index) => `line ${index}`).join('\n')}\n`, 'utf8')

    const diff = await readWorkspaceReviewDiff(repository, target)
    const renderedLines = diff.layers.flatMap((layer) => layer.hunks)
      .flatMap((hunk) => hunk.lines)
    expect(renderedLines).toHaveLength(5_000)
    expect(diff.truncated).toBe(true)
    expect(diff.notice).toContain('已显示前 5000 行')
  }, 15_000)

  it('propagates cancellation through snapshot and detail reads', async () => {
    const repository = await createRepository()
    const target = join(repository, 'tracked.txt')
    await writeFile(target, 'changed\n', 'utf8')
    const snapshotController = new AbortController()
    const snapshotRead = readWorkspaceReview(repository, { signal: snapshotController.signal })
    snapshotController.abort()
    await expect(snapshotRead).rejects.toMatchObject({ name: 'AbortError' })

    const detailController = new AbortController()
    const detailRead = readWorkspaceReviewDiff(repository, target, { signal: detailController.signal })
    detailController.abort()
    await expect(detailRead).rejects.toMatchObject({ name: 'AbortError' })
  })
})

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-edge-'))
  cleanup.push(directory)
  await git(directory, ['init'])
  await git(directory, ['config', 'user.email', 'review@example.test'])
  await git(directory, ['config', 'user.name', 'Review Test'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(directory, 'tracked.txt'), 'base\n', 'utf8')
  await git(directory, ['add', 'tracked.txt'])
  await git(directory, ['commit', '-m', 'initial'])
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
