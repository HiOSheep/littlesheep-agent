// Real-window measurement for CS-10: a data root with hundreds of historical
// durable-event partitions must not delay execution readiness, and the light
// routes must stay answerable while the Runner is still recovering.
//
// Why a synthetic data root: the real one that exposed this (about 399 partitions,
// 13,769 event files) belongs to the user and cannot be committed, and its numbers
// exist only as prose in the taskbook. This script writes partitions in the exact
// on-disk format the store validates (`durable-events/<sha256(sessionId\0runId)>/
// <cursor>-<sha256(eventId)>.json`, version 1, contiguous cursors, completed runs)
// so the app's own reader is what proves the fixture is well formed. What it can
// prove is the mechanism - recovery no longer gates readiness, metadata and
// workspace routes answer during it. What it cannot prove is real-disk behaviour
// at the real scale, and the ledger says so.
//
// Usage:
//   node scripts/measure-desktop-large-history-startup.mjs [--partitions=400] [--label=2026-09-24] [--out=docs/reference/cold-start-baseline] [--keep]

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, CdpClient, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const EVENT_VERSION = 1
const PARTITION_NAME = /^[a-f0-9]{64}$/u

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 120_000, actionTimeoutMs: 30_000 })
const partitions = Number.parseInt(readOption('partitions', '400'), 10)
const label = readOption('label', '2026-09-24')
const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoots = process.argv.includes('--keep')
const POST_READY_SAMPLES = 20

const hashParts = (...parts) => createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')
const round = (value) => Math.round(value * 10) / 10

/**
 * One completed historical run, in the exact format the store reads back.
 *
 * The stream has to be a *valid* settled run, not just any two events: the
 * recovery pass reads every discovered run, and a run whose completion lacks a
 * settled final reply is rejected ("run completion requires a settled final
 * reply"), which would turn the fixture into 400 real failures instead of 400
 * cheap skips. Field requirements come from the kernel's projection.
 */
function buildPartitionEvents(sessionId, runId) {
  const base = (cursor, type, payload) => ({
    version: EVENT_VERSION,
    eventId: `${sessionId}:${runId}:${type}:${cursor}`,
    idempotencyKey: `${sessionId}:${runId}:${type}:${cursor}`,
    sessionId,
    runId,
    cursor,
    type,
    source: 'runtime',
    occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, cursor)).toISOString(),
    payload,
  })
  const reply = { reply: '历史夹具回复', replyFingerprint: `fixture-${runId}`, modelRequestId: `fixture-model-${runId}` }
  return [
    base(1, 'run_accepted', { fixture: 'historical-run' }),
    base(2, 'final_reply_proposed', reply),
    base(3, 'final_reply_settled', reply),
    base(4, 'run_completed', { fixture: 'historical-run' }),
  ]
}

async function synthesizeHistoricalPartitions(root, count) {
  const eventsRoot = join(root, 'durable-events')
  await mkdir(eventsRoot, { recursive: true })
  const startedAt = Date.now()
  let files = 0
  for (let index = 0; index < count; index += 1) {
    const sessionId = `history-fixture-session-${index}`
    const runId = `history-fixture-run-${index}`
    const partition = join(eventsRoot, hashParts(sessionId, runId))
    if (!PARTITION_NAME.test(partition.split(/[\\/]/u).at(-1) ?? '')) {
      throw new Error('synthesized partition name is not a 64-hex hash')
    }
    await mkdir(partition, { recursive: true })
    for (const event of buildPartitionEvents(sessionId, runId)) {
      const fileName = `${String(event.cursor).padStart(12, '0')}-${hashParts(event.eventId)}.json`
      await writeFile(join(partition, fileName), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'wx' })
      files += 1
    }
  }
  return { eventsRoot, partitions: count, files, synthesizeMs: Date.now() - startedAt }
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
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

async function seedSessions(dataDir) {
  const now = Date.now()
  const sessions = [0, 1].map((index) => ({
    id: `history-session-${index}`,
    title: `大历史会话 ${index}`,
    createdAt: now - index * 1_000,
    lastMessageAt: now - index * 1_000,
    mode: 'research',
    scope: 'standalone',
  }))
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
  return sessions
}

