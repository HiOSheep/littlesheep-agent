// @littlesheep/app — main/index.ts
// Electron main process entry.
//
// Bootstrap sequence:
//   1. Load branding + data dirs
//   2. Load + decrypt API keys from keychain → inject into process.env
//   3. Load config (resolveApiKey("$VAR") now finds keys in env)
//   4. Complete any registered Memory v3 migration/rollback before writers start
//   5. Create embedded Runner (in-process agent loop, origin='app')
//   6. Initialize ProjectIndex + SessionIndex + ArchiveIndex (UI metadata)
//   7. Start local app API server on 127.0.0.1 (random port)
//   8. Discover and activate optional plugins
//   9. Expose port to renderer via env var (preload reads it)
//  10. Create BrowserWindow

import { app, dialog, ipcMain, net } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  loadConfig,
  saveConfig,
  type Config,
} from '@littlesheep/config'
import { loadBranding, dataSubdirs, type BrandingConfig } from '@littlesheep/branding'
import { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import { createRunner, type AgentRunner } from '@littlesheep/runner'
import type { PluginHost } from '@littlesheep/plugins'
import { startLocalAppApiServer, type LocalAppApiServer, type LocalAppApiServerOptions } from './local-app-api-server.js'
import { BOOTSTRAP_TEMPLATES } from './bootstrap-templates.js'
import { classifyAttachment } from './attachments.js'
import { SessionIndex } from './session-index.js'
import { createRecoveryReadAuthorizer } from './run-policy.js'
import { ProjectIndex } from './project-index.js'
import { ArchiveIndex } from './archive-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { prepareRuntimeConfig } from './runtime-config-preparation.js'
import { createRuntimeConfigUpdater } from './runtime-config-change.js'
import { createExecutionRetryController } from './execution-retry.js'
import { loadApiKeys, injectKeysIntoEnv } from './keychain.js'
import { loadPluginHost } from './plugin-host-startup.js'
import { runShutdownSequence } from './shutdown-sequence.js'
import { RunActivityMonitor } from './run-activity-monitor.js'
import { LittleSheepDesktopShell } from './desktop-shell.js'
import { createDesktopAcceptanceSnapshotProvider } from './desktop-acceptance-snapshot.js'
import { createDesktopAcceptanceActions, waitForAcceptanceReadyDelay } from './desktop-acceptance-actions.js'
import { DataRootMigrationManager } from './data-root-migration.js'
import { prepareMemoryV3Bootstrap } from './memory-v3-bootstrap.js'
import { removeLocalAppApiLocator, writeLocalAppApiLocator } from './local-app-api-locator.js'
import { developmentEnvironmentLabel } from './development-environment-definitions.js'
import {
  clearEmbeddedBrowserCache,
  clearEmbeddedBrowserData,
  getBrowserStorageStatus,
  getEmbeddedBrowserSession,
} from './embedded-browser.js'
import { recordBootstrapTiming } from './bootstrap-timing.js'
import { createRuntimeReadinessController } from './runtime-readiness.js'
import {
  isRendererTimingDuration,
  isRendererTimingStage,
  RENDERER_TIMING_CHANNEL,
  RUNTIME_READINESS_QUERY_CHANNEL,
  RUNTIME_RETRY_EXECUTION_CHANNEL,
} from '../shared/runtime-readiness-ipc.js'

let runner: AgentRunner | null = null
let server: LocalAppApiServer | null = null
let pluginHost: PluginHost | null = null
let sessionIndex: SessionIndex | null = null
let projectIndex: ProjectIndex | null = null
let archiveIndex: ArchiveIndex | null = null
let terminalActivityIndex: TerminalActivityIndex | null = null
let workspaceArtifactIndex: WorkspaceArtifactIndex | null = null
let workspaceLayoutIndex: WorkspaceLayoutIndex | null = null
let shutdownStarted = false
let quitRequested = false
const runActivity = new RunActivityMonitor()

// Startup timing anchor for cold-start measurement. `process.uptime()` is the
// honest origin: module loading before the first business log is already
// included in it. The explicit `process-start` entry exists so a harness can
// read the origin without parsing the module-load entry.
recordBootstrapTiming('main-module-ready')
recordBootstrapTiming('process-start')

// Module-level state for runner rebuild (triggered by API key change).
let currentConfig: Config | null = null
let currentBranding: BrandingConfig | null = null
let currentModel: string = ''
let currentDataDir: string = ''
let currentBootstrapDir: string = ''
let currentWorkplaceDir: string = ''
let providerCalibrationToken = ''
let rebuildMutex: Promise<void> | null = null
const retiredRunners = new Map<AgentRunner, NodeJS.Timeout>()
const MAX_RETIRED_RUNNERS = 4
const RETIRED_RUNNER_POLL_MS = 1_000
const desktopShell = new LittleSheepDesktopShell({
  activity: runActivity,
  getClosePolicy: () => currentConfig?.desktop.closePolicy ?? 'background-while-active',
  canCreateWindow: () => !shutdownStarted && currentConfig !== null,
  isQuitting: () => quitRequested || shutdownStarted,
  getWindowStateFilePath: () => currentDataDir ? join(currentDataDir, 'ui', 'desktop-window.json') : undefined,
  onQuit: requestApplicationQuit,
  onWarning: (message) => console.warn(`[desktop] ${message}`),
})
const desktopAcceptanceSnapshot = createDesktopAcceptanceSnapshotProvider({
  desktopShell,
  runActivity,
  getCurrentRunner: () => runner,
  getRetiredRunnerCount: () => retiredRunners.size,
})

// Execution readiness is published to the visible window so the Renderer can
// show the real stage instead of an empty shell. The window is resolved per
// publish: close-to-background can replace it while startup is still running.
const readiness = createRuntimeReadinessController({
  getWindow: () => desktopShell.currentWindow(),
  onWarning: (message) => console.warn(`[readiness] ${message}`),
})

/**
 * Retrying execution after a failed start.
 *
 * The attempt re-reads `config.json` first, so fixing the model in settings (or
 * restoring a missing key) is enough - no restart. Attempts are bounded: three
 * failed tries mean the problem is outside what the app can fix by retrying.
 */
const executionRetry = createExecutionRetryController({
  onBegin: () => readiness.begin('execution', '正在重试启动运行能力', { port: server?.port }),
  onFailure: (message, retryable) => readiness.fail(message, { retryable }),
  attempt: async () => {
    if (!currentBranding || !currentDataDir) throw new Error('启动尚未完成，暂时无法重试。')
    const reloaded = prepareRuntimeConfig(await loadConfig({ dataDir: currentDataDir }), currentWorkplaceDir)
    currentConfig = reloaded.config
    currentModel = reloaded.model
    await startExecution({
      branding: currentBranding,
      config: reloaded.config,
      model: reloaded.model,
      dataDir: currentDataDir,
    })
  },
  log: (message) => console.warn(`[retry] ${message}`),
})

function installReadinessHandlers(): void {
  ipcMain.handle(RUNTIME_READINESS_QUERY_CHANNEL, () => readiness.current())
  // The window offers this only in a retryable failed state; the controller
  // refuses extra calls itself, so a second click cannot start a second start.
  ipcMain.handle(RUNTIME_RETRY_EXECUTION_CHANNEL, () => executionRetry.retry())
  ipcMain.on(RENDERER_TIMING_CHANNEL, (_event, stage: unknown, durationMs: unknown) => {
    if (!isRendererTimingStage(stage)) return
    if (!isRendererTimingDuration(durationMs)) return
    // The renderer measures its own deltas; only the stage name and the bounded
    // duration cross the bridge, and both are recorded as-is.
    recordBootstrapTiming(stage, undefined, { durationMs })
  })
}

// Single-instance lock: prevent multiple Electron instances from opening the
// same SQLite database (which causes "disk I/O error" on the WAL -shm file).
// The second instance focuses the first's window and quits.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance holds the lock — exit immediately.
  app.quit()
} else {
  app.on('second-instance', () => {
    desktopShell.show()
  })
}

