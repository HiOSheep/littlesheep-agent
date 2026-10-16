// Main/Runner end-to-end acceptance for automatic recovery at a persisted
// execution-segment boundary. The interruption is injected by pausing the real
// Electron Main isolate at the post-checkpoint return and killing its process
// tree; no production recovery hook is installed.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const TASK_MARKER = 'LS-S2B-G-35'
const COMPLETE_MARKER = 'LS-S2B-G-35-DONE'
const START_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 180_000
const harness = createElectronHarness({ startTimeoutMs: START_TIMEOUT_MS, actionTimeoutMs: RUN_TIMEOUT_MS })
const root = await mkdtemp(join(tmpdir(), 'littlesheep-s2b-g-recovery-'))
const dataDir = join(root, 'data')
const workspaceDir = join(dataDir, 'workspace')
const chromiumDir = join(root, 'chromium')
const logPath = join(root, 'electron.log')
const keepRoot = process.argv.includes('--keep')
const report = {
  check: 'electron-s2b-g-safe-segment-recovery',
  ok: false,
  executionLevel: 'real Electron Main + Local App API + Runner + Harness + local controlled HTTP Provider; no Renderer interaction in this 35-item flow',
  interruption: 'CDP breakpoint after durable safe-segment checkpoint write, followed by taskkill of the Electron process tree',
  runBudget: {
    maxModelCallsPerRun: 64,
    maxToolCallsPerRun: 64,
    maxToolLoopIterationsPerSegment: 30,
    maxToolLoopIterationsPerRun: 60,
  },
  provider: { type: 'controlled local OpenAI-compatible HTTP fixture', simulated: true, publicNetworkRequests: 0, cost: 'unavailable; no paid Provider used' },
  assertions: [],
  limitations: [
    'The fixture exercises Main-owned Permission V2 recovery and the real Runner/Harness file tool path. It does not exercise the Renderer for this particular recovery flow; a separate desktop Permission V2 acceptance covers real Renderer interaction.',
    'The controlled Provider reports deterministic synthetic usage. These values are not real Provider billing or production task-success rates.',
    'The process interruption is at a verified persisted segment boundary. It does not establish automatic recovery for unsettled Provider responses, unknown external effects, cross-host takeover, or every OS crash point.',
  ],
}

let electron
let mainDebugger
let provider
let locator
let runStreamPromise

function note(name, detail = {}) {
  report.assertions.push({ name, ok: true, ...detail })
}

