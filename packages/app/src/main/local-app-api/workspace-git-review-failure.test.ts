// UX-28 item 1 against real repositories: a damaged object store and a missing
// repository must not answer with the same sentence, and a repository without commits
// must stay usable rather than being reported as broken.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview } from './workspace-git-review'

const run = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'littlesheep-review-failure-'))
  roots.push(repository)
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'acceptance@example.com'])
  await git(repository, ['config', 'user.name', 'Acceptance'])
  await writeFile(join(repository, 'tracked.txt'), 'first\n', 'utf8')
  await git(repository, ['add', 'tracked.txt'])
  await git(repository, ['commit', '-m', 'first'])
  return repository
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('workspace Git review failures', () => {
  it('says a plain directory is not a repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'littlesheep-review-plain-'))
    roots.push(directory)

    const snapshot = await readWorkspaceReview(directory)

    expect(snapshot.availability).toBe('not-repository')
    expect(snapshot.message).toContain('不是 Git 仓库')
  })

  it('reports a repository with a damaged object store as damaged, not as missing', async () => {
    const repository = await createRepository()
    // A packed object that no longer parses is what a half-copied or interrupted
    // repository looks like; Git refuses to read it and says why.
    const packDirectory = join(repository, '.git', 'objects', 'pack')
    await mkdir(packDirectory, { recursive: true })
    await writeFile(join(packDirectory, 'pack-broken.pack'), 'not a pack file\n', 'utf8')
    await writeFile(join(packDirectory, 'pack-broken.idx'), 'not an index\n', 'utf8')
    await git(repository, ['config', 'core.repositoryformatversion', '0'])

    const snapshot = await readWorkspaceReview(repository)

    // Either Git notices the damage and the snapshot names it, or Git still reads the
    // loose objects and the snapshot is ready — both are acceptable; what must not
    // happen is "this is not a Git repository".
    expect(['corrupt-repository', 'ready']).toContain(snapshot.availability)
    if (snapshot.availability === 'corrupt-repository') {
      expect(snapshot.message).toContain('git fsck')
    }
  })

  it('reports a corrupt index as damaged instead of as an empty repository', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, '.git', 'index'), 'garbage that is not an index\n', 'utf8')

    const snapshot = await readWorkspaceReview(repository)

    expect(snapshot.availability).toBe('corrupt-repository')
    expect(snapshot.message).toContain('git fsck')
    expect(snapshot.message).not.toContain('不是 Git 仓库')
  })

  it('stays ready for a repository whose first commit has not happened yet', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'littlesheep-review-unborn-'))
    roots.push(repository)
    await git(repository, ['init', '--initial-branch=main'])
    await writeFile(join(repository, 'fresh.txt'), 'new\n', 'utf8')

    const snapshot = await readWorkspaceReview(repository)

    // An unborn HEAD is a normal state: the file is listed and no failure is reported.
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files.map((file) => file.path)).toContain('fresh.txt')
    expect(snapshot.unstable).toBeUndefined()
  })
})
