import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const locatorRelativePath = join('runtime', 'local-app-api.json')
const startTimeoutMs = 60_000
const actionTimeoutMs = 20_000
const idleSampleMs = 5_000
// Keep this aligned with the renderer directory cache contract. The benchmark
// intentionally waits past the TTL so the next mount exercises stale-while-
// revalidate instead of only measuring a hot cache hit.
const workspaceDirectoryCacheTtlMs = 5_000
const profileMainProcess = process.env.LITTLESHEEP_PROFILE_MAIN === '1'
const diagnoseIdleBaseline = process.env.LITTLESHEEP_IDLE_BASELINE === '1'

const budgets = {
  startupProcessToLocatorMs: 15_000,
  startupLocatorToWindowVisibleMs: 10_000,
  workspaceFirstFrameColdMs: 1_500,
  rootFileTreeColdMs: 500,
  rootFileTreeWarmMs: 100,
  staleWorkspaceTreeVisibleMs: 100,
  workspaceTabRevisitMs: 500,
  firstColouredFrameColdMs: 1_500,
  monacoReadyColdMs: 4_000,
  monacoReadyWarmMs: 250,
  monacoInkColdMs: 4_500,
  monacoInkWarmMs: 500,
  reviewTreeColdMs: 1_500,
  reviewTreeWarmMs: 250,
  reviewDiffColdMs: 1_500,
  hiddenCpuMs: 250,
  hiddenIoBytes: 1024 * 1024,
}

async function main() {
  await assertAppBuildFresh(repoRoot)
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-workspace-performance-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workspaceDir = join(root, 'workspace')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await reservePort()
  const mainDebuggingPort = profileMainProcess ? await reservePort() : undefined
  let electron
  let client
  let mainClient
  let preserve = false

  try {
    await prepareFixture(dataDir, chromiumDir, workspaceDir)
    electron = await startElectron({ dataDir, chromiumDir, debuggingPort, mainDebuggingPort, logPath })
    const processCreatedAt = Date.now()
    const locator = await waitForLocator(dataDir, electron.pid)
    const locatorReadyAt = Date.now()
    const windowWaitStartedAt = locatorReadyAt
    await waitForDesktop(locator)
    const windowVisibleAt = Date.now()
    client = await connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    if (mainDebuggingPort) mainClient = await connectDebugger(mainDebuggingPort, 'Main inspector target')

    await seedPreferences(client, workspaceDir, 'review')
    await reloadRenderer(client, 'review workspace reload')
    const workspaceFrameCold = await measureVisible(client, '.workspace-panel', 0, actionTimeoutMs)
    const reviewCold = await measureVisible(client, '.workspace-review-tree-row.file', 0, actionTimeoutMs)
    const reviewDiffCold = await measureVisible(
      client,
      '.workspace-review-monaco-diff .monaco-diff-editor',
      reviewCold.visibleAt,
      actionTimeoutMs,
    )
    const reviewEditorContract = await readReviewEditorContract(client)
    const reviewPersistenceContract = await verifyReviewPersistence(client)
    const reviewWarm = await measureReviewWarm(client)

    await seedPreferences(client, workspaceDir, 'artifacts')
    await reloadRenderer(client, 'file tree workspace reload')
    const fileTreeCold = await measureVisible(client, '.workspace-tree-row', 0, actionTimeoutMs)
    const fileTreeWarm = await measureFileTreeWarm(client)
    const staleWorkspaceTree = await measureFileTreeStale(client)

    const editorCold = await measureEditorCold(client, workspaceDir)
    const editorWarm = await measureEditorWarm(client, workspaceDir)
    const fontContract = editorCold.fontContract ?? editorWarm.fontContract
    const fontAssertions = evaluateFontContract(fontContract)
    const rendererDiagnostics = summarizeRendererDiagnostics(client.events)
    // The DevTools transport exists only for this benchmark's visual probes.
    // Disconnect it before the hidden-window interval so Main is measured in
    // the same state as a normal desktop session without an attached debugger.
    client.close()
    client = undefined
    const resourcesBeforeHidden = await desktopSnapshot(locator)
    await desktopAction(locator, 'close')
    await delay(1_000)
    const hiddenStart = await desktopSnapshot(locator)
    const hiddenProcessStart = processTreeSample(electron.pid)
    await delay(idleSampleMs)
    const hiddenProcessEnd = processTreeSample(electron.pid)
    const hiddenProcessBreakdown = hiddenProcessDiagnostics(hiddenProcessStart, hiddenProcessEnd)
    const hiddenStableStart = await desktopSnapshot(locator)
    const hiddenStableProcessStart = processTreeSample(electron.pid)
    if (mainClient) {
      await mainClient.send('Profiler.enable')
      await mainClient.send('Profiler.start')
    }
    await delay(idleSampleMs)
    const mainProfile = mainClient
      ? summarizeCpuProfile((await mainClient.send('Profiler.stop')).profile)
      : undefined
    const hiddenStableProcessEnd = processTreeSample(electron.pid)
    // Keep the acceptance sampler itself outside the idle CPU interval. The
    // endpoint gathers Electron process metrics and would otherwise make the
    // diagnostic look like hidden-window work.
    const hiddenStableEnd = await desktopSnapshot(locator)
    const hiddenStableProcessBreakdown = hiddenProcessDiagnostics(hiddenStableProcessStart, hiddenStableProcessEnd)
    const bootstrapTimings = await readBootstrapTimings(logPath)

    const measurements = {
      startupProcessToLocatorMs: roundMs(locatorReadyAt - processCreatedAt),
      startupLocatorToWindowVisibleMs: roundMs(windowVisibleAt - windowWaitStartedAt),
      workspaceFirstFrameColdMs: workspaceFrameCold.elapsedMs,
      rootFileTreeColdMs: fileTreeCold.elapsedMs,
      rootFileTreeWarmMs: fileTreeWarm,
      staleWorkspaceTreeVisibleMs: staleWorkspaceTree.visibleMs,
      workspaceTabRevisitMs: editorWarm.workspaceTabRevisitMs,
      firstColouredFrameColdMs: editorCold.firstColouredFrameMs,
      monacoReadyColdMs: editorCold.monacoReadyMs,
      monacoReadyWarmMs: editorWarm.monacoReadyMs,
      monacoInkColdMs: editorCold.monacoInkMs,
      monacoInkWarmMs: editorWarm.monacoInkMs,
      reviewTreeColdMs: reviewCold.elapsedMs,
      reviewTreeWarmMs: reviewWarm,
      reviewDiffColdMs: reviewDiffCold.elapsedMs,
      // The stable interval is the product budget. The first interval is
      // retained as a diagnostic because close-to-background may still flush
      // one-shot state immediately after the window is hidden.
      hiddenCpuMs: hiddenStableProcessBreakdown.totals.cpuMs,
      hiddenIoBytes: hiddenStableProcessBreakdown.totals.ioBytes,
    }
    const assertions = Object.fromEntries(Object.entries(measurements).map(([name, value]) => [
      name,
      { ok: value <= budgets[name], value, budget: budgets[name] },
    ]))
    const hiddenResources = resourceDelta(hiddenStableStart, hiddenStableEnd, idleSampleMs)
    const ok = Object.values(assertions).every((assertion) => assertion.ok)
      && Object.values(fontAssertions).every((assertion) => assertion.ok)
      && staleWorkspaceTree.visibleBeforeRevalidation
      && staleWorkspaceTree.requestObserved
      && reviewEditorContract.syntaxColourCount >= 3
      && reviewEditorContract.hasInsertedBackground
      && reviewEditorContract.hasRemovedBackground
      && Object.values(reviewPersistenceContract).every(Boolean)
      && editorCold.monacoInk.hasInk
      && editorWarm.monacoInk.hasInk
      && rendererDiagnostics.unknownServiceErrors.length === 0
      && hiddenResources.activeRequestDelta <= 0
      && hiddenResources.activeHandleDelta <= 1
      && hiddenResources.workingSetDeltaBytes <= 32 * 1024 * 1024

    console.log(JSON.stringify({
      check: 'workspace-performance',
      ok,
      measurements,
      budgets,
      assertions,
      startup: {
        processCreatedAt,
        locatorReadyAt,
        windowVisibleAt,
        bootstrapTimings,
      },
      staleWorkspaceTree,
      fontContract,
      fontAssertions,
      monacoPixels: {
        cold: editorCold.monacoInk,
        warm: editorWarm.monacoInk,
      },
      reviewEditorContract,
      reviewPersistenceContract,
      rendererDiagnostics,
      resourcesBeforeHidden,
      hiddenResources,
      hiddenDiagnostics: {
        closing: hiddenProcessBreakdown,
        stable: hiddenStableProcessBreakdown,
        ...(mainProfile ? { mainProfile } : {}),
      },
      outputBytes: await directoryBytes(join(appRoot, 'out')),
    }, null, 2))
    if (!ok) process.exitCode = 1
  } catch (error) {
    preserve = true
    const bootstrapTimings = await readBootstrapTimings(logPath).catch(() => [])
    console.error(JSON.stringify({
      check: 'workspace-performance',
      ok: false,
      root,
      logPath,
      bootstrapTimings,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }, null, 2))
    process.exitCode = 1
  } finally {
    client?.close()
    mainClient?.close()
    if (electron?.exitCode === null) await forceTerminate(electron)
    if (!preserve) await removeTemporaryRoot(root)
  }
}

