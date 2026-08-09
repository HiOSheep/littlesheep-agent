import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js'
import { getProvider, loadConfig, withProviderPresets } from '../packages/config/dist/index.js'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const locatorRelativePath = join('runtime', 'local-app-api.json')
const START_TIMEOUT_MS = 60_000
const RUN_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 20_000
const ACCEPTANCE_ANCHOR = 'deepseek-electron-continuity-anchor-6824'
const ACCEPTANCE_DETAIL = '琥珀色'
const CONTINUATION_PROMPT = '继续上一轮。请输出上一轮让我保存的代号和颜色，格式为“代号：...；颜色：...”，不要调用工具。'
const MODEL = 'deepseek-v4-flash'

async function main() {
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'))
  const sourceDataDir = resolveDataDir(branding)
  const sourceConfig = withProviderPresets(await loadConfig({ dataDir: sourceDataDir }))
  const sourceProvider = getProvider(sourceConfig, 'deepseek')
  if (!sourceProvider) throw new Error('DeepSeek is not configured in the active LittleSheep data root')

  const sourceKeys = join(sourceDataDir, 'config', 'keys.json')
  const sourceTokenizer = join(sourceDataDir, 'models', 'tokenizer')
  const sourceChromiumLocalState = join(resolveSourceChromiumDir(), 'Local State')
  for (const [label, path] of [
    ['encrypted Provider credentials', sourceKeys],
    ['verified local tokenizer assets', sourceTokenizer],
    ['Electron safeStorage context', sourceChromiumLocalState],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} are unavailable for isolated acceptance`)
  }

  const root = await mkdtemp(join(tmpdir(), 'littlesheep-deepseek-reply-continuity-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  let electron
  let report

  try {
    await prepareIsolatedDataRoot({
      dataDir,
      workplaceDir,
      sourceKeys,
      sourceTokenizer,
      sourceProvider,
    })
    await mkdir(chromiumDir, { recursive: true })
    await copyFile(sourceChromiumLocalState, join(chromiumDir, 'Local State'))

    electron = startElectron({ dataDir, chromiumDir })
    let locator = await waitForLocator(dataDir, electron.pid)
    await waitForDesktop(locator)

    const initial = await runStream(locator, {
      text: `请记住代号“${ACCEPTANCE_ANCHOR}”和颜色“${ACCEPTANCE_DETAIL}”。仅本轮确认时只回复“记录完成”，不要复述代号或颜色；后续我询问时必须原样回答。不要调用工具。`,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    assertSuccessfulDeepSeekRun(initial.result, 'initial continuity seed')
    assertIncludes(initial.result.reply, '记录完成', 'initial reply')
    assertNotIncludes(initial.result.reply, ACCEPTANCE_ANCHOR, 'initial reply')
    assertNotIncludes(initial.result.reply, ACCEPTANCE_DETAIL, 'initial reply')
    const sessionId = initial.result.sessionId

    await desktopAction(locator, 'quit')
    await waitForExit(electron, EXIT_TIMEOUT_MS)
    await waitForMissing(join(dataDir, locatorRelativePath), EXIT_TIMEOUT_MS)
    electron = undefined

    electron = startElectron({ dataDir, chromiumDir })
    locator = await waitForLocator(dataDir, electron.pid)
    await waitForDesktop(locator)
    const continued = await runStream(locator, {
      text: CONTINUATION_PROMPT,
      sessionId,
      permissionMode: 'full',
      workspace: workplaceDir,
    })
    assertSuccessfulDeepSeekRun(continued.result, 'cross-restart reply continuity')
    assertIncludes(continued.result.reply, ACCEPTANCE_ANCHOR, 'cross-restart reply')
    assertIncludes(continued.result.reply, ACCEPTANCE_DETAIL, 'cross-restart reply')
    assertAnswerBasedContinuity(continued.result)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, EXIT_TIMEOUT_MS)
    await waitForMissing(join(dataDir, locatorRelativePath), EXIT_TIMEOUT_MS)
    electron = undefined

    report = {
      check: 'electron-deepseek-reply-continuity',
      ok: true,
      provider: 'deepseek',
      model: MODEL,
      scenario: 'cross_restart_reply_continuity',
      answerContainedPriorValue: true,
      currentPromptContainedPriorValue: false,
      continuity: continued.result.memoryContinuityAssessment,
      runs: [runMetrics('initial_seed', initial.result), runMetrics('cross_restart', continued.result)],
      copiedChromiumFiles: ['Local State'],
    }
  } finally {
    if (electron?.exitCode === null) await forceTerminate(electron)
    await rm(root, { recursive: true, force: true })
  }

  console.log(JSON.stringify({
    ...report,
    isolatedDataRemoved: !existsSync(root),
  }))
}

async function prepareIsolatedDataRoot(options) {
  const configDir = join(options.dataDir, 'config')
  const tokenizerDir = join(options.dataDir, 'models', 'tokenizer')
  await mkdir(options.workplaceDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  await copyFile(options.sourceKeys, join(configDir, 'keys.json'))
  await cp(options.sourceTokenizer, tokenizerDir, { recursive: true, force: true })
  await writeFile(join(options.workplaceDir, 'continuity-marker.txt'), `${ACCEPTANCE_ANCHOR}\n`, 'utf8')
  await writeFile(join(options.dataDir, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'deepseek',
      name: options.sourceProvider.name ?? 'DeepSeek',
      baseURL: options.sourceProvider.baseURL,
      apiKey: options.sourceProvider.apiKey ?? '$DEEPSEEK_API_KEY',
      timeoutSeconds: 120,
      models: [MODEL],
    }],
    agents: {
      defaults: {
        workspace: options.workplaceDir,
        model: `deepseek/${MODEL}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
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
    memory: {
      repositoryBackend: 'v2',
      llmCapture: false,
      llmEvolve: 'never',
    },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }, null, 2), 'utf8')
}