function requestApplicationQuit(): void {
  if (shutdownStarted) return
  quitRequested = true
  app.quit()
}

async function ensureUserDataLayout(dirs: ReturnType<typeof dataSubdirs>): Promise<void> {
  await Promise.all([
    mkdir(dirs.root, { recursive: true }),
    mkdir(dirs.memory, { recursive: true }),
    mkdir(dirs.skills, { recursive: true }),
    mkdir(dirs.config, { recursive: true }),
    mkdir(dirs.plugins, { recursive: true }),
    mkdir(dirs.pluginData, { recursive: true }),
    mkdir(dirs.attachmentCache, { recursive: true }),
    mkdir(dirs.workplace, { recursive: true }),
  ])
  await Promise.all(Object.entries(BOOTSTRAP_TEMPLATES).map(async ([file, content]) => {
    const path = join(dirs.root, file)
    if (!existsSync(path)) {
      await writeFile(path, content, 'utf8')
    }
  }))
  const configPath = join(dirs.root, 'config.json')
  if (!existsSync(configPath)) {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      agents: {
        defaults: {
          workspace: dirs.workplace,
          reasoning: 'auto',
        },
      },
    }, null, 2), 'utf8')
  }
}

async function persistRuntimeConfig(config: Config): Promise<void> {
  if (currentDataDir) {
    await saveConfig(config, join(currentDataDir, 'config.json'))
  }
  currentConfig = config
  if (server) server.setConfig(config)
  pluginHost?.setConfig(config)
}

