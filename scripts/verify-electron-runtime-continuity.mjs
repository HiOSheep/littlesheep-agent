import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const locatorRelativePath = join('runtime', 'local-app-api.json')
const START_TIMEOUT_MS = 60_000
const RUN_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 20_000
const ACCEPTANCE_ANCHOR = 'runtime-continuity-anchor-4827'

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-electron-continuity-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider()
  let electron
  let preserve = false

  try {
    await mkdir(workplaceDir, { recursive: true })
    await writeFile(join(workplaceDir, 'continuity-marker.txt'), `${ACCEPTANCE_ANCHOR}\n`, 'utf8')
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(buildConfig(provider.baseURL, workplaceDir), null, 2), 'utf8')

    electron = await startElectron({ dataDir, chromiumDir, logPath })
    let locator = await waitForLocator(dataDir, electron.child.pid)
    await waitForDesktop(locator, (snapshot) => snapshot.windowExists && snapshot.windowVisible)
    const first = await runStream(locator, {
      text: `请只回复你会记住并继续 ${ACCEPTANCE_ANCHOR}，不要调用工具。`,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    assertResultOk(first.result, 'initial continuity seed')
    assertIncludes(first.result.reply, ACCEPTANCE_ANCHOR, 'initial reply')
    const sessionId = first.result.sessionId

    await desktopAction(locator, 'quit')
    await waitForExit(electron.child, EXIT_TIMEOUT_MS)
    await waitForMissing(join(dataDir, locatorRelativePath), EXIT_TIMEOUT_MS)

    electron = await startElectron({ dataDir, chromiumDir, logPath })
    locator = await waitForLocator(dataDir, electron.child.pid)
    await waitForDesktop(locator, (snapshot) => snapshot.windowExists && snapshot.windowVisible)
    const continued = await runStream(locator, {
      text: '继续',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    assertResultOk(continued.result, 'cross-restart reply continuity')
    assertIncludes(continued.result.reply, ACCEPTANCE_ANCHOR, 'cross-restart reply')
    assertSupportedContinuity(continued.result, 'cross-restart reply')

    await provider.setDelay({ model: 'slow-a', delayMs: 4_000 })
    const providerRequestCountBeforeLongRun = provider.requests.length
    const activeRunFromSse = waitForActiveRunSse(locator)
    const longRun = runStream(locator, {
      text: '继续执行。请使用 glob 工具检查当前工作区。',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    const active = await activeRunFromSse
    await waitFor(
      () => provider.requests.length > providerRequestCountBeforeLongRun,
      RUN_TIMEOUT_MS,
      'background long run provider request',
    )
    await desktopAction(locator, 'close')
    await waitForDesktop(locator, (snapshot) => !snapshot.windowVisible && snapshot.activeRunCount >= 1)
    await desktopAction(locator, 'show')
    await waitForDesktop(locator, (snapshot) => snapshot.windowVisible && snapshot.activeRunCount >= 1)
    await controlRun(locator, active.runId, 'pause')
    await controlRun(locator, active.runId, 'resume')
    const longResult = await longRun
    assertResultOk(longResult.result, 'background long run')
    assertIncludes(longResult.result.reply, ACCEPTANCE_ANCHOR, 'background long-run reply')
    assertSupportedContinuity(longResult.result, 'background long-run reply')

    await provider.setDelay({ model: 'slow-a', delayMs: 6_000 })
    const pausedRun = runStream(locator, {
      text: '继续执行。请使用 glob 工具检查当前工作区。',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    const pausing = await waitForActiveRun(locator)
    await controlRun(locator, pausing.runId, 'pause')
    const pausedResult = await pausedRun
    if (pausedResult.result?.status !== 'aborted' || !pausedResult.result.runCheckpointId) {
      throw new Error(`pause did not produce a resumable checkpoint: ${JSON.stringify(pausedResult.result)}`)
    }
    const checkpointId = pausedResult.result.runCheckpointId
    const checkpoints = await getJson(locator, '/run-checkpoints')
    const checkpoint = checkpoints.checkpoints?.find((item) => item.id === checkpointId)
    if (!checkpoint?.resumable || checkpoint.status !== 'paused') {
      throw new Error(`paused checkpoint is not resumable: ${JSON.stringify(checkpoint)}`)
    }

    await forceTerminate(electron.child)
    electron = await startElectron({ dataDir, chromiumDir, logPath })
    locator = await waitForLocator(dataDir, electron.child.pid)
    // The locator file appears before the Runner is wired, and the resume route
    // answers 503 ("runtime checkpoint continuation is unavailable") until it is.
    // The checkpoint list is served by the same runtime object the resume route
    // needs, so a 200 from it is the honest readiness signal; without this wait
    // the forced-restart resume raced startup and failed the acceptance.
    await waitForRunnerReady(locator)
    const resumed = await resumeCheckpoint(locator, checkpointId)
    assertResultOk(resumed.result, 'checkpoint recovery after forced restart')
    assertIncludes(resumed.result.reply, ACCEPTANCE_ANCHOR, 'resumed reply')
    assertSupportedContinuity(resumed.result, 'resumed reply')
    const messages = await getJson(locator, `/sessions/${encodeURIComponent(sessionId)}/messages?limit=240`)
    const seededUserMessages = (messages.messages ?? []).filter((message) => (
      message.role === 'user' && historyMessageText(message).includes('请使用 glob 工具检查当前工作区')
    ))
    if (seededUserMessages.length !== 2) {
      throw new Error(`checkpoint resume duplicated or lost original user messages: ${seededUserMessages.length}`)
    }

    await provider.setDelay({ model: 'slow-a', delayMs: 5_000 })
    const oldRunnerTask = runStream(locator, {
      text: '继续执行。请使用 glob 工具检查当前工作区。',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    await waitForActiveRun(locator)
    const runtime = await postJson(locator, '/runtime', { model: 'acceptance/slow-b' })
    if (runtime.model !== 'acceptance/slow-b') throw new Error('runtime model hot reload did not select slow-b')
    const newRunnerTask = runStream(locator, {
      text: '继续，请只回复新的 slow-b 运行正在承接的目标。',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    const [oldFinished, newFinished] = await Promise.all([oldRunnerTask, newRunnerTask])
    assertResultOk(oldFinished.result, 'retired slow-a Runner')
    assertResultOk(newFinished.result, 'new slow-b Runner')
    if (oldFinished.result.replyProvenance?.model !== 'slow-a') {
      throw new Error(`old task changed model during hot reload: ${oldFinished.result.replyProvenance?.model}`)
    }
    if (newFinished.result.replyProvenance?.model !== 'slow-b') {
      throw new Error(`new task did not use slow-b: ${newFinished.result.replyProvenance?.model}`)
    }
    assertSupportedContinuity(newFinished.result, 'hot-reloaded Runner reply')

    await provider.setDelay({ model: 'slow-b', delayMs: 6_000 })
    const interrupting = runStream(locator, {
      text: '继续执行。请使用 glob 工具检查当前工作区。',
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    const interruptRun = await waitForActiveRun(locator)
    await controlRun(locator, interruptRun.runId, 'interrupt')
    const interrupted = await interrupting
    if (interrupted.result?.status !== 'aborted' || !interrupted.result.runCheckpointId) {
      throw new Error(`interrupt did not return an aborted recoverable result: ${JSON.stringify(interrupted.result)}`)
    }

    await desktopAction(locator, 'quit')
    await waitForExit(electron.child, EXIT_TIMEOUT_MS)
    electron = undefined
    const compactionCancel = await runCompactionCancelScenario(provider)
    const providerRequests = provider.requests
    console.log(JSON.stringify({
      check: 'electron-runtime-continuity',
      ok: true,
      dataDir,
      scenarios: [
        'cross_restart_reply_continuity',
        'active_run_sse',
        'close_to_tray_and_restore',
        'pause_resume',
        'paused_checkpoint_forced_restart_resume',
        'runtime_model_hot_reload',
        'interrupt_checkpoint',
        'compaction_cancel',
      ],
      providerRequests: providerRequests.length,
      finalContinuity: resumed.result.memoryContinuityAssessment,
      compactionCancel,
    }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'electron-runtime-continuity',
      ok: false,
      dataDir,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    if (electron?.child && electron.child.exitCode === null) await forceTerminate(electron.child).catch(() => undefined)
    await provider.close().catch(() => undefined)
    if (!preserve) await rm(root, { recursive: true, force: true })
  }
}

/**
 * HC-19 bounded scenario: interrupt a run while its finalize compaction call is
 * in flight, and require a settled terminal operation plus an intact transcript.
 */
async function runCompactionCancelScenario(provider) {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-electron-compaction-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  let electron
  try {
    await mkdir(workplaceDir, { recursive: true })
    await writeFile(join(dataDir, 'config.json'), JSON.stringify(
      buildConfig(provider.baseURL, workplaceDir, { compaction: { threshold: 2, keepRecent: 1 } }),
      null,
      2,
    ), 'utf8')
    electron = await startElectron({ dataDir, chromiumDir, logPath })
    const locator = await waitForLocator(dataDir, electron.child.pid)
    await waitForDesktop(locator, (snapshot) => snapshot.windowExists && snapshot.windowVisible)

    // Only the compaction prompt is slow, so the interrupt lands inside finalize.
    await provider.setDelay({ promptContains: 'You maintain a versioned session summary', delayMs: 8_000 })
    const requestBaseline = provider.requests.length
    const running = runStream(locator, {
      text: '请只回复 compaction-cancel-anchor，不要调用工具。',
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    const activeRun = await waitForActiveRun(locator)
    await waitFor(
      () => provider.requests.slice(requestBaseline).some((request) => request.messages.some((message) => (
        String(message.content).includes('You maintain a versioned session summary')
      ))),
      RUN_TIMEOUT_MS,
      'compaction provider request',
    )
    await controlRun(locator, activeRun.runId, 'interrupt')
    const settled = await running
    if (settled.result?.status === 'error') {
      throw new Error(`compaction cancel left the run in error: ${settled.result.error}`)
    }
    const sessionId = settled.result?.sessionId
    if (!sessionId) throw new Error('compaction cancel scenario returned no session id')

    const operations = await waitFor(async () => {
      const payload = await getJson(
        locator,
        `/sessions/${encodeURIComponent(sessionId)}/compaction-operations`,
      ).catch(() => undefined)
      return payload?.operations?.some((operation) => operation.status === 'cancelled') ? payload : undefined
    }, RUN_TIMEOUT_MS, 'cancelled compaction operation')
    await provider.setDelay({ promptContains: 'You maintain a versioned session summary', delayMs: 0 })

    const cancelled = operations.operations.find((operation) => operation.status === 'cancelled')
    if (!cancelled?.settledAt) throw new Error('cancelled compaction operation has no terminal timestamp')
    const page = await getJson(locator, `/sessions/${encodeURIComponent(sessionId)}/messages?limit=50`)
    if (!Array.isArray(page?.messages) || page.messages.length === 0) {
      throw new Error('compaction cancel scenario lost the session transcript')
    }
    await desktopAction(locator, 'quit')
    await waitForExit(electron.child, EXIT_TIMEOUT_MS)
    electron = undefined
    return {
      sessionId,
      runStatus: settled.result?.status,
      cancelledOperationId: cancelled.id,
      transcriptMessages: page.messages.length,
    }
  } finally {
    if (electron?.child && electron.child.exitCode === null) await forceTerminate(electron.child).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

function buildConfig(baseURL, workplaceDir, overrides = {}) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Electron Acceptance',
      baseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 30,
      models: ['slow-a', 'slow-b'],
    }],
    agents: {
      defaults: {
        workspace: workplaceDir,
        model: 'acceptance/slow-a',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 16,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: {
      exec: { whitelist: [], blacklist: [], approvalMode: 'auto-deny' },
      maxOutputChars: 10_000,
      stripImages: true,
      maxParallel: 2,
    },
    memory: {
      repositoryBackend: 'v2',
      treeRunTokenBudget: 3_200,
      treeBranchTokenBudget: 1_200,
      treeRootIndexMaxChars: 1_600,
      experienceWriteThreshold: 0.65,
    },
    safety: {
      enabled: true,
      maxEntryChars: 500,
      quarantineDir: 'quarantine',
      blockInjectionPatterns: true,
      sanitizePrelude: true,
    },
    sessions: {
      writeLock: { acquireTimeoutMs: 60_000 },
      compaction: overrides.compaction ?? { threshold: 100, keepRecent: 20 },
    },
    skills: { extraDirs: [], disabled: [] },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: {
      enabled: false,
      maxCheckpoints: 64,
      maxFileBytes: 8 * 1024 * 1024,
      maxWorkspaceFiles: 2_000,
      maxWorkspaceBytes: 64 * 1024 * 1024,
    },
  }
}

async function startElectron({ dataDir, chromiumDir, logPath }) {
  const executable = resolveVerifiedElectronExecutable(repoRoot)
  const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath, { flags: 'a' }))
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['.', `--user-data-dir=${chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.once('exit', () => log.end())
  return { child, log }
}

async function waitForLocator(dataDir, expectedPid) {
  const path = join(dataDir, locatorRelativePath)
  return waitFor(async () => {
    try {
      const locator = JSON.parse(await readFile(path, 'utf8'))
      if (locator.pid !== expectedPid || locator.host !== '127.0.0.1' || !locator.token) return undefined
      return locator
    } catch {
      return undefined
    }
  }, START_TIMEOUT_MS, 'Local App API locator')
}

async function waitForDesktop(locator, predicate) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/acceptance').catch(() => undefined)
    return payload?.snapshot && predicate(payload.snapshot) ? payload.snapshot : undefined
  }, START_TIMEOUT_MS, 'desktop snapshot')
}

async function waitForActiveRun(locator) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/active-runs').catch(() => undefined)
    return payload?.runs?.[0]
  }, START_TIMEOUT_MS, 'active run')
}

async function waitForActiveRunSse(locator) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), START_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(locator, '/application/active-runs/stream'), {
      headers: authHeaders(locator),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`active run SSE failed: ${response.status}`)
    }
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (!event) continue
        if (event.event === 'error') {
          throw new Error(`active run SSE error: ${event.data?.error ?? 'unknown error'}`)
        }
        const run = event.event === 'active_runs' ? event.data?.runs?.[0] : undefined
        if (run) return run
      }
    }
    throw new Error('active run SSE ended before publishing a run')
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out waiting for active run SSE')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

async function desktopAction(locator, action) {
  return postJson(locator, '/application/acceptance', { action })
}

async function controlRun(locator, runId, action) {
  return postJson(locator, `/application/active-runs/${encodeURIComponent(runId)}/control`, {
    action,
    reason: `electron acceptance ${action}`,
  })
}

function runStream(locator, body) {
  return readSse(locator, '/run/stream', body)
}

function resumeCheckpoint(locator, checkpointId) {
  return readSse(locator, `/run-checkpoints/${encodeURIComponent(checkpointId)}/resume/stream`, {
    reason: 'Electron acceptance forced-restart continuation',
  })
}

async function readSse(locator, path, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
  try {
    const response = await fetch(apiUrl(locator, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`SSE ${path} failed: ${response.status}`)
    const events = []
    let result
    let error
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseBlock(block)
        if (!event) continue
        events.push(event)
        if (event.event === 'result') result = event.data
        if (event.event === 'error') error = event.data?.error ?? 'unknown SSE error'
      }
    }
    if (error) throw new Error(`${path}: ${error}`)
    if (!result) throw new Error(`${path}: SSE ended without a result`)
    return { result, events }
  } finally {
    clearTimeout(timeout)
  }
}

function parseSseBlock(block) {
  let event = 'message'
  const data = []
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (data.length === 0) return undefined
  return { event, data: JSON.parse(data.join('\n')) }
}

/** Wait until the Runner's checkpoint control answers, not just the window. */
async function waitForRunnerReady(locator) {
  await waitFor(async () => {
    const response = await fetch(apiUrl(locator, '/run-checkpoints')).catch(() => undefined)
    return response?.ok === true
  }, START_TIMEOUT_MS, 'runner checkpoint control readiness')
}

async function getJson(locator, path) {  const response = await fetch(apiUrl(locator, path), {
    headers: path === '/application/acceptance' ? authHeaders(locator) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${payload.error ?? 'unknown error'}`)
  return payload
}

async function postJson(locator, path, body) {
  const response = await fetch(apiUrl(locator, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(path === '/application/acceptance' ? authHeaders(locator) : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`POST ${path} failed (${response.status}): ${payload.error ?? 'unknown error'}`)
  return payload
}

function authHeaders(locator) {
  return { Authorization: `Bearer ${locator.token}` }
}

function apiUrl(locator, path) {
  return `http://${locator.host}:${locator.port}${path}`
}

function assertResultOk(result, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${JSON.stringify(result)}`)
}

function assertIncludes(value, expected, label) {
  if (typeof value !== 'string' || !value.includes(expected)) {
    throw new Error(`${label} does not contain ${expected}: ${JSON.stringify(value)}`)
  }
}

function assertSupportedContinuity(result, label) {
  const assessment = result?.memoryContinuityAssessment
  if (assessment?.status !== 'supported') {
    throw new Error(`${label} is not memory-continuous: ${JSON.stringify(assessment)}`)
  }
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function historyMessageText(message) {
  return typeof message?.text === 'string' ? message.text : messageText(message)
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined && value !== false && value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForMissing(path, timeoutMs) {
  await waitFor(async () => existsSync(path) ? undefined : true, timeoutMs, `removal of ${path}`)
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Electron process ${child.pid} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    const onExit = (code) => {
      cleanup()
      resolveExit(code)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

async function forceTerminate(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolveTask) => {
      const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      taskkill.once('exit', resolveTask)
      taskkill.once('error', resolveTask)
    })
  } else {
    child.kill('SIGKILL')
  }
  await waitForExit(child, EXIT_TIMEOUT_MS).catch(() => undefined)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

await main()