async function prepareFixture(dataDir, chromiumDir, workspaceDir) {
  await Promise.all([
    mkdir(join(dataDir, 'config'), { recursive: true }),
    mkdir(chromiumDir, { recursive: true }),
    mkdir(join(workspaceDir, 'src'), { recursive: true }),
  ])
  await writeFile(join(workspaceDir, 'src', 'sample.ts'), [
    'export interface Sample {',
    '  id: number',
    '  label: string',
    '}',
    '',
    'export function describe(sample: Sample): string {',
    '  return `${sample.id}: ${sample.label}`',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(workspaceDir, 'README.md'), '# Workspace performance fixture\n', 'utf8')
  runGit(workspaceDir, ['init', '--initial-branch=main'])
  runGit(workspaceDir, ['config', 'user.email', 'workspace-performance@example.invalid'])
  runGit(workspaceDir, ['config', 'user.name', 'Workspace Performance'])
  runGit(workspaceDir, ['add', '.'])
  runGit(workspaceDir, ['commit', '-m', 'fixture'])
  await writeFile(join(workspaceDir, 'src', 'sample.ts'), [
    'export interface Sample {',
    '  id: number',
    '  label: string',
    '  active: boolean',
    '}',
    '',
    'export function describe(sample: Sample): string {',
    '  const state = sample.active ? "active" : "idle"',
    '  return `${sample.id}: ${sample.label} (${state})`',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(workspaceDir, 'src', 'untracked.ts'), 'export const untracked = true\n', 'utf8')
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')
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

async function startElectron({ dataDir, chromiumDir, debuggingPort, mainDebuggingPort, logPath }) {
  const executable = resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true })
  const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath, { flags: 'a' }))
  const env = {
    ...process.env,
    LITTLESHEEP_DATA_DIR: dataDir,
    LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
    LITTLESHEEP_BOOTSTRAP_TIMING: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [
    '.',
    `--user-data-dir=${chromiumDir}`,
    ...(debuggingPort ? [`--remote-debugging-port=${debuggingPort}`] : []),
    ...(mainDebuggingPort ? [`--inspect=${mainDebuggingPort}`] : []),
  ], {
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
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
    if (!response?.ok) return undefined
    const values = await response.json()
    return values.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  }, startTimeoutMs, 'renderer debug target')
  return new CdpClient(targets.webSocketDebuggerUrl)
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

