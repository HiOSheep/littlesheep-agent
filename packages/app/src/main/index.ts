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

import { app, dialog, net } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  loadConfig,
  saveConfig,
  selectDefaultModelForAvailableProvider,
  withProviderPresets,
  resolveApiKey,
  type Config,
  type ModelProvider,
} from '@littlesheep/config'
import { loadBranding, dataSubdirs, type BrandingConfig } from '@littlesheep/branding'
import { MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import { createRunner, type AgentRunner, type LogFn } from '@littlesheep/runner'
import { createPluginHost, type PluginHost } from '@littlesheep/plugins'
import { startLocalAppApiServer, type LocalAppApiServer } from './local-app-api-server.js'
import { BUILTIN_PLUGIN_SOURCES } from './builtin-plugins.js'
import { classifyAttachment } from './attachments.js'
import { SessionIndex } from './session-index.js'
import { ProjectIndex } from './project-index.js'
import { ArchiveIndex } from './archive-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { resolveRuntimeWorkspaceDefault } from './runtime-config.js'
import { loadApiKeys, injectKeysIntoEnv } from './keychain.js'
import { runShutdownSequence } from './shutdown-sequence.js'
import { RunActivityMonitor } from './run-activity-monitor.js'
import { LittleSheepDesktopShell } from './desktop-shell.js'
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
  onQuit: requestApplicationQuit,
  onWarning: (message) => console.warn(`[desktop] ${message}`),
})

const BOOTSTRAP_TEMPLATES: Record<string, string> = {
  'AGENTS.md': [
    '# AGENTS.md',
    '',
    'Project-level operating instructions for LittleSheep.',
    'Add durable rules here when you want every run to follow them.',
    '',
  ].join('\n'),
  'USER.md': [
    '# USER.md',
    '',
    'Durable user preferences and profile notes live here.',
    'Keep this concise and update it when preferences change.',
    '',
  ].join('\n'),
  'PHILOSOPHY.md': [
    '# PHILOSOPHY.md',
    '',
    '这里保存经用户确认的长期价值判断、设计取舍和共同工作理念。',
    'LS 只在任务相关时沿资源索引按需读取，不会把全文常驻到每轮上下文。',
    '',
  ].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md',
    '',
    'Tool usage conventions and local command policies live here.',
    'Record lessons that prevent repeated tool mistakes.',
    '',
  ].join('\n'),
  'MEMORY.md': [
    '# MEMORY.md',
    '',
    'Curated long-term memory for LittleSheep.',
    'Daily detailed memory lives in the memory/ directory.',
    '',
  ].join('\n'),
  'SOUL.md': [
    '# SOUL.md',
    '',
    'Voice, temperament, and identity notes for LittleSheep.',
    'Keep the stable personality here; keep task rules in AGENTS.md.',
    '',
  ].join('\n'),
}

function providerHasKey(provider: ModelProvider): boolean {
  return !provider.apiKey || !!resolveApiKey(provider.apiKey)
}

function prepareRuntimeConfig(config: Config, workplaceDir?: string): { config: Config; model: string; migratedDefaultWorkspace: boolean } {
  const prepared = withProviderPresets(config)
  const defaultWorkspace = prepared.agents.defaults.workspace
  const workspaceResolution = resolveRuntimeWorkspaceDefault(defaultWorkspace, workplaceDir)
  const workspace = workspaceResolution.workspace
  const normalized: Config = {
    ...prepared,
    agents: {
      ...prepared.agents,
      defaults: {
        ...prepared.agents.defaults,
        workspace,
      },
    },
  }
  const model = selectDefaultModelForAvailableProvider(normalized, providerHasKey)
  return { config: normalized, model, migratedDefaultWorkspace: workspaceResolution.migrated }
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
  currentConfig = config
  if (server) server.setConfig(config)
  pluginHost?.setConfig(config)
  if (currentDataDir) {
    await saveConfig(config, join(currentDataDir, 'config.json'))
  }
}

async function updateRuntimeConfig(config: Config): Promise<void> {
  const normalized = prepareRuntimeConfig(config, currentWorkplaceDir).config
  const modelChanged = normalized.agents.defaults.model !== currentConfig?.agents.defaults.model
  await persistRuntimeConfig(normalized)
  if (modelChanged) {
    await rebuildRunner()
  }
}

