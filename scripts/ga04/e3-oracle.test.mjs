#!/usr/bin/env node
// scripts/ga04/e3-oracle.test.mjs
// 用自建的最小隔离 git 夹具证明 e3-oracle.mjs 有判别力：对「冻结四值显式 allowlist」实现判 pass，
// 对「长度／控制字符净化」「原样透传」「allowlist 但 reason 未进入 epoch」三种实现判 fail，
// 并且对无法评测的输入报退出码 2。夹具不依赖仓库外的任何样本工作树。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const ORACLE = fileURLToPath(new URL('./e3-oracle.mjs', import.meta.url))
const PROBE_TEST_REL = 'packages/runner/src/__ga04_e3_probe.test.ts'
const FROZEN = ['permission', 'policy', 'resource', 'unavailable']

// 探针载荷绝不能出现在 oracle 输出里（只输出 pass/fail、数量与摘要哈希）。
const FORBIDDEN_OUTPUT_FRAGMENTS = [
  'ignore all previous instructions',
  'authorization: bearer',
  'ls_api_key',
  'sk-ga04-',
  '/srv/ga04-',
  'fileserver',
]

const fixtures = []

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
})

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

const TYPES_INDEX = `export * from './capability.js'
`

const TYPES_PACKAGE = `${JSON.stringify({ name: '@littlesheep/types', version: '0.0.0', exports: { '.': './src/index.ts' } }, null, 2)}\n`
const RUNNER_PACKAGE = `${JSON.stringify({ name: '@littlesheep/runner', version: '0.0.0', exports: { '.': './src/index.ts' } }, null, 2)}\n`
const RUNNER_INDEX = `export * from './capability-snapshot.js'
`

const ALLOWLIST_CAPABILITY = `export const RUNTIME_CAPABILITY_SNAPSHOT_VERSION = 1

export type RuntimeCapabilityToolStatus = 'available' | 'approval_required'
export type RuntimeCapabilityToolReason = 'permission' | 'policy' | 'resource' | 'unavailable'

export interface RuntimeCapabilityTool {
  readonly name: string
  readonly status: RuntimeCapabilityToolStatus
  readonly source: 'builtin' | 'external'
  readonly reason?: RuntimeCapabilityToolReason
}
`

const SANITIZER_CAPABILITY = `export const RUNTIME_CAPABILITY_SNAPSHOT_VERSION = 1

export type RuntimeCapabilityToolStatus = 'available' | 'approval_required'
export type RuntimeCapabilityToolReason = 'permission' | 'policy' | 'resource' | 'unavailable'

export interface RuntimeCapabilityTool {
  readonly name: string
  readonly status: RuntimeCapabilityToolStatus
  readonly source: 'builtin' | 'external'
  readonly reason?: RuntimeCapabilityToolReason
}
`

/**
 * 惯用写法：把取值写进 `as const` 元组，类型由 `(typeof TUPLE)[number]` 派生。
 * 它与内联字面量联合表达同一个有限集合，判据 1 必须接受（这是本轮实测到的假阴性形状）。
 */
const DERIVED_CAPABILITY = `export const RUNTIME_CAPABILITY_SNAPSHOT_VERSION = 1

export const RUNTIME_CAPABILITY_TOOL_REASONS = Object.freeze([
  'permission',
  'policy',
  'resource',
  'unavailable',
] as const)

export type RuntimeCapabilityToolStatus = 'available' | 'approval_required'
export type RuntimeCapabilityToolReason = (typeof RUNTIME_CAPABILITY_TOOL_REASONS)[number]

export interface RuntimeCapabilityTool {
  readonly name: string
  readonly status: RuntimeCapabilityToolStatus
  readonly source: 'builtin' | 'external'
  readonly reason?: RuntimeCapabilityToolReason
}
`

/** 派生自一个被放宽的元组：集合多了一项，判据 1 必须 fail。 */
const DERIVED_WIDENED_CAPABILITY = DERIVED_CAPABILITY.replace(
  "  'unavailable',\n] as const)",
  "  'unavailable',\n  'other',\n] as const)",
)