async function readReadiness(locator) {
  const response = await fetch(harness.apiUrl(locator, '/runtime/readiness')).catch(() => undefined)
  if (!response?.ok) return undefined
  return response.json().catch(() => undefined)
}

/** One timed GET against the live API; the status and latency are the evidence. */
async function timedGet(locator, path) {
  const startedAt = Date.now()
  const response = await fetch(harness.apiUrl(locator, path), { headers: harness.authHeaders(locator) }).catch((error) => ({ error }))
  const ms = Date.now() - startedAt
  if (response?.error) return { path, ms, status: null, error: String(response.error) }
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { path, ms, status: response.status, ...(body === undefined ? {} : { bodyBytes: JSON.stringify(body).length }) }
}

function marksFromLog(text) {
  const marks = {}
  for (const line of text.split(/\r?\n/u)) {
    const index = line.indexOf('[bootstrap-timing]')
    if (index < 0) continue
    try {
      const parsed = JSON.parse(line.slice(index + '[bootstrap-timing]'.length).trim())
      if (parsed?.stage) marks[parsed.stage] = parsed
    } catch {
      // A partially flushed line is not evidence.
    }
  }
  return marks
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-large-history-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  let client
  let child
  const observation = { steps: [] }
  const failures = []

  try {
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(workspaceDir, 'README.md'), `# 大历史夹具\n\n${'正文段落。\n\n'.repeat(80)}`, 'utf8')
    await writeFile(join(workspaceDir, 'notes.md'), '# notes\n\n第二份文件。\n', 'utf8')
    const fixture = await synthesizeHistoricalPartitions(dataDir, partitions)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')
    const sessions = await seedSessions(dataDir)
    observation.fixture = {
      partitions: fixture.partitions,
      eventFiles: fixture.files,
      synthesizeMs: fixture.synthesizeMs,
      sessions: sessions.length,
      eventsPerRun: 4,
    }

    let spawnRequestedAt = 0
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
      onSpawn: ({ spawnRequestedAt: at }) => {
        spawnRequestedAt = at
      },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    const apiListeningMs = Date.now() - spawnRequestedAt

    // 1. While the Runner is still recovering, the light routes must answer.
    const duringRecovery = []
    let readiness = await readReadiness(locator)
    const recoveryStartedAt = Date.now()
    while (readiness?.state === 'starting' && Date.now() - recoveryStartedAt < 60_000) {
      const round = await Promise.all([
        timedGet(locator, '/runtime/readiness'),
        timedGet(locator, '/runtime'),
        timedGet(locator, '/sessions'),
        timedGet(locator, '/workspace/list'),
      ])
      duringRecovery.push({ atMs: Date.now() - spawnRequestedAt, results: round })
      readiness = await readReadiness(locator)
      if (duringRecovery.length >= 40) break
      await delay(250)
    }
    const executionReadyMs = Date.now() - spawnRequestedAt
    observation.steps.push({
      step: 'during-recovery',
      apiListeningMs,
      executionReadyMs,
      readinessState: readiness?.state ?? null,
      samples: duringRecovery.length,
      slowest: duringRecovery
        .flatMap((sample) => sample.results.map((result) => ({ atMs: sample.atMs, ...result })))
        .sort((left, right) => right.ms - left.ms)
        .slice(0, 5),
    })
    if (readiness?.state !== 'ready') {
      failures.push({ check: 'execution readiness still arrives with a large historical data root', detail: { readiness, executionReadyMs } })
    }
    const lightFailures = duringRecovery
      .flatMap((sample) => sample.results)
      .filter((result) => result.status === null || result.status >= 500)
    if (lightFailures.length > 0) {
      failures.push({ check: 'light routes answer while the Runner is recovering', detail: lightFailures.slice(0, 5) })
    }

    // 2. The renderer's own marks: first frame and the first directory row.
    await delay(500)
    try {
      client = await harness.connectRenderer(debuggingPort)
      await client.send('Runtime.enable')
      await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
      await client.evaluate(`(() => {
        const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
        if (toggle && document.querySelector('.workspace-panel.collapsed')) toggle.click();
        return true;
      })()`)
      const rows = await harness.waitFor(async () => {
        const count = await client.evaluate(`document.querySelectorAll('.workspace-tree-row.file').length`)
        return count > 0 ? count : undefined
      }, harness.actionTimeoutMs, 'workspace rows in a large historical data root').catch(() => 0)
      observation.steps.push({ step: 'renderer', workspaceRows: rows })
    } catch (error) {
      failures.push({ check: 'the renderer is usable with a large historical data root', detail: String(error) })
    }

    // 3. Selected-session first-page history, then responsiveness while the
    //    background compatibility scan works through the history.
    const history = []
    for (const session of sessions) {
      for (let index = 0; index < 3; index += 1) {
        history.push({ session: session.id, ...(await timedGet(locator, `/sessions/${session.id}/messages?limit=30`)) })
      }
    }
    const responsiveness = []
    for (let index = 0; index < POST_READY_SAMPLES; index += 1) {
      responsiveness.push(await timedGet(locator, '/runtime'))
      await delay(400)
    }
    const sorted = [...responsiveness].sort((left, right) => left.ms - right.ms)
    observation.steps.push({
      step: 'after-ready',
      history,
      responsiveness: {
        samples: responsiveness.length,
        minMs: sorted[0]?.ms ?? null,
        medianMs: sorted[Math.floor(sorted.length / 2)]?.ms ?? null,
        maxMs: sorted.at(-1)?.ms ?? null,
      },
    })
    if (history.some((entry) => entry.status !== 200)) {
      failures.push({ check: 'the selected session first page answers once execution is ready', detail: history.filter((entry) => entry.status !== 200) })
    }

    const log = await readFile(logPath, 'utf8').catch(() => '')
    const marks = marksFromLog(log)
    observation.marks = {
      rendererFirstFrame: marks['renderer-first-frame'] ?? null,
      rendererWorkspaceEntries: marks['renderer-workspace-entries'] ?? null,
      executionStart: marks['execution-start'] ?? null,
      runnerReady: marks['runner-ready'] ?? null,
      durableEventsReady: marks['runner-infra-durable-events-ready'] ?? null,
    }
    observation.recoveryLogLines = {
      recovered: (log.match(/\[durable-harness\] recovered /gu) ?? []).length,
      failed: (log.match(/\[durable-harness\] recovery failed /gu) ?? []).length,
      discoveryFailed: (log.match(/\[durable-harness\] run recovery discovery failed /gu) ?? []).length,
    }
    if (observation.recoveryLogLines.discoveryFailed > 0) {
      failures.push({ check: 'the historical partitions are readable, so discovery does not fail', detail: observation.recoveryLogLines })
    }
    if (observation.recoveryLogLines.failed > 0) {
      failures.push({ check: 'no synthetic historical run fails recovery', detail: observation.recoveryLogLines })
    }

    const ledger = {
      check: 'desktop-large-history-startup',
      ok: failures.length === 0,
      label,
      measuredAt: new Date().toISOString(),
      environment: {
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        electron: 'see packages/app/package.json',
      },
      fixture: observation.fixture,
      steps: observation.steps,
      marks: observation.marks,
      recoveryLogLines: observation.recoveryLogLines,
      failures,
      gaps: [
        'The data root is synthetic: 400 partitions of completed 2-event runs written in the',
        'store format, not the user data root that produced the taskbook observations',
        '(about 399 partitions / 13,769 event files). It proves the mechanism - recovery no',
        'longer gates readiness and the light routes answer during it - and cannot prove',
        'real-disk behaviour at that scale.',
        'The background compatibility scan runs after readiness by design; this ledger times',
        'the light routes across it but does not observe a completion signal for the scan',
        'itself, because the router exposes none.',
        'Packaged builds are not covered here.',
      ],
    }
    await mkdir(outDir, { recursive: true })
    const jsonPath = join(outDir, `desktop-large-history-startup-${label}.json`)
    await writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      ok: ledger.ok,
      jsonPath,
      fixture: ledger.fixture,
      apiListeningMs,
      executionReadyMs,
      failures,
      marks: ledger.marks,
      recoveryLogLines: ledger.recoveryLogLines,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!keepRoots) await rm(root, { recursive: true, force: true })
    else console.log(`[large-history] kept ${root}`)
  }
}

await main()
