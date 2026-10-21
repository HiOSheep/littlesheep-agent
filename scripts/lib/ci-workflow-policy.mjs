// CI workflow policy for LittleSheep's GitHub Actions gates.
//
// The repository treats CI as a hard gate, not as advisory output. That only
// holds if weakening the workflow file is itself a failure, so this module
// evaluates `.github/workflows/*.yml` against an explicit policy and returns
// every violation instead of stopping at the first one.
//
// It is used in two places:
//   - `scripts/verify-ci-workflows.mjs` (run as `pnpm run verify:ci-config`),
//     which is executed by the fast workflow itself;
//   - `scripts/verify-ci-workflows.test.mjs`, which mutates copies of the
//     committed workflows in a temporary repository and proves each weakening
//     is rejected.
//
// The policy is intentionally narrow: it checks the things that would make a
// gate skip silently or reach for real accounts, and it deliberately does not
// try to be a general GitHub Actions linter.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Workflow files owned by this policy, relative to `.github/workflows/`. */
export const WORKFLOW_FILES = Object.freeze(['ci-fast.yml', 'ci-full.yml'])

/**
 * Node.js pin for both jobs. This is the toolchain version verified locally
 * (Node 26.4.0). package.json declares engines `>=22.13.0` because production
 * code imports the unflagged `node:sqlite` module (unflagged from Node
 * v22.13.0); other Node majors are not exercised by this repository's local
 * evidence.
 */
export const REQUIRED_NODE_VERSION = '26.4.0'

/** Reports are kept for two weeks: long enough to inspect a red main run. */
export const ARTIFACT_RETENTION_DAYS = 14

/** Stable marker the coverage document must keep. */
export const GUI_NOT_COVERED_MARKER = '<!-- ci-gates:electron-gui-not-covered -->'

/**
 * Marker for host-specific platform acceptances that cannot be reproduced on a
 * hosted Windows runner (real WSL terminal/ConPTY, real POSIX shell).
 */
export const PLATFORM_EXCLUSIONS_MARKER = '<!-- ci-gates:platform-exclusions -->'

/** Environment variables the synthetic data-root bootstrap exports. */
export const DATA_ROOT_ENV_KEYS = Object.freeze([
  'LITTLESHEEP_DATA_DIR',
  'LITTLESHEEP_DATA_LOCATOR',
  'LITTLESHEEP_RUN_ARTIFACTS_DIR',
])

export const DATA_ROOT_BOOTSTRAP_COMMAND =
  'node scripts/ci/prepare-ci-data-root.mjs --github-env $env:GITHUB_ENV'

/**
 * Recovery regression files owned by `test:ci-recovery`. They are listed here
 * as well so deleting a file from the npm script is a CI-policy failure rather
 * than a silent coverage loss. `scripts/verify-ci-workflows.test.mjs` also
 * asserts every path exists in the checkout.
 */
export const REQUIRED_RECOVERY_TESTS = Object.freeze([
  'packages/app/src/main/run-checkpoint-api.test.ts',
  'packages/app/src/main/run-recovery-authorization.test.ts',
  'packages/app/src/renderer/runtime-recovery/checkpoint-recovery-request.test.ts',
  'packages/app/src/renderer/runtime-recovery/checkpoint-recovery-state.test.ts',
  'packages/runner/src/durable-effect-lease-coordinator.test.ts',
  'packages/runner/src/durable-effect-lease-crash-worker.test.ts',
  'packages/runner/src/durable-effect-lease-recovery.test.ts',
  'packages/runner/src/durable-effect-lease-store.test.ts',
  'packages/runner/src/durable-effect-query.test.ts',
  'packages/runner/src/durable-event-store-concurrency.test.ts',
  'packages/runner/src/durable-event-store-crash-worker.test.ts',
  'packages/runner/src/durable-event-store.test.ts',
  'packages/runner/src/durable-harness-infrastructure.test.ts',
  'packages/runner/src/durable-inbox-crash-worker.test.ts',
  'packages/runner/src/durable-inbox-recovery.test.ts',
  'packages/runner/src/durable-inbox-store.test.ts',
  'packages/runner/src/durable-run-lease-crash-worker.test.ts',
  'packages/runner/src/durable-run-lease-heartbeat.test.ts',
  'packages/runner/src/durable-run-lease-recovery.test.ts',
  'packages/runner/src/durable-run-lease-store.test.ts',
  'packages/runner/src/durable-run-mode.test.ts',
  'packages/runner/src/durable-run-ownership.test.ts',
  'packages/runner/src/durable-run-recorder.test.ts',
  'packages/runner/src/durable-run-recovery.test.ts',
  'packages/runner/src/durable-runner-effect-crash-worker.test.ts',
  'packages/runner/src/durable-runner-effect-recovery.test.ts',
  'packages/runner/src/durable-runner-final-settlement-crash-worker.test.ts',
  'packages/runner/src/durable-runner-final-settlement-crash.test.ts',
  'packages/runner/src/durable-runner-no-progress-recovery-worker.test.ts',
  'packages/runner/src/durable-runner-no-progress-recovery.test.ts',
  'packages/runner/src/durable-runner-provider-request-crash-worker.test.ts',
  'packages/runner/src/durable-runner-provider-request-crash.test.ts',
  'packages/runner/src/durable-runner-segment-recovery-contender-worker.test.ts',
  'packages/runner/src/durable-runner-segment-recovery-policy.test.ts',
  'packages/runner/src/durable-runner-segment-recovery-worker.test.ts',
  'packages/runner/src/durable-runner-segment-recovery.test.ts',
  'packages/runner/src/durable-runner-task-outcome-crash-matrix.test.ts',
  'packages/runner/src/durable-runner-task-outcome-crash-worker.test.ts',
  'packages/runner/src/run-checkpoint-controller.test.ts',
  'packages/runner/src/run-checkpoint-disposition-store.test.ts',
  'packages/runner/src/run-checkpoint-store.test.ts',
  'packages/runner/src/run-checkpoint.test.ts',
  'packages/runner/src/session-restart-continuity.test.ts',
  'packages/runner/src/task-outcome-request.test.ts',
  'packages/runner/src/task-outcome-runner.test.ts',
  'packages/runner/src/task-outcome.test.ts',
  'packages/runner/src/vrs-verify-checkpoint-compat.test.ts',
])

