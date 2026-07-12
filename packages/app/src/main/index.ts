// @littlesheep/app — main/index.ts
// Electron main process entry.
//
// Bootstrap sequence:
//   1. Load branding + data dirs
//   2. Load + decrypt API keys from keychain → inject into process.env
//   3. Load config (resolveApiKey("$VAR") now finds keys in env)
//   4. Create embedded Runner (in-process agent loop, origin='app')
//   5. Initialize ProjectIndex + SessionIndex + ArchiveIndex (UI metadata)
//   6. Start local app API server on 127.0.0.1 (random port)
//   7. Expose port to renderer via env var (preload reads it)
//   8. Create BrowserWindow

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
import { createRunner, type AgentRunner, type LogFn } from '@littlesheep/runner'
import { createGatewayService, type GatewayService } from '@littlesheep/gateway'
import { createWebhookPlugin } from '@littlesheep/channel-webhook'
import { createTelegramPlugin } from '@littlesheep/channel-telegram'
import { createFeishuPlugin } from '@littlesheep/channel-feishu'
import { createQqbotPlugin } from '@littlesheep/channel-qqbot'
import { startLocalAppApiServer, type LocalAppApiServer } from './local-app-api-server.js'
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

let runner: AgentRunner | null = null
let server: LocalAppApiServer | null = null
let gatewayService: GatewayService | null = null
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
    },
  })

  // Open external links in the system browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
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
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) showWindow(win)
  }, 4000)

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
  gatewayService?.setConfig(config)
  if (currentDataDir) {
    await saveConfig(config, join(currentDataDir, 'config.json'))
  }
}

async function updateRuntimeConfig(config: Config): Promise<void> {
  const modelChanged = config.agents.defaults.model !== currentConfig?.agents.defaults.model
  await persistRuntimeConfig(config)
  if (modelChanged) {
    await rebuildRunner()
  }
}

async function bootstrap(): Promise<void> {
  // 1. Load branding + data dirs.
  const branding = await loadBranding()
  const dataDir = dataSubdirs(branding)
  await ensureUserDataLayout(dataDir)

  // 2. Load + decrypt API keys from keychain → inject into process.env.
  //    Must happen BEFORE loadConfig so resolveApiKey("$VAR") finds the key.
  const keys = loadApiKeys(dataDir.root)
  injectKeysIntoEnv(keys)

  // 3. Load config (env vars are now set, $VAR references resolve correctly).
  const runtime = prepareRuntimeConfig(await loadConfig({ dataDir: dataDir.root }), dataDir.workplace)
  const config = runtime.config
  const model = runtime.model
  if (runtime.migratedDefaultWorkspace) {
    await saveConfig(config, join(dataDir.root, 'config.json'))
  }

  // 4. Create embedded runner.
  runner = await createRunner({ config, branding, model, bootstrapDir: dataDir.root })

  // 5. Project + session + archive indexes for UI sidebar and settings.
  projectIndex = new ProjectIndex({ dataDir: dataDir.root })
  await projectIndex.removeByPath(dataDir.workplace)
  sessionIndex = new SessionIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  archiveIndex = new ArchiveIndex({ dataDir: dataDir.root, workplaceDir: dataDir.workplace })
  await archiveIndex.removeProjectByPath(dataDir.workplace)
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

  // 6. Start local app API server on loopback (random free port).
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
  })

  // 7. Start channel gateway service (embedded in-process).
  //    Factories for all 4 channel types are registered; only enabled channels
  //    in config.channels.channels will actually start. Fire-and-forget so a
  //    channel failure doesn't block window creation.
  gatewayService = createGatewayService({
    runner,
    bindingsFile: join(dataDir.channels, 'bindings.json'),
    config,
    pluginFactories: new Map([
      ['webhook', createWebhookPlugin],
      ['telegram', createTelegramPlugin],
      ['feishu', createFeishuPlugin],
      ['qqbot', createQqbotPlugin],
    ]),
    log: ((level: 'info' | 'warn' | 'error', msg: string) =>
      console.log(`[gateway:${level}] ${msg}`)) as LogFn,
  })
  void gatewayService.start().catch((err) => {
    console.error('[gateway] failed to start channels:', err)
  })

  // 7b. Inject external channel gateway service into the local app API server.
  server.setChannelGatewayService(gatewayService)

  // 8. Expose server port to renderer via env (preload reads it).
  process.env['LITTLESHEEP_API_PORT'] = String(server.port)

  // 9. Create window.
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
  gatewayService?.setRunner(newRunner)
  gatewayService?.setConfig(currentConfig)

  // 3. Delay closing old runner to let in-flight requests complete.
  //    vectorStore writes are fire-and-forget; 5s covers most run windows.
  if (oldRunner) {
    setTimeout(() => {
      void oldRunner.shutdown().catch(() => {
        /* best-effort: old runner shutdown failure is non-fatal */
      })
    }, 5000)
  }
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
      { name: 'external channels', run: () => gatewayService?.stop() },
      { name: 'runner', run: () => runner?.shutdown() },
    ], {
      stepTimeoutMs: 1500,
      onWarning: (message) => console.warn(`[shutdown] ${message}`),
    }).finally(() => app.exit(0))
  })
}
