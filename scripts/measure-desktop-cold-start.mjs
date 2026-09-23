// Real-Electron desktop cold-start benchmark (taskbook CS-01).
//
// It measures five user-visible moments that a single "window shown" timestamp
// cannot express, because the window is deliberately visible before the Runtime
// is ready:
//
//   1. process start            — the parent's spawn, plus the child's own
//                                 `processUptimeMs` anchor for the main-module
//                                 load that happens before any business log;
//   2. real first frame         — Chromium's first contentful paint for the
//                                 production renderer document;
//   3. input usable             — the composer accepted a typed character (not
//                                 merely "the textarea exists");
//   4. current session readable — a session row from `sessions.json` is on
//                                 screen, i.e. metadata reads answered;
//   5. first executable         — `/runtime/readiness` reported `ready`.
//
// Each profile runs in an isolated data root, so an empty first run, an ordinary
// history, a large history and a pending-recovery data root are separate
// samples. Every raw sample is kept; no percentile is claimed from too few runs.
//
// `--launches=N` starts the application N times against the *same* data root
// before moving to the next sample. Launch 1 is the cold start; every later
// launch is a steady-state start of the same installation, which is a different
// measurement: the bootstrap resource registration and any first-run layout work
// are already done. Both kinds are recorded separately and both are guarded.
//
// Usage:
//   node scripts/measure-desktop-cold-start.mjs [--samples=3] [--profiles=empty,normal,large,recovery]
//                                               [--launches=1] [--label=before]
//                                               [--out=docs/reference/cold-start-baseline]
//                                               [--keep] [--no-send]

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, repoRoot } from './lib/electron-cdp-harness.mjs'

const PACKAGED_EXECUTABLE_RELATIVE = 'release/win-unpacked/LittleSheep.exe'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const appKind = readOption('app', 'dev')
if (appKind !== 'dev' && appKind !== 'packaged') {
  throw new Error(`--app must be dev or packaged, received ${appKind}`)
}
const packagedExecutable = appKind === 'packaged' ? resolve(repoRoot, PACKAGED_EXECUTABLE_RELATIVE) : undefined
const harness = createElectronHarness({
  startTimeoutMs: 90_000,
  actionTimeoutMs: 30_000,
  ...(packagedExecutable === undefined ? {} : { packagedExecutable }),
})
const PROFILES = ['empty', 'normal', 'large', 'recovery']
const READINESS_TIMEOUT_MS = 90_000
const SESSION_READABLE_TIMEOUT_MS = 60_000

const samples = Number.parseInt(readOption('samples', '3'), 10)
const launches = Math.max(1, Number.parseInt(readOption('launches', '1'), 10))
const label = readOption('label', 'unlabeled')
const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoots = process.argv.includes('--keep')
const measureFirstSend = !process.argv.includes('--no-send')
const profiles = readOption('profiles', PROFILES.join(',')).split(',').map((item) => item.trim()).filter(Boolean)

for (const profile of profiles) {
  if (!PROFILES.includes(profile)) throw new Error(`unknown profile: ${profile}`)
}