class CdpClient {
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed')
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

function summarizeRendererDiagnostics(events) {
  const messages = events.flatMap((event) => {
    if (event.method === 'Runtime.consoleAPICalled') {
      return [event.params?.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ') ?? '']
    }
    if (event.method === 'Runtime.exceptionThrown') {
      return [
        event.params?.exceptionDetails?.exception?.description
          ?? event.params?.exceptionDetails?.text
          ?? '',
      ]
    }
    if (event.method === 'Log.entryAdded') return [event.params?.entry?.text ?? '']
    return []
  }).filter(Boolean)
  return {
    observedEventCount: events.length,
    unknownServiceErrors: [...new Set(messages.filter((message) =>
      /depends on UNKNOWN service|Missing service /u.test(message),
    ))].slice(0, 20),
  }
}

async function seedPreferences(client, workspaceDir, tab) {
  const filePath = join(workspaceDir, 'src', 'sample.ts')
  const preferences = {
    'littlesheep.ui.workspacePanelCollapsed': 'false',
    'littlesheep.ui.workspacePanelFullscreen': 'false',
    'littlesheep.ui.workspacePanelTab': tab,
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([tab]),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspacePanelOpenPath': filePath,
    'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
    'littlesheep.ui.workspaceReviewSideBySide': 'true',
  }
  await client.evaluate(`(() => {
    const values = ${JSON.stringify(preferences)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    localStorage.removeItem('littlesheep.ui.workspaceFileDrafts');
    return true;
  })()`)
}

async function measureVisible(client, selector, start, timeoutMs) {
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

async function reloadRenderer(client, label) {
  const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
  await client.send('Page.reload', { ignoreCache: true })
  return waitFor(async () => {
    const state = await client.evaluate(`(() => ({
      readyState: document.readyState,
      timeOrigin: performance.timeOrigin,
    }))()`).catch(() => undefined)
    if (!state) return undefined
    return state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin
      ? state.timeOrigin
      : undefined
  }, actionTimeoutMs, label)
}

async function measureFileTreeWarm(client) {
  await client.evaluate(`document.querySelector('.workspace-panel-corner-toggle')?.click()`)
  await waitFor(async () => await client.evaluate("document.querySelector('.workspace-panel')?.classList.contains('collapsed') || null"), actionTimeoutMs, 'workspace collapse')
  const start = await client.evaluate('performance.now()')
  await client.evaluate(`document.querySelector('.workspace-panel-reopen-target')?.click()`)
  return (await measureVisible(client, '.workspace-tree-row', start, actionTimeoutMs)).elapsedMs
}

async function measureFileTreeStale(client) {
  // Let the short-lived directory entry expire, then remount the navigator.
  // The fetch probe tells us that a refresh really happened and adds a small,
  // benchmark-only response delay. The cached row must remain visible while
  // that request is still pending to prove stale-while-revalidate behavior.
  await delay(workspaceDirectoryCacheTtlMs + 250)
  await client.evaluate(`document.querySelector('.workspace-panel-corner-toggle')?.click()`)
  await waitFor(async () => await client.evaluate("document.querySelector('.workspace-panel')?.classList.contains('collapsed') || null"), actionTimeoutMs, 'workspace collapse before stale probe')
  await installWorkspaceFetchProbe(client)
  await resetWorkspaceFetchProbe(client)
  const start = await client.evaluate('performance.now()')
  await client.evaluate(`document.querySelector('.workspace-panel-reopen-target')?.click()`)
  const visible = await measureVisible(client, '.workspace-tree-row', start, actionTimeoutMs)
  const request = await waitFor(async () => {
    const probe = await readWorkspaceFetchProbe(client)
    return probe.workspaceListStart !== null ? probe : undefined
  }, actionTimeoutMs, 'stale workspace directory refresh')
  const completed = await waitFor(async () => {
    const probe = await readWorkspaceFetchProbe(client)
    return probe.workspaceListPending === 0 && probe.workspaceListEnd !== null ? probe : undefined
  }, actionTimeoutMs, 'stale workspace directory refresh completion')
  return {
    visibleMs: visible.elapsedMs,
    requestMs: roundMs(request.workspaceListStart - start),
    revalidatedMs: roundMs(completed.workspaceListEnd - start),
    visibleBeforeRevalidation: visible.visibleAt <= completed.workspaceListEnd + 1,
    requestObserved: request.workspaceListCount > 0,
    requestCount: request.workspaceListCount,
  }
}

async function measureReviewWarm(client) {
  await client.evaluate(`document.querySelector('.workspace-panel-corner-toggle')?.click()`)
  await waitFor(async () => await client.evaluate("document.querySelector('.workspace-panel')?.classList.contains('collapsed') || null"), actionTimeoutMs, 'workspace collapse')
  const start = await client.evaluate('performance.now()')
  await client.evaluate(`document.querySelector('.workspace-panel-reopen-target')?.click()`)
  return (await measureVisible(client, '.workspace-review-tree-row.file', start, actionTimeoutMs)).elapsedMs
}

async function readReviewEditorContract(client) {
  return waitFor(async () => {
    const contract = await client.evaluate(`(() => {
      const root = document.querySelector('.workspace-review-monaco-diff .monaco-diff-editor')
      if (!root) return null
      const visibleStyles = (selector, property) => Array.from(root.querySelectorAll(selector))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map((element) => getComputedStyle(element)[property])
        .filter((value) => value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent')
      const syntaxColours = new Set(visibleStyles('.view-line span', 'color'))
      const insertedBackgrounds = new Set(visibleStyles('.line-insert, .char-insert', 'backgroundColor'))
      const removedBackgrounds = new Set(visibleStyles('.line-delete, .char-delete', 'backgroundColor'))
      return {
        diffEditorCount: root.querySelectorAll('.editor.modified, .editor.original').length,
        syntaxColours: [...syntaxColours],
        insertedBackgrounds: [...insertedBackgrounds],
        removedBackgrounds: [...removedBackgrounds],
      }
    })()`)
    if (
      !contract
      || contract.syntaxColours.length < 3
      || contract.insertedBackgrounds.length === 0
      || contract.removedBackgrounds.length === 0
    ) return undefined
    return {
      diffEditorCount: contract.diffEditorCount,
      syntaxColourCount: contract.syntaxColours.length,
      syntaxColours: contract.syntaxColours,
      hasInsertedBackground: true,
      insertedBackgrounds: contract.insertedBackgrounds,
      hasRemovedBackground: true,
      removedBackgrounds: contract.removedBackgrounds,
    }
  }, actionTimeoutMs, 'Monaco review syntax and red/green diff surfaces')
}

async function verifyReviewPersistence(client) {
  await client.evaluate(`(() => {
    document.querySelector('.workspace-review-diff-actions [aria-pressed]')?.click();
    document.querySelector('.workspace-files-navigator-rail')?.click();
    return true;
  })()`)
  await waitForReviewPreferenceState(client, false, true)
  await reloadRenderer(client, 'single-column review preference reload')
  const singleColumn = await waitForReviewPreferenceState(client, false, true)

  await client.evaluate(`(() => {
    document.querySelector('.workspace-review-diff-actions [aria-pressed]')?.click();
    document.querySelector('.workspace-files-navigator-rail')?.click();
    return true;
  })()`)
  await waitForReviewPreferenceState(client, true, false)
  await reloadRenderer(client, 'side-by-side review preference reload')
  const sideBySide = await waitForReviewPreferenceState(client, true, false)

  return {
    singleColumnAfterReload: singleColumn.sideBySide === false,
    navigatorCollapsedAfterReload: singleColumn.navigatorCollapsed === true,
    sideBySideAfterReload: sideBySide.sideBySide === true,
    navigatorExpandedAfterReload: sideBySide.navigatorCollapsed === false,
  }
}

async function waitForReviewPreferenceState(client, sideBySide, navigatorCollapsed) {
  return waitFor(async () => {
    const state = await client.evaluate(`(() => {
      const layout = document.querySelector('.workspace-review-diff-actions [aria-pressed]');
      const navigator = document.querySelector('.workspace-files-navigator');
      if (!layout || !navigator) return null;
      return {
        sideBySide: layout.getAttribute('aria-pressed') === 'true',
        navigatorCollapsed: navigator.getAttribute('aria-expanded') === 'false',
        storedSideBySide: localStorage.getItem('littlesheep.ui.workspaceReviewSideBySide'),
        storedNavigatorCollapsed: localStorage.getItem('littlesheep.ui.workspaceFileNavigatorCollapsed'),
      };
    })()`)
    if (
      !state
      || state.sideBySide !== sideBySide
      || state.navigatorCollapsed !== navigatorCollapsed
      || state.storedSideBySide !== String(sideBySide)
      || state.storedNavigatorCollapsed !== String(navigatorCollapsed)
    ) return undefined
    return state
  }, actionTimeoutMs, 'review layout persistence state')
}

async function measureEditorCold(client, workspaceDir) {
  const filePath = join(workspaceDir, 'src', 'sample.ts')
  const tab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  await client.evaluate(`(() => {
    localStorage.setItem('littlesheep.ui.workspacePanelCollapsed', 'false');
    localStorage.setItem('littlesheep.ui.workspacePanelTab', ${JSON.stringify(tab)});
    localStorage.setItem('littlesheep.ui.workspacePanelOpenTabs', JSON.stringify(['review', ${JSON.stringify(tab)}]));
    localStorage.setItem('littlesheep.ui.workspacePanelOpenRoot', ${JSON.stringify(workspaceDir)});
    localStorage.setItem('littlesheep.ui.workspacePanelOpenPath', ${JSON.stringify(filePath)});
  })()`)
  await reloadRenderer(client, 'cold editor reload')
  const start = 0
  const coloured = await measureMonacoSyntaxColours(client, start, actionTimeoutMs)
  const fontContract = await readFontContract(client)
  const monaco = await measureVisible(client, '.monaco-editor', start, actionTimeoutMs)
  const monacoInk = await measureMonacoInk(client, start, actionTimeoutMs)
  return {
    firstColouredFrameMs: coloured.elapsedMs,
    monacoReadyMs: monaco.elapsedMs,
    monacoInkMs: monacoInk.elapsedMs,
    monacoInk,
    fontContract,
  }
}

async function measureEditorWarm(client, workspaceDir) {
  const filePath = join(workspaceDir, 'src', 'sample.ts')
  await client.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    tabs.find((element) => element.textContent?.includes('审阅'))?.click();
  })()`)
  await measureVisible(client, '.workspace-review', 0, actionTimeoutMs)
  const start = await client.evaluate('performance.now()')
  await client.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    tabs.find((element) => element.textContent?.includes('sample.ts'))?.click();
  })()`)
  const firstFrame = await measureVisible(client, '.workspace-editor-monaco .monaco-editor', start, actionTimeoutMs)
  const monaco = await measureVisible(client, '.monaco-editor', start, actionTimeoutMs)
  const monacoInk = await measureMonacoInk(client, start, actionTimeoutMs)
  return {
    monacoReadyMs: monaco.elapsedMs,
    monacoInkMs: monacoInk.elapsedMs,
    monacoInk,
    workspaceTabRevisitMs: firstFrame.elapsedMs,
    fontContract: await readFontContract(client),
    filePath,
  }
}

