import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const START_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 20_000
const COMPOSER_DRAFT = 'restart continuity draft 4827'

async function main() {
  await assertAppBuildFresh(repoRoot)
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-ui-state-continuity-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const windowStatePath = join(dataDir, 'ui', 'desktop-window.json')
  const logPath = join(root, 'electron.log')
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(dirname(windowStatePath), { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir), null, 2)}\n`, 'utf8')
    await writeFile(windowStatePath, JSON.stringify({
      version: 1,
      bounds: { x: 120, y: 80, width: 1100, height: 700 },
      maximized: false,
    }, null, 2), 'utf8')

    let debuggingPort = await reservePort()
    electron = await startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    let locator = await waitForLocator(dataDir, electron.pid)
    client = await connectRenderer(debuggingPort)
    await waitForRendererReady(client)
    const firstWindow = await readWindowGeometry(client)
    const chatBottomGap = await verifyChatBottomAnchor(client)
    const fileNavigatorWidth = await verifyFileNavigatorResize(client)

    const changed = await client.evaluate(`(() => {
      const textarea = document.querySelector('.composer textarea')
      const conversation = document.querySelector('.conversation-section .sidebar-section-toggle')
      const project = document.querySelector('.project-section .sidebar-section-toggle')
      const resizer = document.querySelector('.sidebar-resizer')
      const settings = document.querySelector('.settings-entry-btn')
      if (!(textarea instanceof HTMLTextAreaElement) || !(conversation instanceof HTMLElement)
        || !(project instanceof HTMLElement) || !(resizer instanceof HTMLElement)
        || !(settings instanceof HTMLElement)) return false
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(textarea, ${JSON.stringify(COMPOSER_DRAFT)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      conversation.click()
      project.click()
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      settings.click()
      return true
    })()`)
    if (!changed) throw new Error('renderer controls were not ready for the continuity fixture')
    await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.settings-workspace'))`), START_TIMEOUT_MS, 'settings workspace')
    const browserOpened = await client.evaluate(`(() => {
      const item = [...document.querySelectorAll('.settings-nav-item')]
        .find((candidate) => candidate.textContent?.includes('浏览器'))
      if (!(item instanceof HTMLElement)) return false
      item.click()
      return true
    })()`)
    if (!browserOpened) throw new Error('browser settings navigation item was unavailable')
    await waitFor(async () => client.evaluate(`document.querySelector('.settings-nav-item.active')?.textContent?.includes('浏览器') === true`), START_TIMEOUT_MS, 'browser settings page')

    // A stale write after this point would leave this marker behind. The quit
    // handshake must replace it with the live native window state.
    await writeFile(windowStatePath, '{"corrupted":true}\n', 'utf8')
    client.close()
    client = undefined
    await desktopAction(locator, 'quit')
    await waitForExit(electron, EXIT_TIMEOUT_MS)
    electron = undefined

    const savedWindowState = JSON.parse(await readFile(windowStatePath, 'utf8'))
    assertWindowState(savedWindowState, firstWindow)

    debuggingPort = await reservePort()
    electron = await startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await waitForLocator(dataDir, electron.pid)
    client = await connectRenderer(debuggingPort)
    await waitForRendererReady(client)
    const restored = await client.evaluate(`(() => ({
      composerDraft: document.querySelector('.composer textarea')?.value ?? '',
      conversationCollapsed: document.querySelector('.conversation-section')?.classList.contains('collapsed') === true,
      projectCollapsed: document.querySelector('.project-section')?.classList.contains('collapsed') === true,
      sidebarWidth: document.querySelector('.sidebar-resizer')?.getAttribute('aria-valuenow') ?? '',
      settingsOpen: Boolean(document.querySelector('.settings-workspace')),
      activeSettingsPage: document.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? '',
      persisted: JSON.parse(localStorage.getItem('littlesheep.ui.appShellState') ?? 'null'),
      workspaceLayouts: JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') ?? 'null'),
    }))()`)
    const secondWindow = await readWindowGeometry(client)

    if (restored.composerDraft !== COMPOSER_DRAFT) throw new Error('composer draft was not restored')
    if (!restored.conversationCollapsed) throw new Error('conversation section state was not restored')
    if (!restored.projectCollapsed) throw new Error('project section state was not restored')
    if (restored.sidebarWidth !== '288') throw new Error(`sidebar width was not restored: ${restored.sidebarWidth}`)
    if (!restored.settingsOpen || !restored.activeSettingsPage.includes('浏览器')) {
      throw new Error(`settings route was not restored: ${JSON.stringify(restored)}`)
    }
    if (restored.persisted?.composerDraft !== COMPOSER_DRAFT || restored.persisted?.route?.page !== 'browser') {
      throw new Error(`persisted application shell snapshot is incomplete: ${JSON.stringify(restored.persisted)}`)
    }
    if (restored.workspaceLayouts?.__draft__?.fileNavigatorWidth !== fileNavigatorWidth) {
      throw new Error(`file navigator width snapshot was not restored: ${JSON.stringify(restored.workspaceLayouts)}`)
    }
    assertGeometryNear(secondWindow, firstWindow, 'restored native window')

    const renderedNavigatorWidth = await revealWorkspaceAndReadNavigatorWidth(client)
    if (renderedNavigatorWidth !== fileNavigatorWidth) {
      throw new Error(`file navigator rendered at ${renderedNavigatorWidth}, expected ${fileNavigatorWidth}`)
    }

    client.close()
    client = undefined
    await desktopAction(locator, 'quit')
    await waitForExit(electron, EXIT_TIMEOUT_MS)
    electron = undefined
    console.log(JSON.stringify({
      check: 'electron-ui-state-continuity',
      ok: true,
      restored: {
        composerDraft: true,
        conversationCollapsed: true,
        projectCollapsed: true,
        sidebarWidth: 288,
        chatBottomGap,
        fileNavigatorWidth,
        settingsPage: 'browser',
        nativeWindow: true,
      },
    }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'electron-ui-state-continuity',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!preserve) await rm(root, { recursive: true, force: true })
  }
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    providers: [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: '',
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
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2', llmCapture: false, llmEvolve: 'never' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function startElectron({ dataDir, chromiumDir, debuggingPort, logPath }) {
  const executable = resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true })
  const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath, { flags: 'a' }))
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['.', `--user-data-dir=${chromiumDir}`, `--remote-debugging-port=${debuggingPort}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.once('exit', () => log.end())
  return child
}

async function connectRenderer(port) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
    if (!response?.ok) return undefined
    const values = await response.json()
    return values.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
  }, START_TIMEOUT_MS, 'renderer debug target')
  return new CdpClient(target.webSocketDebuggerUrl)
}

async function waitForRendererReady(client) {
  await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.composer textarea') && document.querySelector('.sidebar-resizer'))`), START_TIMEOUT_MS, 'renderer UI')
}