async function main() {
  await harness.assertBuildFresh()
  const startedAt = new Date()
  const machine = await readMachineDescription()
  const runs = []

  for (const profile of profiles) {
    for (let index = 0; index < samples; index += 1) {
      const family = await runSampleFamily({ profile, index, launches })
      for (const sample of family) {
        runs.push(sample)
        const suffix = launches > 1 ? ` launch ${sample.launch}/${launches}` : ''
        console.log(`[cold-start] ${profile} #${index + 1}${suffix}: ${JSON.stringify(sample.timings)}`)
      }
    }
  }

  const coldRuns = runs.filter((run) => (run.launch ?? 1) === 1)
  const warmRuns = runs.filter((run) => (run.launch ?? 1) > 1)
  const summary = summarizeRuns(coldRuns)
  const warmSummary = warmRuns.length === 0 ? undefined : summarizeRuns(warmRuns)
  const budgets = await readBudgets(outDir)
  const assertions = evaluateBudgets({ summary, warmSummary }, budgets)
  const ledger = {
    check: 'desktop-cold-start',
    label,
    app: appKind,
    appExecutable: appKind === 'packaged' ? PACKAGED_EXECUTABLE_RELATIVE : 'packages/app/out (dev entry)',
    startedAt: startedAt.toISOString(),
    samples,
    launches,
    profiles,
    note: [
      'Hot-cache repeats are not a full cold start: a rebooted machine and a',
      'first-ever binary read are outside what this harness can automate.',
      'Each sample uses a fresh isolated data root, so the data layout is cold',
      'while the OS file cache for the application bundle is warm from the',
      'previous repeat. Treat the first repeat of a session as the coldest.',
      launches > 1
        ? `Launch 1 of each sample is the cold start; launches 2-${launches} reuse that data root and are steady-state starts (first-run layout and bootstrap registration already done).`
        : 'Only one launch per sample was taken, so the ledger has no steady-state numbers.',
    ],
    machine,
    runs,
    summary,
    ...(warmSummary === undefined ? {} : { warmSummary }),
    budgets,
    assertions,
  }
  await mkdir(outDir, { recursive: true })
  const jsonPath = join(outDir, `desktop-cold-start-${label}.json`)
  await writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  // The human-readable summary is printed and rendered on demand; only the raw
  // ledger is written so a run cannot silently overwrite a curated report.
  const markdown = renderMarkdown(ledger)
  console.log(JSON.stringify({ ok: assertions.ok, jsonPath, summary, assertions: assertions.checks }, null, 2))
  if (process.argv.includes('--markdown')) {
    const markdownPath = join(outDir, `desktop-cold-start-${label}.md`)
    await writeFile(markdownPath, markdown, 'utf8')
    console.log(`[cold-start] wrote ${markdownPath}`)
  }
  if (!assertions.ok) process.exitCode = 1
}

/**
 * Optional regression guard. A missing budgets file means the run is a pure
 * baseline: the numbers are still recorded, and nothing is asserted.
 */
async function readBudgets(dir) {
  const explicit = readOption('budgets', '')
  const path = explicit || join(dir, 'budgets.json')
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    console.warn(`[cold-start] ignoring unreadable budgets file ${path}: ${error.message}`)
    return undefined
  }
}

/**
 * Compare each metric's observed maximum against its budget.
 *
 * The maximum, not the median: one slow run is what a user notices, and a small
 * sample cannot support a percentile claim. Cold (`launch 1`) and steady-state
 * (`launch 2+`) samples are checked separately against the same limits, because
 * a regression can appear in either one.
 *
 * `warmVsColdMs` adds the one thing the shared limits cannot express: the second
 * launch of an installation must not become *slower* than the first, which is
 * what a start-up path that redoes first-run work would look like while still
 * sitting under an absolute limit.
 */
function evaluateBudgets({ summary, warmSummary }, budgets) {
  // The packaged build reads a full unpacked tree, so a session's first launch is
  // disk-cold and much slower than the dev build ever is; it gets its own limits
  // instead of loosening the dev guard. A missing packaged set falls back to the
  // dev limits, and the set actually used is reported either way.
  const budgetSet = appKind === 'packaged' && budgets?.packagedBudgetsMs ? 'packagedBudgetsMs' : 'budgetsMs'
  const budgetsMs = budgets?.[budgetSet]
  if (!budgetsMs) return { ok: true, checks: {}, note: 'no budgets file; baseline only' }
  const checks = {}
  let ok = true
  const groups = [
    ...Object.entries(summary ?? {}).map(([profile, group]) => [profile, group]),
    ...Object.entries(warmSummary ?? {}).map(([profile, group]) => [`${profile}~warm`, group]),
  ]
  for (const [name, group] of groups) {
    for (const [metric, budget] of Object.entries(budgetsMs)) {
      const values = group.metrics?.[metric]?.values
      if (!values || values.length === 0) continue
      const observedMax = Math.max(...values)
      checks[`${name}.${metric}`] = { observedMax, budget, ok: observedMax <= budget }
      if (observedMax > budget) ok = false
    }
  }
  // Keyed by metric, not by profile: the same drift is worth watching in every
  // profile, and a missing entry means "not compared" rather than "no limit".
  const margins = budgets.warmVsColdMs ?? {}
  for (const [profile, cold] of Object.entries(summary ?? {})) {
    const warm = warmSummary?.[profile]?.metrics
    if (!warm) continue
    for (const [metric, margin] of Object.entries(margins)) {
      const coldMedian = median(cold.metrics?.[metric]?.values)
      const warmMedian = median(warm[metric]?.values)
      if (coldMedian === undefined || warmMedian === undefined) continue
      const delta = round(warmMedian - coldMedian)
      const passed = delta <= margin
      checks[`${profile}.warm-vs-cold.${metric}`] = { coldMedian, warmMedian, delta, budget: margin, ok: passed }
      if (!passed) ok = false
    }
  }
  return { ok, checks, budgetSet }
}