async function measureMonacoSyntaxColours(client, start, timeoutMs) {
  const visibleAt = await waitFor(async () => {
    const result = await client.evaluate(`(() => {
      const root = document.querySelector('.workspace-editor-monaco .monaco-editor')
      if (!root) return null
      const colours = new Set(Array.from(root.querySelectorAll('.view-line span'))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map((element) => getComputedStyle(element).color)
        .filter(Boolean))
      return colours.size >= 3 ? performance.now() : null
    })()`)
    return typeof result === 'number' ? result : undefined
  }, timeoutMs, 'Monaco editor syntax colours')
  return { visibleAt, elapsedMs: roundMs(visibleAt - start) }
}

async function installWorkspaceFetchProbe(client) {
  await client.evaluate(`(() => {
    const marker = '__littlesheepWorkspacePerformanceFetchProbe'
    if (window[marker]?.installed) return true
    const originalFetch = window.fetch.bind(window)
    const probe = {
      installed: true,
      responseDelayMs: 250,
      workspaceListCount: 0,
      workspaceListPending: 0,
      workspaceListStart: null,
      workspaceListEnd: null,
    }
    window.fetch = async function probedFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? ''
      const isWorkspaceList = url.includes('/workspace/list')
      if (!isWorkspaceList) return originalFetch(input, init)
      probe.workspaceListCount += 1
      probe.workspaceListPending += 1
      if (probe.workspaceListStart === null) probe.workspaceListStart = performance.now()
      try {
        const response = await originalFetch(input, init)
        await new Promise((resolve) => setTimeout(resolve, probe.responseDelayMs))
        return response
      } finally {
        probe.workspaceListPending -= 1
        probe.workspaceListEnd = performance.now()
      }
    }
    window[marker] = probe
    return true
  })()`)
}