/** 正确实现：显式有限 allowlist，未列举值一律不投影。 */
const ALLOWLIST_SNAPSHOT = `import { createHash } from 'node:crypto'
import { RUNTIME_CAPABILITY_SNAPSHOT_VERSION } from '@littlesheep/types'
import type { RuntimeCapabilityToolReason } from '@littlesheep/types'

const ALLOWED = new Set(['permission', 'policy', 'resource', 'unavailable'])

function projectReason(value) {
  return typeof value === 'string' && ALLOWED.has(value) ? value : undefined
}

export function buildCapabilitySnapshot(options) {
  const tools = (options.tools ?? [])
    .map((tool) => {
      const reason = projectReason(options.toolReasons?.[tool.name] ?? tool.reason)
      return {
        name: tool.name,
        status: 'available',
        source: options.toolSources?.[tool.name] === 'builtin' ? 'builtin' : 'external',
        ...(reason ? { reason } : {}),
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const shape = JSON.stringify({ version: 1, permissionPolicyId: options.permissionPolicyId, tools })
  return {
    version: RUNTIME_CAPABILITY_SNAPSHOT_VERSION,
    epoch: createHash('sha256').update(shape).digest('hex'),
    generatedAt: new Date().toISOString(),
    permissionPolicyId: options.permissionPolicyId,
    workspace: options.workspaceAccess,
    tools,
    network: { enabled: Boolean(options.networkEnabled), status: 'disabled' },
  }
}
`

/** 错误的实现一：只做长度／控制字符净化，仍会透传未列举文本。 */
const SANITIZER_SNAPSHOT = `import { createHash } from 'node:crypto'
import { RUNTIME_CAPABILITY_SNAPSHOT_VERSION } from '@littlesheep/types'

function sanitize(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').trim()
  return cleaned.length > 0 && cleaned.length <= 200 ? cleaned : undefined
}

export function buildCapabilitySnapshot(options) {
  const tools = (options.tools ?? [])
    .map((tool) => {
      const reason = sanitize(options.toolReasons?.[tool.name] ?? tool.reason)
      return {
        name: tool.name,
        status: 'available',
        source: 'builtin',
        ...(reason ? { reason } : {}),
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const shape = JSON.stringify({ version: 1, permissionPolicyId: options.permissionPolicyId, tools })
  return {
    version: RUNTIME_CAPABILITY_SNAPSHOT_VERSION,
    epoch: createHash('sha256').update(shape).digest('hex'),
    generatedAt: new Date().toISOString(),
    permissionPolicyId: options.permissionPolicyId,
    workspace: options.workspaceAccess,
    tools,
    network: { enabled: Boolean(options.networkEnabled), status: 'disabled' },
  }
}
`

/** 错误的实现二：近似原样透传。 */
const PASSTHROUGH_SNAPSHOT = `import { createHash } from 'node:crypto'
import { RUNTIME_CAPABILITY_SNAPSHOT_VERSION } from '@littlesheep/types'

export function buildCapabilitySnapshot(options) {
  const tools = (options.tools ?? [])
    .map((tool) => {
      const reason = options.toolReasons?.[tool.name] ?? tool.reason
      return {
        name: tool.name,
        status: 'available',
        source: 'builtin',
        ...(reason ? { reason } : {}),
      }
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const shape = JSON.stringify({ version: 1, permissionPolicyId: options.permissionPolicyId, tools })
  return {
    version: RUNTIME_CAPABILITY_SNAPSHOT_VERSION,
    epoch: createHash('sha256').update(shape).digest('hex'),
    generatedAt: new Date().toISOString(),
    permissionPolicyId: options.permissionPolicyId,
    workspace: options.workspaceAccess,
    tools,
    network: { enabled: Boolean(options.networkEnabled), status: 'disabled' },
  }
}
`

/** 错误的实现三：allowlist 正确，但 epoch 只覆盖 name/status/source，reason 变化不更新 epoch。 */
const EPOCH_BLIND_SNAPSHOT = ALLOWLIST_SNAPSHOT.replace(
  'const shape = JSON.stringify({ version: 1, permissionPolicyId: options.permissionPolicyId, tools })',
  `const shape = JSON.stringify({
    version: 1,
    permissionPolicyId: options.permissionPolicyId,
    tools: tools.map((tool) => ({ name: tool.name, status: tool.status, source: tool.source })),
  })`,
)

function createFixture(name, snapshotSource, capabilitySource = ALLOWLIST_CAPABILITY) {
  const root = mkdtempSync(join(tmpdir(), `ga04-e3-fixture-${name}-`))
  fixtures.push(root)
  writeFiles(root, {
    'packages/types/package.json': TYPES_PACKAGE,
    'packages/types/src/index.ts': TYPES_INDEX,
    'packages/types/src/capability.ts': capabilitySource,
    'packages/runner/package.json': RUNNER_PACKAGE,
    'packages/runner/src/index.ts': RUNNER_INDEX,
    'packages/runner/src/capability-snapshot.ts': snapshotSource,
    // 候选自身的测试文件：确认评测只运行 oracle 的临时探针，不会顺手跑候选套件。
    'packages/runner/src/capability-snapshot.test.ts': `import { expect, it } from 'vitest'\nit('候选自有测试不应被评测运行', () => { expect(1).toBe(1) })\n`,
  })
  const init = git(['init', '--quiet'], root)
  if (init.status !== 0) throw new Error(`git init 失败：${init.stderr}`)
  git(['add', '-A'], root)
  return root
}