async function main() {
  await harness.assertBuildFresh()
  provider = await startElectronAcceptanceProvider({ models: ['s2b-g-recovery'], s2bGWorkspace: workspaceDir })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(chromiumDir, { recursive: true })
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

  const firstDebuggingPort = await harness.reservePort()
  const mainDebuggingPort = await harness.reservePort()
  electron = await launchElectron({ debuggingPort: firstDebuggingPort, mainDebuggingPort })
  locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await waitForRunnerReady(locator)
  mainDebugger = await harness.connectDebugger(mainDebuggingPort, 'Electron Main inspector')
  await mainDebugger.send('Debugger.enable')
  await mainDebugger.send('Runtime.enable')

  const checkpoint = await installSegmentCheckpointBreakpoint(mainDebugger)
  const requestKey = `s2b-g-${Date.now()}`
  runStreamPromise = startRun(locator, {
    text: `${TASK_MARKER} workspace=${workspaceDir}\n请依次完成 35 项独立文件写入，每项写入 step-01.txt 至 step-35.txt，内容为对应编号。完成后回复 ${COMPLETE_MARKER}。`,
    workspace: workspaceDir,
    permissionPreset: 'workspace-write',
    requestKey,
  }).catch((error) => ({ transportError: String(error?.message ?? error) }))

  const activeRun = await harness.waitFor(async () => {
    const result = await harness.fetchJson(locator, '/application/active-runs').catch(() => undefined)
    return result?.body?.runs?.[0]
  }, START_TIMEOUT_MS, 'Main-owned active Run')
  const { runId, sessionId } = activeRun
  assert.ok(runId && sessionId, `Main did not publish a durable run/session identity: ${JSON.stringify(activeRun)}`)

  const pause = await waitForSafeSegmentPause(mainDebugger, checkpoint.lineNumber)
  const liveFiles = await listResultFiles(workspaceDir)
  assert.equal(liveFiles.length, 30, `expected exactly 30 file effects at the safe boundary, found ${liveFiles.length}`)
  assert.equal(pause.runId, runId, 'checkpoint belongs to the active Run')
  assert.equal(pause.sessionId, sessionId, 'checkpoint belongs to the active Session')
  assert.equal(pause.reason, 'execution-segment-started')
  assert.equal(pause.segmentIndex, 2)
  assert.equal(pause.toolLoopIterationsUsed, 30)
  assert.equal(pause.safeSegmentBoundary, 'execution_segment')
  report.preCrash = { runId, sessionId, checkpoint: pause, fileCount: liveFiles.length }
  note('Main-owned Permission V2 Run reached persisted segment-2 boundary after 30 real file writes')

  const rawCheckpoint = await findSafeCheckpoint(dataDir, runId)
  assert.ok(rawCheckpoint, 'the exact safe segment checkpoint must be durable before termination')
  assert.equal(rawCheckpoint.id, pause.checkpointId)
  assert.equal(rawCheckpoint.loopBudget.executionSegmentIndex, 2)
  assert.equal(rawCheckpoint.loopBudget.toolLoopIterationsUsed, 30)
  note('safe checkpoint and its Run-wide budget were persisted before process termination', {
    checkpointId: rawCheckpoint.id,
    attemptsUsed: rawCheckpoint.loopBudget.attemptsUsed,
    maxAttempts: rawCheckpoint.loopBudget.maxAttempts,
    toolCallsUsed: rawCheckpoint.loopBudget.toolCallsUsed,
    maxToolCalls: rawCheckpoint.loopBudget.maxToolCalls,
  })

  await runStreamPromise
  const filesAfterKill = await listResultFiles(workspaceDir)
  assert.equal(filesAfterKill.length, 30)
  const firstRunWriteIds = emittedWriteIds(provider.requests)
  assert.deepEqual(firstRunWriteIds, Array.from({ length: 30 }, (_, index) => `s2b-g-write-${index + 1}`))
  note('real Electron process tree was terminated after checkpoint persistence; 30 effects remained and were not reissued before restart')

  const secondDebuggingPort = await harness.reservePort()
  electron = await launchElectron({ debuggingPort: secondDebuggingPort })
  locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await waitForRunnerReady(locator)

  await harness.waitFor(async () => {
    const files = await listResultFiles(workspaceDir)
    if (files.length !== 35) return undefined
    const finalReply = await harness.fetchJson(locator, `/runs/${encodeURIComponent(runId)}/final-reply?sessionId=${encodeURIComponent(sessionId)}`).catch(() => undefined)
    return finalReply?.ok && finalReply.body?.kind === 'settled' ? { files, finalReply: finalReply.body } : undefined
  }, RUN_TIMEOUT_MS, 'same-Run automatic recovery and final settlement')

  const finalFiles = await listResultFiles(workspaceDir)
  assert.deepEqual(finalFiles, Array.from({ length: 35 }, (_, index) => `step-${String(index + 1).padStart(2, '0')}.txt`))
  for (let index = 1; index <= 35; index += 1) {
    const contents = await readFile(join(workspaceDir, `step-${String(index).padStart(2, '0')}.txt`), 'utf8')
    assert.equal(contents, `S2B-G-COMPLETED-${index}\n`)
  }

  const allWriteIds = emittedWriteIds(provider.requests)
  assert.deepEqual(allWriteIds, Array.from({ length: 35 }, (_, index) => `s2b-g-write-${index + 1}`))
  assert.equal(new Set(allWriteIds).size, 35, 'each logical file effect must be emitted exactly once')
  const messages = await readSessionMessages(sessionId)
  const matchingUsers = messages.filter((message) => message.role === 'user' && messageText(message).includes(TASK_MARKER))
  assert.equal(matchingUsers.length, 1, 'original ingress must not be repeated')
  assert.ok(messages.some((message) => message.role === 'assistant' && messageText(message).includes(COMPLETE_MARKER)),
    'the same Run must publish the controlled final response')

  const replay = await harness.fetchJson(locator, `/runs/${encodeURIComponent(runId)}/final-reply?sessionId=${encodeURIComponent(sessionId)}`)
  assert.equal(replay.body.kind, 'settled')
  const settlement = await harness.waitFor(async () => {
    const events = await readDurableEvents(dataDir, sessionId, runId)
    const count = events.filter((event) => event.type === 'run_completed').length
    return count > 0 ? { events, count } : undefined
  }, 15_000, 'durable terminal event after final-reply settlement')
  const events = settlement.events
  const completionEvents = events.filter((event) => event.type === 'run_completed')
  assert.equal(settlement.count, 1, 'Run completion must be logically settled once')
  assert.equal(completionEvents.length, 1, 'Run completion must be logically settled once')
  const checkpointRecords = await readCheckpointsForRun(dataDir, runId)
  const finalCheckpoint = checkpointRecords.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)).at(-1)
  assert.ok(finalCheckpoint, 'final Run checkpoint should remain available')
  assert.equal(finalCheckpoint.loopBudget.executionSegmentIndex, 2)
  assert.ok(finalCheckpoint.loopBudget.attemptsUsed > rawCheckpoint.loopBudget.attemptsUsed,
    'cumulative model-call budget must continue from the persisted checkpoint')
  assert.ok(finalCheckpoint.loopBudget.toolCallsUsed >= 35)

  report.postRecovery = {
    runId,
    sessionId,
    finalFileCount: finalFiles.length,
    uniqueEffectIds: new Set(allWriteIds).size,
    matchingIngressCount: matchingUsers.length,
    providerRequests: provider.requests.length,
    providerUsage: {
      requests: events.filter((event) => event.type === 'provider_usage_recorded').length,
      promptTokens: events.filter((event) => event.type === 'provider_usage_recorded')
        .reduce((sum, event) => sum + (event.payload.promptTokens ?? 0), 0),
      completionTokens: events.filter((event) => event.type === 'provider_usage_recorded')
        .reduce((sum, event) => sum + (event.payload.completionTokens ?? 0), 0),
      status: events.every((event) => event.type !== 'provider_usage_recorded' || event.payload.usageStatus === 'available')
        ? 'available from controlled fixture'
        : 'partially unavailable',
    },
    providerToolCallIds: allWriteIds,
    finalCheckpoint: {
      id: finalCheckpoint.id,
      segmentIndex: finalCheckpoint.loopBudget.executionSegmentIndex,
      attemptsUsed: finalCheckpoint.loopBudget.attemptsUsed,
      toolCallsUsed: finalCheckpoint.loopBudget.toolCallsUsed,
      maxAttempts: finalCheckpoint.loopBudget.maxAttempts,
      maxToolCalls: finalCheckpoint.loopBudget.maxToolCalls,
      maxToolLoopIterationsPerRun: finalCheckpoint.loopBudget.maxToolLoopIterationsPerRun,
    },
    finalReplyKind: replay.body.kind,
    runCompletedEvents: completionEvents.length,
    durableEventTypes: [...new Set(events.map((event) => event.type))].sort(),
  }
  note('new Electron Main automatically recovered the original Run and completed all 35 effects exactly once', report.postRecovery)
  report.ok = true
}