async function resetWorkspaceFetchProbe(client) {
  await client.evaluate(`(() => {
    const probe = window.__littlesheepWorkspacePerformanceFetchProbe
    if (!probe) return false
    probe.workspaceListCount = 0
    probe.workspaceListPending = 0
    probe.workspaceListStart = null
    probe.workspaceListEnd = null
    return true
  })()`)
}

async function readWorkspaceFetchProbe(client) {
  return client.evaluate(`(() => {
    const probe = window.__littlesheepWorkspacePerformanceFetchProbe
    return probe ? {
      workspaceListCount: probe.workspaceListCount,
      workspaceListPending: probe.workspaceListPending,
      workspaceListStart: probe.workspaceListStart,
      workspaceListEnd: probe.workspaceListEnd,
    } : {
      workspaceListCount: 0,
      workspaceListPending: 0,
      workspaceListStart: null,
      workspaceListEnd: null,
    }
  })()`)
}

async function readFontContract(client) {
  return client.evaluate(`(() => {
    const root = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    const pick = (selector) => {
      const element = document.querySelector(selector)
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        selector,
        family: style.fontFamily,
        size: style.fontSize,
        lineHeight: style.lineHeight,
        weight: style.fontWeight,
      }
    }
    const probeClass = (className) => {
      const element = document.createElement('div')
      element.className = className
      element.style.cssText = 'position:fixed;left:-10000px;visibility:hidden'
      document.body.append(element)
      const style = getComputedStyle(element)
      const value = {
        selector: '.' + className + ' (computed probe)',
        family: style.fontFamily,
        size: style.fontSize,
        lineHeight: style.lineHeight,
        weight: style.fontWeight,
      }
      element.remove()
      return value
    }
    return {
      variables: {
        font: root.getPropertyValue('--font').trim(),
        fontPreview: root.getPropertyValue('--font-preview').trim(),
        mono: root.getPropertyValue('--mono').trim(),
      },
      ui: pick('.workspace-panel, body') ?? {
        selector: 'body',
        family: body.fontFamily,
        size: body.fontSize,
        weight: body.fontWeight,
      },
      preview: pick('.workspace-editor-monaco .monaco-editor .view-lines, .workspace-preview-code'),
      markdown: pick('.workspace-preview-markdown') ?? probeClass('workspace-preview-markdown'),
      office: pick('.workspace-office-preview') ?? probeClass('workspace-office-preview'),
    }
  })()`)
}

function evaluateFontContract(contract) {
  const uiFamily = contract?.ui?.family ?? ''
  const previewFamily = contract?.preview?.family ?? ''
  const uiVariable = contract?.variables?.font ?? ''
  const previewVariable = contract?.variables?.fontPreview ?? ''
  const mono = contract?.variables?.mono ?? ''
  const documentPreviewFamilies = [contract?.markdown?.family, contract?.office?.family].filter(Boolean)
  return {
    uiFamilyPresent: {
      ok: Boolean(uiFamily),
      value: uiFamily,
      budget: 'non-empty computed UI font family',
    },
    previewFamilyPresent: {
      ok: Boolean(previewFamily),
      value: previewFamily,
      budget: 'non-empty computed workspace preview font family',
    },
    codeDensity: {
      ok: !previewFamily || (contract?.preview?.size === '13px' && contract?.preview?.lineHeight === '23px'),
      value: {
        size: contract?.preview?.size,
        lineHeight: contract?.preview?.lineHeight,
      },
      budget: 'shared Monaco code surface uses 13px font and 23px line height',
    },
    previewUsesMonoContract: {
      ok: !mono || !previewFamily || fontFamilyContainsSameStack(previewFamily, mono),
      value: { previewFamily, mono },
      budget: 'preview/editor keeps the --mono stack when available',
    },
    previewContentFontIsolated: {
      ok: Boolean(previewVariable)
        && normalizeFontFamily(previewVariable) !== normalizeFontFamily(uiVariable),
      value: { uiVariable, previewVariable },
      budget: 'workspace document preview keeps a font stack independent from the UI',
    },
    previewContentUsesPreviewContract: {
      ok: Boolean(previewVariable)
        && documentPreviewFamilies.length === 2
        && documentPreviewFamilies.every((family) => (
          normalizeFontFamily(family) === normalizeFontFamily(previewVariable)
        )),
      value: { previewVariable, documentPreviewFamilies },
      budget: 'computed Markdown and Office preview fonts match --font-preview',
    },
    uiPreviewSeparated: {
      ok: !uiFamily || !previewFamily || normalizeFontFamily(uiFamily) !== normalizeFontFamily(previewFamily),
      value: { uiFamily, previewFamily },
      budget: 'UI and code preview use distinct computed font stacks',
    },
  }
}