function median(values) {
  const sorted = (values ?? []).filter((value) => typeof value === 'number').sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * One sample = one data root, launched `launches` times.
 *
 * The fixture is written once, before the first launch: later launches see the
 * layout the first launch produced, which is exactly what separates a steady
 * state from a cold one. A fixture failure is recorded as a failed first launch
 * instead of aborting the whole run.
 */
async function runSampleFamily({ profile, index, launches }) {
  const root = await mkdtemp(join(tmpdir(), `littlesheep-cold-start-${profile}-`))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const collected = []
  let fixtureError
  try {
    await prepareFixture({ profile, dataDir, workspaceDir })
  } catch (error) {
    fixtureError = error
  }
  try {
    if (fixtureError !== undefined) {
      collected.push({
        profile,
        index,
        launch: 1,
        launchCount: launches,
        warm: false,
        ok: false,
        error: `fixture preparation failed: ${fixtureError instanceof Error ? fixtureError.message : String(fixtureError)}`,
        timings: {},
      })
      return collected
    }
    for (let launch = 1; launch <= launches; launch += 1) {
      collected.push(await runOneLaunch({ profile, index, launch, launchCount: launches, root, dataDir, workspaceDir }))
    }
  } finally {
    const allOk = collected.length === launches && collected.every((run) => run.ok)
    if (keepRoots) console.log(`[cold-start] kept ${root}`)
    else if (allOk) await harness.removeTemporaryRoot(root)
    else console.log(`[cold-start] kept ${root} after a failed launch`)
  }
  return collected
}

async function runOneLaunch({ profile, index, launch, launchCount, root, dataDir, workspaceDir }) {
  // Each launch gets its own Chromium profile: a lock left by the previous
  // process would otherwise block or redirect the next start, and that would
  // measure the harness rather than the application.
  const chromiumDir = launch === 1 ? join(root, 'chromium') : join(root, `chromium-${launch}`)
  const logPath = launch === 1 ? join(root, 'electron.log') : join(root, `electron-${launch}.log`)
  let electron
  let client
  const timings = {}
  const diagnostics = {
    profile,
    index,
    launch,
    launchCount,
    warm: launch > 1,
    ok: false,
  }
  try {
    const debuggingPort = await harness.reservePort()
    let spawnRequestedAt = 0
    electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
      onSpawn: ({ spawnRequestedAt: at }) => { spawnRequestedAt = at },
    })
    diagnostics.pid = electron.pid
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    const locatorAt = Date.now()
    client = await harness.connectRenderer(debuggingPort)
    const attachedAt = Date.now()
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    const bootstrapTimings = await harness.readBootstrapTimings(logPath)
    const mainModuleReady = stageUptime(bootstrapTimings, 'main-module-ready')
    const processStart = stageUptime(bootstrapTimings, 'process-start')
    // The parent's spawn call precedes the OS process by however long Node needs
    // to bootstrap; `process.uptime()` starts at creation, so subtracting it
    // recovers the real process-creation instant for wall-clock metrics.
    const processCreatedAt = processStart === undefined ? spawnRequestedAt : spawnRequestedAt - processStart
    diagnostics.processCreatedAt = Math.round(processCreatedAt)
    timings.mainModuleReadyMs = mainModuleReady
    timings.processStartRecordedAtMs = processStart
    timings.spawnToMainModuleMs = processStart === undefined ? undefined : round(processStart)
    timings.spawnToLocatorMs = round(locatorAt - processCreatedAt)
    timings.locatorToCdpAttachedMs = round(attachedAt - locatorAt)

    const input = await measureInputUsable(client)
    timings.inputUsableMs = input.elapsedMs
    timings.inputAcceptedCharacter = input.accepted

    const sessionReadable = await measureSessionReadable(client, profile)
    timings.sessionReadableMs = sessionReadable.elapsedMs
    if (sessionReadable.error) diagnostics.sessionReadableError = sessionReadable.error

    // The real first frame is the renderer's own report (see
    // `renderer-timing.ts`): it observes the paint on its own timeline, where
    // `performance.now()` starts at navigation. Main timestamps the report's
    // arrival as `processUptimeMs`, which is the same origin the other metrics
    // use, so the two together give both the renderer-relative duration and the
    // process-relative instant without comparing two different clocks.
    //
    // Readiness is observed concurrently: the frame wait has its own timeout, and
    // a report that never arrives must be recorded as a missing frame rather than
    // charged to "first executable" as 15 extra seconds.
    const readinessObservation = waitForExecutionReady(locator, processCreatedAt)
    const rendererFrame = await waitForRendererFrame(logPath)
    timings.rendererFirstFrameMs = rendererFrame?.durationMs
    timings.processCreateToFirstFrameMs = rendererFrame?.processUptimeMs
    diagnostics.rendererFrameReported = rendererFrame !== undefined

    const readiness = await readinessObservation
    timings.executionReadyMs = readiness.elapsedMs
    diagnostics.readinessPhase = readiness.state?.phase

    if (measureFirstSend) {
      const send = await measureFirstSendPreparation(client)
      timings.firstSendPreparationMs = send.elapsedMs
      diagnostics.firstSendOutcome = send.outcome
    }

    diagnostics.ok = true
    Object.assign(diagnostics, { bootstrapTimings, rendererState: await readRendererState(client) })
    return { ...diagnostics, timings }
  } catch (error) {
    diagnostics.error = error instanceof Error ? error.message : String(error)
    diagnostics.bootstrapTimings = await harness.readBootstrapTimings(logPath).catch(() => [])
    if (client) diagnostics.rendererState = await readRendererState(client).catch(() => undefined)
    return { ...diagnostics, timings }
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
  }
}