function resolveSourceChromiumDir() {
  const explicit = process.env.LITTLESHEEP_CHROMIUM_USER_DATA_DIR
  if (explicit?.trim()) return resolve(explicit)
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@littlesheep', 'app')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', '@littlesheep', 'app')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '@littlesheep', 'app')
}

function startElectron({ dataDir, chromiumDir }) {
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
  }
  delete env.DEEPSEEK_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(resolveVerifiedElectronExecutable(repoRoot), ['.', `--user-data-dir=${chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: 'ignore',
    windowsHide: true,
  })
}

async function waitForLocator(dataDir, expectedPid) {
  const path = join(dataDir, locatorRelativePath)
  return waitFor(async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const locator = JSON.parse(await readFile(path, 'utf8'))
      if (locator.pid !== expectedPid || locator.host !== '127.0.0.1' || !locator.token) return undefined
      return locator
    } catch {
      return undefined
    }
  }, START_TIMEOUT_MS, 'Local App API locator')
}

function waitForDesktop(locator) {
  return waitFor(async () => {
    const response = await fetch(apiUrl(locator, '/application/acceptance'), {
      headers: authHeaders(locator),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    const payload = await response.json()
    return payload.snapshot?.windowExists && payload.snapshot?.windowVisible
      ? payload.snapshot
      : undefined
  }, START_TIMEOUT_MS, 'desktop window')
}

function desktopAction(locator, action) {
  return postJson(locator, '/application/acceptance', { action }, true)
}

function runStream(locator, body) {
  return readSse(locator, '/run/stream', body)
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
    let result
    let error
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (event?.event === 'result') result = event.data
        if (event?.event === 'error') error = event.data?.error ?? 'unknown SSE error'
      }
    }
    if (error) throw new Error(`${path}: ${error}`)
    if (!result) throw new Error(`${path}: SSE ended without a result`)
    return { result }
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

async function postJson(locator, path, body, authenticated = false) {
  const response = await fetch(apiUrl(locator, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? authHeaders(locator) : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`POST ${path} failed (${response.status}): ${payload.error ?? 'unknown error'}`)
  return payload
}

function assertSuccessfulDeepSeekRun(result, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safeResult(result)}`)
  if (result.replyProvenance?.source !== 'llm' || result.replyProvenance.provider !== 'deepseek') {
    throw new Error(`${label} did not publish a traceable DeepSeek reply`)
  }
  if (result.replyProvenance.model !== MODEL) {
    throw new Error(`${label} used an unexpected model`)
  }
  if (result.resolvedRunConfig?.permissionPolicyId !== 'full'
    || result.resolvedRunConfig?.behaviorModeId !== 'general') {
    throw new Error(`${label} did not keep behavior and permission settings orthogonal`)
  }
  assertProviderUsage(result, label)
}

