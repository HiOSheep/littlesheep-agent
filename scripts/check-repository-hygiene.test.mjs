import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const gateSource = fileURLToPath(new URL('./check-repository-hygiene.mjs', import.meta.url))

const GENERATED_LABEL = 'Git 未跟踪生成物'

/**
 * Generated artifacts that were actually committed to this repository and passed
 * every earlier gate: ten `cache-scope-matrix-*` scratch directories from an
 * interrupted harness run, plus Vite's bundled-config temp files. They are staged
 * with `git add -f` here on purpose — that is exactly how a file whose shape is
 * listed in `.gitignore` still ends up tracked (`git add -f`, a tool that ignores
 * `.gitignore`, or a checkout made before the rule existed), which is the case the
 * gate has to catch.
 */
const GENERATED_SHAPES = [
  ['cache-scope-matrix-Ab12Cd', 'entry.json', '{}'],
  ['cache-observation-store-Ab12Cd', 'entry.json', '{}'],
  ['.', 'vitest.config.ts.timestamp-1758799775433-34d9cdd2b46f2.mjs', 'export default {}\n'],
  ['packages/app', 'electron.vite.config.1790498847415.mjs', 'export default {}\n'],
]

/**
 * Names that merely look like the generated shapes. They are real sources and
 * stay tracked: the patterns must reject the artifact, not the basename family.
 */
const LOOKALIKE_SOURCES = [
  ['packages/harness/src', 'cache-observation-store.ts', 'export const store = 1\n'],
  ['packages/harness/src', 'cache-scope-isolation-matrix.test.ts', 'export const matrix = 1\n'],
  ['.', 'vitest.config.ts', 'export default {}\n'],
  ['packages/app', 'electron.vite.config.ts', 'export default {}\n'],
]

const GITIGNORE = [
  'packages/app/out/',
  'dist/',
  '*.tsbuildinfo',
  'cache-scope-matrix-*/',
  'cache-observation-store-*/',
  'vitest.config.ts.timestamp-*.mjs',
  'electron.vite.config.*.mjs',
  '',
].join('\n')

async function writeFixture(root, [directory, name, content]) {
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(join(root, directory, name), content)
}

function trackedPath([directory, name]) {
  return directory === '.' ? name : `${directory}/${name}`
}

/**
 * The tracked paths the gate reported under the generated-artifact label, or null
 * when it reported none. Comparing this list instead of raw stderr substrings
 * matters: `vitest.config.ts.timestamp-….mjs` (generated) contains the name of
 * `vitest.config.ts` (a real config), so a substring test would report a false
 * positive for the look-alike.
 */
function generatedFailurePaths(stderr) {
  const prefix = `[fail] ${GENERATED_LABEL}: `
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith(prefix))
  if (!line) return null
  return line.slice(prefix.length).split(',').map((path) => path.trim()).filter(Boolean)
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function runGate(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-repository-hygiene.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
}

/**
 * The gate always inspects the repository that contains the script, so the only
 * way to answer "would this shape fail the gate?" without touching this
 * repository is to copy the gate into a throwaway repository and run it there.
 * The throwaway carries the minimum surface the earlier checks read, because the
 * gate collects failures and prints them at the end — an exception on a missing
 * file would hide the failure under test.
 */
async function createScratchRepository() {
  const root = await mkdtemp(join(tmpdir(), 'ls-hygiene-'))
  await mkdir(join(root, 'docs', 'reference'), { recursive: true })
  await mkdir(join(root, 'packages', 'channels'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts', 'check-repository-hygiene.mjs'), await readFile(gateSource, 'utf8'))
  await writeFile(join(root, '.gitignore'), GITIGNORE)
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'packages/channels/*'\n")
  await writeFile(join(root, 'README.md'), '# 隔离夹具\n\n最后更新：2026-09-27 00:00:00\n\n入口见 docs/README.md。\n')
  await writeFile(join(root, 'docs', 'README.md'), [
    '# 夹具文档',
    '',
    '最后更新：2026-09-27 00:00:00',
    '',
    '## 现在先做什么',
    '## 需要确认依据时',
    '## 需要修改长期方向时',
    '## 已决定方向后再看任务书',
    '## 需要定位代码或维护仓库时',
    '',
  ].join('\n'))
  await writeFile(join(root, 'docs', 'reference', 'module-split-map.md'), [
    '# 模块拆分地图',
    '',
    '最后更新：2026-09-27 00:00:00',
    '',
    '本轮复查到期：2099-01-01',
    '',
  ].join('\n'))
  git(root, ['init', '-q'])
  return root
}

describe('repository hygiene gate', () => {
  it('fails on tracked generated artifacts in an isolated repository', async () => {
    const root = await createScratchRepository()
    try {
      for (const source of LOOKALIKE_SOURCES) await writeFixture(root, source)
      git(root, ['add', '-A'])

      const clean = runGate(root)
      expect(generatedFailurePaths(clean.stderr)).toBeNull()
      expect(git(root, ['ls-files'])).toContain('packages/harness/src/cache-observation-store.ts')

      for (const shape of GENERATED_SHAPES) await writeFixture(root, shape)
      git(root, ['add', '-f', ...GENERATED_SHAPES.map(([directory, name]) => join(directory, name))])

      const tracked = git(root, ['ls-files'])
      for (const shape of GENERATED_SHAPES) {
        expect(tracked.replaceAll('\\', '/')).toContain(trackedPath(shape))
      }

      const polluted = runGate(root)
      expect(polluted.status).not.toBe(0)
      // Exactly the generated shapes fail, and none of the look-alike sources
      // (which stay tracked) is caught by the same patterns.
      expect(generatedFailurePaths(polluted.stderr)?.sort())
        .toEqual(GENERATED_SHAPES.map(trackedPath).sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
