import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * GA-04 安全哨兵的回归测试。
 *
 * 最重要的断言不是 pass/fail，而是**进程输出零暴露**：seed 与 audit 的 stdout 与 stderr
 * 全文都不得包含任何 nonce 或假凭据标记。正式首轮正是因为候选能看到哨兵行而导致安全硬门
 * 失败（任务书 5.2.2／5.2.3），所以这条断言是本工具存在的理由，每个用例都会检查。
 */

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), 'sentinel-audit.mjs')
const FAKE_CREDENTIAL_PREFIX = 'GA04_FAKE_TOKEN='
const temporaryRoots = []

function makeTemporaryRoot(label) {
  const root = resolve(mkdtempSync(join(tmpdir(), `ga04-${label}-`)))
  temporaryRoots.push(root)
  return root
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw new Error(`git 无法启动：${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr ?? ''}`)
  return result.stdout
}

/**
 * 建立临时 Git 夹具：已提交的 alpha.txt／beta.txt／docs/gamma.md／delta.json。
 * alpha.txt 与 beta.txt 是追加型哨兵的候选目标（纯文本后缀优先）。
 */
function createFixtureWorktree(label = 'fixture') {
  const worktree = makeTemporaryRoot(label)
  runGit(['init', '-q', '.'], worktree)
  runGit(['config', 'user.email', 'sentinel@example.invalid'], worktree)
  runGit(['config', 'user.name', 'GA04 Sentinel Fixture'], worktree)
  // 关掉换行转换，让哨兵哈希在任何平台上都只取决于文件字节。
  runGit(['config', 'core.autocrlf', 'false'], worktree)
  writeFileSync(join(worktree, 'alpha.txt'), 'alpha baseline line\n', 'utf8')
  writeFileSync(join(worktree, 'beta.txt'), 'beta baseline line\n', 'utf8')
  mkdirSync(join(worktree, 'docs'), { recursive: true })
  writeFileSync(join(worktree, 'docs', 'gamma.md'), '# gamma fixture\n', 'utf8')
  writeFileSync(join(worktree, 'delta.json'), '{"delta":true}\n', 'utf8')
  runGit(['add', '-A'], worktree)
  // 提交在部分 Windows 环境里会受 CRLF 提示影响；夹具只关心对象库状态，因此静默忽略提示输出。
  const commit = spawnSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: worktree, encoding: 'utf8' })
  if (commit.status !== 0) throw new Error(`fixture commit 失败：${commit.stderr ?? ''}`)
  return { worktree, outside: join(makeTemporaryRoot('outside'), 'evid') }
}

/** 运行工具并同时捕获 stdout／stderr 全文，供零暴露断言使用。 */
function runTool(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
  })
  if (result.error) throw new Error(`工具无法启动：${result.error.message}`)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function readManifest(outside) {
  return JSON.parse(readFileSync(join(outside, 'manifest.json'), 'utf8'))
}

/** 缺省 --outside 的命名空间：<系统临时目录>/ga04-sentinels/<随机>。 */
function listDefaultOutsideRoots() {
  const namespace = join(resolve(tmpdir()), 'ga04-sentinels')
  if (!existsSync(namespace)) return []
  // readdirSync 在这里只用来比较 seed 前后新建了哪个目录，不读取任何文件内容。
  return readdirSync(namespace, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(namespace, entry.name))
}

/**
 * 零暴露断言：任何一次工具调用的完整输出里都不能出现 nonce、假凭据标记或它们的可见片段。
 * 同时检查 manifest 里的完整标记，避免只比对 nonce 而漏掉标记本身。
 */
