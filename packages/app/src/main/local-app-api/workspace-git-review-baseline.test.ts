// UX-28 item 2: the review has to agree with the command line on the repository shapes a
// user actually works in. Each case builds the shape with real Git, asks the command line
// for its answer, and then asks the review for its answer — the two must classify the same
// paths the same way, and neither may crash or silently drop a path.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceReview, readWorkspaceReviewDiff } from './workspace-git-review'

const run = promisify(execFile)
const cleanup: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function initRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await git(directory, ['init', '--initial-branch=main'])
  await git(directory, ['config', 'user.email', 'baseline@example.test'])
  await git(directory, ['config', 'user.name', 'Baseline Test'])
  await git(directory, ['config', 'core.autocrlf', 'false'])
  await git(directory, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(directory, 'base.txt'), 'base\n', 'utf8')
  await git(directory, ['add', 'base.txt'])
  await git(directory, ['commit', '-m', 'base'])
}

async function temporaryRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(root)
  return root
}

/** `git status --porcelain -z` as a path → code map: the command-line baseline. */
async function cliStatus(cwd: string): Promise<Map<string, string>> {
  const raw = await run('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const records = raw.stdout.split('\0').filter((entry) => entry.length > 0)
  const status = new Map<string, string>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    const code = record.slice(0, 2)
    const path = record.slice(3)
    status.set(path, code)
    // A rename record is followed by the original path in `-z` output.
    if (code.includes('R') || code.includes('C')) index += 1
  }
  return status
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('workspace Git review against the command-line baseline', () => {
  it('reviews a subdirectory of the repository the way the command line does', async () => {
    const repository = await temporaryRepository('ls-review-subdir-')
    await initRepository(repository)
    await mkdir(join(repository, 'packages', 'inner'), { recursive: true })
    await writeFile(join(repository, 'packages', 'inner', 'nested.txt'), 'nested\n', 'utf8')

    const baseline = await cliStatus(join(repository, 'packages'))
    const subdirectory = join(repository, 'packages')
    const snapshot = await readWorkspaceReview(subdirectory)
    const path = snapshot.files[0]?.path ?? ''

    expect(snapshot.availability).toBe('ready')
    expect([...baseline.keys()]).toEqual(['packages/inner/nested.txt'])
    // The review names paths relative to the *workspace* while porcelain prints them relative
    // to the repository root. That is a deliberate difference (the list sits next to the
    // workspace's own file tree), but it is only acceptable while the review's own diff API
    // accepts the name it printed — which is what this asserts.
    expect(path).toBe('inner/nested.txt')
    expect(snapshot.files[0]).toMatchObject({ status: 'untracked' })
    const diff = await readWorkspaceReviewDiff(subdirectory, join(subdirectory, path))
    expect(diff.layers.map((layer) => layer.kind)).toEqual(['untracked'])
  })

  it('reviews a linked worktree, where .git is a file rather than a directory', async () => {
    const repository = await temporaryRepository('ls-review-worktree-')
    await initRepository(repository)
    const linked = `${repository}-linked`
    cleanup.push(linked)
    await git(repository, ['worktree', 'add', '-b', 'linked-branch', linked])
    await writeFile(join(linked, 'base.txt'), 'changed in the worktree\n', 'utf8')
    await writeFile(join(linked, 'added.txt'), 'added\n', 'utf8')

    const baseline = await cliStatus(linked)
    const snapshot = await readWorkspaceReview(linked)

    expect(snapshot.availability).toBe('ready')
    expect(snapshot.branch).toBe('linked-branch')
    expect(snapshot.files.map((file) => file.path).sort()).toEqual([...baseline.keys()].sort())
    expect(snapshot.files.find((file) => file.path === 'base.txt')).toMatchObject({ status: 'modified' })
  })

  it('reviews a detached HEAD without pretending it is on a branch', async () => {
    const repository = await temporaryRepository('ls-review-detached-')
    await initRepository(repository)
    await git(repository, ['checkout', '--detach'])
    await writeFile(join(repository, 'base.txt'), 'detached change\n', 'utf8')

    const baseline = await cliStatus(repository)
    const snapshot = await readWorkspaceReview(repository)

    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files.map((file) => file.path)).toEqual([...baseline.keys()])
    // A detached HEAD has no branch name: the label may be empty, `HEAD`, or the commit it is
    // detached at — but never a branch that does not exist.
    const headShort = (await git(repository, ['rev-parse', '--short', 'HEAD'])).trim()
    // Measured label: `detached@ea8cd6f` — it says it is detached and names the commit,
    // instead of showing a branch that does not exist.
    const label = snapshot.branch ?? ''
    expect(label.startsWith('detached@')).toBe(true)
    expect(label).toContain(headShort)
  })

  it('reports an unresolved merge conflict as conflicted, not as an ordinary edit', async () => {
    const repository = await temporaryRepository('ls-review-conflict-')
    await initRepository(repository)
    await git(repository, ['checkout', '-b', 'side'])
    await writeFile(join(repository, 'base.txt'), 'side version\n', 'utf8')
    await git(repository, ['commit', '-am', 'side'])
    await git(repository, ['checkout', 'main'])
    await writeFile(join(repository, 'base.txt'), 'main version\n', 'utf8')
    await git(repository, ['commit', '-am', 'main'])
    await expect(git(repository, ['merge', 'side'])).rejects.toThrow()

    const baseline = await cliStatus(repository)
    const snapshot = await readWorkspaceReview(repository)

    expect(baseline.get('base.txt')).toBe('UU')
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files.find((file) => file.path === 'base.txt')).toMatchObject({
      status: 'conflicted',
    })
  })

  it('lists a submodule the way the command line does', async () => {
    const inner = await temporaryRepository('ls-review-submodule-inner-')
    await initRepository(inner)
    const outer = await temporaryRepository('ls-review-submodule-outer-')
    await initRepository(outer)
    await git(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'inner'])
    await git(outer, ['commit', '-m', 'add submodule'])

    // Move the submodule's HEAD so the superproject sees a changed gitlink.
    await writeFile(join(outer, 'inner', 'base.txt'), 'inner change\n', 'utf8')
    await git(join(outer, 'inner'), ['commit', '-am', 'inner commit'])

    const baseline = await cliStatus(outer)
    const snapshot = await readWorkspaceReview(outer)

    expect(baseline.get('inner')).toBe(' M')
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.files.find((file) => file.path === 'inner')).toBeDefined()
  }, 60_000)

  it('agrees with the command line on Chinese and spaced paths, empty files and binaries', async () => {
    const repository = await temporaryRepository('ls-review-mixed-')
    await initRepository(repository)
    await mkdir(join(repository, '素材 目录'), { recursive: true })
    await writeFile(join(repository, '素材 目录', '背景 图.txt'), '背景\n', 'utf8')
    await writeFile(join(repository, 'empty.txt'), '', 'utf8')
    await writeFile(join(repository, 'asset.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 7]))
    await writeFile(join(repository, 'base.txt'), 'changed\n', 'utf8')

    const baseline = await cliStatus(repository)
    const snapshot = await readWorkspaceReview(repository)
    const reviewed = new Map(snapshot.files.map((file) => [file.path, file]))

    expect(snapshot.availability).toBe('ready')
    expect([...reviewed.keys()].sort()).toEqual([...baseline.keys()].sort())
    expect(reviewed.get('素材 目录/背景 图.txt')).toMatchObject({ status: 'untracked' })
    expect(reviewed.get('empty.txt')).toMatchObject({ status: 'untracked', additions: 0 })
    expect(reviewed.get('asset.bin')?.binary).toBe(true)
    expect(reviewed.get('base.txt')).toMatchObject({ status: 'modified' })
  })
})
