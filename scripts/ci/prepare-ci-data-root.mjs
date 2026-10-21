#!/usr/bin/env node
// CI bootstrap for the LittleSheep data root and run-artifact directory.
//
// `pnpm run verify:full` includes `pnpm run verify:app-recovery`, and
// `scripts/verify-app-recovery-sources.mjs` fails when the resolved user data
// root does not exist. A clean GitHub runner has no LittleSheep data root, so
// the full gate would fail for an environmental reason rather than a product
// defect.
//
// This script provisions an ISOLATED, SYNTHETIC data root in the runner temp
// area and exports the three environment variables the recovery audit and the
// verification-report writer understand:
//
//   LITTLESHEEP_DATA_DIR           synthetic data root (`config.json`, indexes)
//   LITTLESHEEP_DATA_LOCATOR       locator pointing at the synthetic data root
//   LITTLESHEEP_RUN_ARTIFACTS_DIR  upload directory: logs, run metadata, reports
//
// It also creates `run-artifacts/logs/` and writes
// `run-artifacts/ci-run-metadata.json`, so a run that fails before any gate can
// still upload a non-empty artifact that identifies the runner and toolchain.
// CI runs this step before dependency installation for exactly that reason.
//
// Disk headroom is checked before anything is created or replaced: a hosted
// runner with a nearly full artifact drive should fail with a clear message
// instead of producing a burst of unrelated ENOSPC errors (the R4-A full-gate
// block was external disk exhaustion, seen as git "unable to write loose object
// file" and import-repo ENOSPC).
//
// What this proves is narrow and must stay described that way: the recovery
// audit runs cleanly against a freshly created, well-formed synthetic root. It
// is NOT evidence that user data recovers on a real machine. Real user-data
// recovery evidence comes from the dedicated Electron and fault-injection
// acceptance runs, none of which this workflow claims to cover.
//
// Safety: the target directory is removed only when it carries the marker file
// this script wrote, it must be outside the repository checkout, and it must
// not name a real LittleSheep data root. That makes an accidental
// `LITTLESHEEP_CI_DATA_ROOT` misconfiguration fail loudly instead of deleting
// personal data.

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { arch, homedir, release, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marker written into the synthetic root; only a marked directory may be replaced. */
export const MARKER_FILE = '.littlesheep-ci-data-root.json'
export const MARKER_SCHEMA_VERSION = 1

/** Minimum free space required on the artifact drive before the bootstrap runs. */
export const DEFAULT_MIN_FREE_MIB = 2048

/** Directory under the run-artifacts root that holds captured gate logs. */
export const LOGS_DIRNAME = 'logs'

/** Machine-readable record of the run that produced the artifact upload. */
export const METADATA_FILE = 'ci-run-metadata.json'

/** Environment variables written through `--github-env` for the rest of the job. */
export const CI_ENV_KEYS = Object.freeze([
  'LITTLESHEEP_DATA_DIR',
  'LITTLESHEEP_DATA_LOCATOR',
  'LITTLESHEEP_RUN_ARTIFACTS_DIR',
])

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultRoot = join(
  process.env.RUNNER_TEMP?.trim() || tmpdir(),
  'littlesheep-ci-data-root',
)

function usage() {
  return [
    'Create an isolated synthetic LittleSheep data root and run-artifact directory for CI.',
    '',
    'Usage:',
    '  node scripts/ci/prepare-ci-data-root.mjs [--root=<dir>] [--min-free-mib=<n>] [--github-env=<file>] [--github-output=<file>] [--json]',
    '',
    'Options:',
    '  --root=<dir>          Target directory (default: $RUNNER_TEMP/littlesheep-ci-data-root).',
    '                        Must be outside the repository and must not be a real data root.',
    '  --min-free-mib=<n>    Required free space on the artifact drive (default: 2048).',
    '  --github-env=<file>   Append LITTLESHEEP_* assignments to a GitHub Actions env file.',
    '  --github-output=<file> Append data-dir/data-locator/run-artifacts-dir to a GitHub Actions output file.',
    '  --json                Print the machine-readable summary as the last stdout line.',
    '  --help                Show this help.',
    '',
    'The created root is synthetic: it proves the recovery audit runs on a clean,',
    'well-formed root. It is not real user-data recovery evidence.',
  ].join('\n')
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    root: defaultRoot,
    minFreeMib: DEFAULT_MIN_FREE_MIB,
    githubEnv: null,
    githubOutput: null,
    json: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}.`)
      index += 1
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--root') options.root = value()
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
    else if (arg === '--min-free-mib') options.minFreeMib = Number.parseInt(value(), 10)
    else if (arg.startsWith('--min-free-mib=')) options.minFreeMib = Number.parseInt(arg.slice('--min-free-mib='.length), 10)
    else if (arg === '--github-env') options.githubEnv = value()
    else if (arg.startsWith('--github-env=')) options.githubEnv = arg.slice('--github-env='.length)
    else if (arg === '--github-output') options.githubOutput = value()
    else if (arg.startsWith('--github-output=')) options.githubOutput = arg.slice('--github-output='.length)
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`)
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new Error('--root must not be empty.')
  }
  if (!Number.isInteger(options.minFreeMib) || options.minFreeMib <= 0) {
    throw new Error('--min-free-mib must be a positive integer.')
  }
  return options
}

