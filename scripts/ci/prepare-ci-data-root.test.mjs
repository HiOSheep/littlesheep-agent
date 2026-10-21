// Tests for the CI synthetic data-root bootstrap.
//
// The bootstrap writes and deletes directories, so its refusals are as
// important as its output: it must never touch a real data root or the
// repository checkout.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = fileURLToPath(new URL('./prepare-ci-data-root.mjs', import.meta.url))
const auditPath = fileURLToPath(new URL('../verify-app-recovery-sources.mjs', import.meta.url))
const fixtures = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ls-ci-data-root-'))
  fixtures.push(root)
  return join(root, 'synthetic')
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('synthetic CI data root bootstrap', () => {
  it('creates an isolated root the recovery source audit accepts', async () => {
    const root = await makeRoot()
    const prepared = run([`--root=${root}`, '--json'])
    expect(prepared.status, prepared.stderr).toBe(0)
    const summary = JSON.parse(prepared.stdout)
    expect(summary.synthetic).toBe(true)
    expect(summary.remark).toContain('not real user-data recovery evidence')
    expect(summary.minFreeMib).toBe(2048)
    expect(existsSync(summary.env.LITTLESHEEP_DATA_DIR)).toBe(true)
    expect(existsSync(summary.env.LITTLESHEEP_RUN_ARTIFACTS_DIR)).toBe(true)
    expect(existsSync(summary.logsDir)).toBe(true)
    expect(existsSync(summary.metadataPath)).toBe(true)

    const metadata = JSON.parse(await readFile(summary.metadataPath, 'utf8'))
    expect(metadata.schemaVersion).toBe(1)
    expect(metadata.synthetic).toBe(true)
    expect(metadata.generatedBy).toBe('scripts/ci/prepare-ci-data-root.mjs')
    expect(metadata.toolchain.node).toBe(process.version)
    expect(metadata.toolchain.pnpm).toMatch(/^\d+\.\d+\.\d+$/u)
    // Read from the lockfile: the bootstrap runs before dependency installation.
    expect(metadata.toolchain.electron).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(metadata.paths.dataDir).toBe(summary.dataDir)
    expect(metadata.paths.runArtifactsDir).toBe(summary.runArtifactsDir)
    expect(metadata.paths.logsDir).toBe(summary.logsDir)
    expect(metadata.freeDiskAtStart.freeMiB).toBeGreaterThan(0)
    expect(metadata.freeDiskAtStart.minFreeMib).toBe(2048)

    const audit = spawnSync(process.execPath, [auditPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        LITTLESHEEP_DATA_DIR: summary.env.LITTLESHEEP_DATA_DIR,
        LITTLESHEEP_DATA_LOCATOR: summary.env.LITTLESHEEP_DATA_LOCATOR,
      },
    })
    expect(audit.status, audit.stdout + audit.stderr).toBe(0)
    expect(audit.stdout).toContain('LittleSheep recovery sources: ok')
  })

  it('records the GitHub run context in the run metadata', async () => {
    const root = await makeRoot()
    const prepared = run([`--root=${root}`, '--json'], {
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_WORKFLOW: 'CI Full Gate',
      GITHUB_JOB: 'full-gate',
      GITHUB_SHA: '0123456789abcdef',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_EVENT_NAME: 'push',
      RUNNER_NAME: 'runner-x',
    })
    expect(prepared.status, prepared.stderr).toBe(0)
    const summary = JSON.parse(prepared.stdout)
    const metadata = JSON.parse(await readFile(summary.metadataPath, 'utf8'))
    expect(metadata.run).toMatchObject({
      repository: 'owner/repo',
      workflow: 'CI Full Gate',
      job: 'full-gate',
      sha: '0123456789abcdef',
      runId: '42',
      runAttempt: '2',
      eventName: 'push',
    })
    expect(metadata.runner.name).toBe('runner-x')
  })

  it('refuses to run when the artifact drive is below the free-space floor', async () => {
    const root = await makeRoot()
    const prepared = run([`--root=${root}`, '--min-free-mib=1000000000', '--json'])
    expect(prepared.status).toBe(1)
    expect(prepared.stderr).toContain('Insufficient free disk space')
    // The disk check runs before anything is created or replaced.
    expect(existsSync(root)).toBe(false)
  })

  it('rejects a non-positive free-space floor instead of skipping the check', async () => {
    const root = await makeRoot()
    for (const value of ['0', '-1', 'not-a-number']) {
      const prepared = run([`--root=${root}`, `--min-free-mib=${value}`])
      expect(prepared.status).toBe(1)
      expect(prepared.stderr).toContain('--min-free-mib must be a positive integer')
    }
  })

  it('exports the LITTLESHEEP_* environment through a GitHub env file', async () => {
    const root = await makeRoot()
    const envFile = join(root, '..', 'github-env.txt')
    await mkdir(join(root, '..'), { recursive: true })
    const prepared = run([`--root=${root}`, `--github-env=${envFile}`])
    expect(prepared.status, prepared.stderr).toBe(0)
    const content = await readFile(envFile, 'utf8')
    for (const key of ['LITTLESHEEP_DATA_DIR', 'LITTLESHEEP_DATA_LOCATOR', 'LITTLESHEEP_RUN_ARTIFACTS_DIR']) {
      expect(content).toContain(`${key}=`)
    }
  })

  it('replaces a previously bootstrapped, marked root', async () => {
    const root = await makeRoot()
    expect(run([`--root=${root}`, '--json']).status).toBe(0)
    expect(run([`--root=${root}`, '--json']).status).toBe(0)
  })

  it('refuses to replace an existing directory it did not create', async () => {
    const root = await makeRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'config.json'), '{"real":"data"}\n', 'utf8')
    const prepared = run([`--root=${root}`])
    expect(prepared.status).toBe(1)
    expect(prepared.stderr).toContain('without the synthetic-root marker')
    expect(existsSync(join(root, 'config.json'))).toBe(true)
  })

  it('refuses to write inside the repository checkout', () => {
    const prepared = run([`--root=${join(repoRoot, 'ci-synthetic-root')}`])
    expect(prepared.status).toBe(1)
    expect(prepared.stderr).toContain('inside the repository')
  })

  it('rejects unknown options instead of silently ignoring them', () => {
    const prepared = run(['--not-an-option'])
    expect(prepared.status).toBe(1)
    expect(prepared.stderr).toContain('Unknown option')
  })
})
