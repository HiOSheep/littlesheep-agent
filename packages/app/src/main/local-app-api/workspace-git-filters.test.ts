import { execFile } from 'node:child_process'
import { access, appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runReadOnlyGit } from './workspace-git-command.js'
import { readDisabledFilterOverrides } from './workspace-git-filters.js'

const execFileAsync = promisify(execFile)
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe('workspace Git filter hardening', () => {
  it('neutralizes repository clean filters while reading status and diffs', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'ls-review-filter-'))
    cleanup.push(repository)
    await git(repository, ['init'])
    await git(repository, ['config', 'user.email', 'review@example.test'])
    await git(repository, ['config', 'user.name', 'Review Test'])
    const marker = join(repository, 'filter-ran.marker')
    const script = join(repository, 'passthrough-filter.mjs')
    await writeFile(script, [
      "import { writeFileSync } from 'node:fs'",
      'const chunks = []',
      "process.stdin.on('data', (chunk) => chunks.push(chunk))",
      "process.stdin.on('end', () => { writeFileSync(process.argv[2], 'ran'); process.stdout.write(Buffer.concat(chunks)) })",
    ].join('\n'), 'utf8')
    await writeFile(join(repository, '.gitattributes'), 'tracked.txt filter=reviewevil\n', 'utf8')
    await writeFile(join(repository, 'tracked.txt'), 'base\n', 'utf8')
    const command = `node "${script.replace(/\\/gu, '/')}" "${marker.replace(/\\/gu, '/')}"`
    await git(repository, ['config', 'filter.reviewevil.clean', command])
    await git(repository, ['add', '.gitattributes', 'tracked.txt'])
    await git(repository, ['commit', '-m', 'initial'])
    await rm(marker, { force: true })
    await writeFile(join(repository, 'tracked.txt'), 'changed\n', 'utf8')

    const overrides = await readDisabledFilterOverrides(repository)
    expect(overrides).toContainEqual(['filter.reviewevil.clean', ''])
    await runReadOnlyGit(repository, ['status', '--porcelain=v1'], { configOverrides: overrides })
    await runReadOnlyGit(repository, ['diff', '--no-textconv', '--no-ext-diff'], { configOverrides: overrides })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when executable filter configuration exceeds its bound', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'ls-review-filter-limit-'))
    cleanup.push(repository)
    await git(repository, ['init'])
    const filterSections = Array.from({ length: 33 }, (_, index) => [
      `[filter "review-${index}"]`,
      '\tclean = cat',
      '',
    ].join('\n')).join('')
    await appendFile(join(repository, '.git', 'config'), `\n${filterSections}`, 'utf8')

    await expect(readDisabledFilterOverrides(repository))
      .rejects.toThrow('exceeds the safe review limit')
  })
})

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