function isInside(parent, child) {
  const delta = relative(parent, child)
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`))
}

function samePath(left, right) {
  return resolve(left).replace(/[\\/]+$/u, '').toLowerCase()
    === resolve(right).replace(/[\\/]+$/u, '').toLowerCase()
}

/** Refuse targets that are not an isolated, disposable synthetic root. */
export function assertSafeRoot(root) {
  const absolute = resolve(root)
  if (isInside(repoRoot, absolute)) {
    throw new Error(`Refusing to write the synthetic data root inside the repository: ${absolute}`)
  }
  const home = resolve(homedir())
  const realRoots = [
    join(home, '.littlesheep'),
    join(home, '.littlesheep-location.json'),
  ]
  for (const realRoot of realRoots) {
    if (samePath(absolute, realRoot)) {
      throw new Error(`Refusing to replace a real LittleSheep data path: ${absolute}`)
    }
  }
  if (samePath(absolute, home)) {
    throw new Error(`Refusing to replace the home directory: ${absolute}`)
  }
  return absolute
}

async function assertReplaceable(root) {
  if (!existsSync(root)) return
  const markerPath = join(root, MARKER_FILE)
  if (!existsSync(markerPath)) {
    throw new Error(
      `Refusing to replace ${root}: it exists without the synthetic-root marker ${MARKER_FILE}. `
        + 'Point --root at a fresh or previously bootstrapped CI directory.',
    )
  }
  let marker
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch (error) {
    throw new Error(`Refusing to replace ${root}: unreadable marker (${error.message}).`)
  }
  if (marker?.schemaVersion !== MARKER_SCHEMA_VERSION) {
    throw new Error(
      `Refusing to replace ${root}: marker schemaVersion ${String(marker?.schemaVersion)} is not ${MARKER_SCHEMA_VERSION}.`,
    )
  }
}

/** Nearest existing ancestor, so free space can be read before the root exists. */
function existingAncestor(path) {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Fail closed when the artifact drive is too full. `statfs` is available on the
 * supported Windows/Node toolchain; an unreadable value is an error, never a
 * silent skip.
 */
export async function checkFreeDisk(targetPath, minFreeMib = DEFAULT_MIN_FREE_MIB) {
  const volume = existingAncestor(targetPath)
  let stats
  try {
    stats = await statfs(volume)
  } catch (error) {
    throw new Error(`Cannot determine free disk space for ${volume}: ${error.message}`)
  }
  const blockSize = Number(stats.bsize)
  const availableBlocks = Number(stats.bavail)
  const freeBytes = blockSize * availableBlocks
  const freeMiB = Math.floor(freeBytes / (1024 * 1024))
  const checkedAt = new Date().toISOString()
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) {
    throw new Error(`Cannot determine free disk space for ${volume}: statfs returned unusable values.`)
  }
  if (freeMiB < minFreeMib) {
    throw new Error(
      `Insufficient free disk space on ${volume}: ${freeMiB} MiB available, `
        + `below the required ${minFreeMib} MiB. Free the artifact drive before rerunning the gate.`,
    )
  }
  return { volume, freeBytes, freeMiB, minFreeMib, checkedAt }
}

async function readPnpmVersion() {
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    const match = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(String(manifest?.packageManager ?? ''))
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Electron's resolved version comes from the lockfile rather than the installed
 * package: the bootstrap runs before dependency installation, and the lockfile
 * pin is exactly what the frozen install will produce.
 */
async function readLockedElectronVersion() {
  try {
    const lockfile = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
    const match = /^\s{2}electron@(\d+\.\d+\.\d+):/mu.exec(lockfile)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function runMetadata({ absoluteRoot, dataDir, workspaceDir, workplaceDir, locatorPath, runArtifactsDir, logsDir, freeDisk, pnpmVersion, electronVersion }) {
  const environment = process.env
  return {
    schemaVersion: 1,
    synthetic: true,
    createdAt: new Date().toISOString(),
    generatedBy: 'scripts/ci/prepare-ci-data-root.mjs',
    run: {
      repository: environment.GITHUB_REPOSITORY || null,
      workflow: environment.GITHUB_WORKFLOW || null,
      job: environment.GITHUB_JOB || null,
      sha: environment.GITHUB_SHA || null,
      runId: environment.GITHUB_RUN_ID || null,
      runAttempt: environment.GITHUB_RUN_ATTEMPT || null,
      eventName: environment.GITHUB_EVENT_NAME || null,
    },
    runner: {
      os: `${process.platform} ${release()}`,
      arch: arch(),
      name: environment.RUNNER_NAME || null,
      temp: environment.RUNNER_TEMP || null,
    },
    toolchain: {
      node: process.version,
      pnpm: pnpmVersion,
      electron: electronVersion,
    },
    paths: {
      root: absoluteRoot,
      dataDir,
      workspaceDir,
      workplaceDir,
      locatorPath,
      runArtifactsDir,
      logsDir,
    },
    freeDiskAtStart: freeDisk,
  }
}

export async function prepareCiDataRoot(root, { minFreeMib = DEFAULT_MIN_FREE_MIB } = {}) {
  const absoluteRoot = assertSafeRoot(root)
  // Fail before deleting or writing anything: a low-disk runner otherwise
  // surfaces as a cascade of unrelated ENOSPC failures later in the gate.
  const freeDisk = await checkFreeDisk(absoluteRoot, minFreeMib)
  await assertReplaceable(absoluteRoot)
  await rm(absoluteRoot, { recursive: true, force: true })

  const dataDir = join(absoluteRoot, 'data')
  const workspaceDir = join(absoluteRoot, 'workspace')
  const workplaceDir = join(dataDir, 'workplace')
  const locatorPath = join(absoluteRoot, 'location.json')
  const runArtifactsDir = join(absoluteRoot, 'run-artifacts')
  const logsDir = join(runArtifactsDir, LOGS_DIRNAME)
  const metadataPath = join(runArtifactsDir, METADATA_FILE)

  const directories = [
    dataDir,
    workspaceDir,
    workplaceDir,
    join(dataDir, 'projects'),
    join(dataDir, 'sessions'),
    join(dataDir, 'execution-logs'),
    join(dataDir, 'run-checkpoints'),
    join(dataDir, 'run-checkpoint-dispositions'),
    join(dataDir, 'workspace', 'resource-indexes'),
    runArtifactsDir,
    logsDir,
  ]
  for (const directory of directories) await mkdir(directory, { recursive: true })

  // The minimum shape the recovery source audit requires: a readable config
  // whose agents.defaults.workspace points at an existing directory. The empty
  // indexes below are valid documents, so the audit does not warn about
  // unreadable optional state.
  await writeFile(
    join(dataDir, 'config.json'),
    `${JSON.stringify({ agents: { defaults: { workspace: workspaceDir } } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(dataDir, 'projects', 'index.json'),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(dataDir, 'sessions.json'),
    `${JSON.stringify({ version: 1, sessions: [] }, null, 2)}\n`,
    'utf8',
  )
  // Optional workspace-side indexes are written in their valid empty shape so
  // the audit reports "readable, 0 records" instead of "missing optional file".
  await writeFile(
    join(dataDir, 'workspace', 'artifacts.json'),
    `${JSON.stringify({ version: 1, records: [] }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(dataDir, 'workspace', 'terminal-activity.json'),
    `${JSON.stringify({ version: 1, records: [] }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(dataDir, 'workspace', 'layout.json'),
    `${JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      snapshots: {},
    }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    locatorPath,
    `${JSON.stringify({ version: 1, activeDataDir: dataDir }, null, 2)}\n`,
    'utf8',
  )

  const metadata = runMetadata({
    absoluteRoot,
    dataDir,
    workspaceDir,
    workplaceDir,
    locatorPath,
    runArtifactsDir,
    logsDir,
    freeDisk,
    pnpmVersion: await readPnpmVersion(),
    electronVersion: await readLockedElectronVersion(),
  })
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

  await writeFile(
    join(absoluteRoot, MARKER_FILE),
    `${JSON.stringify({
      schemaVersion: MARKER_SCHEMA_VERSION,
      createdBy: 'scripts/ci/prepare-ci-data-root.mjs',
      createdAt: new Date().toISOString(),
      synthetic: true,
    }, null, 2)}\n`,
    'utf8',
  )

  return {
    schemaVersion: 1,
    synthetic: true,
    root: absoluteRoot,
    dataDir,
    workspaceDir,
    workplaceDir,
    locatorPath,
    runArtifactsDir,
    logsDir,
    metadataPath,
    minFreeMib,
    freeDiskAtStart: freeDisk,
    env: {
      LITTLESHEEP_DATA_DIR: dataDir,
      LITTLESHEEP_DATA_LOCATOR: locatorPath,
      LITTLESHEEP_RUN_ARTIFACTS_DIR: runArtifactsDir,
    },
    remark: 'Synthetic root for a clean-repository audit; not real user-data recovery evidence.',
  }
}

async function writeGithubFile(path, lines) {
  if (!path) return
  await appendFile(path, lines.join('\n') + '\n', 'utf8')
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }
  const summary = await prepareCiDataRoot(options.root, { minFreeMib: options.minFreeMib })
  if (options.githubEnv) {
    await writeGithubFile(
      options.githubEnv,
      CI_ENV_KEYS.map((key) => `${key}=${summary.env[key]}`),
    )
  }
  if (options.githubOutput) {
    await writeGithubFile(options.githubOutput, [
      `data-dir=${summary.dataDir}`,
      `data-locator=${summary.locatorPath}`,
      `run-artifacts-dir=${summary.runArtifactsDir}`,
    ])
  }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`[ci-data-root] isolated synthetic data root: ${summary.root}`)
  console.log(`[ci-data-root] data root: ${summary.dataDir}`)
  console.log(`[ci-data-root] workspace: ${summary.workspaceDir}`)
  console.log(`[ci-data-root] run artifacts: ${summary.runArtifactsDir}`)
  console.log(`[ci-data-root] logs: ${summary.logsDir}`)
  console.log(`[ci-data-root] metadata: ${summary.metadataPath}`)
  console.log(`[ci-data-root] free disk at start: ${summary.freeDiskAtStart.freeMiB} MiB (required ${summary.minFreeMib} MiB)`)
  if (options.githubEnv) {
    console.log(`[ci-data-root] exported ${CI_ENV_KEYS.join(', ')} via ${options.githubEnv}`)
  }
  console.log('[ci-data-root] clean synthetic-root audit only — not real user-data recovery evidence.')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(`[ci-data-root] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
