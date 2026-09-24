import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

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
  const provider = await startElectronAcceptanceProvider({
    requestDelayMs: 600,
    streamChunkDelayMs: 120,
    streamChunkCharacters: 6,
  })
  let electron
  let client
  let preserve = false
  let activityEvidence

  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(dirname(windowStatePath), { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')
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
    activityEvidence = await verifyObservableActivityStream(client)
    const leanHarnessEvidence = await verifyLeanBoundedExecution(client, provider)
    const activeSessionId = await client.evaluate(`localStorage.getItem('littlesheep.ui.activeSession')`)
    const workspaceLayoutKey = typeof activeSessionId === 'string' && activeSessionId.trim()
      ? `session:${encodeURIComponent(activeSessionId.trim())}`
      : '__draft__'
    const firstWindow = await readWindowGeometry(client)
    const chatReadingPosition = await verifyChatReadingPosition(client)
    const navigatorResize = await verifyFileNavigatorResize(client)

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
      const initialSidebarWidth = Number(resizer.getAttribute('aria-valuenow'))
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return {
        ok: true,
        initialSidebarWidth,
      }
    })()`)
    if (!changed?.ok || !Number.isFinite(changed.initialSidebarWidth)) {
      throw new Error('renderer controls were not ready for the continuity fixture')
    }
    const expectedChangedSidebarWidth = Math.min(460, Math.round(changed.initialSidebarWidth + 12))
    await waitFor(async () => client.evaluate(`Number(document.querySelector('.sidebar-resizer')?.getAttribute('aria-valuenow')) === ${expectedChangedSidebarWidth} || null`), START_TIMEOUT_MS, 'sidebar width nudge')
    const sidebarPreference = await client.evaluate(`Number(localStorage.getItem('littlesheep.ui.sidebarWidth'))`)
    if (!Number.isFinite(sidebarPreference)) throw new Error('responsive sidebar width preference was not persisted')
    await client.evaluate(`document.querySelector('.settings-entry-btn')?.click()`)
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
    const expectedRestoredSidebarWidth = Math.round(Math.min(460, Math.max(220, sidebarPreference * secondWindow.innerWidth / 1280)))

    if (restored.composerDraft !== COMPOSER_DRAFT) throw new Error('composer draft was not restored')
    if (!restored.conversationCollapsed) throw new Error('conversation section state was not restored')
    if (!restored.projectCollapsed) throw new Error('project section state was not restored')
    if (restored.sidebarWidth !== String(expectedRestoredSidebarWidth)) {
      throw new Error(`sidebar width was not restored: ${restored.sidebarWidth} !== ${expectedRestoredSidebarWidth}`)
    }
    if (!restored.settingsOpen || !restored.activeSettingsPage.includes('浏览器')) {
      throw new Error(`settings route was not restored: ${JSON.stringify(restored)}`)
    }
    if (restored.persisted?.composerDraft !== COMPOSER_DRAFT || restored.persisted?.route?.page !== 'browser') {
      throw new Error(`persisted application shell snapshot is incomplete: ${JSON.stringify(restored.persisted)}`)
    }
    const restoredNavigator = restored.workspaceLayouts?.[workspaceLayoutKey]
    const restoredNavigatorWidth = navigatorResize.kind === 'review'
      ? restoredNavigator?.reviewNavigatorWidth
      : restoredNavigator?.fileNavigatorWidth
    if (restoredNavigatorWidth !== navigatorResize.width) {
      throw new Error(`navigator width snapshot was not restored: ${JSON.stringify(restored.workspaceLayouts)}`)
    }
    assertGeometryNear(secondWindow, firstWindow, 'restored native window')

    const renderedNavigatorWidth = await revealWorkspaceAndReadNavigatorWidth(client)
    if (renderedNavigatorWidth !== navigatorResize.width) {
      throw new Error(`navigator rendered at ${renderedNavigatorWidth}, expected ${navigatorResize.width}`)
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
        sidebarWidth: expectedRestoredSidebarWidth,
        chatReadingPosition,
        navigatorResize,
        settingsPage: 'browser',
        nativeWindow: true,
        observableActivity: activityEvidence,
        leanHarness: leanHarnessEvidence,
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
    await provider.close().catch(() => undefined)
    if (!preserve) await rm(root, { recursive: true, force: true })
  }
}

async function verifyLeanBoundedExecution(client, provider) {
  const before = provider.requests.length
  // Start a fresh conversation first. The acceptance Provider only answers with a tool
  // call while its transcript still has no tool result, so reusing the previous
  // fixture's session would be answered directly and this fixture could observe no tool
  // activity at all — it would then fail on the fixture's own state, not on the product.
  const startedConversation = await client.evaluate(`(() => {
    const button = document.querySelector('.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`)
  if (!startedConversation) throw new Error('lean Harness fixture could not start a new conversation')
  await waitFor(
    () => client.evaluate(`document.querySelectorAll('.assistant-turn').length === 0 || null`),
    START_TIMEOUT_MS,
    'empty transcript for the lean fixture',
  )
  const submitted = await client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, '请使用 glob 工具列出当前工作区顶层条目')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('lean Harness fixture could not submit the composer')
  const rendered = await waitFor(() => client.evaluate(`(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream[data-stream-state="settled"]')
    if (!response?.textContent?.trim()) return null
    const rows = [...turn.querySelectorAll('.agent-flow-row')]
    return {
      text: response.textContent.trim(),
      // Tool rows are titled in the user's language ("搜索" for glob), so the row class is
      // the stable identity; matching the raw tool name in the text checked a translation.
      toolRows: rows.filter((row) => row.classList.contains('agent-tool-row')).length,
    }
  })()`), START_TIMEOUT_MS, 'lean bounded execution')
  const requests = provider.requests.slice(before)
  const decideRequests = requests.filter((request) => request.messages.some((message) => (
    String(message.content).includes('You are the DECIDE stage')
  )))
  const toolRequests = requests.filter((request) => request.tools.includes('glob'))
  if (decideRequests.length !== 0) {
    throw new Error(`ordinary bounded execution made ${decideRequests.length} DECIDE request(s)`)
  }
  if (toolRequests.length < 1 || rendered.toolRows < 1) {
    throw new Error(`bounded tool activity was not observable: ${JSON.stringify({ requests, rendered })}`)
  }
  if (toolRequests.some((request) => request.stream !== true)) {
    throw new Error('durable harness tool-loop requests were not streamed')
  }
  return {
    providerRequests: requests.length,
    decideRequests: decideRequests.length,
    streamedRequests: requests.filter((request) => request.stream).length,
    toolRequests: toolRequests.length,
    renderedToolRows: rendered.toolRows,
  }
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Electron Acceptance', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 30, models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/slow-a',
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
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function verifyObservableActivityStream(client) {
  const submitted = await client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, '请简短确认已收到这条流式验收消息。')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const startedAt = performance.now()
    window.__lsActivityProbeStartedAt = startedAt
    window.__lsActivityProbe = { localRequestMs: null }
    window.__lsActivityObserver?.disconnect()
    window.__lsActivityObserver = new MutationObserver(() => {
      const turn = document.querySelector('.assistant-turn.running')
      if (turn?.textContent?.includes('请求已发出') && window.__lsActivityProbe.localRequestMs === null) {
        window.__lsActivityProbe.localRequestMs = performance.now() - startedAt
      }
    })
    window.__lsActivityObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('observable activity fixture could not submit the composer')

  const localFeedback = await waitFor(() => client.evaluate(`(() => {
    const elapsedMs = window.__lsActivityProbe?.localRequestMs
    return typeof elapsedMs === 'number' ? { elapsedMs } : null
  })()`), START_TIMEOUT_MS, 'local request activity')
  const modelFeedback = await waitFor(() => client.evaluate(`(() => {
    const turn = document.querySelector('.assistant-turn.running')
    if (!turn?.textContent?.includes('模型正在')) return null
    return { elapsedMs: performance.now() - window.__lsActivityProbeStartedAt, text: turn.textContent }
  })()`), START_TIMEOUT_MS, 'real model activity')
  const partial = await waitFor(() => client.evaluate(`(() => {
    const response = document.querySelector('.assistant-response-stream[data-stream-state="streaming"]')
    const text = response?.textContent?.trim() ?? ''
    return text.length >= 6 && text.length < 30 ? { text, elapsedMs: performance.now() - window.__lsActivityProbeStartedAt } : null
  })()`), START_TIMEOUT_MS, 'partial streamed reply')
  const settled = await waitFor(() => client.evaluate(`(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream[data-stream-state="settled"]')
    const system = turn?.querySelector('.agent-transcript-reasoning.system')
    if (!response?.textContent?.trim() || !(system instanceof HTMLElement)) return null
    const targetRows = [...turn.querySelectorAll('.agent-flow-row')]
    return {
      text: response.textContent.trim(),
      systemPromptCharacters: system.querySelector('.agent-transcript-details')?.textContent?.length ?? 0,
      targetRows: targetRows.length,
      svgRows: targetRows.filter((row) => row.querySelector('svg')).length,
    }
  })()`), START_TIMEOUT_MS, 'settled streamed reply')
  if (settled.targetRows > 0 && settled.svgRows !== settled.targetRows) {
    throw new Error(`observable activity rows are not all SVG-backed: ${JSON.stringify(settled)}`)
  }
  await client.evaluate(`window.__lsActivityObserver?.disconnect()`)
  return {
    localFeedbackMs: Math.round(localFeedback.elapsedMs),
    modelFeedbackMs: Math.round(modelFeedback.elapsedMs),
    partialReplyCharacters: partial.text.length,
    partialBeforeSettlement: partial.text !== settled.text,
    systemPromptCharacters: settled.systemPromptCharacters,
    svgRows: settled.svgRows,
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
    return values.find((candidate) => candidate.type === 'page'
      && candidate.webSocketDebuggerUrl
      && candidate.url
      && !candidate.url?.startsWith('data:text/html'))
  }, START_TIMEOUT_MS, 'renderer debug target')
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.enableRuntime()
  await waitFor(async () => {
    try {
      return await client.evaluate(`Boolean(document.querySelector('.composer textarea') && document.querySelector('.sidebar-resizer'))`)
    } catch {
      // The startup page and the renderer share a WebContents. Navigation can
      // replace the execution context between target discovery and evaluation.
      return undefined
    }
  }, START_TIMEOUT_MS, 'renderer UI context')
  return client
}