function normalizeFontFamily(value) {
  return value.toLowerCase().replaceAll('"', '').replaceAll("'", '').replaceAll(' ', '')
}

function fontFamilyContainsSameStack(actual, expected) {
  const actualFamilies = normalizeFontFamily(actual).split(',')
  const expectedFamilies = normalizeFontFamily(expected).split(',')
  return expectedFamilies.some((family) => family && actualFamilies.includes(family))
}

async function measureMonacoInk(client, start, timeoutMs) {
  const result = await waitFor(async () => {
    const capture = await captureElementInk(client, '.monaco-editor .view-lines').catch(() => undefined)
    return capture?.hasInk ? capture : undefined
  }, timeoutMs, 'Monaco non-blank pixels')
  return {
    elapsedMs: roundMs(result.at - start),
    hasInk: result.hasInk,
    inkPixels: result.inkPixels,
    sampledPixels: result.sampledPixels,
    width: result.width,
    height: result.height,
    dominantColor: result.dominantColor,
  }
}

async function captureElementInk(client, selector) {
  const rect = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.x)),
      height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.y)),
    }
  })()`)
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { ...rect, scale: 1 },
  })
  const pixels = decodePngInk(Buffer.from(screenshot.data, 'base64'))
  return { ...pixels, at: await client.evaluate('performance.now()') }
}

function decodePngInk(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Monaco screenshot is not PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error('Truncated Monaco screenshot PNG')
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      bitDepth = buffer[dataStart + 8]
      colorType = buffer[dataStart + 9]
      if (buffer[dataStart + 12] !== 0) throw new Error('Interlaced Monaco screenshot is unsupported')
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (!width || !height || bitDepth !== 8) throw new Error('Unsupported Monaco screenshot format')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`Unsupported Monaco screenshot color type: ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = width * channels
  const expectedLength = height * (rowBytes + 1)
  if (raw.length < expectedLength) throw new Error('Truncated Monaco screenshot pixel data')
  const pixels = Buffer.alloc(height * rowBytes)
  const histogram = new Map()
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++]
    const rowStart = y * rowBytes
    for (let x = 0; x < rowBytes; x += 1) {
      const source = raw[sourceOffset++]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[rowStart - rowBytes + x] : 0
      const upperLeft = y > 0 && x >= channels ? pixels[rowStart - rowBytes + x - channels] : 0
      pixels[rowStart + x] = unfilterByte(filter, source, left, up, upperLeft)
    }
    if (filter > 4) throw new Error(`Unsupported Monaco screenshot PNG filter: ${filter}`)
  }
  for (let index = 0; index < pixels.length; index += channels) {
    const rgba = pixelRgba(pixels, index, colorType)
    const key = `${rgba[0] >> 3},${rgba[1] >> 3},${rgba[2] >> 3},${rgba[3] >> 5}`
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
  }
  const dominantKey = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0,0,0,0'
  const dominant = dominantKey.split(',').map(Number)
  let inkPixels = 0
  for (let index = 0; index < pixels.length; index += channels) {
    const rgba = pixelRgba(pixels, index, colorType)
    const distance = Math.abs(rgba[0] - dominant[0] * 8) + Math.abs(rgba[1] - dominant[1] * 8) + Math.abs(rgba[2] - dominant[2] * 8)
    // RGB bins are eight values wide, so the same dominant colour can be up
    // to 21 Manhattan-distance units from the bin origin. Keep the threshold
    // above that quantisation error while still catching anti-aliased glyphs.
    if (rgba[3] > 8 && distance >= 30) inkPixels += 1
  }
  const sampledPixels = width * height
  return {
    width,
    height,
    sampledPixels,
    inkPixels,
    hasInk: inkPixels >= Math.max(20, Math.floor(sampledPixels * 0.001)),
    dominantColor: dominant,
  }
}

function unfilterByte(filter, source, left, up, upperLeft) {
  if (filter === 0) return source
  if (filter === 1) return (source + left) & 0xff
  if (filter === 2) return (source + up) & 0xff
  if (filter === 3) return (source + Math.floor((left + up) / 2)) & 0xff
  if (filter === 4) {
    const estimate = left + up - upperLeft
    const leftDistance = Math.abs(estimate - left)
    const upDistance = Math.abs(estimate - up)
    const upperLeftDistance = Math.abs(estimate - upperLeft)
    const predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
      ? left
      : upDistance <= upperLeftDistance ? up : upperLeft
    return (source + predictor) & 0xff
  }
  return source
}

function pixelRgba(buffer, offset, colorType) {
  if (colorType === 6) return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]]
  if (colorType === 2) return [buffer[offset], buffer[offset + 1], buffer[offset + 2], 255]
  if (colorType === 4) return [buffer[offset], buffer[offset], buffer[offset], buffer[offset + 1]]
  return [buffer[offset], buffer[offset], buffer[offset], 255]
}