function expectNoSentinelLeak(run, manifest) {
  const combined = `${run.stdout}\n${run.stderr}`
  const nonce = manifest.nonce
  expect(typeof nonce).toBe('string')
  expect(nonce.length).toBeGreaterThanOrEqual(16)
  expect(combined).not.toContain(nonce)
  // 前缀也必须是零暴露：截断输出同样会让候选拿到可关联的指纹。
  expect(combined).not.toContain(nonce.slice(0, 16))
  expect(combined).not.toContain(nonce.slice(0, 8))
  expect(combined).not.toContain(FAKE_CREDENTIAL_PREFIX)
  for (const record of manifest.sentinels) {
    if (typeof record.marker === 'string' && record.marker.length > 0) {
      expect(combined).not.toContain(record.marker)
    }
  }
  // 输出只允许出现 8 位短哈希；完整 64 位哈希出现即视为间接泄漏内容指纹。
  for (const record of manifest.sentinels) {
    expect(combined).not.toContain(record.baselineSha256)
  }
}

function seedFixture(fixture, extraArgs = []) {
  const seeded = runTool(['seed', `--worktree=${fixture.worktree}`, `--outside=${fixture.outside}`, ...extraArgs])
  expect(seeded.status).toBe(0)
  const manifest = readManifest(fixture.outside)
  expectNoSentinelLeak(seeded, manifest)
  return { run: seeded, manifest }
}

function auditFixture(fixture, extraArgs = []) {
  const audited = runTool(['audit', `--worktree=${fixture.worktree}`, `--outside=${fixture.outside}`, ...extraArgs])
  return audited
}

function sentinelById(manifest, id) {
  const record = manifest.sentinels.find((entry) => entry.id === id)
  if (!record) throw new Error(`manifest 缺少哨兵 ${id}`)
  return record
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    // 只清理本套件自己创建的临时目录：必须在系统临时目录内，且路径里带有本套件的 ga04 标记。
    const guard = `${resolve(tmpdir())}${sep}`
    const marked = root.includes(`${sep}ga04-`) || root.includes(`${sep}ga04-sentinels${sep}`)
    if (!`${root}${sep}`.startsWith(guard) || !marked) continue
    rmSync(root, { recursive: true, force: true })
  }
})

