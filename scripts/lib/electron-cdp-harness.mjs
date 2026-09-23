// Shared Playwright-free Electron/CDP harness for the real-window verification
// scripts (workspace performance, desktop cold start).
//
// Ownership: process launch, the locator handshake, the minimal CDP client and
// the polling/rounding primitives every real-window measurement needs. Domain
// assertions (what a workspace panel or a cold-start stage must satisfy) stay in
// the individual scripts; this module must not grow product budgets.
//
// The launch contract matches the app's own acceptance surface:
//   - `LITTLESHEEP_DATA_DIR` isolates the data root,
//   - `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` exposes `/application/acceptance`,
//   - the locator file (<data-root>/runtime/local-app-api.json) carries the
//     loopback port and bearer token once the Local App API is listening.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './app-build-fingerprint.mjs'
import { resolveVerifiedElectronExecutable } from './electron-runtime.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const appRoot = join(repoRoot, 'packages', 'app')
export const LOCATOR_RELATIVE_PATH = join('runtime', 'local-app-api.json')

export const DEFAULT_START_TIMEOUT_MS = 60_000
export const DEFAULT_ACTION_TIMEOUT_MS = 20_000

/**
 * Build the harness bound to one repo checkout. Budgets stay with each caller so
 * the shared module never hardcodes a product commitment.
 */