/** Required run commands per workflow. Matching is exact after whitespace normalization. */
const REQUIRED_RUN_STEPS = Object.freeze({
  'ci-fast.yml': Object.freeze([
    'pnpm install --frozen-lockfile',
    'pnpm run verify:ci-config',
    'pnpm run typecheck',
    'pnpm run check:repo',
    'pnpm run test:core-eval',
  ]),
  'ci-full.yml': Object.freeze([
    'pnpm install --frozen-lockfile',
    'pnpm run verify:ci-config',
    'pnpm run verify:app-recovery',
    'pnpm run test:ci-recovery',
    'pnpm run verify:full',
    'pnpm run assert:app-build',
  ]),
})

/** Steps that only work after the synthetic data root has been exported. */
const DATA_ROOT_DEPENDENT_STEPS = Object.freeze([
  'pnpm run verify:app-recovery',
  'pnpm run test:ci-recovery',
  'pnpm run verify:full',
])

/**
 * Long gate steps whose full console output must be captured into the run
 * artifact. `scripts/run-verification-gate.mjs` truncates each stage's stored
 * stdout/stderr to 4000 characters, so the uploaded report alone cannot explain
 * a failure; the captured log is the complete record.
 *
 * Capture is one allowlisted pwsh pipeline. The step still fails on a gate
 * failure because GitHub appends `exit $LASTEXITCODE` to pwsh scripts, which
 * carries the native `pnpm` exit code through the pipeline (verified locally;
 * a Tee write failure is silent, so logs are diagnostics, never evidence).
 */
const REQUIRED_CAPTURED_STEPS = Object.freeze({
  'ci-full.yml': Object.freeze([
    'pnpm install --frozen-lockfile',
    'pnpm run test:ci-recovery',
    'pnpm run verify:full',
  ]),
})

/**
 * The only additional shell construct allowed on a gate step: merge stderr into
 * stdout and tee it into the run-artifacts logs directory. Any other pipeline
 * can swallow or redirect failure output and is rejected.
 */
const CAPTURE_PATTERN = /^(?<command>.+?) 2>&1 \| Tee-Object -FilePath "\$env:LITTLESHEEP_RUN_ARTIFACTS_DIR[\\/]logs[\\/](?<logName>[a-z0-9._-]+\.log)"$/iu

/**
 * Electron/GUI interaction verifications. They need a real display and a
 * desktop session, so CI must never claim to run them. The coverage document
 * records this; the validator enforces it from both sides.
 */
const GUI_VERIFICATION_PATTERN = new RegExp(
  String.raw`\b(?:verify:(?:electron|desktop|window|chat|composer|settings|skills|context-menus|` +
  String.raw`conversation|recovery-states|ui-refinement|appearance|review|html-preview|transient-notice|` +
  String.raw`runtime-picker|harness-paths|model-provider-ui|narrow|shared-ui|code-wrap|workspace|` +
  String.raw`no-model-config-loop|async-feedback|startup-failure-retry|keyboard-modal-focus|` +
  String.raw`deletion-confirmation|local-stream-disconnect|transcript-state-visibility|channel-entry-states|` +
  String.raw`retry-feedback|file-preview|provider-card|provider-protocol-selector|settings-overview|` +
  String.raw`task-outcome-renderer|web-llm-evidence|web-fetch|web-migration|web-artifacts|web-performance)|` +
  String.raw`measure:desktop)`,
  'iu',
)

/**
 * Host-specific platform acceptances. They need a real WSL distribution or a
 * real POSIX shell and therefore cannot be reproduced on `windows-latest`; a
 * hosted runner would either fail for an environment reason or silently pass
 * an early-return branch while claiming coverage. They keep an explicit,
 * observable local entry (`pnpm run verify:wsl-terminal`) and must never be
 * wired into CI as if they were portable coverage.
 */
const PLATFORM_ACCEPTANCE_PATTERN = /\bverify:wsl-terminal\b/iu

/** Commands that would need provider credentials, paid usage, or explicit live authorization. */
const LIVE_PROVIDER_PATTERN = new RegExp(
  String.raw`(?:--run-real\b|--authorize-live\b|\bs3b-eval\.mjs\b|\bs3a-eval\.mjs\b|` +
  String.raw`\bverify:(?:provider|web-provider|web-live-llm-evidence|memory-live-model|` +
  String.raw`conversation-continuity-live|ledger-reexecution-live|memory-v3-provider|` +
  String.raw`web-live-llm-evidence-boundary|web-llm-evidence-boundary))`,
  'iu',
)

