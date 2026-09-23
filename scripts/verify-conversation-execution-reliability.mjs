import { spawn, execFileSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js'
import { getProvider, loadConfig, withProviderPresets } from '../packages/config/dist/index.js'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'

/**
 * CE-12 acceptance for the conversation-execution-reliability taskbook.
 *
 * Real model, real Windows shell, real Electron window, isolated data root:
 * the Provider credentials are copied into a temporary root so the user's own
 * data is never touched, and every artifact is written into a temporary
 * workspace whose name contains a space.
 *
 * What it can decide: whether a plain "做一个小游戏吧" produces a playable
 * artifact in the right directory, whether the model's own process language is
 * Chinese, whether the runtime context brief reached the real request, and
 * whether a natural-language continuation binds to the same work.
 *
 * What it cannot decide: whether the game is fun. That stays a human step.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const locatorRelativePath = join('runtime', 'local-app-api.json')
const START_TIMEOUT_MS = 60_000
const RUN_TIMEOUT_MS = 600_000
const EXIT_TIMEOUT_MS = 20_000
const MODEL = 'deepseek-v4-flash'
const GAME_PROMPT = '做一个小游戏吧'
const CONTINUATION_PROMPT = '继续做吧'
const MAX_ARTIFACT_BYTES = 512 * 1024
/** Evidence paths a failed run keeps, so the error report can point at them. */
let keptRoot
let keptAppLog

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

  const root = await mkdtemp(join(tmpdir(), 'littlesheep-ce12-'))
  const dataDir = join(root, 'data')
  // A space in the directory name is deliberate: the reported failures included
  // workspace paths that needed quoting in the real shell.
  const workspaceDir = join(root, 'work space')
  const chromiumDir = join(root, 'chromium')
  const appLogPath = join(repoRoot, '.codex_tmp', `ce12-app-${Date.now()}.log`)
  let electron
  let report
  let succeeded = false

  try {
    await prepareIsolatedDataRoot({ dataDir, workspaceDir, sourceKeys, sourceTokenizer, sourceProvider })
    await mkdir(chromiumDir, { recursive: true })
    await copyFile(sourceChromiumLocalState, join(chromiumDir, 'Local State'))

    electron = startElectron({ dataDir, chromiumDir, logPath: appLogPath })
    let locator = await waitForLocator(dataDir, electron.pid)
    await waitForDesktop(locator)
    progress(`window ready on ${locator.host}:${locator.port}; app log ${appLogPath}`)

    const scenarios = []

    const first = await runStream(locator, { text: GAME_PROMPT, permissionMode: 'full', workspace: workspaceDir })
    assertSuccessfulRun(first.result, 'normal workspace run')
    const firstArtifacts = await collectNewArtifacts(workspaceDir, [])
    assertDelivered(first.result, firstArtifacts, 'normal workspace run')
    assertRuntimeContextBrief(first.result, 'normal workspace run')
    scenarios.push(describeScenario('normal_workspace', first.result, firstArtifacts, first.transport))
    progress(`normal workspace: ${progressLine(first.result, firstArtifacts)} ${transportLine(first.transport)}`)

    const beforeContinuation = firstArtifacts.map((artifact) => artifact.relativePath)
    const continued = await runStream(locator, {
      text: CONTINUATION_PROMPT,
      sessionId: first.result.sessionId,
      permissionMode: 'full',
      workspace: workspaceDir,
    })
    assertSuccessfulRun(continued.result, 'natural-language continuation')
    const continuedArtifacts = await collectNewArtifacts(workspaceDir, beforeContinuation)
    scenarios.push(describeScenario('continuation', continued.result, continuedArtifacts, {
      ...continued.transport,
      reusedSession: continued.result.sessionId === first.result.sessionId,
    }))
    progress(`continuation: ${progressLine(continued.result, continuedArtifacts)} ${transportLine(continued.transport)}`)

    const repeated = await runStream(locator, { text: GAME_PROMPT, permissionMode: 'full', workspace: workspaceDir })
    assertSuccessfulRun(repeated.result, 'independent repeat')
    const repeatedArtifacts = await collectNewArtifacts(
      workspaceDir,
      [...beforeContinuation, ...continuedArtifacts.map((artifact) => artifact.relativePath)],
    )
    assertDelivered(repeated.result, repeatedArtifacts, 'independent repeat')
    scenarios.push(describeScenario('independent_repeat', repeated.result, repeatedArtifacts, repeated.transport))
    progress(`independent repeat: ${progressLine(repeated.result, repeatedArtifacts)} ${transportLine(repeated.transport)}`)

    const playable = await inspectPlayableArtifact(workspaceDir)
    progress(`playable artifact: ${JSON.stringify(playable)}`)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, EXIT_TIMEOUT_MS)
    await waitForMissing(join(dataDir, locatorRelativePath), EXIT_TIMEOUT_MS)
    electron = undefined
    await delay(1_500)

    report = {
      check: 'conversation-execution-reliability-acceptance',
      ok: true,
      provider: 'deepseek',
      model: MODEL,
      permissionMode: 'full',
      isolatedDataRoot: true,
      workspaceHasSpace: true,
      sourceRevision: revision(),
      electronVersion: readFileSync(join(dirname(resolveVerifiedElectronExecutable(repoRoot)), 'version'), 'utf8').trim(),
      scenarios,
      playableArtifact: playable,
      humanPlaythrough: 'not_performed',
    }
    succeeded = true
  } finally {
    if (electron?.exitCode === null) await forceTerminate(electron)
    // The credential copy is only needed while the app is starting.
    await rm(join(dataDir, 'config', 'keys.json'), { force: true }).catch(() => undefined)
    if (succeeded) {
      // Electron's helper processes can hold the profile for a moment after the
      // main process exits. Retry the removal.
      const removed = await removeIsolatedRoot(root)
      progress(`isolated root removed: ${removed}`)
    } else {
      // Keep the evidence instead of deleting it: the workspace artifacts and
      // the isolated data root (sessions, execution logs, checkpoints) are what
      // a failed acceptance has to be diagnosed from.
      keptRoot = root
      keptAppLog = appLogPath
      progress(`failed run kept at ${root}`)
      progress(`app log kept at ${appLogPath}`)
    }
  }

  console.log(JSON.stringify({
    ...report,
    keptRoot,
    keptAppLog,
    isolatedDataRemoved: keptRoot === undefined && !existsSync(root),
  }, null, 2))
}