async function waitForRendererReady(client) {
  await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.composer textarea') && document.querySelector('.sidebar-resizer'))`), START_TIMEOUT_MS, 'renderer UI')
}

async function readWindowGeometry(client) {
  return client.evaluate(`({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight, innerWidth: window.innerWidth })`)
}

/**
 * UX-19: two readers, two anchors, measured in the real window.
 *
 * A bottom-pinned reader is anchored to the bottom edge, so a viewport height change
 * must leave the gap at ~0. A reader who scrolled up is anchored to the message they
 * are reading: its position on screen must not move. The check this replaced compared
 * only the bottom gap, which is exactly the arithmetic that moved a reading user by
 * the viewport delta — it would now pass on the bug and fail on the fix.
 */
async function verifyChatReadingPosition(client) {
  const result = await client.evaluate(`(async () => {
    const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
    const settle = async (frames) => { for (let index = 0; index < frames; index += 1) await raf() }
    const messages = document.querySelector('.messages')
    const content = document.querySelector('.messages-content')
    const chat = document.querySelector('.chat')
    if (!(messages instanceof HTMLElement) || !(content instanceof HTMLElement)) return null

    const probe = document.createElement('div')
    probe.dataset.messageKey = 'reading-position-fixture'
    probe.style.height = '2400px'
    probe.style.pointerEvents = 'none'
    content.append(probe)
    const originalFlex = messages.style.flex
    const originalChatFlex = chat instanceof HTMLElement ? chat.style.flex : ''
    messages.style.flex = '0 0 480px'

    const viewportTop = () => messages.getBoundingClientRect().top
    const gap = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight
    const anchorTop = () => probe.getBoundingClientRect().top - viewportTop()
    const jumpButton = () => document.querySelector('.chat-jump-to-latest')
    const visibleKey = () => {
      const height = messages.clientHeight
      for (const element of messages.querySelectorAll('[data-message-key]')) {
        const bounds = element.getBoundingClientRect()
        const top = bounds.top - viewportTop()
        if (bounds.bottom - viewportTop() > 0 && top < height) return element.getAttribute('data-message-key')
      }
      return null
    }
    const scrollTo = (top) => {
      messages.scrollTop = top
      // A programmatic scrollTop assignment does not reliably emit a native scroll
      // event in every Electron/Chromium build, and the renderer learns the reader's
      // position from that event.
      messages.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    const waitFor = async (predicate, timeoutMs) => {
      const startedAt = performance.now()
      while (performance.now() - startedAt < timeoutMs) {
        if (predicate()) return true
        await raf()
      }
      return false
    }

    try {
      // Reading reader: put the fixture at the viewport top and register the position.
      scrollTo(probe.offsetTop + 520)
      const readingRegistered = await waitFor(() => jumpButton() !== null, 2000)
      await settle(3)
      const readingGapBefore = gap()
      const readingAnchorTopBefore = anchorTop()
      const readingAnchorKey = visibleKey()

      // Viewport height change (composer growth, window resize) while reading.
      messages.style.flexBasis = '360px'
      await settle(5)
      const readingGapAfterResize = gap()
      const readingAnchorTopAfterResize = anchorTop()

      // Width reflow (workspace panel drag) while reading: the same message stays put.
      if (chat instanceof HTMLElement) chat.style.flex = '0 0 620px'
      await settle(6)
      const readingGapAfterReflow = gap()
      const readingAnchorTopAfterReflow = anchorTop()
      const readingAnchorKeyAfterReflow = visibleKey()
      if (chat instanceof HTMLElement) chat.style.flex = originalChatFlex
      await settle(4)

      // Reachable way back to the newest message.
      const jumpButtonRendered = jumpButton() !== null
      jumpButton()?.click()
      const returnedToBottom = await waitFor(() => gap() <= 1, 2000)
      await settle(3)
      const gapAfterReturn = gap()
      const jumpButtonHiddenAfterReturn = jumpButton() === null

      // Pinned reader: the bottom edge is its anchor, so it must stay at the bottom.
      scrollTo(messages.scrollHeight)
      await settle(3)
      const pinnedGapBefore = gap()
      messages.style.flexBasis = '420px'
      await settle(5)
      const pinnedGapAfter = gap()

      return {
        readingRegistered,
        readingAnchorKey,
        readingAnchorTopBefore,
        readingAnchorTopAfterResize,
        readingAnchorTopAfterReflow,
        readingAnchorKeyAfterReflow,
        readingGapBefore,
        readingGapAfterResize,
        readingGapAfterReflow,
        jumpButtonRendered,
        returnedToBottom,
        gapAfterReturn,
        jumpButtonHiddenAfterReturn,
        pinnedGapBefore,
        pinnedGapAfter,
      }
    } finally {
      probe.remove()
      messages.style.flex = originalFlex
      if (chat instanceof HTMLElement) chat.style.flex = originalChatFlex
    }
  })()`)
  if (!result) throw new Error('chat reading position fixture could not attach to the transcript')
  const moved = (before, after) => Math.abs(after - before)
  if (!result.readingRegistered) {
    throw new Error(`reading position was never registered: ${JSON.stringify(result)}`)
  }
  if (moved(result.readingAnchorTopBefore, result.readingAnchorTopAfterResize) > 1) {
    throw new Error(`viewport resize moved the message being read: ${JSON.stringify(result)}`)
  }
  if (moved(result.readingAnchorTopBefore, result.readingAnchorTopAfterReflow) > 2) {
    throw new Error(`width reflow moved the message being read: ${JSON.stringify(result)}`)
  }
  if (moved(result.readingGapBefore, result.readingGapAfterResize) < 60) {
    // The old contract preserved this gap; preserving it is the defect.
    throw new Error(`reading gap was preserved across the resize: ${JSON.stringify(result)}`)
  }
  if (!result.jumpButtonRendered || !result.returnedToBottom || !result.jumpButtonHiddenAfterReturn) {
    throw new Error(`the way back to the newest message did not work: ${JSON.stringify(result)}`)
  }
  if (result.gapAfterReturn > 1) {
    throw new Error(`returning to the bottom did not reach the bottom: ${JSON.stringify(result)}`)
  }
  if (result.pinnedGapAfter > 1) {
    throw new Error(`a pinned chat left the bottom: ${JSON.stringify(result)}`)
  }
  return result
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
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width, kind: resizer.closest('.workspace-review') ? 'review' : 'file' }
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
  // Which width this drag wrote depends on the tab that owns the visible navigator:
  // the review tab has had its own persisted width since UX-18, and the restore
  // assertions below must read the same field the drag actually changed.
  return { width: resized.width, kind: initial.kind }
}