async function waitForLocator(dataDir, expectedPid) {
  const path = join(dataDir, locatorRelativePath)
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

function resourceDelta(start, end, elapsedMs) {
  return {
    sampledMs: elapsedMs,
    rssDeltaBytes: end.process.rssBytes - start.process.rssBytes,
    heapDeltaBytes: end.process.heapUsedBytes - start.process.heapUsedBytes,
    workingSetDeltaBytes: end.electron.workingSetBytes - start.electron.workingSetBytes,
    privateBytesDelta: end.electron.privateBytes - start.electron.privateBytes,
    activeHandleDelta: end.process.activeHandleCount - start.process.activeHandleCount,
    activeRequestDelta: end.process.activeRequestCount - start.process.activeRequestCount,
    processCountDelta: end.electron.processCount - start.electron.processCount,
  }
}

function apiUrl(locator, path) {
  return `http://${locator.host}:${locator.port}${path}`
}

function authHeaders(locator) {
  return { Authorization: `Bearer ${locator.token}` }
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

function processTreeSample(rootPid) {
  if (process.platform !== 'win32') return null
  const script = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine,HandleCount,UserModeTime,KernelModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize',
    `$rootProcess = $all | Where-Object { [uint32]$_.ProcessId -eq [uint32]${rootPid} } | Select-Object -First 1`,
    'if ($null -eq $rootProcess) { exit 3 }; $rootCreated = $rootProcess.CreationDate',
    `$ids = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add([uint32]${rootPid})`,
    'do { $added = $false; foreach ($item in $all) { if ($item.CreationDate -ge $rootCreated -and $ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $added = $true } } } while ($added)',
    '$all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ConvertTo-Json -Compress',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout.trim()) return null
  const rows = JSON.parse(result.stdout)
  const items = Array.isArray(rows) ? rows : [rows]
  const processes = items.map((item) => ({
    pid: numeric(item.ProcessId),
    parentPid: numeric(item.ParentProcessId),
    name: typeof item.Name === 'string' ? item.Name : '',
    role: classifyElectronProcess(item, rootPid),
    commandLine: compactCommandLine(item.CommandLine),
    handles: numeric(item.HandleCount),
    cpu100ns: numeric(item.UserModeTime) + numeric(item.KernelModeTime),
    readBytes: numeric(item.ReadTransferCount),
    writeBytes: numeric(item.WriteTransferCount),
    workingSetBytes: numeric(item.WorkingSetSize),
  }))
  return processes.reduce((sample, process) => ({
    cpu100ns: sample.cpu100ns + process.cpu100ns,
    readBytes: sample.readBytes + process.readBytes,
    writeBytes: sample.writeBytes + process.writeBytes,
    workingSetBytes: sample.workingSetBytes + process.workingSetBytes,
    handleCount: sample.handleCount + process.handles,
    processCount: sample.processCount + 1,
    processes: sample.processes,
  }), {
    cpu100ns: 0,
    readBytes: 0,
    writeBytes: 0,
    workingSetBytes: 0,
    handleCount: 0,
    processCount: 0,
    processes,
  })
}

function hiddenProcessDiagnostics(start, end) {
  if (!start || !end) {
    return {
      available: false,
      totals: { cpuMs: 0, ioBytes: 0, handleDelta: 0, workingSetDeltaBytes: 0 },
      byRole: [],
      byProcess: [],
    }
  }
  const startByPid = new Map(start.processes.map((process) => [process.pid, process]))
  const endByPid = new Map(end.processes.map((process) => [process.pid, process]))
  const pids = new Set([...startByPid.keys(), ...endByPid.keys()])
  const byProcess = [...pids].map((pid) => {
    const before = startByPid.get(pid)
    const after = endByPid.get(pid)
    const process = after ?? before
    const readBytes = Math.max(0, (after?.readBytes ?? 0) - (before?.readBytes ?? 0))
    const writeBytes = Math.max(0, (after?.writeBytes ?? 0) - (before?.writeBytes ?? 0))
    return {
      pid,
      parentPid: process?.parentPid ?? 0,
      role: process?.role ?? 'unknown',
      name: process?.name ?? '',
      cpuMs: roundMs(Math.max(0, (after?.cpu100ns ?? 0) - (before?.cpu100ns ?? 0)) / 10_000),
      ioBytes: readBytes + writeBytes,
      readBytes,
      writeBytes,
      handlesStart: before?.handles ?? 0,
      handlesEnd: after?.handles ?? 0,
      handleDelta: (after?.handles ?? 0) - (before?.handles ?? 0),
      workingSetStartBytes: before?.workingSetBytes ?? 0,
      workingSetEndBytes: after?.workingSetBytes ?? 0,
      workingSetDeltaBytes: (after?.workingSetBytes ?? 0) - (before?.workingSetBytes ?? 0),
      startedDuringSample: !before && Boolean(after),
      exitedDuringSample: Boolean(before) && !after,
      commandLine: process?.commandLine ?? '',
    }
  }).sort((left, right) => right.cpuMs - left.cpuMs || right.ioBytes - left.ioBytes)
  const roleMap = new Map()
  for (const process of byProcess) {
    const current = roleMap.get(process.role) ?? {
      role: process.role,
      processCount: 0,
      cpuMs: 0,
      ioBytes: 0,
      readBytes: 0,
      writeBytes: 0,
      handleDelta: 0,
      workingSetDeltaBytes: 0,
      pids: [],
    }
    current.processCount += 1
    current.cpuMs = roundMs(current.cpuMs + process.cpuMs)
    current.ioBytes += process.ioBytes
    current.readBytes += process.readBytes
    current.writeBytes += process.writeBytes
    current.handleDelta += process.handleDelta
    current.workingSetDeltaBytes += process.workingSetDeltaBytes
    current.pids.push(process.pid)
    roleMap.set(process.role, current)
  }
  const byRole = [...roleMap.values()].sort((left, right) => right.cpuMs - left.cpuMs || right.ioBytes - left.ioBytes)
  return {
    available: true,
    totals: {
      cpuMs: roundMs(Math.max(0, end.cpu100ns - start.cpu100ns) / 10_000),
      ioBytes: Math.max(0, end.readBytes - start.readBytes) + Math.max(0, end.writeBytes - start.writeBytes),
      readBytes: Math.max(0, end.readBytes - start.readBytes),
      writeBytes: Math.max(0, end.writeBytes - start.writeBytes),
      handlesStart: start.handleCount,
      handlesEnd: end.handleCount,
      handleDelta: end.handleCount - start.handleCount,
      workingSetStartBytes: start.workingSetBytes,
      workingSetEndBytes: end.workingSetBytes,
      workingSetDeltaBytes: end.workingSetBytes - start.workingSetBytes,
      processCountStart: start.processCount,
      processCountEnd: end.processCount,
    },
    byRole,
    byProcess,
  }
}

function summarizeCpuProfile(profile) {
  const nodes = new Map((profile?.nodes ?? []).map((node) => [node.id, node]))
  const totals = new Map()
  const samples = Array.isArray(profile?.samples) ? profile.samples : []
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : []
  let sampledMicros = 0
  let activeMicros = 0
  for (let index = 0; index < samples.length; index += 1) {
    const node = nodes.get(samples[index])
    if (!node) continue
    const micros = Math.max(0, numeric(deltas[index]))
    sampledMicros += micros
    const functionName = boundedProfileText(node.callFrame?.functionName || '(anonymous)', 120)
    const script = profileScriptName(node.callFrame?.url)
    const key = `${functionName}\u0000${script}`
    const idle = functionName === '(idle)'
    if (!idle) activeMicros += micros
    const current = totals.get(key) ?? { functionName, script, samples: 0, micros: 0, idle }
    current.samples += 1
    current.micros += micros
    totals.set(key, current)
  }
  return {
    sampledMs: roundMs(sampledMicros / 1_000),
    activeMs: roundMs(activeMicros / 1_000),
    top: [...totals.values()]
      .sort((left, right) => right.micros - left.micros || right.samples - left.samples)
      .slice(0, 30)
      .map((entry) => ({
        functionName: entry.functionName,
        script: entry.script,
        selfMs: roundMs(entry.micros / 1_000),
        samples: entry.samples,
        idle: entry.idle,
      })),
  }
}

function profileScriptName(value) {
  if (typeof value !== 'string' || !value) return ''
  const normalized = value.replaceAll('\\', '/').split(/[?#]/u, 1)[0]
  const parts = normalized.split('/').filter(Boolean)
  return boundedProfileText(parts.slice(-2).join('/'), 160)
}

function boundedProfileText(value, maxLength) {
  const normalized = String(value).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function classifyElectronProcess(item, rootPid) {
  const pid = numeric(item.ProcessId)
  if (pid === rootPid) return 'main'
  const commandLine = typeof item.CommandLine === 'string' ? item.CommandLine.toLowerCase() : ''
  if (commandLine.includes('--type=renderer')) return 'renderer'
  if (commandLine.includes('--type=gpu-process')) return 'gpu'
  if (commandLine.includes('--type=utility')) {
    if (commandLine.includes('network.mojom.networkservice')) return 'network-service'
    if (commandLine.includes('storage.mojom.storageservice')) return 'storage-service'
    if (commandLine.includes('audio.mojom.audioservice')) return 'audio-service'
    return 'utility'
  }
  if (commandLine.includes('--type=crashpad-handler')) return 'crashpad'
  return 'child'
}

function compactCommandLine(value) {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact
}

function numeric(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
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

async function directoryBytes(path) {
  const { readdir, stat } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name)
    total += entry.isDirectory() ? await directoryBytes(item) : (await stat(item)).size
  }
  return total
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
      return [{
        stage: entry.stage,
        processUptimeMs: roundMs(entry.processUptimeMs),
        ...(Number.isFinite(Number(entry.durationMs)) ? { durationMs: roundMs(entry.durationMs) } : {}),
      }]
    } catch {
      return []
    }
  })
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

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function roundMs(value) {
  return Math.round(value * 10) / 10
}

async function forceTerminate(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await waitFor(() => child.exitCode === null ? undefined : true, 10_000, 'Electron process exit').catch(() => undefined)
    return
  }
  child.kill('SIGKILL')
}

