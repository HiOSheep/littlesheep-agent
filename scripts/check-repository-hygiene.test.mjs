import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
})

/** A fixed clock keeps fixture commit metadata independent of the machine. */
const FIXTURE_CLOCK = Date.parse('2026-09-01T00:00:00Z')

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

/**
 * Paths reported under any named check, or null when that check passed. The gate
 * runs many checks, so a test about ONE rule has to read its own line instead of
 * the exit code: two unrelated fixture gaps (no tsconfig, no canonical docs)
 * would otherwise look like a failure of the rule under test.
 */
function failurePaths(stderr, label) {
  const prefix = `[fail] ${label}: `
  const line = stderr.split(/\r?\n/).find((entry) => entry.startsWith(prefix))
  if (!line) return null
  return line.slice(prefix.length).split(',').map((path) => path.trim()).filter(Boolean)
}

function hasFailure(stderr, label) {
  return stderr.includes(`[fail] ${label}`)
}

function git(root, args, { atSeconds = null } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: atSeconds === null
      ? GIT_ENV
      : {
        ...GIT_ENV,
        GIT_AUTHOR_DATE: `${atSeconds} +0000`,
        GIT_COMMITTER_DATE: `${atSeconds} +0000`,
      },
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function commitAll(root, message, atSeconds) {
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', message], { atSeconds })
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
  for (const category of ['decision', 'principles', 'taskbooks', 'reference']) {
    await mkdir(join(root, 'docs', category), { recursive: true })
  }
  await mkdir(join(root, 'packages', 'channels'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts', 'check-repository-hygiene.mjs'), await readFile(gateSource, 'utf8'))
  await writeFile(join(root, '.gitignore'), GITIGNORE)
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'packages/channels/*'\n")
  await writeFile(join(root, 'README.md'), '# 隔离夹具\n\n入口见 docs/README.md。\n')
  await writeFile(join(root, 'docs', 'README.md'), [
    '# 夹具文档',
    '',
    '## 当前阶段',
    '## 当前方向',
    '## 文档入口',
    '[decision](decision/README.md) [principles](principles/README.md) [taskbooks](taskbooks/README.md) [reference](reference/README.md)',
    '## 快速定位',
    '',
  ].join('\n'))
  await writeFile(join(root, 'docs', 'decision', 'README.md'), '# Decisions\n')
  await writeFile(join(root, 'docs', 'principles', 'README.md'), '# Principles\n')
  await writeFile(join(root, 'docs', 'taskbooks', 'README.md'), '# Taskbooks\n')
  await mkdir(join(root, 'docs', 'reference', 'nested'), { recursive: true })
  await writeFile(join(root, 'docs', 'reference', 'README.md'), '# References\n\nmodule-split-map.md\nnested/README.md\n')
  await writeFile(join(root, 'docs', 'reference', 'nested', 'README.md'), '# Nested reference\n\ndetail.md\n')
  await writeFile(join(root, 'docs', 'reference', 'nested', 'detail.md'), '# Detail\n\nNested fact.\n')
  await writeFile(join(root, 'docs', 'reference', 'module-split-map.md'), [
    '# 模块拆分地图',
    '',
    '本轮复查到期：2099-01-01',
    '',
  ].join('\n'))
  /**
   * One taskbook, because the gate fails when the whole `docs/taskbooks/` category
   * disappears. Its date identity is deliberately written WITHOUT seconds: the
   * removal under test is exactly that a formal document no longer has to carry
   * the second-precision stamp.
   */
  await mkdir(join(root, 'docs', 'taskbooks'), { recursive: true })
  await writeFile(join(root, 'docs', 'taskbooks', 'fixture-taskbook-2026-09-01.md'), [
    '# 夹具任务书 2026-09-01',
    '',
    '最后更新：2026-09-01',
    '',
    '正文。',
    '',
  ].join('\n'))
  await writeFile(join(root, 'docs', 'taskbooks', 'README.md'), '# Taskbooks\n\nfixture-taskbook-2026-09-01.md\n')
  git(root, ['init', '-q'])
  return root
}

/**
 * One package with a README, private source, and test, all committed.
 */
async function createPackageReaderRepository() {
  const root = await createScratchRepository()
  await writeFixture(root, ['packages/alpha', 'package.json', '{"name":"@fixture/alpha"}\n'])
  await writeFixture(root, ['packages/alpha', 'README.md', [
    '# 夹具包',
    '',
    '职责：夹具。',
    '',
  ].join('\n')])
  await writeFixture(root, ['packages/alpha/src', 'private-helper.ts', 'export const a = 1\n'])
  await writeFixture(root, ['packages/alpha/src', 'private-helper.test.ts', 'export const t = 1\n'])
  commitAll(root, 'fixture baseline', FIXTURE_CLOCK / 1000)
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

  /**
   * A private source, test, or style edit needs no corresponding README edit.
   */
  it('accepts a package source or test commit that does not touch the README', async () => {
    const root = await createPackageReaderRepository()
    try {
      const readmeBefore = await readFile(join(root, 'packages/alpha/README.md'), 'utf8')
      await writeFixture(root, ['packages/alpha/src', 'private-helper.ts', 'export const a = 2\n'])
      await writeFixture(root, ['packages/alpha/src', 'private-helper.test.ts', 'export const t = 2\n'])
      await writeFixture(root, ['packages/alpha/src', 'styles.css', '.a { color: red }\n'])
      commitAll(root, 'private helper, test and styles only', FIXTURE_CLOCK / 1000 + 3600)

      const result = runGate(root)
      // The README has no timestamp and stays byte-for-byte unchanged after a later source commit.
      expect(failurePaths(result.stderr, 'workspace package README 完整')).toBeNull()
      expect(hasFailure(result.stderr, '任务书文件名与基线日期有效')).toBe(false)
      expect(await readFile(join(root, 'packages/alpha/README.md'), 'utf8')).toBe(readmeBefore)
      expect(await readFile(gateSource, 'utf8')).not.toContain('requiredDomainReadmes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('still fails when an owned directory has no README, a link is broken, or a canonical path is missing', async () => {
    const root = await createPackageReaderRepository()
    try {
      await rm(join(root, 'packages/alpha/README.md'))
      await rm(join(root, 'docs', 'reference', 'module-split-map.md'))
      await writeFile(join(root, 'docs', 'reference', 'repository-guide.md'), '# 夹具指南\n')
      await writeFile(
        join(root, 'docs', 'README.md'),
        `${await readFile(join(root, 'docs', 'README.md'), 'utf8')}\n[断链](reference/missing-doc.md)\n`,
      )

      const result = runGate(root)
      expect(result.status).not.toBe(0)
      expect(
        failurePaths(result.stderr, 'workspace package README 完整') ?? [],
        `gate stderr:\n${result.stderr}`,
      ).toContain('packages/alpha')
      expect(
        failurePaths(result.stderr, 'Markdown 本地链接有效')?.join(' ') ?? '',
        `gate stderr:\n${result.stderr}`,
      ).toContain('reference/missing-doc.md')
      expect(
        failurePaths(result.stderr, '正式文档和维护脚本完整')?.join(' ') ?? '',
        `gate stderr:\n${result.stderr}`,
      ).toContain('docs/reference/plugin-development.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * The taskbook date is the one date identity that stays a rule, and the check
   * around it must survive documents that no longer carry the second-precision
   * form (dropping the time used to be a hard failure on every formal document).
   */
  it('accepts a taskbook whose stamp has no seconds and still rejects a wrong title date', async () => {
    const root = await createScratchRepository()
    try {
      const taskbook = join(root, 'docs', 'taskbooks', 'sample-taskbook-2026-09-01.md')
      await mkdir(join(root, 'docs', 'taskbooks'), { recursive: true })
      await writeFile(taskbook, '# 样例任务书 2026-09-01\n\n最后更新：2026-09-01\n\n正文。\n')
      const accepted = runGate(root)
      expect(hasFailure(accepted.stderr, '任务书文件名与基线日期有效')).toBe(false)

      await writeFile(taskbook, '# 样例任务书 2026-09-02\n\n最后更新：2026-09-01\n\n正文。\n')
      const rejected = runGate(root)
      expect(failurePaths(rejected.stderr, '任务书文件名与基线日期有效')?.join(' '))
        .toContain('一级标题日期应为 2026-09-01')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * Structure stays a gate even after growth became advice. A hotspot that no longer
   * exists (renamed, deleted, moved) is a broken baseline table, not a length opinion,
   * so it must still fail — otherwise "advisory" would have swallowed the difference
   * between "the file grew" and "the file is gone". The scratch repository cannot hold
   * the real hotspots, so this fixture is exactly the deleted-hotspot case.
   */
  it('keeps a structurally broken hotspot registration as a failure, not an advisory', async () => {
    const root = await createPackageReaderRepository()
    try {
      const result = runGate(root)
      expect(
        failurePaths(result.stderr, '热点登记文件仍存在') ?? [],
        `gate stderr:\n${result.stderr}`,
      ).toContain('packages/app/src/renderer/App.tsx: 文件不存在')
      expect(result.stdout).not.toContain('[advisory] 热点登记文件仍存在')

      // Growth past a registered ceiling is the advisory half. A scratch repository
      // cannot hold the real hotspots, so the fixture plants the whole registry with
      // one-line files and pushes App.tsx one line over its baseline: structure passes,
      // growth only advises. Keeping this list in step with the gate is deliberate —
      // a hotspot added without a fixture row fails this test instead of drifting.
      const hotspotPaths = [
        'packages/app/src/renderer/App.tsx',
        'packages/app/src/renderer/app-shell/use-app-controller.ts',
        'packages/app/src/renderer/chat/run-actions.ts',
        'packages/app/src/renderer/settings/plugins.tsx',
        'packages/app/src/renderer/ui/icons.tsx',
        'packages/app/src/renderer/workspace/file-navigator.tsx',
        'packages/app/src/renderer/workspace/panel.tsx',
        'packages/app/src/renderer/workspace/preview-pane.tsx',
        'packages/app/src/renderer/workspace/review.tsx',
        'packages/app/src/renderer/workspace/terminal.tsx',
        'packages/app/src/renderer/workspace/use-workspace-layout-controller.ts',
        'packages/app/src/main/local-app-api-server.ts',
        'packages/app/src/renderer/api.ts',
        'packages/memory-tree/src/memory-repository.ts',
        'packages/memory-tree/src/memory-service.ts',
        'packages/context/src/engine.ts',
        'packages/harness/src/stages/execute.ts',
        'packages/harness/src/stages/verify.ts',
        'packages/app/src/renderer/MemoryTreeView.tsx',
      ]
      for (const path of hotspotPaths) {
        await mkdir(join(root, dirname(path)), { recursive: true })
        await writeFile(join(root, path), 'export const placeholder = 1\n')
      }
      await writeFile(join(root, 'packages/app/src/renderer/App.tsx'), 'export const App = 1\n'.repeat(20))

      const grown = runGate(root)
      expect(failurePaths(grown.stderr, '热点登记文件仍存在')).toBeNull()
      expect(hasFailure(grown.stderr, '核心组合热点未继续增长')).toBe(false)
      expect(grown.stdout).toContain('[advisory] 核心组合热点未继续增长（提示，非硬门）')
      expect(grown.stdout).toContain('advisory')
      expect(failurePaths(grown.stderr, 'Git 未跟踪生成物')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
