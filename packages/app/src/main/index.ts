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

import { app, BrowserWindow, shell, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
import { DataRootMigrationManager } from './data-root-migration.js'
import { prepareMemoryV3Bootstrap } from './memory-v3-bootstrap.js'

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

// Module-level state for runner rebuild (triggered by API key change).
let currentConfig: Config | null = null
let currentBranding: BrandingConfig | null = null
let currentModel: string = ''
let currentDataDir: string = ''
let currentBootstrapDir: string = ''
let currentWorkplaceDir: string = ''
let rebuildMutex: Promise<void> | null = null
const retiredRunners = new Map<AgentRunner, NodeJS.Timeout>()
const MAX_RETIRED_RUNNERS = 4

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
    // Focus the existing window when a second instance tries to launch.
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      showWindow(wins[0]!)
    }
  })
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'LittleSheep',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#e8e8e8',
      height: 32,
    },
    backgroundColor: '#181818',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep hidden work display-driven and throttled. Visible animations are
      // still scheduled by Chromium against the active monitor's VSync.
      backgroundThrottling: true,
      // Web pages are rendered in an isolated guest surface so navigation
      // and links remain inside LS instead of escaping to the system browser.
      webviewTag: true,
    },
  })

  // The renderer owns internal web navigation. Never turn a webpage link into
  // an unexpected system-browser window from the host shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//iu.test(url) && /^(mailto|tel):/iu.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Guest webviews are the LS browser surface. A page opening a new window
  // must be routed back into the same guest, never into the system browser.
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//iu.test(url)) void guestContents.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
    guestContents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//iu.test(url)) event.preventDefault()
    })
  })

  // F12 / Ctrl+Shift+I to toggle DevTools (Electron 36 doesn't bind F12 by default).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  win.once('ready-to-show', () => showWindow(win))
  win.webContents.once('did-finish-load', () => {
    if (!win.isVisible()) showWindow(win)
  })
  const showFallbackTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) showWindow(win)
  }, 4000)
  win.once('closed', () => clearTimeout(showFallbackTimer))

  // Dev: load from vite dev server. Prod: load built index.html.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
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
  runner = await createRunner({ config, branding, model, bootstrapDir: dataDir.root })

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

  // Save module-level state for rebuildRunner.
  currentConfig = config
  currentBranding = branding
  currentModel = model
  currentDataDir = dataDir.root
  currentBootstrapDir = dataDir.root
  currentWorkplaceDir = dataDir.workplace

  // 7. Start local app API server on loopback (random free port).
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
    rebuildRunner,
    updateRuntimeConfig,
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
      app.quit()
    },
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

  // 10. Create window.
  createWindow()
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
}

function scheduleRetiredRunnerShutdown(retiredRunner: AgentRunner): void {
  const timer = setTimeout(() => {
    retiredRunners.delete(retiredRunner)
    void retiredRunner.shutdown().catch(() => undefined)
  }, 5000)
  retiredRunners.set(retiredRunner, timer)

  while (retiredRunners.size > MAX_RETIRED_RUNNERS) {
    const oldest = retiredRunners.entries().next().value as [AgentRunner, NodeJS.Timeout] | undefined
    if (!oldest) break
    const [oldestRunner, oldestTimer] = oldest
    clearTimeout(oldestTimer)
    retiredRunners.delete(oldestRunner)
    void oldestRunner.shutdown().catch(() => undefined)
  }
}

async function shutdownRetiredRunners(): Promise<void> {
  const entries = [...retiredRunners.entries()]
  retiredRunners.clear()
  for (const [, timer] of entries) clearTimeout(timer)
  await Promise.all(entries.map(([retiredRunner]) => retiredRunner.shutdown().catch(() => undefined)))
}

// Only the instance that holds the single-instance lock should bootstrap.
// The losing instance calls app.quit() above and never reaches here.
if (gotLock) {
  app.whenReady().then(() => {
    void bootstrap()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (shutdownStarted) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    shutdownStarted = true
    void runShutdownSequence([
      { name: 'local app API', run: () => server?.stop() },
      { name: 'plugins', run: () => pluginHost?.stop() },
      { name: 'retired runners', run: shutdownRetiredRunners },
      { name: 'runner', run: () => runner?.shutdown() },
    ], {
      stepTimeoutMs: 5000,
      onWarning: (message) => console.warn(`[shutdown] ${message}`),
    }).finally(() => app.exit(0))
  })
}
