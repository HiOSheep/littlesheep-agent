import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBranding, resolveDataDir } from '../../packages/branding/dist/index.js'
import { getProvider, loadConfig, withProviderPresets } from '../../packages/config/dist/index.js'
import { resolveVerifiedElectronExecutable } from './electron-runtime.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const appRoot = join(repoRoot, 'packages', 'app')
export const locatorRelativePath = join('runtime', 'local-app-api.json')
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_START_TIMEOUT_MS = 60_000
export const DEFAULT_RUN_TIMEOUT_MS = 120_000
export const DEFAULT_EXIT_TIMEOUT_MS = 20_000

export async function createIsolatedDeepSeekEnvironment(options = {}) {
  const model = options.model ?? DEFAULT_DEEPSEEK_MODEL
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'))
  const sourceDataDir = resolveDataDir(branding)
  const sourceConfig = withProviderPresets(await loadConfig({ dataDir: sourceDataDir }))
  const sourceProvider = getProvider(sourceConfig, 'deepseek')
  if (!sourceProvider) {
    throw new Error('DeepSeek is not configured in the active LittleSheep data root')
  }

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

  const root = await mkdtemp(join(tmpdir(), options.prefix ?? 'littlesheep-deepseek-acceptance-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const configDir = join(dataDir, 'config')
  const tokenizerDir = join(dataDir, 'models', 'tokenizer')

  await Promise.all([
    mkdir(workplaceDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(chromiumDir, { recursive: true }),
  ])
  await Promise.all([
    copyFile(sourceKeys, join(configDir, 'keys.json')),
    cp(sourceTokenizer, tokenizerDir, { recursive: true, force: true }),
    copyFile(sourceChromiumLocalState, join(chromiumDir, 'Local State')),
  ])

  const baseConfig = buildAcceptanceConfig({
    dataDir,
    workplaceDir,
    sourceProvider,
    model,
    closePolicy: options.closePolicy,
    maxModelCallsPerRun: options.maxModelCallsPerRun,
    runTimeoutSeconds: options.runTimeoutSeconds,
    toolInvocationTimeoutMs: options.toolInvocationTimeoutMs,
  })
  const config = options.configureConfig
    ? await options.configureConfig(structuredClone(baseConfig))
    : baseConfig
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  return {
    root,
    dataDir,
    chromiumDir,
    workplaceDir,
    model,
    copiedChromiumFiles: ['Local State'],
  }
}

function buildAcceptanceConfig(options) {
  return {
    version: 1,
    providers: [{
      id: 'deepseek',
      name: options.sourceProvider.name ?? 'DeepSeek',
      baseURL: options.sourceProvider.baseURL,
      apiKey: options.sourceProvider.apiKey ?? '$DEEPSEEK_API_KEY',
      timeoutSeconds: 120,
      models: [options.model],
    }],
    agents: {
      defaults: {
        workspace: options.workplaceDir,
        model: `deepseek/${options.model}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: options.runTimeoutSeconds ?? 120,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: options.maxModelCallsPerRun ?? 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: options.closePolicy ?? 'always-background' },
    tools: {
      exec: {},
      maxOutputChars: 10_000,
      stripImages: true,
      maxParallel: 4,
      invocationTimeoutMs: options.toolInvocationTimeoutMs ?? 120_000,
    },
    memory: {
      repositoryBackend: 'v2',
    },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
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

export function startElectron(options) {
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: options.dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
  }
  delete env.DEEPSEEK_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  return spawn(resolveVerifiedElectronExecutable(repoRoot), ['.', `--user-data-dir=${options.chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: options.stdio ?? 'ignore',
    windowsHide: true,
  })
}

export async function waitForLocator(dataDir, expectedPid, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
  const path = join(dataDir, locatorRelativePath)
  return waitFor(async () => {
    try {
      const locator = JSON.parse(await readFile(path, 'utf8'))
      if (locator.pid !== expectedPid || locator.host !== '127.0.0.1' || !locator.token) return undefined
      return locator
    } catch {
      return undefined
    }
  }, timeoutMs, 'Local App API locator')
}

export function waitForDesktop(locator, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
  return waitFor(async () => {
    const response = await fetch(apiUrl(locator, '/application/acceptance'), {
      headers: authHeaders(locator),
    }).catch(() => undefined)
    if (!response?.ok) return undefined
    const payload = await response.json()
    return payload.snapshot?.windowExists && payload.snapshot?.windowVisible
      ? payload.snapshot
      : undefined
  }, timeoutMs, 'desktop window')
}

export function desktopAction(locator, action) {
  return postJson(locator, '/application/acceptance', { action }, true)
}

export function runStream(locator, body, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  return readSse(locator, '/run/stream', body, timeoutMs)
}

export async function readSse(locator, path, body, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
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
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
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

export async function getJson(locator, path, authenticated = false) {
  const response = await fetch(apiUrl(locator, path), {
    headers: authenticated ? authHeaders(locator) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${payload.error ?? 'unknown error'}`)
  return payload
}

export async function postJson(locator, path, body, authenticated = false) {
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

export function apiUrl(locator, path) {
  return `http://${locator.host}:${locator.port}${path}`
}

export function authHeaders(locator) {
  return { Authorization: `Bearer ${locator.token}` }
}

export async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined && value !== false && value !== null) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export function waitForMissing(path, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
  return waitFor(() => existsSync(path) ? undefined : true, timeoutMs, `removal of ${path}`)
}

export async function waitForExit(child, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
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

export async function forceTerminate(child, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
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
  await waitForExit(child, timeoutMs).catch(() => undefined)
}

export function removeEnvironment(root) {
  return rm(root, { recursive: true, force: true })
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