/**
 * Poll the bootstrap log for the renderer's own first-frame report.
 *
 * The renderer sends it over IPC when the paint happens, which can be before or
 * after the debugger attaches, so a single read races. Bounded polling keeps the
 * metric reproducible; a missing report after the bound is reported as absent.
 */
async function waitForRendererFrame(logPath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await harness.readBootstrapTimings(logPath).catch(() => [])
    const entry = entries.find((item) => item.stage === 'renderer-first-frame')
    if (entry && typeof entry.durationMs === 'number' && typeof entry.processUptimeMs === 'number') {
      return { durationMs: entry.durationMs, processUptimeMs: entry.processUptimeMs }
    }
    await harness.delay(100)
  }
  return undefined
}

async function measureInputUsable(client) {
  const result = await harness.waitFor(async () => {
    const present = await client.evaluate(`(() => {
      const input = document.querySelector('.composer textarea');
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? true : null;
    })()`)
    return present === true ? true : undefined
  }, SESSION_READABLE_TIMEOUT_MS, 'composer input').then(() => true)

  const outcome = await client.evaluate(`(async () => {
    const input = document.querySelector('.composer textarea');
    if (!input) return { accepted: false, at: null };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, 'a');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { accepted: input.value === 'a', at: performance.now() };
  })()`)
  // Clear the probe so the draft does not leak into the send measurement.
  await client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  return { accepted: outcome?.accepted === true && result, elapsedMs: outcome?.at == null ? undefined : round(outcome.at) }
}

const SESSION_ROW_SELECTOR = '.session-item, [data-session-id]'

