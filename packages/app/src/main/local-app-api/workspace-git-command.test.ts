import { execFile } from 'node:child_process'
import { access, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runReadOnlyGit } from './workspace-git-command.js'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('workspace Git command hardening', () => {
  it.runIf(process.platform === 'win32')('does not execute a git.exe placed in the repository root', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'ls-review-git-command-'))
    cleanup.push(repository)
    await copyFile(process.execPath, join(repository, 'git.exe'))

    const result = await runReadOnlyGit(repository, ['--version'])

    expect(result.stdout.toString('utf8')).toMatch(/^git version /u)
  })

  it('ignores inherited variables that redirect Git to another repository', async () => {
    const repository = await createRepository('expected.txt')
    const redirectedRepository = await createRepository('redirected.txt')
    const tracePath = join(repository, 'git-trace.log')
    const inherited = new Map([
      ['GIT_DIR', process.env.GIT_DIR],
      ['GIT_WORK_TREE', process.env.GIT_WORK_TREE],
      ['GIT_INDEX_FILE', process.env.GIT_INDEX_FILE],
      ['GIT_OBJECT_DIRECTORY', process.env.GIT_OBJECT_DIRECTORY],
      ['GIT_ALTERNATE_OBJECT_DIRECTORIES', process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES],
      ['GIT_COMMON_DIR', process.env.GIT_COMMON_DIR],
      ['GIT_TRACE', process.env.GIT_TRACE],
    ])
    Object.assign(process.env, {
      GIT_DIR: join(redirectedRepository, '.git'),
      GIT_WORK_TREE: redirectedRepository,
      GIT_INDEX_FILE: join(redirectedRepository, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(redirectedRepository, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(redirectedRepository, '.git', 'objects'),
      GIT_COMMON_DIR: join(redirectedRepository, '.git'),
      GIT_TRACE: tracePath,
    })

    try {
      const result = await runReadOnlyGit(repository, ['ls-files', '-z'])
      expect(result.stdout.toString('utf8').split('\0').filter(Boolean)).toEqual(['expected.txt'])
      await expect(access(tracePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const [key, value] of inherited) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

async function createRepository(fileName: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-review-git-env-'))
  cleanup.push(directory)
  await git(directory, ['init'])
  await writeFile(join(directory, fileName), 'content\n', 'utf8')
  await git(directory, ['add', fileName])
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: resolve(cwd), windowsHide: true })
}