function progress(message) {
  console.error(`[ce12] ${message}`)
}

function progressLine(result, artifacts) {
  return [
    `status=${result.status}`,
    `ms=${result.durationMs}`,
    `requests=${(result.modelRequests ?? []).length}`,
    `tools=${(result.toolInvocations ?? []).length}`,
    `verdict=${result.verificationHistory?.at(-1)?.verdict ?? 'none'}`,
    `artifacts=${artifacts.length}`,
  ].join(' ')
}

function transportLine(transport) {
  return `transport=frames:${transport?.frames ?? 0}${transport?.terminated ? ' (terminated, reconciled from the durable log)' : ''}`
}

async function removeIsolatedRoot(root) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      if (!existsSync(root)) return true
    } catch {
      // locked by a still-exiting helper process; retry below
    }
    await delay(500)
  }
  return !existsSync(root)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** Source revision the acceptance ran against; the repository is the record. */
function revision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

async function prepareIsolatedDataRoot(options) {
  const configDir = join(options.dataDir, 'config')
  const tokenizerDir = join(options.dataDir, 'models', 'tokenizer')
  await mkdir(options.workspaceDir, { recursive: true })
  await mkdir(configDir, { recursive: true })
  await copyFile(options.sourceKeys, join(configDir, 'keys.json'))
  await cp(options.sourceTokenizer, tokenizerDir, { recursive: true, force: true })
  await writeFile(join(options.dataDir, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{
      id: 'deepseek',
      name: options.sourceProvider.name ?? 'DeepSeek',
      baseURL: options.sourceProvider.baseURL,
      apiKey: options.sourceProvider.apiKey ?? '$DEEPSEEK_API_KEY',
      timeoutSeconds: 180,
      models: [MODEL],
    }],
    agents: {
      defaults: {
        workspace: options.workspaceDir,
        model: `deepseek/${MODEL}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 300,
        maxRecoveryAttempts: 3,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 40,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    memory: { repositoryBackend: 'v2' },
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

function startElectron({ dataDir, chromiumDir, logPath }) {
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
    LITTLESHEEP_BOOTSTRAP_TIMING: '1',
  }
  delete env.DEEPSEEK_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  const out = openSync(logPath, 'a')
  const err = openSync(logPath, 'a')
  return spawn(resolveVerifiedElectronExecutable(repoRoot), ['.', `--user-data-dir=${chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', out, err],
    windowsHide: true,
  })
}

async function collectNewArtifacts(workspaceDir, known) {
  const seen = new Set(known)
  const found = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      const relativePath = relative(workspaceDir, full).replace(/\\/g, '/')
      if (seen.has(relativePath)) continue
      seen.add(relativePath)
      const content = await readFile(full).catch(() => undefined)
      found.push({
        relativePath,
        bytes: content?.length ?? 0,
        text: content && content.length <= MAX_ARTIFACT_BYTES ? content.toString('utf8') : undefined,
      })
    }
  }
  await walk(workspaceDir)
  return found
}