const BANNED_SECRET_KEY = /(?:api[_-]?key|secret|token|password|credential)/iu
const SECRET_EXPRESSION = /\bsecrets\s*[.[]/iu
const MULTILINE_OR_CHAINED = /(?:\r?\n|;|&&|\|\|)/u

const DOC_PATH = 'docs/reference/ci-gates.md'
const DOC_INDEX_PATH = 'docs/reference/README.md'
const BOOTSTRAP_SCRIPT_PATH = 'scripts/ci/prepare-ci-data-root.mjs'

function violation(code, location, message) {
  return { code, location, message }
}

function normalizeRun(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * Recognize the one allowlisted capture form and return the gate command it
 * wraps. Anything else that contains a pipe is rejected by checkJobs.
 */
function parseCapturedRun(run) {
  const trimmed = String(run ?? '').trim()
  if (!trimmed.includes('|')) return null
  const match = CAPTURE_PATTERN.exec(trimmed)
  if (!match?.groups?.command) return null
  return {
    command: normalizeRun(match.groups.command),
    logName: match.groups.logName ?? null,
  }
}

/** The gate command a step runs, with the allowlisted capture wrapper removed. */
function gateCommandOf(entry) {
  const run = typeof entry?.step?.run === 'string' ? entry.step.run : null
  if (run === null) return null
  const captured = parseCapturedRun(run)
  return captured ? captured.command : normalizeRun(run)
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function walk(value, visit, path = 'workflow') {
  visit(value, path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
    return
  }
  const object = asObject(value)
  if (!object) return
  for (const [key, child] of Object.entries(object)) walk(child, visit, `${path}.${key}`)
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(text ?? '').trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * The `engines.node` syntax in package.json is a single range in this
 * repository (`>=22.13.0`; the lowest Node line where `node:sqlite` works
 * without `--experimental-sqlite`). Parse that shape and refuse anything the
 * policy cannot judge instead of guessing.
 */
function parseEngineMinimum(range) {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(String(range ?? '').trim())
  return match ? parseVersion(match[1]) : null
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function readJson(path) {
  const text = await readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function triggerKeys(on) {
  if (typeof on === 'string' || on === null) return on === null ? [] : [on]
  const object = asObject(on)
  return object ? Object.keys(object) : []
}

function pushBranches(on) {
  const object = asObject(on)
  const push = asObject(object?.push)
  const branches = asArray(push?.branches).filter((branch) => typeof branch === 'string')
  return branches
}

function requireObjectField(result, object, field, code, location) {
  if (!asObject(object?.[field])) {
    result.violations.push(violation(code, location, `\`${field}\` must be a mapping.`))
    return null
  }
  return object[field]
}

function collectSteps(workflow) {
  const jobs = asObject(workflow?.jobs) ?? {}
  const entries = []
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = asArray(asObject(job)?.steps)
    steps.forEach((step, index) => {
      entries.push({ jobId, index, step: asObject(step) ?? {}, steps })
    })
  }
  return entries
}

function checkTriggers(result, file, workflow) {
  const on = workflow.on
  const keys = triggerKeys(on)
  const location = `${file} on`
  if (keys.length === 0) {
    result.violations.push(violation('workflow-triggers', location, 'Workflow has no triggers.'))
    return
  }
  if (file === 'ci-fast.yml') {
    if (!keys.includes('pull_request')) {
      result.violations.push(violation('workflow-triggers', location, 'Fast gate must run on `pull_request`.'))
    }
    if (!pushBranches(on).includes('main')) {
      result.violations.push(violation('workflow-triggers', location, 'Fast gate must run on pushes to `main`.'))
    }
  } else {
    if (!pushBranches(on).includes('main')) {
      result.violations.push(violation('workflow-triggers', location, 'Full gate must run on pushes to `main`.'))
    }
    if (!keys.includes('workflow_dispatch')) {
      result.violations.push(violation('workflow-triggers', location, 'Full gate must stay manually triggerable (`workflow_dispatch`).'))
    }
  }
}

function checkTopLevel(result, file, workflow) {
  if (typeof workflow?.name !== 'string' || workflow.name.trim() === '') {
    result.violations.push(violation('workflow-name', `${file} name`, 'Workflow needs a name.'))
  }
  const permissions = requireObjectField(result, workflow, 'permissions', 'workflow-permissions', `${file} permissions`)
  if (permissions) {
    for (const [scope, access] of Object.entries(permissions)) {
      if (access === 'write-all' || access === 'write') {
        result.violations.push(violation(
          'workflow-permissions',
          `${file} permissions.${scope}`,
          `CI gates must stay least-privilege: \`${scope}: ${access}\` is not allowed.`,
        ))
      }
    }
    if (permissions.contents !== 'read') {
      result.violations.push(violation(
        'workflow-permissions',
        `${file} permissions.contents`,
        'Workflow must request `contents: read`.',
      ))
    }
  }
  const concurrency = requireObjectField(result, workflow, 'concurrency', 'workflow-concurrency', `${file} concurrency`)
  if (concurrency) {
    if (typeof concurrency.group !== 'string' || concurrency.group.trim() === '') {
      result.violations.push(violation('workflow-concurrency', `${file} concurrency.group`, 'Concurrency group must be set.'))
    }
    if (typeof concurrency['cancel-in-progress'] !== 'boolean') {
      result.violations.push(violation(
        'workflow-concurrency',
        `${file} concurrency.cancel-in-progress`,
        'Concurrency `cancel-in-progress` must be an explicit boolean.',
      ))
    }
  }
  const defaults = asObject(workflow?.defaults)
  const runDefaults = asObject(defaults?.run)
  if (runDefaults?.shell !== 'pwsh') {
    result.violations.push(violation(
      'workflow-shell',
      `${file} defaults.run.shell`,
      'Workflow must set `defaults.run.shell: pwsh` so single-command steps propagate exit codes.',
    ))
  }
}

function checkSecretsAndLiveProviders(result, file, workflow) {
  walk(workflow, (value, path) => {
    if (typeof value !== 'string') return
    if (SECRET_EXPRESSION.test(value)) {
      result.violations.push(violation(
        'no-secrets',
        `${file} ${path}`,
        'CI gates must not read GitHub secrets; no real-provider credentials or tokens.',
      ))
    }
    if (LIVE_PROVIDER_PATTERN.test(value)) {
      result.violations.push(violation(
        'no-live-provider',
        `${file} ${path}`,
        `Live-provider evaluation command is not allowed in CI: ${value.trim()}`,
      ))
    }
    if (GUI_VERIFICATION_PATTERN.test(value)) {
      result.violations.push(violation(
        'gui-not-covered',
        `${file} ${path}`,
        `GUI/Electron interaction verification needs a real display and must not run in CI: ${value.trim()}`,
      ))
    }
    if (PLATFORM_ACCEPTANCE_PATTERN.test(value)) {
      result.violations.push(violation(
        'platform-acceptance-not-covered',
        `${file} ${path}`,
        `Host-specific platform acceptance needs a real WSL/POSIX host and must not run in CI: ${value.trim()}`,
      ))
    }
  })
  // Environment keys that look like credentials are rejected even when empty:
  // an empty secret slot invites a later "temporary" real-value edit.
  for (const entry of collectSteps(workflow)) {
    const env = asObject(entry.step.env)
    if (!env) continue
    for (const key of Object.keys(env)) {
      if (BANNED_SECRET_KEY.test(key)) {
        result.violations.push(violation(
          'no-secrets',
          `${file} jobs.${entry.jobId}.steps[${entry.index}].env.${key}`,
          'CI gates must not declare credential-shaped environment variables.',
        ))
      }
    }
  }
}

function checkNoContinueOnError(result, file, workflow) {
  walk(workflow, (value, path) => {
    if (!asObject(value)) return
    if (Object.hasOwn(value, 'continue-on-error')) {
      result.violations.push(violation(
        'no-continue-on-error',
        `${file} ${path}.continue-on-error`,
        'Hard gates must not use `continue-on-error`.',
      ))
    }
  })
}

function checkJobs(result, file, workflow) {
  const jobs = asObject(workflow?.jobs)
  if (!jobs || Object.keys(jobs).length === 0) {
    result.violations.push(violation('workflow-jobs', `${file} jobs`, 'Workflow must define at least one job.'))
    return
  }
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asObject(rawJob) ?? {}
    const location = `${file} jobs.${jobId}`
    if (job['runs-on'] !== 'windows-latest') {
      result.violations.push(violation(
        'job-host',
        `${location}.runs-on`,
        'Both gates run on windows-latest; Linux/macOS CI is an explicit follow-up.',
      ))
    }
    const timeout = job['timeout-minutes']
    if (!Number.isInteger(timeout) || timeout < 5 || timeout > 180) {
      result.violations.push(violation(
        'job-timeout',
        `${location}.timeout-minutes`,
        'Job needs an explicit `timeout-minutes` between 5 and 180.',
      ))
    }
    if (Object.hasOwn(job, 'if')) {
      result.violations.push(violation(
        'conditional-job',
        `${location}.if`,
        'Hard-gate jobs must not be conditional: a condition can silently skip the gate.',
      ))
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      result.violations.push(violation('job-steps', `${location}.steps`, 'Job must define steps.'))
      continue
    }
    job.steps.forEach((rawStep, index) => {
      const step = asObject(rawStep) ?? {}
      const stepLocation = `${location}.steps[${index}]`
      if (Object.hasOwn(step, 'if')) {
        const isArtifactUpload = typeof step.uses === 'string'
          && /^actions\/upload-artifact@v\d+$/u.test(step.uses)
        if (!isArtifactUpload || String(step.if).trim() !== 'always()') {
          result.violations.push(violation(
            'conditional-step',
            `${stepLocation}.if`,
            'Only the `if: always()` artifact upload may carry a condition.',
          ))
        }
      }
      if (step.shell !== undefined && step.shell !== 'pwsh') {
        result.violations.push(violation(
          'step-shell',
          `${stepLocation}.shell`,
          'Gate steps must run under pwsh (Windows-first host).',
        ))
      }
      const run = typeof step.run === 'string' ? step.run : null
      if (run === null) return
      if (MULTILINE_OR_CHAINED.test(run)) {
        result.violations.push(violation(
          'single-command-step',
          `${stepLocation}.run`,
          'Gate steps must be one command per step: no multi-line scripts, `;`, `&&`, or `||`. '
            + 'Only the allowlisted `2>&1 | Tee-Object` log capture may follow the command.',
        ))
      }
      const captured = parseCapturedRun(run)
      if (run.includes('|') && !captured) {
        result.violations.push(violation(
          'log-capture',
          `${stepLocation}.run`,
          'The only pipeline allowed on a gate step is the log capture '
            + '`2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\\logs\\<name>.log"`; '
            + 'other pipelines can hide failures or write logs outside the uploaded artifact.',
        ))
      }
      const command = captured ? captured.command : normalizeRun(run)
      if (/\bpnpm install\b/u.test(command) && command !== 'pnpm install --frozen-lockfile') {
        result.violations.push(violation(
          'install-frozen-lockfile',
          `${stepLocation}.run`,
          'The only install command allowed is `pnpm install --frozen-lockfile`.',
        ))
      }
    })
  }
}

/** Find a gate command either bare or wrapped in the allowlisted capture form. */
function findGateStep(entries, normalizedCommand) {
  return entries.find((entry) => gateCommandOf(entry) === normalizedCommand) ?? null
}

/** Find a gate command that is not wrapped in the capture form. */
function findPlainStep(entries, normalizedCommand) {
  return entries.find((entry) => {
    if (typeof entry.step.run !== 'string') return false
    if (parseCapturedRun(entry.step.run)) return false
    return normalizeRun(entry.step.run) === normalizedCommand
  }) ?? null
}

function findActionStep(entries, pattern) {
  return entries.find((entry) => typeof entry.step.uses === 'string' && pattern.test(entry.step.uses)) ?? null
}

function checkToolchain(result, file, workflow, toolchain) {
  const entries = collectSteps(workflow)
  const checkout = findActionStep(entries, /^actions\/checkout@v\d+$/u)
  if (!checkout) {
    result.violations.push(violation('checkout-step', `${file} steps`, 'Workflow must check out the repository with actions/checkout.'))
  } else if (checkout.index !== 0) {
    result.violations.push(violation('checkout-step', `${file} steps`, 'actions/checkout must be the first step.'))
  }

  const pnpmSetup = findActionStep(entries, /^pnpm\/action-setup@v\d+$/u)
  if (!pnpmSetup) {
    result.violations.push(violation('pnpm-setup', `${file} steps`, 'Workflow must install pnpm with pnpm/action-setup.'))
  } else {
    const version = String(pnpmSetup.step.with?.version ?? '')
    if (version !== toolchain.pnpmVersion) {
      result.violations.push(violation(
        'pnpm-version',
        `${file} jobs.${pnpmSetup.jobId}.steps[${pnpmSetup.index}].with.version`,
        `pnpm/action-setup version ${version || '(missing)'} must equal package.json packageManager pnpm@${toolchain.pnpmVersion}.`,
      ))
    }
    const runInstall = pnpmSetup.step.with?.run_install
    if (runInstall !== false && String(runInstall).toLowerCase() !== 'false') {
      result.violations.push(violation(
        'pnpm-setup',
        `${file} jobs.${pnpmSetup.jobId}.steps[${pnpmSetup.index}].with.run_install`,
        '`run_install` must be false so the only install is the frozen-lockfile step.',
      ))
    }
  }

  const nodeSetup = findActionStep(entries, /^actions\/setup-node@v\d+$/u)
  if (!nodeSetup) {
    result.violations.push(violation('node-setup', `${file} steps`, 'Workflow must set up Node.js with actions/setup-node.'))
  } else {
    const location = `${file} jobs.${nodeSetup.jobId}.steps[${nodeSetup.index}].with`
    const version = String(nodeSetup.step.with?.['node-version'] ?? '')
    if (version !== REQUIRED_NODE_VERSION) {
      result.violations.push(violation(
        'node-version',
        `${location}.node-version`,
        `Node must be pinned to the locally verified ${REQUIRED_NODE_VERSION}; got ${version || '(missing)'}.`,
      ))
    }
    if (nodeSetup.step.with?.cache !== 'pnpm') {
      result.violations.push(violation('node-cache', `${location}.cache`, 'setup-node must cache the pnpm store.'))
    }
    const cacheDependencyPath = String(nodeSetup.step.with?.['cache-dependency-path'] ?? '')
    if (!cacheDependencyPath.includes('pnpm-lock.yaml')) {
      result.violations.push(violation('node-cache', `${location}.cache-dependency-path`, 'pnpm cache must be keyed on pnpm-lock.yaml.'))
    }
  }

  const electronCache = entries.find((entry) => {
    if (typeof entry.step.uses !== 'string' || !/^actions\/cache@v\d+$/u.test(entry.step.uses)) return false
    return /electron/iu.test(String(entry.step.with?.path ?? ''))
  })
  if (!electronCache) {
    result.violations.push(violation('electron-cache', `${file} steps`, 'Workflow must cache the Electron download cache.'))
  } else if (typeof electronCache.step.with?.key !== 'string' || electronCache.step.with.key.trim() === '') {
    result.violations.push(violation('electron-cache', `${file} steps`, 'Electron cache step needs an explicit key.'))
  }

  const install = findGateStep(entries, 'pnpm install --frozen-lockfile')
  if (!install) {
    result.violations.push(violation(
      'install-frozen-lockfile',
      `${file} steps`,
      'Missing hard-gate step: `pnpm install --frozen-lockfile`.',
    ))
  } else {
    const position = (entry) => entries.indexOf(entry)
    if (pnpmSetup && position(pnpmSetup) > position(install)) {
      result.violations.push(violation('step-order', `${file} steps`, 'pnpm must be installed before dependencies.'))
    }
    if (nodeSetup && position(nodeSetup) > position(install)) {
      result.violations.push(violation('step-order', `${file} steps`, 'Node.js must be set up before dependencies.'))
    }
  }
}

function checkRequiredSteps(result, file, workflow) {
  const entries = collectSteps(workflow)
  const capturedCommands = (REQUIRED_CAPTURED_STEPS[file] ?? []).map(normalizeRun)
  for (const command of REQUIRED_RUN_STEPS[file]) {
    const normalized = normalizeRun(command)
    const found = findGateStep(entries, normalized)
    if (!found) {
      result.violations.push(violation(
        'required-step',
        `${file} steps`,
        `Missing hard-gate step: \`${command}\`.`,
      ))
      continue
    }
    if (capturedCommands.includes(normalized) && !parseCapturedRun(found.step.run ?? '')) {
      result.violations.push(violation(
        'log-capture',
        `${file} jobs.${found.jobId}.steps[${found.index}].run`,
        `\`${command}\` must capture its full output with `
          + '`2>&1 | Tee-Object -FilePath "$env:LITTLESHEEP_RUN_ARTIFACTS_DIR\\logs\\<name>.log"` '
          + 'so the artifact carries the complete log instead of the 4000-character stage excerpt.',
      ))
    }
  }
}

function checkDataRootBootstrap(result, file, workflow) {
  if (file !== 'ci-full.yml') return
  const entries = collectSteps(workflow)
  const bootstrap = findPlainStep(entries, normalizeRun(DATA_ROOT_BOOTSTRAP_COMMAND))
  if (!bootstrap) {
    result.violations.push(violation(
      'data-root-bootstrap',
      `${file} steps`,
      `Missing synthetic data-root bootstrap: \`${DATA_ROOT_BOOTSTRAP_COMMAND}\`.`,
    ))
    return
  }
  // The bootstrap exports LITTLESHEEP_RUN_ARTIFACTS_DIR, so it has to run
  // before the install step captures its log and before the gates that need
  // the synthetic data root.
  const install = findGateStep(entries, 'pnpm install --frozen-lockfile')
  if (install && entries.indexOf(bootstrap) > entries.indexOf(install)) {
    result.violations.push(violation(
      'data-root-order',
      `${file} steps`,
      'Synthetic data-root bootstrap must run before dependency installation so '
        + '`LITTLESHEEP_RUN_ARTIFACTS_DIR` exists for the captured install log.',
    ))
  }
  for (const command of DATA_ROOT_DEPENDENT_STEPS) {
    const dependent = findGateStep(entries, normalizeRun(command))
    if (!dependent) continue
    if (dependent.jobId !== bootstrap.jobId || entries.indexOf(dependent) < entries.indexOf(bootstrap)) {
      result.violations.push(violation(
        'data-root-order',
        `${file} steps`,
        `\`${command}\` must run after the synthetic data-root bootstrap in the same job.`,
      ))
    }
  }
}

function checkArtifactUpload(result, file, workflow) {
  if (file !== 'ci-full.yml') return
  const entries = collectSteps(workflow)
  const upload = findActionStep(entries, /^actions\/upload-artifact@v\d+$/u)
  if (!upload) {
    result.violations.push(violation(
      'artifact-upload',
      `${file} steps`,
      'Full gate must upload the verification report with actions/upload-artifact.',
    ))
    return
  }
  const step = upload.step
  const location = `${file} jobs.${upload.jobId}.steps[${upload.index}]`
  if (String(step.if ?? '').trim() !== 'always()') {
    result.violations.push(violation('artifact-always', `${location}.if`, 'Report upload must use `if: always()`.'))
  }
  if (typeof step.with?.name !== 'string' || step.with.name.trim() === '') {
    result.violations.push(violation('artifact-upload', `${location}.with.name`, 'Artifact upload needs a name.'))
  }
  const path = String(step.with?.path ?? '').trim()
  if (path !== '${{ env.LITTLESHEEP_RUN_ARTIFACTS_DIR }}') {
    result.violations.push(violation(
      'artifact-path',
      `${location}.with.path`,
      'Artifact upload must cover the whole `LITTLESHEEP_RUN_ARTIFACTS_DIR` root '
        + '(run metadata, captured logs and verification reports); '
        + `got ${path || '(missing)'}.`,
    ))
  }
  if (step.with?.['retention-days'] !== ARTIFACT_RETENTION_DAYS) {
    result.violations.push(violation(
      'artifact-retention',
      `${location}.with.retention-days`,
      `Artifact retention must be ${ARTIFACT_RETENTION_DAYS} days; got ${String(step.with?.['retention-days'] ?? '(missing)')}.`,
    ))
  }
  if (step.with?.['if-no-files-found'] !== 'error') {
    result.violations.push(violation(
      'artifact-missing-report',
      `${location}.with.if-no-files-found`,
      'A missing run-artifact directory must be a failure (`if-no-files-found: error`).',
    ))
  }
}

function checkCredentialCommandPatterns(result, file, workflow) {
  // Credential-shaped environment variables may live on the workflow, a job, or
  // a step; the per-step sweep above catches steps, this catches the rest.
  for (const [scopeName, scope] of [
    ['env', workflow?.env],
    ...Object.entries(asObject(workflow?.jobs) ?? {}).map(([jobId, job]) => [`jobs.${jobId}.env`, asObject(job)?.env]),
  ]) {
    const env = asObject(scope)
    if (!env) continue
    for (const key of Object.keys(env)) {
      if (BANNED_SECRET_KEY.test(key)) {
        result.violations.push(violation(
          'no-secrets',
          `${file} ${scopeName}.${key}`,
          'CI gates must not declare credential-shaped environment variables.',
        ))
      }
    }
  }
}

function checkPackageWiring(result, repoRoot, packageJson) {
  const scripts = asObject(packageJson?.scripts) ?? {}
  const packageManager = String(packageJson?.packageManager ?? '')
  const pnpmMatch = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageManager)
  if (!pnpmMatch) {
    result.violations.push(violation(
      'package-manager',
      'package.json packageManager',
      'package.json must pin `packageManager` to `pnpm@<exact version>`.',
    ))
  }
  const engineMinimum = parseEngineMinimum(packageJson?.engines?.node)
  if (!engineMinimum) {
    result.violations.push(violation(
      'node-engines',
      'package.json engines.node',
      'package.json must declare a simple `>=x.y.z` Node.js engine range.',
    ))
  } else {
    const pinned = parseVersion(REQUIRED_NODE_VERSION)
    if (!pinned || compareVersions(pinned, engineMinimum) < 0) {
      result.violations.push(violation(
        'node-engines',
        'package.json engines.node',
        `Pinned Node ${REQUIRED_NODE_VERSION} must satisfy engines.node ${packageJson.engines.node}.`,
      ))
    }
  }

  const recoveryScript = String(scripts['test:ci-recovery'] ?? '')
  if (!recoveryScript.startsWith('vitest run ')) {
    result.violations.push(violation(
      'recovery-suite',
      'package.json scripts.test:ci-recovery',
      '`test:ci-recovery` must start with `vitest run` and name the recovery suites explicitly.',
    ))
  }
  if (recoveryScript.includes('--passWithNoTests')) {
    result.violations.push(violation(
      'recovery-suite',
      'package.json scripts.test:ci-recovery',
      '`test:ci-recovery` must not use `--passWithNoTests`: an empty selection is a failure.',
    ))
  }
  for (const testFile of REQUIRED_RECOVERY_TESTS) {
    if (!recoveryScript.includes(testFile)) {
      result.violations.push(violation(
        'recovery-suite',
        'package.json scripts.test:ci-recovery',
        `\`test:ci-recovery\` no longer names required recovery suite ${testFile}.`,
      ))
    }
  }
  const recoveryAudit = String(scripts['verify:app-recovery'] ?? '')
  if (!recoveryAudit.includes('scripts/verify-app-recovery-sources.mjs')) {
    result.violations.push(violation(
      'recovery-audit',
      'package.json scripts.verify:app-recovery',
      '`verify:app-recovery` must run scripts/verify-app-recovery-sources.mjs.',
    ))
  }
  const fullGate = String(scripts['verify:full'] ?? '')
  if (!fullGate.includes('--gate=full')) {
    result.violations.push(violation(
      'full-gate',
      'package.json scripts.verify:full',
      '`verify:full` must invoke the verification-gate runner with --gate=full.',
    ))
  }
  return { pnpmVersion: pnpmMatch?.[1] ?? null }
}

async function checkCoverageDocument(result, repoRoot) {
  const doc = await readText(join(repoRoot, DOC_PATH))
  if (doc === null) {
    result.violations.push(violation('coverage-doc', DOC_PATH, 'CI coverage document is missing.'))
    return
  }
  if (!doc.includes(GUI_NOT_COVERED_MARKER)) {
    result.violations.push(violation(
      'gui-not-covered-doc',
      DOC_PATH,
      `Coverage document must keep the explicit marker ${GUI_NOT_COVERED_MARKER}.`,
    ))
  }
  if (!doc.includes(PLATFORM_EXCLUSIONS_MARKER)) {
    result.violations.push(violation(
      'platform-exclusions-doc',
      DOC_PATH,
      `Coverage document must keep the explicit marker ${PLATFORM_EXCLUSIONS_MARKER}.`,
    ))
  }
  const requiredPhrases = [
    ['真实显示器', 'must state that Electron GUI interaction tests need a real display'],
    ['verify:wsl-terminal', 'must name the dedicated WSL platform acceptance entry'],
    ['WSL', 'must record the WSL platform acceptance as a host-only exclusion'],
    ['ci-fast.yml', 'must name the fast workflow'],
    ['ci-full.yml', 'must name the full workflow'],
    ['windows-latest', 'must state the CI host'],
    ['Linux', 'must record Linux/macOS CI as an explicit follow-up'],
    ['LITTLESHEEP_DATA_DIR', 'must document the synthetic data-root environment'],
    ['不是真实用户数据恢复证据', 'must state that the synthetic root is not real user-data recovery evidence'],
    ['ci-run-metadata.json', 'must document the uploaded run metadata'],
    ['Tee-Object', 'must document the captured full gate log'],
    ['4000', 'must document the verification-report truncation limit'],
    ['首次托管运行检查清单', 'must keep the first hosted-run checklist'],
  ]
  for (const [phrase, reason] of requiredPhrases) {
    if (!doc.includes(phrase)) {
      result.violations.push(violation('coverage-doc', DOC_PATH, `Coverage document ${reason}: missing "${phrase}".`))
    }
  }
  const index = await readText(join(repoRoot, DOC_INDEX_PATH))
  if (index === null || !index.includes('ci-gates.md')) {
    result.violations.push(violation(
      'coverage-doc-index',
      DOC_INDEX_PATH,
      'docs/reference/README.md must link ci-gates.md (check:repo enforces the same rule).',
    ))
  }
  const bootstrapScript = await readText(join(repoRoot, BOOTSTRAP_SCRIPT_PATH))
  if (bootstrapScript === null) {
    result.violations.push(violation('data-root-bootstrap', BOOTSTRAP_SCRIPT_PATH, 'Synthetic data-root bootstrap script is missing.'))
    return
  }
  for (const key of DATA_ROOT_ENV_KEYS) {
    if (!bootstrapScript.includes(key)) {
      result.violations.push(violation(
        'data-root-bootstrap',
        BOOTSTRAP_SCRIPT_PATH,
        `Bootstrap script must export ${key}.`,
      ))
    }
  }
  if (!bootstrapScript.includes('ci-run-metadata.json')) {
    result.violations.push(violation(
      'data-root-bootstrap',
      BOOTSTRAP_SCRIPT_PATH,
      'Bootstrap script must write `ci-run-metadata.json` so early failures still upload run context.',
    ))
  }
  if (!bootstrapScript.includes('Insufficient free disk space')) {
    result.violations.push(violation(
      'data-root-bootstrap',
      BOOTSTRAP_SCRIPT_PATH,
      'Bootstrap script must fail with a clear reason when the artifact drive is below the free-space floor.',
    ))
  }
}

/**
 * Unexpected workflow files are rejected so a gate cannot be bypassed by
 * adding a second, unreviewed workflow that does the same work with weaker
 * settings. Adding a workflow is a deliberate policy change.
 */
async function checkUnexpectedWorkflows(result, repoRoot) {
  const directory = join(repoRoot, '.github', 'workflows')
  if (!existsSync(directory)) {
    result.violations.push(violation('workflow-missing', directory, '.github/workflows is missing.'))
    return
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    result.violations.push(violation('workflow-missing', directory, `Cannot read .github/workflows: ${error.message}`))
    return
  }
  const workflows = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .map((entry) => entry.name)
  for (const name of workflows) {
    if (!WORKFLOW_FILES.includes(name)) {
      result.violations.push(violation(
        'unexpected-workflow',
        `.github/workflows/${name}`,
        `Unexpected workflow ${name}; extend WORKFLOW_FILES and the policy deliberately instead.`,
      ))
    }
  }
}

function checkWorkflow(result, file, workflow, toolchain) {
  checkTriggers(result, file, workflow)
  checkTopLevel(result, file, workflow)
  checkSecretsAndLiveProviders(result, file, workflow)
  checkNoContinueOnError(result, file, workflow)
  checkJobs(result, file, workflow)
  checkToolchain(result, file, workflow, toolchain)
  checkRequiredSteps(result, file, workflow)
  checkDataRootBootstrap(result, file, workflow)
  checkArtifactUpload(result, file, workflow)
  checkCredentialCommandPatterns(result, file, workflow)
}

/**
 * Evaluate the CI policy.
 *
 * @param {{ repoRoot?: string }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   repoRoot: string,
 *   workflowFiles: string[],
 *   violations: Array<{code: string, location: string, message: string}>,
 *   facts: Record<string, unknown>,
 * }>}
 */
export async function evaluateCiPolicy({ repoRoot = moduleRoot } = {}) {
  const root = resolve(repoRoot)
  const result = {
    ok: true,
    repoRoot: root,
    workflowFiles: [],
    violations: [],
    facts: {},
  }
  const packageJson = await readJson(join(root, 'package.json'))
  if (!packageJson) {
    result.violations.push(violation('package-json', 'package.json', 'package.json is missing or unreadable.'))
    result.ok = false
    return result
  }
  const toolchain = checkPackageWiring(result, root, packageJson)
  result.facts.pnpmVersion = toolchain.pnpmVersion
  result.facts.nodeVersion = REQUIRED_NODE_VERSION

  await checkUnexpectedWorkflows(result, root)

  for (const file of WORKFLOW_FILES) {
    const path = join(root, '.github', 'workflows', file)
    if (!existsSync(path)) {
      result.violations.push(violation('workflow-missing', path, `Required workflow is missing: ${path}.`))
      continue
    }
    const text = await readText(path)
    let workflow
    try {
      workflow = parseYaml(text, { version: '1.2', uniqueKeys: true })
    } catch (error) {
      result.violations.push(violation('workflow-yaml', file, `Workflow is not valid YAML: ${error.message}`))
      continue
    }
    if (!asObject(workflow)) {
      result.violations.push(violation('workflow-yaml', file, 'Workflow root must be a YAML mapping.'))
      continue
    }
    result.workflowFiles.push(file)
    checkWorkflow(result, file, workflow, {
      ...toolchain,
      pnpmVersion: toolchain.pnpmVersion ?? '',
    })
  }

  await checkCoverageDocument(result, root)
  result.ok = result.violations.length === 0
  return result
}

/** One-line failure text, used by the CLI. */
export function formatViolation(item) {
  return `[fail] ${item.code}: ${item.location} — ${item.message}`
}