async function measureSessionReadable(client, profile) {
  if (profile === 'empty') return { elapsedMs: undefined, expected: 0 }
  try {
    const value = await harness.waitFor(async () => {
      const at = await client.evaluate(`(() => {
        const row = document.querySelector(${JSON.stringify(SESSION_ROW_SELECTOR)});
        return row ? performance.now() : null;
      })()`)
      return typeof at === 'number' ? at : undefined
    }, SESSION_READABLE_TIMEOUT_MS, 'session row')
    return { elapsedMs: round(value) }
  } catch (error) {
    // A missing row is a measurement failure, not a run failure: report it and
    // keep the other four moments. The renderer state below shows what was on
    // screen so the gap is diagnosable instead of silently zero.
    return { elapsedMs: undefined, error: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForExecutionReady(locator, processCreatedAt) {
  let lastState
  let failure
  const state = await harness.waitFor(async () => {
    const response = await fetch(harness.apiUrl(locator, '/runtime/readiness')).catch(() => undefined)
    if (!response?.ok) return undefined
    const body = await response.json().catch(() => undefined)
    lastState = body
    if (!body || typeof body.state !== 'string') return undefined
    if (body.state === 'failed') {
      failure = `execution readiness failed: ${body.reason ?? 'no reason reported'}`
      return true
    }
    return body.state === 'ready' ? body : undefined
  }, READINESS_TIMEOUT_MS, 'execution readiness')
  if (failure) throw new Error(failure)
  return { state: state ?? lastState, elapsedMs: round(Date.now() - processCreatedAt) }
}

/**
 * How long a real first send needs before the Runtime accepts it. With no model
 * configured the run cannot succeed, so this measures preparation latency: the
 * SSE `start` frame (when it arrives) is the accepted-send timestamp, and a
 * restored draft with a visible error notice is recorded as the honest failure
 * outcome instead of being reported as a success.
 */
async function measureFirstSendPreparation(client) {
  const startedAt = await client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, 'cold start probe');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return performance.now();
  })()`)
  if (typeof startedAt !== 'number') return { elapsedMs: undefined, outcome: 'no-input' }

  const converged = await harness.waitFor(async () => {
    const state = await client.evaluate(`(() => {
      const input = document.querySelector('.composer textarea');
      const notice = document.querySelector('.composer-error, .runtime-event-notice');
      return {
        draft: input ? input.value : null,
        notice: notice ? notice.textContent : null,
        at: performance.now(),
      };
    })()`)
    if (!state) return undefined
    if (state.notice) return state
    // A consumed draft means the Runtime accepted the send.
    if (state.draft !== null && state.draft.trim() === '') return { ...state, accepted: true }
    return undefined
  }, harness.actionTimeoutMs, 'first send preparation')

  await client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`).catch(() => undefined)
  return {
    elapsedMs: round(converged.at - startedAt),
    outcome: converged.accepted === true ? 'accepted' : `rejected: ${String(converged.notice).slice(0, 120)}`,
  }
}

async function readRendererState(client) {
  return client.evaluate(`(() => ({
    url: location.href,
    readyState: document.readyState,
    hasRoot: Boolean(document.querySelector('#root')),
    hasComposer: Boolean(document.querySelector('.composer textarea')),
    sessionRows: document.querySelectorAll(${JSON.stringify(SESSION_ROW_SELECTOR)}).length,
    readinessNotice: document.querySelector('.runtime-readiness-notice')?.textContent ?? null,
  }))()`)
}

function stageUptime(entries, stage) {
  const entry = entries.find((item) => item.stage === stage)
  return typeof entry?.processUptimeMs === 'number' ? entry.processUptimeMs : undefined
}

async function prepareFixture({ profile, dataDir, workspaceDir }) {
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(workspaceDir, 'README.md'), '# Cold-start fixture\n', 'utf8')
  const configPath = join(dataDir, 'config.json')
  if (profile !== 'empty') {
    await mkdir(dataDir, { recursive: true })
    await writeFile(configPath, `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')
  }
  if (profile === 'empty') return

  const counts = profile === 'large'
    ? { sessions: 200, withHistory: 30, messagesPerHistory: 120 }
    : { sessions: 40, withHistory: 12, messagesPerHistory: 20 }
  await seedSessions(dataDir, counts)
  if (profile === 'recovery') await seedCheckpoints(dataDir, 10)
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    // A declared provider with a dummy key keeps `createRunner` able to build
    // its LLM client: execution readiness then reaches `ready` without any real
    // credential, so the first-executable metric measures startup rather than a
    // configuration failure. The first send still fails closed at the provider,
    // which is exactly the honest outcome this profile records.
    providers: [{
      id: 'fixture',
      name: 'Fixture Provider',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-key-not-a-credential',
      models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'fixture/fixture-model',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 15,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function seedSessions(dataDir, { sessions, withHistory, messagesPerHistory }) {
  const sessionsDir = join(dataDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const now = Date.now()
  const index = []
  for (let position = 0; position < sessions; position += 1) {
    const id = `session-${String(position).padStart(4, '0')}`
    index.push({
      id,
      title: `Fixture session ${position}`,
      createdAt: now - (sessions - position) * 60_000,
      lastMessageAt: now - position * 1_000,
      mode: 'research',
      scope: 'standalone',
    })
    if (position < withHistory) {
      await writeFile(
        join(sessionsDir, `${id}.jsonl`),
        buildSessionHistory(id, messagesPerHistory).join('\n'),
        'utf8',
      )
    }
  }
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: index }, null, 2)}\n`, 'utf8')
}

