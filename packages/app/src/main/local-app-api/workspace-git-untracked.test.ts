import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countUntrackedFiles } from './workspace-git-untracked.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('bounded untracked file scanning', () => {
  it('counts text exactly within the shared byte budget', async () => {
    const root = await temporaryDirectory('ls-untracked-count-')
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8')
    const result = await countUntrackedFiles(root, ['a.txt'])
    expect(result.limited).toBe(false)
    expect(result.counts.get('a.txt')).toEqual({
      additions: 2,
      deletions: 0,
      binary: false,
      countAvailable: true,
    })
  })

  it('stops filesystem inspection at the file and byte budgets', async () => {
    const root = await temporaryDirectory('ls-untracked-budget-')
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => (
      writeFile(join(root, name), 'content\n', 'utf8')
    )))
    const result = await countUntrackedFiles(root, ['a.txt', 'b.txt', 'c.txt'], {
      maxFiles: 2,
      maxScanBytes: 1,
    })
    expect(result.limited).toBe(true)
    expect([...result.counts.keys()]).toHaveLength(2)
    expect([...result.counts.values()].every((count) => !count.countAvailable)).toBe(true)
  })

  it('does not follow an untracked symlink outside the repository', async () => {
    const root = await temporaryDirectory('ls-untracked-root-')
    const outside = await temporaryDirectory('ls-untracked-outside-')
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'outside\ncontent\n', 'utf8')
    try {
      await symlink(secret, join(root, 'linked.txt'), 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    const result = await countUntrackedFiles(root, ['linked.txt'])
    expect(result.counts.get('linked.txt')).toMatchObject({
      additions: 0,
      binary: false,
      countAvailable: false,
    })
  })

  it('opens the canonical file after validation', async () => {
    const root = await temporaryDirectory('ls-untracked-canonical-')
    await writeFile(join(root, 'target.txt'), 'one\ntwo\n', 'utf8')
    const link = join(root, 'alias.txt')
    try {
      await symlink(join(root, 'target.txt'), link, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    const swap = unlink(link).then(() => writeFile(link, 'outside replacement\n', 'utf8'))

    const result = await countUntrackedFiles(root, ['alias.txt'])
    await swap
    expect(result.counts.get('alias.txt')?.countAvailable).toBe(false)
  })

  it('honors cancellation before opening any files', async () => {
    const root = await temporaryDirectory('ls-untracked-abort-')
    await writeFile(join(root, 'a.txt'), 'content\n', 'utf8')
    const controller = new AbortController()
    controller.abort()
    await expect(countUntrackedFiles(root, ['a.txt'], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}