async function readWindowGeometry(client) {
  return client.evaluate(`({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })`)
}

async function verifyChatBottomAnchor(client) {
  const result = await client.evaluate(`new Promise((resolvePromise) => {
    const messages = document.querySelector('.messages')
    const content = document.querySelector('.messages-content')
    if (!(messages instanceof HTMLElement) || !(content instanceof HTMLElement)) {
      resolvePromise(null)
      return
    }

    const probe = document.createElement('div')
    probe.dataset.chatBottomAnchorProbe = 'true'
    probe.style.height = '1800px'
    probe.style.pointerEvents = 'none'
    content.append(probe)
    messages.style.flex = '0 0 480px'

    requestAnimationFrame(() => requestAnimationFrame(() => {
      const expectedGap = 137
      messages.scrollTop = messages.scrollHeight - messages.clientHeight - expectedGap
      requestAnimationFrame(() => {
        const beforeGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight
        messages.style.flexBasis = '360px'
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const afterGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight
          messages.style.removeProperty('flex')
          messages.style.removeProperty('flex-basis')
          probe.remove()
          resolvePromise({ beforeGap, afterGap })
        }))
      })
    }))
  })`)
  if (!result || Math.abs(result.beforeGap - result.afterGap) > 1) {
    throw new Error(`chat viewport lost its bottom anchor: ${JSON.stringify(result)}`)
  }
  return result.afterGap
}