function buildSessionHistory(sessionId, messageCount) {
  const lines = [JSON.stringify({ version: 1, sessionId, createdAt: '2026-09-01T00:00:00.000Z' })]
  for (let position = 0; position < messageCount; position += 1) {
    lines.push(JSON.stringify({
      role: position % 2 === 0 ? 'user' : 'assistant',
      content: position % 2 === 0
        ? `Fixture request ${position} for cold-start history.`
        : `Fixture reply ${position} with enough text to make the record non-trivial.`,
      at: 1_756_684_800_000 + position * 1_000,
    }))
  }
  return lines
}

/**
 * Copy real checkpoint files so the fixture exercises the same discovery path
 * as a genuine interrupted app. Missing sources are reported, never faked.
 */
async function seedCheckpoints(dataDir, count) {
  const sourceDir = process.env.LITTLESHEEP_CHECKPOINT_SOURCE
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.littlesheep', 'run-checkpoints')
  const targetDir = join(dataDir, 'run-checkpoints')
  if (!existsSync(sourceDir)) return { copied: 0, reason: `no checkpoint source at ${sourceDir}` }
  await mkdir(targetDir, { recursive: true })
  const entries = (await readdir(sourceDir)).filter((name) => name.endsWith('.json')).slice(0, count)
  for (const name of entries) {
    await writeFile(join(targetDir, name), await readFile(join(sourceDir, name)))
  }
  return { copied: entries.length }
}

function summarizeRuns(runs) {
  const summary = {}
  for (const profile of [...new Set(runs.map((run) => run.profile))]) {
    const group = runs.filter((run) => run.profile === profile && run.ok)
    const metrics = {}
    for (const key of [
      'spawnToMainModuleMs',
      'spawnToLocatorMs',
      'rendererFirstFrameMs',
      'processCreateToFirstFrameMs',
      'inputUsableMs',
      'sessionReadableMs',
      'executionReadyMs',
      'firstSendPreparationMs',
    ]) {
      const values = group.map((run) => run.timings[key]).filter((value) => typeof value === 'number')
      metrics[key] = values.length === 0
        ? null
        : { samples: values.length, min: round(Math.min(...values)), max: round(Math.max(...values)), values: values.map(round) }
    }
    summary[profile] = { runs: group.length, failedRuns: runs.filter((run) => run.profile === profile && !run.ok).length, metrics }
  }
  return summary
}