function assertProviderUsage(result, label) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  const requests = result.modelRequests ?? []
  if (requests.length === 0) throw new Error(`${label} made no recorded model requests`)
  for (const request of requests) {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    if (snapshot?.providerUsage?.provider !== 'deepseek' || snapshot.providerUsage.promptTokens <= 0) {
      throw new Error(`${label} is missing authoritative DeepSeek usage for request ${request.requestIndex}`)
    }
    if (snapshot.localTokenLedger?.accuracy !== 'exact'
      || snapshot.providerUsage.localCalibration?.status !== 'exact_match') {
      throw new Error(`${label} direct reply token accounting is not exactly calibrated for request ${request.requestIndex}`)
    }
  }
}

function assertAnswerBasedContinuity(result) {
  if (CONTINUATION_PROMPT.includes(ACCEPTANCE_ANCHOR)
    || CONTINUATION_PROMPT.includes(ACCEPTANCE_DETAIL)) {
    throw new Error('continuation prompt leaked the expected prior value')
  }
  const assessment = result.memoryContinuityAssessment
  if (assessment?.status !== 'supported'
    || assessment.method !== 'answer-evidence-v1'
    || assessment.sources?.explicitContinuationRequest !== true
    || !assessment.matchedSources?.includes('recent_history')) {
    throw new Error(`cross-restart reply was not supported by final-answer history evidence: ${safeAssessment(assessment)}`)
  }
}

function runMetrics(label, result) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  const requests = (result.modelRequests ?? []).map((request) => {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    return {
      index: request.requestIndex,
      purpose: request.callContract?.purpose ?? request.stage,
      localPromptTokens: snapshot?.localTokenLedger?.accuracy === 'exact'
        ? snapshot.localTokenLedger.promptTokens
        : undefined,
      providerPromptTokens: snapshot?.providerUsage?.promptTokens,
      completionTokens: snapshot?.providerUsage?.completionTokens,
      calibration: snapshot?.providerUsage?.localCalibration?.status,
    }
  })
  return {
    label,
    status: result.status,
    durationMs: result.durationMs,
    modelCalls: requests.length,
    continuity: result.memoryContinuityAssessment?.status,
    continuitySources: result.memoryContinuityAssessment?.matchedSources ?? [],
    requests,
  }
}

function assertIncludes(value, expected, label) {
  if (typeof value !== 'string' || !value.includes(expected)) {
    const bounded = typeof value === 'string' ? value.slice(0, 500) : value
    throw new Error(`${label} did not include the required prior value: ${JSON.stringify(bounded)}`)
  }
}

function assertNotIncludes(value, expected, label) {
  if (typeof value === 'string' && value.includes(expected)) {
    throw new Error(`${label} repeated content that was reserved for the later continuity question`)
  }
}

function safeResult(result) {
  return JSON.stringify({
    status: result?.status,
    error: typeof result?.error === 'string' ? result.error.slice(0, 300) : undefined,
    runId: result?.runId,
  })
}

function safeAssessment(assessment) {
  return JSON.stringify({
    status: assessment?.status,
    method: assessment?.method,
    matchedSources: assessment?.matchedSources,
    matchedSignals: assessment?.matchedSignals,
    missingSignals: assessment?.missingSignals,
  })
}

function apiUrl(locator, path) {
  return `http://${locator.host}:${locator.port}${path}`
}

function authHeaders(locator) {
  return { Authorization: `Bearer ${locator.token}` }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined && value !== false && value !== null) return value
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function waitForMissing(path, timeoutMs) {
  return waitFor(() => existsSync(path) ? undefined : true, timeoutMs, `removal of ${path}`)
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

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-deepseek-reply-continuity',
    ok: false,
    errorKind: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  }))
  process.exitCode = 1
})