async function revealWorkspaceAndReadNavigatorWidth(client) {
  await client.evaluate(`document.querySelector('.settings-entry-btn')?.click()`)
  // Settings uses a keep-mounted presence layer. Closing it does not remove
  // the workspace node; wait for the authoritative hidden phase instead.
  await waitFor(async () => client.evaluate(`document.querySelector('.settings-presence')?.classList.contains('presence-hidden') || null`), START_TIMEOUT_MS, 'restored workspace route')
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
    this.defaultExecutionContext = undefined
    this.defaultExecutionContextReady = new Promise((resolvePromise) => {
      this.resolveDefaultExecutionContext = resolvePromise
    })
    this.socket = new WebSocket(url)
    this.opened = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context
        if (context?.auxData?.isDefault || context?.name === '') {
          this.defaultExecutionContext = context.id
          this.resolveDefaultExecutionContext?.(context.id)
        }
        return
      }
      if (message.method === 'Runtime.executionContextsCleared') {
        this.defaultExecutionContext = undefined
        return
      }
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  async enableRuntime() {
    await this.send('Runtime.enable')
  }

  async waitForDefaultExecutionContext() {
    if (this.defaultExecutionContext !== undefined) return this.defaultExecutionContext
    return this.defaultExecutionContextReady
  }

  async send(method, params = {}) {
    await this.opened
    const id = this.nextId++
    const response = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return response
  }

  async evaluate(expression) {
    await this.waitForDefaultExecutionContext()
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(this.defaultExecutionContext === undefined ? {} : { contextId: this.defaultExecutionContext }),
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed')
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

await main()