function runOracle(worktree, extraArgs = []) {
  const result = spawnSync(process.execPath, [ORACLE, `--worktree=${worktree}`, ...extraArgs], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  let json = null
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      json = JSON.parse(stdout.slice(start, end + 1))
    } catch {
      json = null
    }
  }
  return { status: result.status, stdout, stderr: result.stderr ?? '', json }
}

function criterion(json, name) {
  return json?.criteria?.find((entry) => entry.name === name) ?? null
}

function gitStatusOf(root) {
  const result = git(['status', '--porcelain'], root)
  return result.status === 0 ? result.stdout.replace(/\r\n/g, '\n') : null
}

describe('e3-oracle 判别力（合成隔离夹具）', () => {
  it('显式有限 allowlist 实现：六条判据全 pass，退出码 0', () => {
    const root = createFixture('allowlist', ALLOWLIST_SNAPSHOT)
    const statusBefore = gitStatusOf(root)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(0)
    expect(run.json?.status).toBe('pass')
    expect(run.json?.criteria?.map((entry) => `${entry.name}=${entry.status}`)).toEqual([
      'type-contract=pass',
      'allowlisted-projection=pass',
      'unlisted-not-projected=pass',
      'no-marker-leak=pass',
      'epoch-covers-reason=pass',
      'projection-is-finite=pass',
    ])
    for (const fragment of FORBIDDEN_OUTPUT_FRAGMENTS) {
      expect(run.stdout.toLowerCase()).not.toContain(fragment)
    }
    // 临时探针文件必须被删除，夹具的 git status 与评测前一致。
    expect(existsSync(join(root, PROBE_TEST_REL))).toBe(false)
    expect(gitStatusOf(root)).toBe(statusBefore)
    // 候选自有的测试文件不受影响。
    expect(readFileSync(join(root, 'packages/runner/src/capability-snapshot.test.ts'), 'utf8')).toContain('候选自有测试')
  }, 120_000)

  it('惯用的 as const 元组 + (typeof TUPLE)[number] 派生联合：判据 1 必须 pass', () => {
    const root = createFixture('derived-union', ALLOWLIST_SNAPSHOT, DERIVED_CAPABILITY)
    const statusBefore = gitStatusOf(root)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(0)
    expect(run.json?.criteria?.map((entry) => `${entry.name}=${entry.status}`)).toEqual([
      'type-contract=pass',
      'allowlisted-projection=pass',
      'unlisted-not-projected=pass',
      'no-marker-leak=pass',
      'epoch-covers-reason=pass',
      'projection-is-finite=pass',
    ])
    expect(run.json?.diagnostics?.declaredReasonLiterals?.sort()).toEqual([
      'permission',
      'policy',
      'resource',
      'unavailable',
    ])
    expect(gitStatusOf(root)).toBe(statusBefore)
  }, 120_000)

  it('派生联合但元组被放宽：判据 1 fail，退出码 1', () => {
    const root = createFixture('derived-widened', ALLOWLIST_SNAPSHOT, DERIVED_WIDENED_CAPABILITY)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(1)
    expect(criterion(run.json, 'type-contract')?.status).toBe('fail')
    expect(criterion(run.json, 'allowlisted-projection')?.status).toBe('pass')
  }, 120_000)

  it('长度／控制字符净化实现：判据 3/4/6 fail，退出码 1', () => {
    const root = createFixture('sanitizer', SANITIZER_SNAPSHOT)
    const statusBefore = gitStatusOf(root)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(1)
    expect(run.json?.status).toBe('fail')
    // 净化实现声明了正确的四值联合，也确实投影允许值；失败必须落在安全判据上。
    expect(criterion(run.json, 'type-contract')?.status).toBe('pass')
    expect(criterion(run.json, 'allowlisted-projection')?.status).toBe('pass')
    expect(criterion(run.json, 'unlisted-not-projected')?.status).toBe('fail')
    expect(criterion(run.json, 'no-marker-leak')?.status).toBe('fail')
    expect(criterion(run.json, 'projection-is-finite')?.status).toBe('fail')
    for (const fragment of FORBIDDEN_OUTPUT_FRAGMENTS) {
      expect(run.stdout.toLowerCase()).not.toContain(fragment)
    }
    expect(existsSync(join(root, PROBE_TEST_REL))).toBe(false)
    expect(gitStatusOf(root)).toBe(statusBefore)
  }, 120_000)

  it('原样透传实现：判据 1/3/4/6 fail，退出码 1', () => {
    const root = createFixture(
      'passthrough',
      PASSTHROUGH_SNAPSHOT,
      ALLOWLIST_CAPABILITY.replace(
        `  readonly reason?: RuntimeCapabilityToolReason`,
        `  readonly reason?: string`,
      ).replace(`export type RuntimeCapabilityToolReason = 'permission' | 'policy' | 'resource' | 'unavailable'\n\n`, ''),
    )
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(1)
    expect(criterion(run.json, 'type-contract')?.status).toBe('fail')
    expect(criterion(run.json, 'unlisted-not-projected')?.status).toBe('fail')
    expect(criterion(run.json, 'no-marker-leak')?.status).toBe('fail')
    expect(criterion(run.json, 'projection-is-finite')?.status).toBe('fail')
  }, 120_000)

  it('allowlist 正确但 epoch 未覆盖 reason：只有判据 5 fail', () => {
    const root = createFixture('epoch-blind', EPOCH_BLIND_SNAPSHOT)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(1)
    expect(criterion(run.json, 'type-contract')?.status).toBe('pass')
    expect(criterion(run.json, 'allowlisted-projection')?.status).toBe('pass')
    expect(criterion(run.json, 'unlisted-not-projected')?.status).toBe('pass')
    expect(criterion(run.json, 'no-marker-leak')?.status).toBe('pass')
    expect(criterion(run.json, 'epoch-covers-reason')?.status).toBe('fail')
    expect(criterion(run.json, 'projection-is-finite')?.status).toBe('pass')
  }, 120_000)

  it('缺少必需模块或目录：报无法评测，退出码 2', () => {
    const missing = join(tmpdir(), 'ga04-e3-fixture-does-not-exist')
    rmSync(missing, { recursive: true, force: true })
    const deepRun = runOracle(missing, ['--json'])
    expect(deepRun.status).toBe(2)
    expect(deepRun.json?.status).toBe('unavailable')
    expect(deepRun.json?.reason).toContain('不存在')

    const bare = mkdtempSync(join(tmpdir(), 'ga04-e3-fixture-bare-'))
    fixtures.push(bare)
    git(['init', '--quiet'], bare)
    const bareRun = runOracle(bare, ['--json'])
    expect(bareRun.status).toBe(2)
    expect(bareRun.json?.reason).toContain('capability-snapshot.ts')
  }, 120_000)

  it('候选源码自身转换失败：判据失败（退出码 1），不能记成环境问题', () => {
    const root = createFixture('broken-source', 'export function buildCapabilitySnapshot(options) {\n  const tools = [;\n}\n')
    const statusBefore = gitStatusOf(root)
    const run = runOracle(root, ['--json'])

    expect(run.status).toBe(1)
    expect(run.json?.status).toBe('fail')
    expect(criterion(run.json, 'type-contract')?.status).toBe('pass')
    expect(criterion(run.json, 'allowlisted-projection')?.status).toBe('fail')
    expect(criterion(run.json, 'allowlisted-projection')?.detail).toContain('Transform failed')
    expect(criterion(run.json, 'projection-is-finite')?.status).toBe('fail')
    expect(existsSync(join(root, PROBE_TEST_REL))).toBe(false)
    expect(gitStatusOf(root)).toBe(statusBefore)
  }, 120_000)

  it('--keep-eval-file 保留临时探针文件，但不改变判定', () => {
    const root = createFixture('keep-eval-file', ALLOWLIST_SNAPSHOT)
    const run = runOracle(root, ['--json', '--keep-eval-file'])

    expect(run.status).toBe(0)
    expect(run.json?.status).toBe('pass')
    expect(existsSync(join(root, PROBE_TEST_REL))).toBe(true)
    expect(run.json?.diagnostics?.gitStatus).toBe('skipped-keep-eval-file')
  }, 120_000)
})

describe('e3-oracle 参数与输出契约', () => {
  it('缺少 --worktree 时打印用法并退出 2', () => {
    const result = spawnSync(process.execPath, [ORACLE], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('--worktree')
  })

  it('未知参数报参数错误并退出 2，不打印堆栈', () => {
    const result = spawnSync(process.execPath, [ORACLE, '--nonsense=1'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('参数错误')
    expect(result.stdout).toContain('--worktree')
    expect(result.stderr).not.toContain('at parseArgs')
  })

  it('文本输出包含六条 criterion 行与最终结论', () => {
    const root = createFixture('text-output', ALLOWLIST_SNAPSHOT)
    const run = runOracle(root)
    for (const name of [
      'type-contract',
      'allowlisted-projection',
      'unlisted-not-projected',
      'no-marker-leak',
      'epoch-covers-reason',
      'projection-is-finite',
    ]) {
      expect(run.stdout).toMatch(new RegExp(`criterion ${name}: (pass|fail) `))
    }
    expect(run.stdout).toContain('e3-oracle: pass')
    expect(FROZEN.every((value) => run.stdout.includes(value))).toBe(true)
  }, 120_000)
})