function assertSuccessfulRun(result, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safeResult(result)}`)
  if (result.replyProvenance?.source !== 'llm' || result.replyProvenance.provider !== 'deepseek') {
    throw new Error(`${label} did not publish a traceable DeepSeek reply`)
  }
  if (result.resolvedRunConfig?.permissionPolicyId !== 'full') {
    throw new Error(`${label} did not run under the requested permission policy`)
  }
  if ((result.modelRequests ?? []).length === 0) throw new Error(`${label} made no recorded model requests`)
}

function assertDelivered(result, artifacts, label) {
  const written = (result.toolInvocations ?? []).filter((invocation) => (
    invocation.toolName === 'write' || invocation.toolName === 'edit'
  ))
  const succeeded = written.filter((invocation) => invocation.status === 'succeeded')
  if (written.length === 0) {
    throw new Error(`${label} recorded no write tool call: ${safeResult(result)}`)
  }
  if (succeeded.length === 0) {
    // A run whose every write failed delivered nothing. A run that failed one
    // write and then corrected it is the CE-04 behaviour under test, so the
    // mixed case is reported, not rejected.
    throw new Error(`${label} recorded no successful write: ${JSON.stringify(written.map((item) => item.status))}`)
  }
  if (artifacts.length === 0) throw new Error(`${label} produced no file in the requested workspace`)
  // The model must have answered in the user's language: the reported failure
  // included English process text for a Chinese request.
  const reply = String(result.reply ?? '')
  if (!/[\u3400-\u9fff]/u.test(reply)) {
    throw new Error(`${label} replied without Chinese text: ${reply.slice(0, 120)}`)
  }
}

/** A failure the same run corrected: direct evidence for the CE-04 contract. */
function writeRecoveryPattern(result) {
  const written = (result.toolInvocations ?? []).filter((invocation) => (
    invocation.toolName === 'write' || invocation.toolName === 'edit'
  ))
  const failed = written.filter((invocation) => invocation.status !== 'succeeded')
  return {
    writes: written.length,
    failedWrites: failed.length,
    failedKinds: [...new Set(failed.map((invocation) => invocation.errorKind ?? invocation.status))],
    // The write succeeded later in the same run, without the user asking again.
    correctedInRun: failed.length > 0 && written.some((invocation) => invocation.status === 'succeeded'),
  }
}

/**
 * CE-13 evidence from a real outbound request: the environment brief has to be
 * part of the request the Provider saw, not something the UI claims.
 */
function assertRuntimeContextBrief(result, label) {
  const items = (result.contextSnapshots ?? []).flatMap((snapshot) => snapshot.items ?? [])
  const brief = items.find((item) => (
    String(item.source?.id ?? '').includes('runtime-context')
    || String(item.id ?? '').includes('runtime-context')
  ))
  if (!brief) {
    throw new Error(`${label} sent no runtime-context brief; snapshot items: ${JSON.stringify(items.map((item) => [item.id, item.source?.id]))}`)
  }
  return brief
}

async function inspectPlayableArtifact(workspaceDir) {
  const artifacts = await collectNewArtifacts(workspaceDir, [])
  const candidates = artifacts.filter((artifact) => /\.(?:html?|js)$/iu.test(artifact.relativePath))
  if (candidates.length === 0) throw new Error('no HTML/JS artifact was produced')
  const html = candidates.find((artifact) => /\.html?$/iu.test(artifact.relativePath))
    ?? candidates.sort((left, right) => right.bytes - left.bytes)[0]
  if (!html.text) throw new Error(`artifact ${html.relativePath} is too large to inspect (${html.bytes} bytes)`)

  const scripts = [...html.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)]
    .map((match) => match[1])
    .filter((body) => body.trim().length > 0)
  if (scripts.length === 0) throw new Error('the artifact carries no inline script')
  // Parse without executing: a syntax error would mean the model shipped a game
  // that cannot even load.
  for (const [index, body] of scripts.entries()) {
    try {
      new Script(body, { filename: `${html.relativePath}#script-${index}` })
    } catch (error) {
      throw new Error(`artifact script ${index} does not parse: ${error.message}`)
    }
  }
  const external = [...html.text.matchAll(/<script[^>]+src=["']([^"']+)["']/giu)].map((match) => match[1])
  const remote = external.filter((url) => /^(?:https?:)?\/\//iu.test(url))
  const signals = [
    /<canvas\b/iu.test(html.text) ? 'canvas' : undefined,
    /requestAnimationFrame|setInterval|setTimeout/iu.test(html.text) ? 'game_loop' : undefined,
    /keydown|keyup|onkey/iu.test(html.text) ? 'keyboard_input' : undefined,
    /score|得分|计分/iu.test(html.text) ? 'score' : undefined,
    /restart|重新开始|再来一局|reset/iu.test(html.text) ? 'restart' : undefined,
  ].filter(Boolean)
  return {
    relativePath: html.relativePath,
    bytes: html.bytes,
    inlineScripts: scripts.length,
    parsedScripts: scripts.length,
    externalScripts: external.length,
    remoteScripts: remote.length,
    signals,
    otherFiles: artifacts.map((artifact) => artifact.relativePath).filter((path) => path !== html.relativePath),
  }
}