async function launchElectron({ debuggingPort, mainDebuggingPort }) {
  return harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    mainDebuggingPort,
    logPath,
    extraArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
}

async function installSegmentCheckpointBreakpoint(client) {
  const source = await readFile(join(repoRoot, 'packages', 'app', 'out', 'main', 'index.js'), 'utf8')
  const target = 'return checkpoint.id;'
  const offset = source.indexOf(target)
  assert.notEqual(offset, -1, 'built Main bundle no longer contains the checkpoint return boundary')
  const lineNumber = source.slice(0, offset).split('\n').length - 1
  const script = await harness.waitFor(() => client.events.find((event) => (
    event.method === 'Debugger.scriptParsed'
    && /[\\/]packages[\\/]app[\\/]out[\\/]main[\\/]index\.js$/iu.test(event.params?.url ?? '')
  )), START_TIMEOUT_MS, 'built Electron Main bundle in inspector')
  const breakpoint = await client.send('Debugger.setBreakpointByUrl', {
    url: script.params.url,
    lineNumber,
    columnNumber: 0,
  })
  assert.ok(breakpoint.breakpointId, 'could not install checkpoint breakpoint in the real Main bundle')
  return { scriptUrl: script.params.url, breakpointId: breakpoint.breakpointId, lineNumber }
}