export function createElectronHarness({
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
} = {}) {
  async function assertBuildFresh() {
    return assertAppBuildFresh(repoRoot)
  }

  function resolveExecutable() {
    return resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true })
  }

  /**
   * Launch the packaged/dev Electron app against an isolated data root.
   * `onSpawn` receives the child pid and the wall-clock time captured right
   * before the call, which is the only honest "process start" anchor available
   * to the parent process.
   */
  async function startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    mainDebuggingPort,
    logPath,
    extraEnv = {},
    extraArgs = [],
    onSpawn,
  }) {
    const executable = resolveExecutable()
    const log = createWriteStream(logPath, { flags: 'a' })
    const env = {
      ...process.env,
      LITTLESHEEP_DATA_DIR: dataDir,
      LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
      ...extraEnv,
    }
    delete env.ELECTRON_RUN_AS_NODE
    const spawnRequestedAt = Date.now()
    const child = spawn(executable, [
      '.',
      `--user-data-dir=${chromiumDir}`,
      ...(debuggingPort ? [`--remote-debugging-port=${debuggingPort}`] : []),
      ...(mainDebuggingPort ? [`--inspect=${mainDebuggingPort}`] : []),
      ...extraArgs,
    ], {
      cwd: appRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.once('exit', () => log.end())
    onSpawn?.({ pid: child.pid, spawnRequestedAt })
    return child
  }

  async function waitForLocator(dataDir, expectedPid) {
    const path = join(dataDir, LOCATOR_RELATIVE_PATH)
    return waitFor(async () => {
      try {
        const locator = JSON.parse(await readFile(path, 'utf8'))
        return locator.pid === expectedPid && locator.host === '127.0.0.1' && locator.token ? locator : undefined
      } catch {
        return undefined
      }
    }, startTimeoutMs, 'Local App API locator')
  }

  async function waitForDesktop(locator) {
    return waitFor(async () => {
      const snapshot = await desktopSnapshot(locator).catch(() => undefined)
      return snapshot?.windowExists && snapshot.windowVisible ? snapshot : undefined
    }, startTimeoutMs, 'desktop window')
  }

  async function desktopSnapshot(locator) {
    const response = await fetch(apiUrl(locator, '/application/acceptance'), { headers: authHeaders(locator) })
    if (!response.ok) throw new Error(`desktop snapshot failed: ${response.status}`)
    return (await response.json()).snapshot
  }

  async function desktopAction(locator, action) {
    const response = await fetch(apiUrl(locator, '/application/acceptance'), {
      method: 'POST',
      headers: { ...authHeaders(locator), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!response.ok) throw new Error(`desktop action ${action} failed: ${response.status}`)
  }

  /**
   * Attach to the production renderer page. The window first shows the
   * standalone startup document and only later the React bundle, so a target
   * must be observed twice with a complete readyState before it counts.
   */
  async function connectRenderer(port) {
    return waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
      if (!response?.ok) return undefined
      const values = await response.json()
      const target = values.find((candidate) => (
        candidate.type === 'page'
        && candidate.webSocketDebuggerUrl
        && /\/renderer\/index\.html(?:[?#]|$)/u.test(candidate.url ?? '')
      ))
      if (!target) return undefined

      const client = new CdpClient(target.webSocketDebuggerUrl)
      try {
        const state = await client.evaluate(`(() => ({
          url: location.href,
          readyState: document.readyState,
          hasRoot: Boolean(document.querySelector('#root')),
        }))()`)
        if (
          state?.readyState === 'complete'
          && state.hasRoot
          && /\/renderer\/index\.html(?:[?#]|$)/u.test(state.url ?? '')
        ) {
          await delay(80)
          const stable = await client.evaluate(`(() => ({
            url: location.href,
            readyState: document.readyState,
            hasRoot: Boolean(document.querySelector('#root')),
          }))()`)
          if (
            stable?.readyState === 'complete'
            && stable.hasRoot
            && /\/renderer\/index\.html(?:[?#]|$)/u.test(stable.url ?? '')
          ) return client
        }
      } catch {
        // The target may still be navigating from the startup page.
      }
      client.close()
      return undefined
    }, startTimeoutMs, 'renderer debug target')
  }

  async function connectDebugger(port, label) {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
      if (!response?.ok) return undefined
      const values = await response.json()
      return values.find((candidate) => candidate.webSocketDebuggerUrl)
    }, startTimeoutMs, label)
    return new CdpClient(target.webSocketDebuggerUrl)
  }

  async function waitFor(read, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await read()
      if (value !== undefined && value !== null && value !== false) return value
      await delay(25)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  async function waitForVisible(client, selector, start, timeoutMs = actionTimeoutMs) {
    const result = await waitFor(async () => {
      const current = await client.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
          ? performance.now()
          : null;
      })()`)
      return typeof current === 'number' ? current : undefined
    }, timeoutMs, selector)
    return { visibleAt: result, elapsedMs: roundMs(result - start) }
  }

  async function reservePort() {
    return new Promise((resolvePromise, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('failed to reserve port'))
        server.close(() => resolvePromise(address.port))
      })
    })
  }

  function apiUrl(locator, path) {
    return `http://${locator.host}:${locator.port}${path}`
  }

  function authHeaders(locator) {
    return { Authorization: `Bearer ${locator.token}` }
  }

  async function fetchJson(locator, path, init) {
    const response = await fetch(apiUrl(locator, path), {
      ...init,
      headers: { ...authHeaders(locator), ...(init?.headers ?? {}) },
    })
    const body = await response.json().catch(() => undefined)
    return { status: response.status, ok: response.ok, body }
  }

  async function readBootstrapTimings(logPath) {
    const contents = await readFile(logPath, 'utf8').catch(() => '')
    const prefix = '[bootstrap-timing] '
    return contents.split(/\r?\n/u).flatMap((line) => {
      const offset = line.indexOf(prefix)
      if (offset < 0) return []
      try {
        const entry = JSON.parse(line.slice(offset + prefix.length))
        if (!entry || typeof entry.stage !== 'string') return []
        return [entry]
      } catch {
        return []
      }
    })
  }

  async function forceTerminate(child) {
    if (!child) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      await waitFor(
        () => (child.exitCode === null ? undefined : true),
        10_000,
        'Electron process exit',
      ).catch(() => undefined)
      return
    }
    child.kill('SIGKILL')
  }

  async function removeTemporaryRoot(root) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        return
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 7) throw error
        await delay(150 * (attempt + 1))
      }
    }
  }

  return {
    CdpClient,
    delay,
    roundMs,
    startTimeoutMs,
    actionTimeoutMs,
    assertBuildFresh,
    resolveExecutable,
    startElectron,
    waitForLocator,
    waitForDesktop,
    desktopSnapshot,
    desktopAction,
    connectRenderer,
    connectDebugger,
    waitFor,
    waitForVisible,
    reservePort,
    apiUrl,
    authHeaders,
    fetchJson,
    readBootstrapTimings,
    forceTerminate,
    removeTemporaryRoot,
  }
}

export class CdpClient {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.socket = new WebSocket(url)
    this.opened = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        this.events.push(message)
        if (this.events.length > 2_000) this.events.shift()
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  async send(method, params = {}) {
    await this.opened
    const id = this.nextId++
    const response = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return response
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      const description = details.exception?.description ?? details.text ?? 'Renderer evaluation failed'
      const location = [details.url, details.lineNumber, details.columnNumber]
        .filter((value) => value !== undefined && value !== '')
        .join(':')
      throw new Error(location ? `${description} (${location})` : description)
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

export function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function roundMs(value) {
  return Math.round(Number(value) * 10) / 10
}

export function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