async function bootstrap(): Promise<void> {
  // 1. Load branding and complete any registered data-root operation before
  //    creating a writer, opening SQLite, or materializing the user layout.
  const branding = await loadBranding()
  const dataRootManager = new DataRootMigrationManager({ branding })
  const dataRootPreparation = await dataRootManager.prepareForBootstrap()
  if (dataRootPreparation.status.pendingMigration?.error) {
    console.error(`[data-root] migration pending: ${dataRootPreparation.status.pendingMigration.error}`)
  }
  if (dataRootPreparation.status.pendingRollback?.error) {
    console.error(`[data-root] rollback pending: ${dataRootPreparation.status.pendingRollback.error}`)
  }
  const dataDir = dataSubdirs(branding)
  await ensureUserDataLayout(dataDir)

  // 2. Load + decrypt API keys from keychain → inject into process.env.
  //    Must happen BEFORE loadConfig so resolveApiKey("$VAR") finds the key.
  const keys = loadApiKeys(dataDir.root)
  injectKeysIntoEnv(keys)

  // 3. Load config (env vars are now set, $VAR references resolve correctly).
  const runtime = prepareRuntimeConfig(await loadConfig({ dataDir: dataDir.root }), dataDir.workplace)
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
  config = memoryPreparation.config
  if (memoryPreparation.error) {
    console.error(`[memory-v3] ${memoryPreparation.operation} recovery pending: ${memoryPreparation.error}`)
  }
  if (runtime.migratedDefaultWorkspace || memoryPreparation.configChanged) {
    await saveConfig(config, join(dataDir.root, 'config.json'))
  }

  // 4. Any registered Memory v3 operation has now completed or failed closed;
  //    config follows the durable locator before the first runtime writer starts.

  // 5. Create embedded runner.
  runner = await createRunner({
    config,
    branding,
    model,
    bootstrapDir: dataDir.root,
    containerRoot: dataDir.root,
    tokenizerFetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  })
  runActivity.setRunners([runner])

  // 6. Project + session + archive indexes for UI sidebar and settings.
  projectIndex = new ProjectIndex({ dataDir: dataDir.root })
  await projectIndex.removeManagedWorkspaceShells(dataDir.workplace)
  sessionIndex = new SessionIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  await sessionIndex.list()
  archiveIndex = new ArchiveIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  await archiveIndex.migrateManagedWorkspaceMetadata()
  terminalActivityIndex = new TerminalActivityIndex({ dataDir: dataDir.root })
  workspaceArtifactIndex = new WorkspaceArtifactIndex({ dataDir: dataDir.root })
  workspaceLayoutIndex = new WorkspaceLayoutIndex({ dataDir: dataDir.root })
  getEmbeddedBrowserSession()

  // Save module-level state for rebuildRunner.
  currentConfig = config
  currentBranding = branding
  currentModel = model
  currentDataDir = dataDir.root
  currentBootstrapDir = dataDir.root
  currentWorkplaceDir = dataDir.workplace

  // 7. Start local app API server on loopback (random free port).
  providerCalibrationToken = randomBytes(32).toString('base64url')
  server = await startLocalAppApiServer(runner, {
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
  })
  await writeLocalAppApiLocator(dataDir.root, {
    version: 1,
    host: '127.0.0.1',
    port: server.port,
    token: providerCalibrationToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })

  // 8. Start the optional plugin host. Built-in channel implementations use
  //    dynamic imports and are activated only when their channel type is enabled.
  pluginHost = createPluginHost({
    runner,
    bindingsFile: join(dataDir.channels, 'bindings.json'),
    pluginInstallDir: dataDir.plugins,
    pluginDataDir: dataDir.pluginData,
    config,
    builtinSources: BUILTIN_PLUGIN_SOURCES,
    log: ((level: 'info' | 'warn' | 'error', msg: string) =>
      console.log(`[plugins:${level}] ${msg}`)) as LogFn,
  })
  server.setPluginHost(pluginHost)
  void pluginHost.start().catch((err) => {
    console.error('[plugins] host failed to start:', err)
  })

  // 9. Expose server port to renderer via env (preload reads it).
  process.env['LITTLESHEEP_API_PORT'] = String(server.port)

  // 10. Create the visible shell and its explicit background control surface.
  desktopShell.initialize()
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
    void bootstrap()
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
    desktopShell.dispose()
    void runShutdownSequence([
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