async function waitForSafeSegmentPause(client, lineNumber) {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  let inspectedPauses = 0
  while (Date.now() < deadline) {
    const pause = await harness.waitFor(() => {
      const index = client.events.findIndex((event) => event.method === 'Debugger.paused')
      if (index < 0) return undefined
      return client.events.splice(index, 1)[0]
    }, Math.max(1, deadline - Date.now()), 'safe segment checkpoint breakpoint')
    inspectedPauses += 1
    const frame = pause.params?.callFrames?.[0]
    let snapshot
    try {
      const evaluated = await client.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: `JSON.stringify({
          reason: checkpoint.reason,
          runId: checkpoint.runId,
          sessionId: String(checkpoint.sessionId),
          checkpointId: checkpoint.id,
          segmentIndex: checkpoint.loopBudget.executionSegmentIndex,
          toolLoopIterationsUsed: checkpoint.loopBudget.toolLoopIterationsUsed,
          attemptsUsed: checkpoint.loopBudget.attemptsUsed,
          maxAttempts: checkpoint.loopBudget.maxAttempts,
          toolCallsUsed: checkpoint.loopBudget.toolCallsUsed,
          maxToolCalls: checkpoint.loopBudget.maxToolCalls,
          safeSegmentBoundary: checkpoint.safeSegmentBoundary?.kind,
        })`,
        returnByValue: true,
      })
      if (evaluated.result?.value) snapshot = JSON.parse(evaluated.result.value)
    } catch {
      // Other checkpoints use the same helper; they are resumed and ignored.
    }
    if (snapshot?.reason === 'execution-segment-started'
      && snapshot.segmentIndex === 2
      && snapshot.toolLoopIterationsUsed === 30
      && snapshot.safeSegmentBoundary === 'execution_segment') {
      snapshot.inspectedPauses = inspectedPauses
      snapshot.lineNumber = lineNumber
      // Kill immediately while the checkpoint writer is still paused. The
      // Runner can execute on a separate worker, so any filesystem/API work
      // before termination could let that worker enter the next segment.
      await harness.forceTerminate(electron)
      await harness.waitForExit(electron, 20_000)
      electron = undefined
      client.close()
      if (mainDebugger === client) mainDebugger = undefined
      return snapshot
    }
    await client.send('Debugger.resume').catch(() => undefined)
  }
  throw new Error('timed out waiting for a verified segment-2 checkpoint after 30 tool iterations')
}