/**
 * The accepted configuration is what the next run resolves policy from, and the
 * Runner captures one immutable copy at construction — so the updater replaces it
 * whenever the saved revision differs in any field the run reads. Owning the
 * transaction in `runtime-config-change.ts` keeps the composition root out of the
 * normalize/persist/rebuild ordering.
 */
const updateRuntimeConfig = createRuntimeConfigUpdater({
  current: () => currentConfig,
  prepare: (config) => prepareRuntimeConfig(config, currentWorkplaceDir).config,
  persist: persistRuntimeConfig,
  rebuild: rebuildRunner,
})

async function bootstrap(): Promise<void> {
  let stageStartedAt = recordBootstrapTiming('bootstrap-start')
  // Stage 1 — durable prerequisites. Data-root migration, the Memory v3
  // locator and the API-key injection must finish before any writer starts, so
  // none of them may be deferred or reordered for the sake of an earlier window.
  readiness.begin('data-root', '正在准备本机数据目录')
  // 1. Load branding and complete any registered data-root operation before
  //    creating a writer, opening SQLite, or materializing the user layout.
  const branding = await loadBranding()
  stageStartedAt = recordBootstrapTiming('branding-ready', stageStartedAt)
  const dataRootManager = new DataRootMigrationManager({ branding })
  const dataRootPreparation = await dataRootManager.prepareForBootstrap()
  stageStartedAt = recordBootstrapTiming('data-root-ready', stageStartedAt)
  if (dataRootPreparation.status.pendingMigration?.error) {
    console.error(`[data-root] migration pending: ${dataRootPreparation.status.pendingMigration.error}`)
  }
  if (dataRootPreparation.status.pendingRollback?.error) {
    console.error(`[data-root] rollback pending: ${dataRootPreparation.status.pendingRollback.error}`)
  }
  const dataDir = dataSubdirs(branding)
  currentDataDir = dataDir.root
  currentBootstrapDir = dataDir.root
  currentWorkplaceDir = dataDir.workplace
  desktopShell.restoreWindowState()
  await ensureUserDataLayout(dataDir)
  stageStartedAt = recordBootstrapTiming('user-data-layout-ready', stageStartedAt)

  // 2. Load + decrypt API keys from keychain → inject into process.env.
  //    Must happen BEFORE loadConfig so resolveApiKey("$VAR") finds the key.
  const keys = loadApiKeys(dataDir.root)
  injectKeysIntoEnv(keys)
  stageStartedAt = recordBootstrapTiming('keychain-ready', stageStartedAt)

  // 3. Load config (env vars are now set, $VAR references resolve correctly).
  readiness.begin('config', '正在读取本机配置')
  const runtime = prepareRuntimeConfig(await loadConfig({ dataDir: dataDir.root }), dataDir.workplace)
  stageStartedAt = recordBootstrapTiming('config-ready', stageStartedAt)
  let config = runtime.config
  const model = runtime.model
  const memoryV3MigrationManager = new MemoryV2ToV3MigrationManager({
    dataDir: dataDir.root,
    policy: { experienceThreshold: config.memory.experienceWriteThreshold },
  })
  const memoryPreparation = await prepareMemoryV3Bootstrap({
    dataDir: dataDir.root,
    config,
    manager: memoryV3MigrationManager,
  })
  stageStartedAt = recordBootstrapTiming('memory-v3-ready', stageStartedAt)
  config = memoryPreparation.config
  if (memoryPreparation.error) {
    console.error(`[memory-v3] ${memoryPreparation.operation} recovery pending: ${memoryPreparation.error}`)
  }
  if (runtime.migratedDefaultWorkspace || memoryPreparation.configChanged) {
    await saveConfig(config, join(dataDir.root, 'config.json'))
  }
  currentConfig = config
  currentBranding = branding
  currentModel = model
  stageStartedAt = recordBootstrapTiming('durable-config-ready', stageStartedAt)

  // Stage 2 — UI metadata + the Local App API listener. These do not need the
  // Runner, so the window can become readable and interactive while execution
  // is still being built. Any registered Memory v3 operation has already
  // completed or failed closed, and `config` already follows the durable
  // locator, so the reads below cannot observe an inconsistent data root.

  // 4. Project + session + archive indexes for UI sidebar and settings.
  readiness.begin('ui-indexes', '正在读取会话与项目索引')
  projectIndex = new ProjectIndex({ dataDir: dataDir.root })
  await projectIndex.removeManagedWorkspaceShells(dataDir.workplace)
  stageStartedAt = recordBootstrapTiming('project-index-ready', stageStartedAt)
  sessionIndex = new SessionIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  await sessionIndex.list()
  stageStartedAt = recordBootstrapTiming('session-index-ready', stageStartedAt)
  archiveIndex = new ArchiveIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  await archiveIndex.migrateManagedWorkspaceMetadata()
  stageStartedAt = recordBootstrapTiming('archive-index-ready', stageStartedAt)
  terminalActivityIndex = new TerminalActivityIndex({ dataDir: dataDir.root })
  workspaceArtifactIndex = new WorkspaceArtifactIndex({ dataDir: dataDir.root })
  workspaceLayoutIndex = new WorkspaceLayoutIndex({ dataDir: dataDir.root })
  getEmbeddedBrowserSession()
  stageStartedAt = recordBootstrapTiming('ui-indexes-ready', stageStartedAt)

  // 5. Start the local app API listener before the Runner exists. Runner-backed
  //    routes answer 503 runtime-not-ready until `startExecution()` finishes;
  //    metadata routes (sessions, projects, config, readiness) serve normally.
  readiness.begin('api', '正在启动本地接口')
  providerCalibrationToken = randomBytes(32).toString('base64url')
  const apiOptions: LocalAppApiServerOptions = {
    port: 0,
    sessionIndex,
    projectIndex,
    archiveIndex,
    terminalActivityIndex,
    workspaceArtifactIndex,
    workspaceLayoutIndex,
    config,
    dataDir: dataDir.root,
    workplaceDir: dataDir.workplace,
    providerCalibrationToken,
    getExecutionReadiness: () => readiness.current(),
    // The Runner is published later by `startExecution()`; until then every
    // Runner-backed route answers 503 runtime-not-ready.
    getRunner: () => runner ?? undefined,
    desktopAcceptance: createDesktopAcceptanceActions({
      token: providerCalibrationToken,
      snapshot: desktopAcceptanceSnapshot,
      shell: desktopShell,
      quit: requestApplicationQuit,
    }),
    rebuildRunner,
    updateRuntimeConfig,
    listActiveRuns: () => runActivity.snapshot(),
    subscribeActiveRuns: (listener) => runActivity.subscribe(listener),
    controlActiveRun: (runId, action, reason) => runActivity.request(runId, action, reason),
    selectWorkspace: async () => {
      const result = await dialog.showOpenDialog({
        title: '选择工作文件夹',
        properties: ['openDirectory', 'createDirectory'],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    selectAttachments: async () => {
      const result = await dialog.showOpenDialog({
        title: '选择附件',
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled) return []
      return Promise.all(result.filePaths.map(classifyAttachment))
    },
    selectProjectMemoryExport: async (projectName, projectPath) => {
      const safeName = projectName.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-').trim() || 'project'
      const result = await dialog.showSaveDialog({
        title: '导出可共享项目记忆',
        defaultPath: join(projectPath, `${safeName}-memory.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      return result.canceled ? null : result.filePath ?? null
    },
    selectMemoryResourceSource: async () => {
      const result = await dialog.showOpenDialog({
        title: '重新定位记忆资源',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    selectMemoryAtomExport: async (suggestedName) => {
      const result = await dialog.showSaveDialog({
        title: '导出记忆原子证据包',
        defaultPath: join(dataDir.root, 'exports', suggestedName),
        filters: [{ name: 'LittleSheep Memory', extensions: ['json'] }],
      })
      return result.canceled ? null : result.filePath ?? null
    },
    memoryV3MigrationManager,
    dataRootManager,
    selectDataRootTarget: async () => {
      const result = await dialog.showOpenDialog({
        title: '选择新的 LittleSheep 数据目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    restartApplication: () => {
      app.relaunch()
      requestApplicationQuit()
    },
    getBrowserStorageStatus,
    clearBrowserCache: clearEmbeddedBrowserCache,
    clearBrowserData: clearEmbeddedBrowserData,
    selectDevelopmentEnvironmentSource: async (environmentId, version) => {
      const label = developmentEnvironmentLabel(environmentId)
      const result = await dialog.showOpenDialog({
        title: version ? `导入 ${label} ${version}` : `导入 ${label} 工具链`,
        message: '选择已下载并解压的工具链目录。LS 会复制一份到自己的数据目录，不会移动或修改原目录。',
        properties: ['openDirectory'],
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
  }
  server = await startLocalAppApiServer(apiOptions)
  stageStartedAt = recordBootstrapTiming('local-api-ready', stageStartedAt)
  await writeLocalAppApiLocator(dataDir.root, {
    version: 1,
    host: '127.0.0.1',
    port: server.port,
    token: providerCalibrationToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })
  stageStartedAt = recordBootstrapTiming('locator-written', stageStartedAt)
  readiness.begin('api', '正在准备运行能力', { port: server.port })

  // 6. Show the application shell now: configuration and session metadata are
  //    consistent, so the window can be read and typed into while the Runner
  //    finishes starting.
  desktopShell.initialize()
  recordBootstrapTiming('desktop-shell-initialized', stageStartedAt)

  // Stage 3 — execution. The plugin host is created first so the Runner can be
  // handed to it in the same step that makes execution available.
  readiness.begin('execution', '正在准备运行能力', { port: server.port })
  await startExecution({ branding, config, model, dataDir: dataDir.root })
}

/**
 * Build the embedded Runner and publish execution readiness.
 *
 * Only the steps that truly need the Runner live here; the window and the
 * metadata API are already usable when this runs. A failure is a reported
 * readiness state, never a frame that pretends the app is working.
 */
async function startExecution(input: {
  branding: BrandingConfig
  config: Config
  model: string
  dataDir: string
}): Promise<void> {
  const dataDir = input.dataDir
  let stageStartedAt = recordBootstrapTiming('execution-start')
  const created = await createRunner({
    config: input.config,
    branding: input.branding,
    model: input.model,
    bootstrapDir: dataDir,
    containerRoot: dataDir,
    authorizeDurableEffectRead: createRecoveryReadAuthorizer(() => sessionIndex, dataDir),
    tokenizerFetch: (fetchInput, init) => net.fetch(fetchInput instanceof URL ? fetchInput.href : fetchInput, init),
  })
  // Publish the Runner before the run router is built: every Runner-backed
  // route reads this reference, and it stays undefined until now on purpose.
  runner = created
  stageStartedAt = recordBootstrapTiming('runner-ready', stageStartedAt)
  runActivity.setRunners([created])

  // The run router owns interrupted-run recovery, so it is created together
  // with the Runner rather than with the listener. Execution readiness is
  // published after it settles, so no request observes a half-built router.
  await server?.setRunner(created)

  // Execution is available now. Everything below is optional and must not delay
  // it: measured, the plugin host costs only ~2.8 ms, but it is an optional
  // capability and the core API stays usable while it is absent (see
  // `local-app-api-server.ts`), so nothing waits on it.
  //
  // An isolated acceptance run can hold the publish back to widen the window the
  // renderer sees; that is 0 in every normal start.
  const acceptanceDelayMs = await waitForAcceptanceReadyDelay()
  if (acceptanceDelayMs > 0) recordBootstrapTiming('acceptance-ready-delay', stageStartedAt)
  readiness.ready()
  recordBootstrapTiming('execution-ready', stageStartedAt)
  void loadPluginHost(
    { runner: created, branding: input.branding, config: input.config },
    { isCurrent: (candidate) => !shutdownStarted && runner === candidate },
  )
    .then((host) => {
      if (!host) return
      pluginHost = host
      server?.setPluginHost(host)
      recordBootstrapTiming('plugin-host-ready')
    })
    .catch((error) => {
      console.error('[plugins] host failed to start:', error)
    })
}

/**
 * Rebuild the runner after an API key change.
 *
 * Strategy: "build new, then teardown old"
 *   1. Create new runner (new LLM client reads new env, new SQLite connection)
 *   2. Atomically swap the server's runner reference
 *   3. Delay 5s before closing old runner (lets in-flight runs finish)
 *
 * Mutex: concurrent calls share the same rebuild Promise (no parallel builds).
 */
async function rebuildRunner(): Promise<void> {
  if (rebuildMutex) return rebuildMutex
  rebuildMutex = doRebuildRunner().finally(() => {
    rebuildMutex = null
  })
  return rebuildMutex
}

async function doRebuildRunner(): Promise<void> {
  if (!currentConfig || !currentBranding || !server) return
  await releaseIdleRetiredRunners()
  if (retiredRunners.size >= MAX_RETIRED_RUNNERS) {
    throw new Error(`cannot replace runtime while ${retiredRunners.size} previous runtime(s) still own active tasks`)
  }

  const oldRunner = runner

  // 1. Create new runner (picks up new API key from process.env).
  const runtime = prepareRuntimeConfig(currentConfig, currentWorkplaceDir)
  currentConfig = runtime.config
  currentModel = runtime.model

  const newRunner = await createRunner({
    config: currentConfig,
    branding: currentBranding,
    model: currentModel,
    bootstrapDir: currentBootstrapDir || currentDataDir,
    containerRoot: currentDataDir || currentBootstrapDir,
    authorizeDurableEffectRead: createRecoveryReadAuthorizer(() => sessionIndex, currentDataDir || currentBootstrapDir),
    tokenizerFetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  })

  // 2. Atomically swap references.
  runner = newRunner
  server.setRunner(newRunner)
  server.setConfig(currentConfig)
  if (pluginHost) await pluginHost.setRunner(newRunner)
  pluginHost?.setConfig(currentConfig)

  // 3. Delay closing the old runner so in-flight requests can finish before
  //    its Catalog and optional local embedding pipeline release their handles.
  if (oldRunner) {
    scheduleRetiredRunnerShutdown(oldRunner)
  }
  refreshActivitySources()
}

function scheduleRetiredRunnerShutdown(retiredRunner: AgentRunner): void {
  const timer = setTimeout(() => inspectRetiredRunner(retiredRunner), RETIRED_RUNNER_POLL_MS)
  timer.unref?.()
  retiredRunners.set(retiredRunner, timer)
  refreshActivitySources()
}

function inspectRetiredRunner(retiredRunner: AgentRunner): void {
  if (!retiredRunners.has(retiredRunner)) return
  if ((retiredRunner.activeRuns?.list().length ?? 0) > 0) {
    const timer = setTimeout(() => inspectRetiredRunner(retiredRunner), RETIRED_RUNNER_POLL_MS)
    timer.unref?.()
    retiredRunners.set(retiredRunner, timer)
    return
  }
  retiredRunners.delete(retiredRunner)
  refreshActivitySources()
  void retiredRunner.shutdown().catch(() => undefined)
}

async function releaseIdleRetiredRunners(): Promise<void> {
  const idle = [...retiredRunners.entries()]
    .filter(([retiredRunner]) => (retiredRunner.activeRuns?.list().length ?? 0) === 0)
  for (const [retiredRunner, timer] of idle) {
    clearTimeout(timer)
    retiredRunners.delete(retiredRunner)
  }
  if (idle.length > 0) {
    refreshActivitySources()
    await Promise.all(idle.map(([retiredRunner]) => retiredRunner.shutdown().catch(() => undefined)))
  }
}

function refreshActivitySources(): void {
  runActivity.setRunners([runner, ...retiredRunners.keys()])
}

async function shutdownRetiredRunners(): Promise<void> {
  const entries = [...retiredRunners.entries()]
  retiredRunners.clear()
  for (const [, timer] of entries) clearTimeout(timer)
  await Promise.all(entries.map(([retiredRunner]) => retiredRunner.shutdown().catch(() => undefined)))
  refreshActivitySources()
}

// Only the instance that holds the single-instance lock should bootstrap.
// The losing instance calls app.quit() above and never reaches here.
if (gotLock) {
  app.whenReady().then(() => {
    installReadinessHandlers()
    recordBootstrapTiming('electron-app-ready')
    desktopShell.showStartup()
    recordBootstrapTiming('desktop-startup-visible')
    void bootstrap().catch((error: unknown) => {
      console.error('[bootstrap] failed:', error)
      readiness.fail(error instanceof Error ? error.message : String(error), { retryable: true })
      // Two failure stages, two visible states (both measured on a real window):
      // before the renderer loads, the standalone failure page carries the error;
      // after it, the shell states the same reason in its readiness notice and
      // keeps the settings that fix the configuration reachable.
      if (!desktopShell.hasLoadedRenderer()) desktopShell.showStartupError(error)
    })
  })

  app.on('activate', () => {
    desktopShell.show()
  })

  app.on('window-all-closed', () => {
    if (!shutdownStarted) requestApplicationQuit()
  })

  app.on('before-quit', (event) => {
    if (shutdownStarted) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    quitRequested = true
    shutdownStarted = true
    void runShutdownSequence([
      { name: 'desktop state', run: () => desktopShell.shutdown() },
      {
        name: 'local app API locator',
        run: () => removeLocalAppApiLocator(currentDataDir, providerCalibrationToken),
      },
      { name: 'local app API', run: () => server?.stop() },
      { name: 'plugins', run: () => pluginHost?.stop() },
      { name: 'retired runners', run: shutdownRetiredRunners },
      { name: 'runner', run: () => runner?.shutdown() },
      { name: 'run activity monitor', run: () => runActivity.dispose() },
    ], {
      stepTimeoutMs: 5000,
      onWarning: (message) => console.warn(`[shutdown] ${message}`),
    }).finally(() => app.exit(0))
  })
}