async function verifyFileNavigatorResize(client) {
  await client.evaluate(`(() => {
    const panel = document.querySelector('.workspace-panel')
    if (panel?.classList.contains('collapsed')) {
      document.querySelector('.workspace-panel-corner-toggle')?.click()
    }
  })()`)
  await waitFor(async () => client.evaluate(`
    document.querySelector('.workspace-panel:not(.collapsed)')?.getBoundingClientRect().width > 0 || null
  `), START_TIMEOUT_MS, 'open workspace panel')
  await client.evaluate(`(() => {
    const panel = document.querySelector('.workspace-panel')
    if (!panel?.classList.contains('fullscreen')) {
      document.querySelector('.workspace-panel-collapse-action')?.click()
    }
  })()`)
  await waitFor(async () => client.evaluate(`
    document.querySelector('.workspace-panel')?.classList.contains('fullscreen') || null
  `), START_TIMEOUT_MS, 'fullscreen workspace panel')
  const initial = await waitFor(async () => client.evaluate(`(() => {
    const resizer = document.querySelector('.workspace-files-navigator-resizer')
    if (!(resizer instanceof HTMLElement)) return null
    const rect = resizer.getBoundingClientRect()
    const width = Number(resizer.getAttribute('aria-valuenow'))
    const maxWidth = Number(resizer.getAttribute('aria-valuemax'))
    const parentWidth = resizer.parentElement?.parentElement?.getBoundingClientRect().width ?? 0
    return rect.width > 0 && rect.height > 0 && Number.isFinite(width)
      && Number.isFinite(maxWidth) && maxWidth >= width + 72 && parentWidth >= 600
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width }
      : null
  })()`), START_TIMEOUT_MS, 'file navigator resizer')

  await dragAt(client, initial.x, initial.y, initial.x - 72, initial.y)
  const resized = await waitFor(async () => client.evaluate(`(() => {
    const resizer = document.querySelector('.workspace-files-navigator-resizer')
    const width = Number(resizer?.getAttribute('aria-valuenow'))
    if (!(resizer instanceof HTMLElement) || !Number.isFinite(width)) return null
    const rect = resizer.getBoundingClientRect()
    return width > ${initial.width}
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width }
      : null
  })()`), START_TIMEOUT_MS, 'resized file navigator')

  await dragAt(client, resized.x, resized.y, resized.x + resized.width + 32, resized.y)
  await waitFor(async () => client.evaluate(`
    document.querySelector('.workspace-files-navigator')?.classList.contains('navigator-collapsed') || null
  `), START_TIMEOUT_MS, 'file navigator threshold collapse')
  await client.evaluate(`document.querySelector('.workspace-files-navigator-rail')?.click()`)
  const reopenedWidth = await waitFor(async () => client.evaluate(`(() => {
    const navigator = document.querySelector('.workspace-files-navigator')
    const resizer = document.querySelector('.workspace-files-navigator-resizer')
    if (navigator?.classList.contains('navigator-collapsed')) return null
    const width = Number(resizer?.getAttribute('aria-valuenow'))
    return Number.isFinite(width) ? width : null
  })()`), START_TIMEOUT_MS, 'reopened file navigator')
  if (reopenedWidth !== resized.width) {
    throw new Error(`file navigator did not restore its open width: ${reopenedWidth} !== ${resized.width}`)
  }
  return resized.width
}

async function revealWorkspaceAndReadNavigatorWidth(client) {
  await client.evaluate(`document.querySelector('.settings-entry-btn')?.click()`)
  await waitFor(async () => client.evaluate(`!document.querySelector('.settings-workspace') || null`), START_TIMEOUT_MS, 'restored workspace route')
  await client.evaluate(`(() => {
    const panel = document.querySelector('.workspace-panel')
    if (panel?.classList.contains('collapsed')) {
      document.querySelector('.workspace-panel-corner-toggle')?.click()
    }
  })()`)
  return waitFor(async () => client.evaluate(`(() => {
    const navigator = document.querySelector('.workspace-files-navigator')
    const resizer = document.querySelector('.workspace-files-navigator-resizer')
    if (navigator?.classList.contains('navigator-collapsed')) return null
    const width = Number(resizer?.getAttribute('aria-valuenow'))
    return Number.isFinite(width) ? width : null
  })()`), START_TIMEOUT_MS, 'restored file navigator width')
}

async function dragAt(client, fromX, fromY, toX, toY) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: fromX,
    y: fromY,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: fromX,
    y: fromY,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: toX,
    y: toY,
    button: 'left',
    buttons: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: toX,
    y: toY,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
}

function assertWindowState(state, expectedGeometry) {
  if (state?.version !== 1 || !state.bounds || state.maximized !== false) {
    throw new Error(`native window state was not flushed: ${JSON.stringify(state)}`)
  }
  assertGeometryNear(state.bounds, expectedGeometry, 'saved native window')
}

function assertGeometryNear(actual, expected, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(actual?.[key]) || Math.abs(actual[key] - expected[key]) > 12) {
      throw new Error(`${label} ${key} differs: expected ${expected[key]}, received ${actual?.[key]}`)
    }
  }
}

async function waitForLocator(dataDir, expectedPid) {
  const path = join(dataDir, 'runtime', 'local-app-api.json')
  return waitFor(async () => {
    try {
      const locator = JSON.parse(await readFile(path, 'utf8'))
      return locator.pid === expectedPid && locator.token ? locator : undefined
    } catch {
      return undefined
    }
  }, START_TIMEOUT_MS, 'Local App API locator')
}

async function desktopAction(locator, action) {
  const response = await fetch(`http://${locator.host}:${locator.port}/application/acceptance`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${locator.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error(`desktop action ${action} failed: ${response.status}`)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise) => server.close(resolvePromise))
  if (!port) throw new Error('failed to reserve a renderer debugging port')
  return port
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron did not exit in time')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

async function waitFor(operation, timeoutMs, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await operation()
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

class CdpClient {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.socket = new WebSocket(url)
    this.opened = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed')
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

await main()