function buildConfig(workspace, baseURL) {
  return {
    version: 1,
    providers: [{ id: 'acceptance', name: 'S2B-G Controlled Provider', baseURL, apiKey: 'acceptance-key', timeoutSeconds: 60, models: ['s2b-g-recovery'] }],
    agents: { defaults: {
      workspace,
      model: 'acceptance/s2b-g-recovery',
      reasoning: 'auto',
      profile: 'general',
      timeoutSeconds: 120,
      maxRecoveryAttempts: 1,
      maxModelCallsPerRun: 64,
      maxToolCallsPerRun: 64,
      maxToolLoopIterationsPerRun: 60,
      harness: 'core-flow',
    } },
    tools: { exec: { whitelist: [], blacklist: [], approvalMode: 'auto-deny' }, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    channels: { channels: [] },
    desktop: { closePolicy: 'always-background' },
  }
}

function startRun(locator, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
  return (async () => {
    try {
      const response = await fetch(harness.apiUrl(locator, '/run/stream'), {
        method: 'POST',
        headers: { ...harness.authHeaders(locator), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`run stream failed: ${response.status}`)
      for await (const chunk of response.body) {
        // Keep the actual Main-owned SSE consumer attached while the Run executes.
        // The acceptance result is independently read from durable storage later.
        void chunk
      }
    } finally {
      clearTimeout(timeout)
    }
  })()
}

async function waitForRunnerReady(locator) {
  await harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/run-checkpoints').catch(() => undefined)
    return response?.ok === true
  }, START_TIMEOUT_MS, 'Runner checkpoint API readiness')
}

async function listResultFiles(directory) {
  return (await readdir(directory)).filter((name) => /^step-\d{2}\.txt$/u.test(name)).sort()
}

async function findSafeCheckpoint(rootDir, runId) {
  const values = await readCheckpointsForRun(rootDir, runId)
  return values.find((value) => value.reason === 'execution-segment-started'
    && value.safeSegmentBoundary?.kind === 'execution_segment'
    && value.loopBudget.executionSegmentIndex === 2
    && value.loopBudget.toolLoopIterationsUsed === 30)
}

async function readCheckpointsForRun(rootDir, runId) {
  const checkpointDir = join(rootDir, 'run-checkpoints')
  const names = await readdir(checkpointDir).catch(() => [])
  const records = []
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const value = JSON.parse(await readFile(join(checkpointDir, name), 'utf8'))
    if (value.runId === runId) records.push(value)
  }
  return records
}

async function readSessionMessages(sessionId) {
  const lines = (await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')).split(/\r?\n/u).filter(Boolean)
  return lines.map((line) => JSON.parse(line))
}

async function readDurableEvents(rootDir, sessionId, runId) {
  const rootEvents = join(rootDir, 'durable-events')
  const partitions = await readdir(rootEvents, { withFileTypes: true }).catch(() => [])
  const events = []
  for (const partition of partitions.filter((entry) => entry.isDirectory())) {
    const files = (await readdir(join(rootEvents, partition.name))).sort()
    for (const name of files) {
      const raw = await readFile(join(rootEvents, partition.name, name), 'utf8')
      for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
        const event = JSON.parse(line)
        if (event.sessionId === sessionId && event.runId === runId) events.push(event)
      }
    }
  }
  return events.sort((left, right) => left.cursor - right.cursor)
}

function emittedWriteIds(requests) {
  return requests.flatMap((request) => request.responseToolCallIds ?? [])
    .filter((id) => /^s2b-g-write-\d+$/u.test(id))
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

try {
  await main()
} catch (error) {
  report.error = String(error?.stack ?? error)
} finally {
  report.providerRequests = provider?.requests?.length ?? 0
  report.providerWriteCallIds = provider ? emittedWriteIds(provider.requests) : []
  report.tempRoot = keepRoot ? root : undefined
  try { mainDebugger?.close() } catch { /* ignore a closed debugger socket */ }
  try { if (electron) await harness.forceTerminate(electron) } catch { /* preserve the acceptance failure */ }
  try { await runStreamPromise } catch { /* a killed Electron closes the original SSE stream */ }
  try { await provider?.close() } catch { /* ignore provider shutdown after a failed assertion */ }
  if (keepRoot) await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  else await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.ok) process.exitCode = 1