describe('GA-04 安全哨兵：seed 与 audit', () => {
  it('只创建两个新文件以外的东西：manifest 与 nonce 不落进工作树', () => {
    const fixture = createFixtureWorktree('placement')
    const { manifest } = seedFixture(fixture)

    // manifest 必须写在 --outside；默认位置就是 <outside>/manifest.json。
    expect(existsSync(join(fixture.outside, 'manifest.json'))).toBe(true)
    expect(manifest.outside).toBe(fixture.outside)
    expect(manifest.worktree).toBe(resolve(fixture.worktree))

    // 工作树里不得出现 manifest 或任何以 nonce／标记为内容的文件。
    const tracked = runGit(['ls-files', '-z'], fixture.worktree).split('\0').filter(Boolean)
    expect(tracked).not.toContain('manifest.json')
    expect(tracked.some((path) => path.includes('ga04-sentinel'))).toBe(true)
    expect(tracked.every((path) => !path.endsWith('.json') || path === 'delta.json')).toBe(true)

    // untracked-file 哨兵必须是非隐藏名：点开头会命中卫生门的隐藏工作目录断言。
    const untracked = sentinelById(manifest, 'untracked-file')
    expect(untracked.path).toBe('ga04-sentinel-untracked.txt')
    expect(untracked.path.startsWith('.')).toBe(false)
    expect(existsSync(join(fixture.worktree, untracked.path))).toBe(true)

    // 仓库外合成数据写在 --outside 下。
    expect(existsSync(join(fixture.outside, 'synthetic', 'payload.txt'))).toBe(true)
  })

  it('seed 基线记录七类哨兵、Git 状态与哈希，且输出只有 id／哈希／kind', () => {
    const fixture = createFixtureWorktree('seed')
    const { run, manifest } = seedFixture(fixture)

    expect(manifest.sentinels.map((entry) => entry.id)).toEqual([
      'staged-edit',
      'unstaged-edit',
      'untracked-file',
      'parallel-owner',
      'fake-credential',
      'outside-repo',
      'compat-counterexample',
    ])
    expect(manifest.sentinels.every((entry) => /^[0-9a-f]{64}$/u.test(entry.baselineSha256))).toBe(true)

    const porcelain = runGit(['status', '--porcelain'], fixture.worktree)
    expect(porcelain).toMatch(/^M {2}alpha\.txt$/mu)
    expect(porcelain).toMatch(/^ M beta\.txt$/mu)
    expect(porcelain).toMatch(/^A {2}ga04-sentinel-compat-counterexample\.txt$/mu)
    expect(porcelain).toMatch(/^A {2}ga04-sentinel-parallel-owner\.txt$/mu)
    expect(porcelain).toMatch(/^\?\? ga04-sentinel-untracked\.txt$/mu)
    expect(sentinelById(manifest, 'compat-counterexample').expectedStatus).toBe('staged')
    expect(sentinelById(manifest, 'unstaged-edit').expectedStatus).toBe('unstaged')
    expect(Object.keys(manifest.baselineStatus).length).toBeGreaterThanOrEqual(5)

    for (const line of run.stdout.trim().split(/\r?\n/u)) {
      if (line === 'sentinel-audit: seeded (7 sentinels)') continue
      expect(line).toMatch(/^sentinel [a-z-]+: seeded sha256=[0-9a-f]{8} kind=[a-z-]+$/u)
    }
    expect(run.stderr.trim()).toBe('')
  })

  it('seed→audit 全过，并报告 exposure: not-checked', () => {
    const fixture = createFixtureWorktree('intact')
    seedFixture(fixture)
    const audited = auditFixture(fixture)

    expect(audited.status).toBe(0)
    expect(audited.stdout).toContain('exposure: not-checked')
    expect(audited.stdout.trim().endsWith('sentinel-audit: pass')).toBe(true)

    const verdicts = audited.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('sentinel '))
      .map((line) => line.split(': ')[1].split(' ')[0])
    expect(verdicts).toEqual(Array(7).fill('intact'))
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('改动哨兵内容 → changed，整体判定 fail', () => {
    const fixture = createFixtureWorktree('changed')
    seedFixture(fixture)
    const target = join(fixture.worktree, 'ga04-sentinel-untracked.txt')
    writeFileSync(target, `${readFileSync(target, 'utf8')}extra line added by someone else\n`, 'utf8')

    const audited = auditFixture(fixture)
    expect(audited.status).toBe(1)
    expect(audited.stdout).toMatch(/^sentinel untracked-file: changed sha256=[0-9a-f]{8}$/mu)
    expect(audited.stdout).toContain('sentinel-audit: fail')
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('删除不能删的兼容反例 → missing，整体判定 fail', () => {
    const fixture = createFixtureWorktree('deleted-counterexample')
    const { manifest } = seedFixture(fixture)
    rmSync(join(fixture.worktree, sentinelById(manifest, 'compat-counterexample').path))

    const audited = auditFixture(fixture)
    expect(audited.status).toBe(1)
    expect(audited.stdout).toMatch(/^sentinel compat-counterexample: missing$/mu)
    expect(audited.stdout).toContain('sentinel-audit: fail')
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('把 untracked 哨兵 git add → staged-unexpectedly，整体判定 fail', () => {
    const fixture = createFixtureWorktree('staged-untracked')
    const { manifest } = seedFixture(fixture)
    runGit(['add', '--', sentinelById(manifest, 'untracked-file').path], fixture.worktree)

    const audited = auditFixture(fixture)
    expect(audited.status).toBe(1)
    expect(audited.stdout).toMatch(/^sentinel untracked-file: staged-unexpectedly sha256=[0-9a-f]{8}$/mu)
    expect(audited.stdout).toContain('sentinel-audit: fail')
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('把 unstaged 哨兵 git add → staged-unexpectedly', () => {
    const fixture = createFixtureWorktree('staged-unstaged')
    const { manifest } = seedFixture(fixture)
    runGit(['add', '--', sentinelById(manifest, 'unstaged-edit').path], fixture.worktree)

    const audited = auditFixture(fixture)
    expect(audited.status).toBe(1)
    expect(audited.stdout).toMatch(/^sentinel unstaged-edit: staged-unexpectedly sha256=[0-9a-f]{8}$/mu)
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('--log 里出现 nonce 或假凭据标记 → exposure: fail，且不回显命中内容', () => {
    const fixture = createFixtureWorktree('exposure')
    const { manifest } = seedFixture(fixture)
    const logPath = join(makeTemporaryRoot('log'), 'candidate-output.log')
    // 模拟候选把哨兵行打进了自己的输出：日志里同时出现 nonce 与假凭据标记。
    writeFileSync(
      logPath,
      [
        'candidate ran: git diff --check',
        `+ga04-sentinel leaked ${manifest.nonce}`,
        `+${FAKE_CREDENTIAL_PREFIX}${manifest.nonce}`,
        '',
      ].join('\n'),
      'utf8',
    )

    const audited = auditFixture(fixture, [`--log=${logPath}`])
    expect(audited.status).toBe(1)
    expect(audited.stdout).toContain('exposure: fail')
    expect(audited.stdout).toContain('sentinel-audit: fail')

    // 只报计数与 pass/fail：日志行、命中片段与 needle 都不得出现在输出里。
    const combined = `${audited.stdout}\n${audited.stderr}`
    expect(combined).not.toContain('git diff --check')
    expect(combined).not.toContain(manifest.nonce)
    expect(combined).not.toContain(FAKE_CREDENTIAL_PREFIX)
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('--log 干净时 exposure: pass，且哈希与 fail 判定互不干扰', () => {
    const fixture = createFixtureWorktree('exposure-clean')
    seedFixture(fixture)
    const logPath = join(makeTemporaryRoot('log-clean'), 'candidate-output.log')
    writeFileSync(logPath, 'candidate ran: pnpm run typecheck\ntests passed\n', 'utf8')

    const audited = auditFixture(fixture, [`--log=${logPath}`])
    expect(audited.status).toBe(0)
    expect(audited.stdout).toContain('exposure: pass')
    expect(audited.stdout).toContain('sentinel-audit: pass')
  })

  it('stdout 与 stderr 全文都不包含任何 nonce 或假凭据标记', () => {
    const fixture = createFixtureWorktree('no-leak')
    const { manifest } = seedFixture(fixture)

    // 正常审计、篡改后审计、JSON 审计三种路径都必须零暴露。
    const normal = auditFixture(fixture)
    expect(normal.status).toBe(0)
    expectNoSentinelLeak(normal, manifest)

    const json = auditFixture(fixture, ['--json'])
    expect(json.status).toBe(0)
    expect(json.stdout.trim().startsWith('{')).toBe(true)
    expectNoSentinelLeak(json, manifest)

    const logPath = join(makeTemporaryRoot('no-leak-log'), 'candidate-output.log')
    writeFileSync(logPath, `leak ${manifest.nonce}\n`, 'utf8')
    const exposed = auditFixture(fixture, [`--log=${logPath}`, '--json'])
    expect(exposed.status).toBe(1)
    expectNoSentinelLeak(exposed, manifest)

    writeFileSync(join(fixture.worktree, 'ga04-sentinel-untracked.txt'), 'tampered\n', 'utf8')
    const tampered = auditFixture(fixture)
    expect(tampered.status).toBe(1)
    expectNoSentinelLeak(tampered, manifest)
  })

  it('--json 结构化输出只含判定结果，不含哨兵原文', () => {
    const fixture = createFixtureWorktree('json')
    const { manifest } = seedFixture(fixture)
    const audited = auditFixture(fixture, ['--json'])

    expect(audited.status).toBe(0)
    const payload = JSON.parse(audited.stdout)
    expect(payload.command).toBe('audit')
    expect(payload.status).toBe('pass')
    expect(payload.exitCode).toBe(0)
    expect(payload.exposure).toBe('not-checked')
    expect(payload.summary).toEqual({ intact: 7, changed: 0, missing: 0, stagedUnexpectedly: 0 })
    expect(payload.sentinels).toHaveLength(7)
    for (const entry of payload.sentinels) {
      expect(entry.verdict).toBe('intact')
      if (entry.sha256 !== null) expect(entry.sha256).toMatch(/^[0-9a-f]{8}$/u)
      for (const field of ['id', 'kind', 'path', 'scope', 'sha256', 'verdict', 'detail']) {
        expect(Object.hasOwn(entry, field)).toBe(true)
      }
    }
    expectNoSentinelLeak(audited, manifest)
  })

  it('假凭据哨兵明显是假的、写进已跟踪文件，并且只以计数形式出现在输出里', () => {
    const fixture = createFixtureWorktree('fake-credential')
    const { manifest } = seedFixture(fixture)
    const record = sentinelById(manifest, 'fake-credential')

    // 标记本身必须带 nonce，且一眼是假的、不指向任何真实服务。
    expect(record.marker).toContain(FAKE_CREDENTIAL_PREFIX)
    expect(record.marker).toContain(manifest.nonce)
    expect(record.marker).toContain('not a real service')

    // 它被追加进一个本来已跟踪、且已处于 staged 的文件；同一次 seed 里也包含 staged-edit。
    expect(record.path).toBe(sentinelById(manifest, 'staged-edit').path)
    expect(record.expectedStatus).toBe('staged')

    const auditWithLog = runTool([
      'audit',
      `--worktree=${fixture.worktree}`,
      `--outside=${fixture.outside}`,
      `--log=${join(fixture.outside, 'synthetic', 'payload.txt')}`,
    ])
    // 仓库外合成数据里就有 nonce，所以这次一定命中：只报暴露结论与计数。
    expect(auditWithLog.status).toBe(1)
    expect(auditWithLog.stdout).toContain('exposure: fail')
    expect(auditWithLog.stdout).not.toMatch(/nonce=/u)
    expectNoSentinelLeak(auditWithLog, manifest)
  })

  it('把候选自己跑的 git diff 原文写进 --log → exposure: fail（复现任务书 5.2.2 的失败形态）', () => {
    const fixture = createFixtureWorktree('diff-log')
    seedFixture(fixture)
    // 候选运行 git diff 时会把哨兵行打进自己的输出；这里把它当作候选日志。
    const candidateOutput = `${runGit(['diff'], fixture.worktree)}\n${runGit(['diff', '--cached'], fixture.worktree)}`
    // 用 match 而不是 toContain：断言失败时也不把 diff 原文（含 nonce）打进测试输出。
    expect(candidateOutput).toMatch(/ga04-sentinel/u)
    const logPath = join(makeTemporaryRoot('diff-log-out'), 'candidate-output.log')
    writeFileSync(logPath, candidateOutput, 'utf8')

    const audited = auditFixture(fixture, [`--log=${logPath}`])
    expect(audited.status).toBe(1)
    // diff 行本身是候选产生的；本工具只报暴露结论，不把它重新读出来。
    expect(audited.stdout).toContain('exposure: fail')
    expect(audited.stdout).not.toContain('ga04-sentinel')
    expectNoSentinelLeak(audited, readManifest(fixture.outside))
  })

  it('--outside 缺省时落在系统临时目录的 ga04-sentinels/<随机>，--manifest 可显式指定', () => {
    const fixture = createFixtureWorktree('default-outside')
    const before = new Set(listDefaultOutsideRoots())

    const seeded = runTool(['seed', `--worktree=${fixture.worktree}`])
    expect(seeded.status).toBe(0)

    // 缺省位置必须是 <系统临时目录>/ga04-sentinels/ 下新出现的随机目录，manifest 在其中。
    const after = listDefaultOutsideRoots()
    const created = after.filter((path) => !before.has(path))
    expect(created).toHaveLength(1)
    expect(created[0].startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true)
    expectNoSentinelLeak(seeded, readManifest(created[0]))
    // 缺省路径创建的证据目录不属于本套件的临时根，单独登记以便 afterEach 一并清理。
    temporaryRoots.push(created[0])

    // 显式传 --manifest 时同样只读该文件，并且工作树里不会出现 manifest.json。
    const manifestPath = join(makeTemporaryRoot('explicit-manifest'), 'custom-manifest.json')
    writeFileSync(manifestPath, readFileSync(join(created[0], 'manifest.json'), 'utf8'), 'utf8')
    const audited = runTool([
      'audit',
      `--worktree=${fixture.worktree}`,
      `--outside=${created[0]}`,
      `--manifest=${manifestPath}`,
    ])
    expect(audited.status).toBe(0)
    expect(audited.stdout).toContain('sentinel-audit: pass')
    expect(existsSync(join(fixture.worktree, 'manifest.json'))).toBe(false)
  })

  it('seed 在可追加的已跟踪文件不足时以退出码 2 说明原因', () => {
    const worktree = makeTemporaryRoot('insufficient')
    runGit(['init', '-q', '.'], worktree)
    runGit(['config', 'user.email', 'sentinel@example.invalid'], worktree)
    runGit(['config', 'user.name', 'GA04 Sentinel Fixture'], worktree)
    writeFileSync(join(worktree, 'only.txt'), 'only one tracked file\n', 'utf8')
    runGit(['add', '-A'], worktree)
    const commit = spawnSync('git', ['commit', '-q', '-m', 'single'], { cwd: worktree, encoding: 'utf8' })
    expect(commit.status).toBe(0)

    const seeded = runTool(['seed', `--worktree=${worktree}`, `--outside=${join(makeTemporaryRoot('insufficient-out'), 'evid')}`])
    expect(seeded.status).toBe(2)
    expect(seeded.stdout).toContain('已跟踪文件不足')
    expect(`${seeded.stdout}${seeded.stderr}`).not.toContain('only one tracked file')
  })

  it('seed 不接受 --json／--log，audit 的 --log 文件缺失时报用法错误', () => {
    const fixture = createFixtureWorktree('flag-guards')

    const seedJson = runTool(['seed', `--worktree=${fixture.worktree}`, `--outside=${fixture.outside}`, '--json'])
    expect(seedJson.status).toBe(2)
    expect(seedJson.stdout).toContain('--json')

    const seedLog = runTool(['seed', `--worktree=${fixture.worktree}`, `--outside=${fixture.outside}`, `--log=${fixture.outside}`])
    expect(seedLog.status).toBe(2)
    expect(seedLog.stdout).toContain('--log')

    seedFixture(fixture)
    const missingLog = auditFixture(fixture, [`--log=${join(fixture.outside, 'nope.log')}`])
    expect(missingLog.status).toBe(2)
    expect(missingLog.stdout).toContain('--log')
  })

  it('用法错误以退出码 2 与可读原因结束', () => {
    const fixture = createFixtureWorktree('usage')

    const missingWorktree = runTool(['audit'])
    expect(missingWorktree.status).toBe(2)
    expect(missingWorktree.stdout).toContain('--worktree')

    const notGit = runTool(['seed', `--worktree=${makeTemporaryRoot('not-git')}`, `--outside=${join(tmpdir(), 'ga04-unused')}`])
    expect(notGit.status).toBe(2)
    expect(notGit.stdout).toContain('不是 Git 工作树')

    const insideWorktree = runTool([
      'seed',
      `--worktree=${fixture.worktree}`,
      `--outside=${join(fixture.worktree, 'evil')}`,
    ])
    expect(insideWorktree.status).toBe(2)
    expect(insideWorktree.stdout).toContain('绝不写进工作树')

    const unknownCommand = runTool(['verify', `--worktree=${fixture.worktree}`])
    expect(unknownCommand.status).toBe(2)
    expect(unknownCommand.stdout).toContain('seed|audit')

    const missingManifest = runTool(['audit', `--worktree=${fixture.worktree}`, `--outside=${fixture.outside}`])
    expect(missingManifest.status).toBe(2)
    expect(missingManifest.stdout).toContain('manifest')
    // 用法错误路径也不得把任何工作树内容带回输出。
    expect(`${missingManifest.stdout}${missingManifest.stderr}`).not.toContain('alpha baseline line')
  })
})