function describeScenario(name, result, artifacts, extra = {}) {
  return {
    name,
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    durationMs: result.durationMs,
    replyChars: String(result.reply ?? '').length,
    chineseReply: /[\u3400-\u9fff]/u.test(String(result.reply ?? '')),
    modelRequests: (result.modelRequests ?? []).length,
    toolCalls: (result.toolInvocations ?? []).map((invocation) => ({
      tool: invocation.toolName,
      status: invocation.status,
    })),
    verification: result.verificationHistory?.at(-1)?.verdict,
    writeRecovery: writeRecoveryPattern(result),
    artifacts: artifacts.map((artifact) => ({ path: artifact.relativePath, bytes: artifact.bytes })),
    ...extra,
  }
}

function runMetrics(label, result) {
  return { label, status: result.status, durationMs: result.durationMs }
}

async function waitForLocator(dataDir, expectedPid) {
  return waitFor(async () => {
    try {
      const locator = JSON.parse(await readFile(join(dataDir, locatorRelativePath), 'utf8'))
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
    return payload.snapshot?.windowExists && payload.snapshot?.windowVisible ? payload.snapshot : undefined
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
    let runId = ''
    let buffer = ''
    let frames = 0
    try {
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const event = parseSseBlock(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (event) frames += 1
          if (event?.event === 'start') runId = String(event.data?.runId ?? '')
          if (event?.event === 'result') result = event.data
          if (event?.event === 'error') error = event.data?.error ?? 'unknown SSE error'
        }
      }
    } catch (streamError) {
      // The observation stream is not the run. A dropped connection must not
      // lose the outcome: the durable execution log is the authoritative record,
      // and the renderer's own history projection reads the same one.
      progress(`${path}: stream ended abnormally after ${frames} frames (${streamError?.message ?? streamError}); reconciling ${runId || 'unknown run'} from the durable log`)
      const reconciled = runId ? await waitForRunLog(locator, runId) : undefined
      if (!reconciled) throw streamError
      return { result: reconciled, transport: { frames, terminated: true } }
    }
    if (error) throw new Error(`${path}: ${error}`)
    if (!result) throw new Error(`${path}: SSE ended without a result`)
    return { result, transport: { frames, terminated: false } }
  } finally {
    clearTimeout(timeout)
  }
}

/** Wait for the run's durable record and return it in the shape the assertions use. */
async function waitForRunLog(locator, runId) {
  let lastError
  const log = await waitFor(async () => {
    try {
      const response = await fetch(apiUrl(locator, `/runs/${runId}`))
      if (response.status === 404) return undefined
      if (!response.ok) {
        lastError = `runs/${runId} returned ${response.status}`
        return undefined
      }
      const payload = await response.json()
      return payload?.runId === runId ? payload : undefined
    } catch (error) {
      lastError = error?.message ?? String(error)
      return undefined
    }
  }, RUN_TIMEOUT_MS, `durable log for run ${runId}`).catch(() => undefined)
  if (!log) progress(`durable log for ${runId} unavailable: ${lastError ?? 'not found'}`)
  return log
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

function apiUrl(locator, path) {
  return `http://${locator.host}:${locator.port}${path}`
}

function authHeaders(locator) {
  return { Authorization: `Bearer ${locator.token}` }
}

function safeResult(result) {
  return JSON.stringify({
    status: result?.status,
    error: result?.error,
    runtimeStatus: result?.runtimeStatus,
    trace: (result?.trace ?? []).map((entry) => `${entry.name}:${entry.ok}`),
  })
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitForExit(child, timeoutMs) {
  await waitFor(async () => (child.exitCode === null ? undefined : true), timeoutMs, 'Electron exit')
}

async function waitForMissing(path, timeoutMs) {
  await waitFor(async () => (existsSync(path) ? undefined : true), timeoutMs, `${path} removal`)
}

async function forceTerminate(child) {
  try {
    child.kill()
  } catch {
    // best effort
  }
}

await main().catch((error) => {
  console.log(JSON.stringify({
    check: 'conversation-execution-reliability-acceptance',
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4) : undefined,
    keptRoot,
    keptAppLog,
  }, null, 2))
  process.exitCode = 1
})