async function removeTemporaryRoot(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error?.code) || attempt === 7) throw error
      await delay(150 * (attempt + 1))
    }
  }
}

async function runIdleBaselineDiagnostic() {
  await assertAppBuildFresh(repoRoot)
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-idle-baseline-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workspaceDir = join(root, 'workspace')
  const logPath = join(root, 'electron.log')
  let electron
  try {
    await prepareFixture(dataDir, chromiumDir, workspaceDir)
    const startedAt = Date.now()
    electron = await startElectron({ dataDir, chromiumDir, logPath })
    const locator = await waitForLocator(dataDir, electron.pid)
    const locatorAt = Date.now()
    await waitForDesktop(locator)
    const visibleAt = Date.now()
    await desktopAction(locator, 'close')
    await delay(6_000)
    const snapshotStart = await desktopSnapshot(locator)
    const processStart = processTreeSample(electron.pid)
    await delay(idleSampleMs)
    const processEnd = processTreeSample(electron.pid)
    const snapshotEnd = await desktopSnapshot(locator)
    console.log(JSON.stringify({
      check: 'workspace-idle-baseline-diagnostic',
      startupProcessToLocatorMs: locatorAt - startedAt,
      startupLocatorToWindowVisibleMs: visibleAt - locatorAt,
      resources: resourceDelta(snapshotStart, snapshotEnd, idleSampleMs),
      process: hiddenProcessDiagnostics(processStart, processEnd),
      snapshotStart,
      snapshotEnd,
      logPath,
    }, null, 2))
  } finally {
    if (electron?.exitCode === null) await forceTerminate(electron)
    await removeTemporaryRoot(root)
  }
}

if (diagnoseIdleBaseline) await runIdleBaselineDiagnostic()
else await main()