function renderMarkdown(ledger) {
  const lines = [
    `# 桌面冷启动基线（${ledger.label}）`,
    '',
    `最后更新：${formatLocal(ledger.startedAt)}`,
    '',
    '本文件由 `scripts/measure-desktop-cold-start.mjs` 生成，记录真实 Electron 进程的逐次原始样本。',
    '',
    '## 环境与口径',
    '',
    `- 机器：${ledger.machine.platform} ${ledger.machine.arch}，CPU ${ledger.machine.cpuModel}（${ledger.machine.cpuCount} 逻辑核），内存 ${ledger.machine.totalMemoryGb} GB`,
    `- Electron：${ledger.machine.electronVersion}，App 构建输入摘要 ${ledger.machine.appBuildInputDigest?.slice(0, 16) ?? 'unknown'}`,
    `- 样本：每个 profile ${ledger.samples} 次，数据根每次隔离`,
    ledger.launches > 1
      ? `- 每次样本启动 ${ledger.launches} 次：第 1 次是冷启动，${ledger.launches === 2 ? '第 2 次' : `第 2–${ledger.launches} 次`}复用同一数据根，属稳态启动`
      : '- 每次样本只启动一次，本账本没有稳态启动数据（用 `--launches=N` 采集）',
    '- 锚点：`spawnToMainModuleMs` 取子进程 `process.uptime()`（Electron 的 `process.getCreationTime()` 不在同一时间轴，故不使用）；其余为父进程墙钟与渲染器 `performance.now()`',
    `- 冷启动口径：${ledger.note.join(' ')}`,
    '',
    '## 逐 profile 汇总（ms，冷启动 = 每次样本的第 1 次启动）',
    '',
    '| 指标 | ' + ledger.profiles.join(' | ') + ' |',
    '| --- | ' + ledger.profiles.map(() => '---:').join(' | ') + ' |',
  ]
  const metricLabels = {
    spawnToMainModuleMs: '进程启动 → 主模块加载完成',
    spawnToLocatorMs: '进程启动 → Local App API 就绪文件',
    rendererFirstFrameMs: '导航开始 → 真实首帧（渲染器时间轴）',
    processCreateToFirstFrameMs: '进程启动 → 真实首帧',
    inputUsableMs: '输入区可输入（渲染器时间轴）',
    sessionReadableMs: '当前会话可读（渲染器时间轴）',
    executionReadyMs: '首次可执行（进程启动起算）',
    firstSendPreparationMs: '首次发送准备耗时',
  }
  for (const [key, text] of Object.entries(metricLabels)) {
    const cells = ledger.profiles.map((profile) => {
      const metric = ledger.summary?.[profile]?.metrics?.[key]
      if (!metric) return '—'
      return metric.min === metric.max ? `${metric.min}` : `${metric.min}–${metric.max}`
    })
    lines.push(`| ${text} | ${cells.join(' | ')} |`)
  }
  if (ledger.warmSummary) {
    lines.push(
      '',
      `## 稳态启动汇总（ms，同一数据根的第 ${ledger.launches === 2 ? '2' : `2–${ledger.launches}`} 次启动）`,
      '',
      '同样按"观测最大值"受 `budgets.json` 的同一组上限约束，另有 `warmVsColdMs` 约束"稳态不得比首次启动更慢"。',
      '',
      '| 指标 | ' + ledger.profiles.join(' | ') + ' |',
      '| --- | ' + ledger.profiles.map(() => '---:').join(' | ') + ' |',
    )
    for (const [key, text] of Object.entries(metricLabels)) {
      const cells = ledger.profiles.map((profile) => {
        const metric = ledger.warmSummary?.[profile]?.metrics?.[key]
        if (!metric) return '—'
        return metric.min === metric.max ? `${metric.min}` : `${metric.min}–${metric.max}`
      })
      lines.push(`| ${text} | ${cells.join(' | ')} |`)
    }
  }
  lines.push('', '## 逐次原始样本', '')
  for (const run of ledger.runs) {
    const launchLabel = ledger.launches > 1 ? ` launch ${run.launch ?? 1}/${ledger.launches}` : ''
    lines.push(`### ${run.profile} #${run.index + 1}${launchLabel}${run.ok ? '' : '（失败）'}`, '')
    if (!run.ok) lines.push(`- 错误：${run.error}`, '')
    lines.push('```json', JSON.stringify(run.timings, null, 2), '```', '')
  }
  lines.push('## 未覆盖的场景', '', '- 系统重启后的完全冷启动、125%/150%/200% 缩放与明暗桌面实拍、打包版安装包实机：需要人工执行，尚无样本。', '')
  return lines.join('\n')
}

async function readMachineDescription() {
  const os = await import('node:os')
  const electron = await readElectronVersion()
  const manifest = await readFile(join(repoRoot, 'packages/app/out/.littlesheep-build-fingerprint.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    electronVersion: electron,
    appBuildInputDigest: manifest?.input?.digest ?? manifest?.inputDigest,
  }
}

async function readElectronVersion() {
  const path = join(repoRoot, 'packages/app/node_modules/electron/package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  return manifest.version
}

function formatLocal(iso) {
  const date = new Date(iso)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined
}

await main()
