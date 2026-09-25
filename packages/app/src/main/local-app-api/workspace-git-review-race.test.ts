// UX-27 item 2 with a *real* repository: an edit that lands in the middle of a read
// must not survive into the snapshot. The race is made deterministic by wrapping the
// Git runner: the first status read of the first attempt writes a file, exactly as a
// user save or another process would.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const run = promisify(execFile)
const repositories: string[] = []

/**
 * Set by the mock below: run on every status read, or once when once is set. A test
 * that keeps the repository moving proves the bounded retries end up *saying* so.
 */
let raceInjection: { run: () => Promise<void>; once: boolean } | null = null

vi.mock('./workspace-git-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-git-command.js')>()
  return {
    ...actual,
    runReadOnlyGit: async (cwd: string, args: string[], options: Parameters<typeof actual.runReadOnlyGit>[2]) => {
      const result = await actual.runReadOnlyGit(cwd, args, options)
      if (raceInjection && args[0] === 'status') {
        const inject = raceInjection
        if (inject.once) raceInjection = null
        await inject.run()
      }
      return result
    },
  }
})

const { readWorkspaceReview } = await import('./workspace-git-review.js')

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repository, ...args], { windowsHide: true })
  return stdout
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'littlesheep-review-race-'))
  repositories.push(repository)
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.email', 'acceptance@example.com'])
  await git(repository, ['config', 'user.name', 'Acceptance'])
  await writeFile(join(repository, 'first.ts'), 'export const first = 1\n', 'utf8')
  await git(repository, ['add', 'first.ts'])
  await git(repository, ['commit', '-m', 'first'])
  return repository
}

afterEach(async () => {
  raceInjection = null
  while (repositories.length > 0) {
    const repository = repositories.pop()
    if (repository) await rm(repository, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('workspace Git review race handling', () => {
  it('re-reads instead of returning what it saw before the change landed', async () => {
    const repository = await createRepository()
    raceInjection = {
      once: true,
      run: async () => {
        await writeFile(join(repository, 'landed-during-read.ts'), 'export const late = true\n', 'utf8')
      },
    }

    const snapshot = await readWorkspaceReview(repository)

    expect(snapshot.availability).toBe('ready')
    // The change happened during the first attempt, so the snapshot may not claim to be
    // a settled read of one state: the bounded retry re-read and the new file is there.
    expect(raceInjection).toBeNull()
    expect(snapshot.files.map((file) => file.path)).toContain('landed-during-read.ts')
    expect(snapshot.unstable).toBeUndefined()
  })

  it('reports a repository that never settles as unstable instead of as fresh', async () => {
    const repository = await createRepository()
    let counter = 0
    // Every status read moves the repository on, so both bounded attempts race.
    raceInjection = {
      once: false,
      run: async () => {
        counter += 1
        await writeFile(join(repository, `churn-${counter}.ts`), `export const churn = ${counter}\n`, 'utf8')
      },
    }

    const snapshot = await readWorkspaceReview(repository)

    // The data still comes back (hiding it would be worse) and it is labelled.
    expect(snapshot.availability).toBe('ready')
    expect(snapshot.unstable).toBe(true)
    expect(counter).toBeGreaterThanOrEqual(2)
  })
  it('reads a repository that is not changing without reporting a race', async () => {
    const repository = await createRepository()

    const snapshot = await readWorkspaceReview(repository)

    expect(snapshot.files).toEqual([])
    expect(snapshot.unstable).toBeUndefined()
  })
})
