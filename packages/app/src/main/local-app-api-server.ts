// @littlesheep/app — local-app-api-server.ts
// Local app API server on 127.0.0.1 (loopback only) exposing AgentRunner.run to the
// renderer process. This is the renderer-main bridge for the desktop app;
// optional extensions are owned by @littlesheep/plugins and exposed here
// through plugin and channel control endpoints.
//
// Bound to a random free port at startup (port=0); the actual port is
// exposed to the renderer via the preload contextBridge.
//
// Endpoints:
//   POST   /run                       — run the agent on a user message
//   POST   /run/stream                — run the agent and stream assistant deltas via SSE
//   GET    /sessions                  — list session metadata for the sidebar
//   GET    /sessions/:id/messages     — read session message history
//   DELETE /sessions/:id              — archive or hard-delete a session
//   GET    /runs/:runId               — replay an execution log by run id
//   GET    /state                     — runner state (model, current session)
//   GET    /config/providers          — list providers + API key status
//   GET    /skills                    — list loaded skills (name + description)
//   GET    /skills/:name              — read a skill's SKILL.md body
//   GET    /memory                    — list daily memory dates + long-term snapshot
//   GET    /memory/tree               — memory tree overview for the settings UI
//   POST   /memory/tree/nodes/:id/manage — archive, restore, delete or retier one memory node
//   POST   /memory/tree/resources/:id/manage — disable, restore, relocate or remove one registration
//   GET    /memory/projects/:id/projection — inspect one project's private memory projection
//   POST   /memory/projects/:id/projection — enable, sync, disable, clean or export project memory
//   GET    /projects                  — list registered project workspaces
//   POST   /projects/register         — explicitly register an existing folder as a project
//   POST   /projects/:id/rebind       — preserve project identity after a folder move or rename
//   DELETE /projects/:id              — archive or hard-delete a project record
//   POST   /projects/create-folder    — create a project folder under a selected parent
//   GET    /workspace/list            — list one directory inside the current workspace
//   GET    /workspace/preview         — read a safe, read-only preview for a workspace file
//   POST   /workspace/save            — save a text workspace file after renderer approval
//   GET    /workspace/layout          — read auditable renderer workspace layout mirror
//   POST   /workspace/layout          — save auditable renderer workspace layout mirror
//   GET    /workspace/artifacts       — list recent files produced or modified in a workspace/session
//   POST   /workspace/open            — open a workspace file/folder with the OS default app
//   POST   /workspace/open-vscode     — open a workspace file/folder in VS Code
//   POST   /workspace/terminal/run    — run a non-interactive shell command in the workspace
//   POST   /workspace/terminal/stream — stream a workspace shell command via SSE
//   GET    /workspace/terminal/activity — list recent user terminal commands
//   POST   /workspace/terminal/session — start an interactive workspace shell session
//   GET    /workspace/terminal/session/:id/stream — stream a workspace shell session
//   POST   /workspace/terminal/session/:id/input — write a command to a workspace shell session
//   POST   /workspace/terminal/session/:id/resize — remember the terminal viewport size
//   POST   /workspace/terminal/session/:id/interrupt — send Ctrl+C/SIGINT to a workspace shell session
//   DELETE /workspace/terminal/session/:id — stop a workspace shell session
//   GET    /archive                   — list archived projects and sessions
//   POST   /archive/sessions/:id/restore
//   POST   /archive/projects/:id/restore
//   DELETE /archive/sessions/:id      — permanently delete an archived session
//   DELETE /archive/projects/:id      — permanently delete an archived project record
//   POST   /config/apikey             — save API key + rebuild runner
//   GET    /plugins                   — installed plugin manifests and runtime state
//   POST   /plugins/reload            — rediscover and reload optional plugins
//   POST   /plugins/:id/enabled       — enable or disable one plugin
//   POST   /plugins/local-code        — update the explicit local-code trust gate
//   GET    /channels/status           — external channel connection status
//   POST   /channels/reload           — reload external channel connections
//   GET    /data-root                 — inspect the active data directory and pending operation
//   POST   /data-root/select          — choose a migration target with the native picker
//   POST   /data-root/migration       — register a migration for the next application start
//   DELETE /data-root/migration       — cancel an uncommitted migration or rollback request
//   POST   /data-root/rollback        — register a switch back to the previous data directory
//   POST   /application/restart       — restart the desktop application after responding

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { closeHttpServer } from './http-server-shutdown.js'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../shared/local-app-api-routes.js'
import type { AgentRunner, RunInput } from '@littlesheep/runner'
import { asSessionId, type Message } from '@littlesheep/types'
import type { Config } from '@littlesheep/config'
import { SessionIndex, type SessionMeta } from './session-index.js'
import { ProjectIndex } from './project-index.js'
import { ProjectRebindingService } from './project-rebinding.js'
import { sameBoundPath } from './path-rebinding.js'
import { ArchiveIndex } from './archive-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex, type WorkspaceArtifactInput } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { workspaceShellConfig } from './workspace-shell.js'
import { normalizePermissionModeId } from './modes.js'
import { resolveRunPolicy, type RunApprovalBroker } from './run-policy.js'
import {
  createInspectAttachmentTool,
  parseAttachments,
  prepareRunAttachments,
  type AttachmentRef,
} from './attachments.js'
import { ManagedAttachmentCache } from './attachment-cache.js'
import type { DataRootMigrationManager } from './data-root-migration.js'
import type { PluginHost } from '@littlesheep/plugins'
import { isSessionScope, type SessionScope } from '../shared/session-scope.js'
import {
  HttpError,
  json,
  readJson,
  writeSse,
  type LocalAppApiRequest,
} from './local-app-api/http.js'
import { routeExtensions } from './local-app-api/extension-routes.js'
import {
  buildRuntimePayload,
  resolveReasoning,
  routeRuntime,
} from './local-app-api/runtime-routes.js'
import { routeMemory } from './local-app-api/memory-routes.js'
import { routeSessions } from './local-app-api/session-routes.js'
import { routeWorkspace } from './local-app-api/workspace-routes.js'
import {
  isPathInsideOrSame,
  normalizeOptionalSessionId,
  normalizePositiveInt,
  resolveWorkspaceContextForPath,
  resolveWorkspaceRoot,
  resolveWorkspaceRootFromValue,
  syncWorkspaceResourceChanges,
} from './local-app-api/workspace-support.js'

const MAX_TERMINAL_COMMAND_BYTES = 16 * 1024
const MAX_TERMINAL_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000
const MAX_TERMINAL_TIMEOUT_MS = 300_000
const MAX_ACTIVE_STREAM_RUNS = 16
const MAX_PENDING_APPROVALS = 64
const MAX_WORKSPACE_TERMINAL_SESSIONS = 16
const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 }
const MIN_TERMINAL_COLS = 20
const MAX_TERMINAL_COLS = 360
const MIN_TERMINAL_ROWS = 6
const MAX_TERMINAL_ROWS = 120
interface PendingApproval {
  resolve: (approved: boolean) => void
  cleanup: () => void
}

const pendingApprovals = new Map<string, PendingApproval>()

interface WorkspaceTerminalSessionSnapshot {
  sessionId: string
  cwd: string
  shell: string
  backend: 'pty' | 'spawn'
  cols: number
  rows: number
}

interface WorkspaceTerminalSessionEvents {
  start: [WorkspaceTerminalSessionSnapshot]
  stdout: [string]
  stderr: [string]
  exit: [{ exitCode: number | null; signal: string | null }]
  error: [Error]
}

interface WorkspaceTerminalProcess {
  readonly kind: 'pty' | 'spawn'
  readonly label: string
  write(data: string): void
  resize(cols: number, rows: number): void
  interrupt(): void
  kill(): void
  onData(listener: (stream: 'stdout' | 'stderr', text: string) => void): void
  onExit(listener: (event: { exitCode: number | null; signal: string | null }) => void): void
  onError(listener: (err: Error) => void): void
}

class WorkspaceTerminalSession extends EventEmitter<WorkspaceTerminalSessionEvents> {
  readonly sessionId = randomUUID()
  readonly root: string
  readonly shellLabel: string
  readonly backend: 'pty' | 'spawn'
  private readonly terminal: WorkspaceTerminalProcess
  private readonly outputHistory: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
  private size: { cols: number; rows: number }
  private exited = false
  private exitInfo: { exitCode: number | null; signal: string | null } | null = null

  private constructor(root: string, size: { cols: number; rows: number }, terminal: WorkspaceTerminalProcess) {
    super()
    this.root = root
    this.size = size
    this.terminal = terminal
    this.backend = terminal.kind
    this.shellLabel = terminal.label
    this.terminal.onData((stream, text) => this.pushOutput(stream, text))
    this.terminal.onError((err) => this.emit('error', err))
    this.terminal.onExit((event) => {
      this.exited = true
      this.exitInfo = event
      this.emit('exit', this.exitInfo)
    })
    queueMicrotask(() => this.emit('start', this.snapshot()))
  }

  static async create(root: string, size = DEFAULT_TERMINAL_SIZE): Promise<WorkspaceTerminalSession> {
    const normalizedSize = normalizeTerminalSize(size)
    const terminal = await createWorkspaceTerminalProcess(root, normalizedSize)
    return new WorkspaceTerminalSession(root, normalizedSize, terminal)
  }

  snapshot(): WorkspaceTerminalSessionSnapshot {
    return {
      sessionId: this.sessionId,
      cwd: this.root,
      shell: this.shellLabel,
      backend: this.backend,
      cols: this.size.cols,
      rows: this.size.rows,
    }
  }

  replayTo(res: ServerResponse): void {
    writeSse(res, 'start', this.snapshot())
    for (const item of this.outputHistory) {
      writeSse(res, item.stream, { text: item.text })
    }
    if (this.exitInfo) writeSse(res, 'exit', this.exitInfo)
  }

  writeCommand(command: string): void {
    this.writeInput(`${command}\r`)
  }

  writeInput(data: string): void {
    if (this.exited) throw new HttpError(410, 'terminal session has exited')
    this.terminal.write(data)
  }

  resize(cols: number, rows: number): WorkspaceTerminalSessionSnapshot {
    this.size = normalizeTerminalSize({ cols, rows })
    this.terminal.resize(this.size.cols, this.size.rows)
    return this.snapshot()
  }

  interrupt(): void {
    if (this.exited) return
    this.terminal.interrupt()
  }

  kill(): void {
    if (this.exited) return
    this.terminal.kill()
  }

  private pushOutput(stream: 'stdout' | 'stderr', text: string): void {
    this.outputHistory.push({ stream, text })
    let totalChars = this.outputHistory.reduce((sum, item) => sum + item.text.length, 0)
    while (this.outputHistory.length > 0 && totalChars > MAX_TERMINAL_OUTPUT_BYTES) {
      const removed = this.outputHistory.shift()
      totalChars -= removed?.text.length ?? 0
    }
    this.emit(stream, text)
  }
}

class WorkspaceTerminalSessionManager {
  private readonly sessions = new Map<string, WorkspaceTerminalSession>()
  private readonly removalTimers = new Map<string, NodeJS.Timeout>()
  private closed = false

  async create(root: string, size = DEFAULT_TERMINAL_SIZE): Promise<WorkspaceTerminalSession> {
    if (this.closed) throw new HttpError(503, 'terminal session manager is stopped')
    if (this.sessions.size >= MAX_WORKSPACE_TERMINAL_SESSIONS) {
      throw new HttpError(429, 'too many workspace terminal sessions')
    }
    const session = await WorkspaceTerminalSession.create(root, size)
    this.sessions.set(session.sessionId, session)
    session.once('exit', () => {
      if (this.closed) return
      const timer = windowSetTimeout(() => {
        this.removalTimers.delete(session.sessionId)
        if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId)
      }, 30_000)
      this.removalTimers.set(session.sessionId, timer)
    })
    return session
  }

  get(sessionId: string): WorkspaceTerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new HttpError(404, `terminal session not found: ${sessionId}`)
    return session
  }

  close(sessionId: string): void {
    const timer = this.removalTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.removalTimers.delete(sessionId)
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.kill()
  }

  closeAll(): void {
    this.closed = true
    for (const timer of this.removalTimers.values()) clearTimeout(timer)
    this.removalTimers.clear()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) session.kill()
  }
}

const workspaceTerminalSessions = new WorkspaceTerminalSessionManager()

interface PendingTerminalCommandCapture {
  terminalSessionId: string
  command: string
  cwd: string
  workspacePath: string
  appSessionId?: string
  startedAt: string
  startedAtMs: number
  stdout: string
  stderr: string
  cleanup: () => void
}

const pendingTerminalCommandCaptures = new Map<string, PendingTerminalCommandCapture>()

function windowSetTimeout(fn: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(fn, ms)
}

type NodePtyModule = typeof import('node-pty')
let nodePtyModulePromise: Promise<NodePtyModule | null> | null = null

async function createWorkspaceTerminalProcess(root: string, size: { cols: number; rows: number }): Promise<WorkspaceTerminalProcess> {
  const pty = await loadNodePty()
  if (pty) {
    try {
      return createPtyTerminalProcess(pty, root, size)
    } catch (err) {
      console.warn(`[workspace-terminal] node-pty failed, falling back to spawn: ${(err as Error).message}`)
    }
  }
  return createSpawnTerminalProcess(root, size)
}

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import('node-pty')
      .catch((err) => {
        console.warn(`[workspace-terminal] node-pty unavailable, falling back to spawn: ${(err as Error).message}`)
        return null
      })
  }
  return nodePtyModulePromise
}

function createPtyTerminalProcess(
  pty: NodePtyModule,
  root: string,
  size: { cols: number; rows: number },
): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const terminal = pty.spawn(shellConfig.command, shellConfig.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: root,
    env: process.env,
    encoding: process.platform === 'win32' ? undefined : 'utf8',
    useConpty: process.platform === 'win32' ? true : undefined,
    useConptyDll: process.platform === 'win32' ? true : undefined,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  terminal.onData((text) => {
    for (const listener of dataListeners) listener('stdout', text)
  })
  terminal.onExit((event) => {
    const signal = event.signal === undefined ? null : String(event.signal)
    for (const listener of exitListeners) listener({ exitCode: event.exitCode, signal })
  })
  return {
    kind: 'pty',
    label: `${shellConfig.label} PTY`,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    interrupt: () => terminal.write('\x03'),
    kill: () => terminal.kill(),
    onData: (listener) => { dataListeners.add(listener) },
    onExit: (listener) => { exitListeners.add(listener) },
    onError: () => undefined,
  }
}

function createSpawnTerminalProcess(root: string, _size: { cols: number; rows: number }): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const child = spawn(shellConfig.command, shellConfig.args, {
    cwd: root,
    env: process.env,
    windowsHide: true,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  const errorListeners = new Set<(err: Error) => void>()
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) listener('stdout', chunk.toString('utf8'))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) listener('stderr', chunk.toString('utf8'))
  })
  child.once('error', (err) => {
    for (const listener of errorListeners) listener(err)
  })
  child.once('close', (exitCode, signal) => {
    for (const listener of exitListeners) listener({ exitCode, signal })
  })
  return {
    kind: 'spawn',
    label: `${shellConfig.label} fallback`,
    write: (data) => {
      const stdin = child.stdin
      if (!stdin?.writable) throw new HttpError(410, 'terminal session has exited')
      stdin.write(data)
    },
    resize: () => undefined,
    interrupt: () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        return
      }
      child.kill('SIGINT')
    },
    kill: () => killSpawnedProcessTree(child),
    onData: (listener) => { dataListeners.add(listener) },
    onExit: (listener) => { exitListeners.add(listener) },
    onError: (listener) => { errorListeners.add(listener) },
  }
}

function killSpawnedProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    killer.once('error', () => child.kill())
    killer.once('close', () => child.kill())
    return
  }
  child.kill()
}

export interface LocalAppApiServerOptions {
  /** Port to listen on. 0 = random free port. */
  port?: number
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
  terminalActivityIndex: TerminalActivityIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  workspaceLayoutIndex: WorkspaceLayoutIndex
  /** Current config (for listing providers). */
  config: Config
  /** Data dir root (for keychain read/write). */
  dataDir: string
  /** Agent-owned fallback working directory. */
  workplaceDir: string
  /** Trigger runner rebuild (after API key change). */
  rebuildRunner: () => Promise<void>
  /** Persist runtime config changes and rebuild/swap services when needed. */
  updateRuntimeConfig: (config: Config) => Promise<void>
  /** Open a native folder picker from the Electron main process. */
  selectWorkspace?: () => Promise<string | null>
  /** Open a native file picker from the Electron main process. */
  selectAttachments?: () => Promise<AttachmentRef[]>
  /** Open a native save dialog for an explicitly requested shareable project-memory export. */
  selectProjectMemoryExport?: (projectName: string, projectPath: string) => Promise<string | null>
  /** Open a native file picker to relocate a missing workspace memory resource. */
  selectMemoryResourceSource?: () => Promise<string | null>
  /** Data-root migration control. Omitted in non-Electron tests that do not need it. */
  dataRootManager?: DataRootMigrationManager
  /** Open a native directory picker for the next data-root target. */
  selectDataRootTarget?: () => Promise<string | null>
  /** Schedule a full application restart after the API response has been flushed. */
  restartApplication?: () => void
}

export interface LocalAppApiServer {
  readonly port: number
  /** Hot-swap the runner (used after API key rebuild). */
  setRunner(r: AgentRunner): void
  /** Inject the optional plugin host after the core API is listening. */
  setPluginHost(host: PluginHost): void
  /** Update the config reference used by settings and extension endpoints. */
  setConfig(c: Config): void
  stop(): Promise<void>
}

export async function startLocalAppApiServer(
  initialRunner: AgentRunner,
  opts: LocalAppApiServerOptions,
): Promise<LocalAppApiServer> {
  // Mutable runner reference — allows hot-swapping without restarting the
  // Local API server (port stays the same, renderer's apiBase remains valid).
  let currentRunner = initialRunner
  // The core API remains usable while the optional plugin host is absent or loading.
  let currentPluginHost: PluginHost | null = null
  let currentConfig: Config = opts.config
  const activeRunControllers = new Set<AbortController>()
  const projectRebinding = new ProjectRebindingService({
    dataDir: opts.dataDir,
    projectIndex: opts.projectIndex,
    sessionIndex: opts.sessionIndex,
    archiveIndex: opts.archiveIndex,
    workspaceArtifactIndex: opts.workspaceArtifactIndex,
    terminalActivityIndex: opts.terminalActivityIndex,
    workspaceLayoutIndex: opts.workspaceLayoutIndex,
    rebindMemory: (previous, project) => currentRunner.infra.memoryService.rebindProjectPath(previous, project),
    rebindRuntimeWorkspace: async (fromPath, toPath) => {
      const currentWorkspace = currentConfig.agents.defaults.workspace || opts.workplaceDir
      if (!sameBoundPath(currentWorkspace, fromPath)) return
      const next: Config = {
        ...currentConfig,
        agents: {
          ...currentConfig.agents,
          defaults: { ...currentConfig.agents.defaults, workspace: toPath },
        },
      }
      currentConfig = next
      await opts.updateRuntimeConfig(next)
    },
  })
  try {
    await projectRebinding.recoverPending()
  } catch (error) {
    console.error(`[projects] pending path rebind recovery failed: ${(error as Error).message}`)
  }
  const attachmentCache = new ManagedAttachmentCache({
    rootDir: join(opts.dataDir, 'attachment-cache'),
  })
  try {
    await attachmentCache.initialize()
  } catch (error) {
    console.error(`[attachments] managed cache initialization failed: ${(error as Error).message}`)
  }

  return new Promise<LocalAppApiServer>((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      route(
        req,
        res,
        () => currentRunner,
        () => currentPluginHost,
        () => currentConfig,
        (c: Config) => { currentConfig = c },
        opts,
        projectRebinding,
        attachmentCache,
        activeRunControllers,
      ).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500
        if (!res.headersSent) {
          json(res, status, { error: (err as Error).message })
        } else {
          res.end()
        }
      })
    })

    server.on('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        setRunner: (r: AgentRunner) => {
          currentRunner = r
        },
        setPluginHost: (host: PluginHost) => {
          currentPluginHost = host
        },
        setConfig: (c: Config) => {
          currentConfig = c
        },
        stop: async () => {
          for (const controller of activeRunControllers) controller.abort()
          activeRunControllers.clear()
          settlePendingApprovals()
          for (const capture of pendingTerminalCommandCaptures.values()) capture.cleanup()
          pendingTerminalCommandCaptures.clear()
          workspaceTerminalSessions.closeAll()
          await closeHttpServer(server)
        },
      })
    })
  })
}

type RunnerGetter = () => AgentRunner
type PluginHostGetter = () => PluginHost | null

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  getRunner: RunnerGetter,
  getPluginHost: PluginHostGetter,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  opts: LocalAppApiServerOptions,
  projectRebinding: ProjectRebindingService,
  attachmentCache: ManagedAttachmentCache,
  activeRunControllers: Set<AbortController>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'
  const runner = getRunner()
  const sessionIndex = opts.sessionIndex
  const projectIndex = opts.projectIndex
  const archiveIndex = opts.archiveIndex
  const terminalActivityIndex = opts.terminalActivityIndex
  const workspaceArtifactIndex = opts.workspaceArtifactIndex
  const workspaceLayoutIndex = opts.workspaceLayoutIndex

  const approvalId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.approvals)
  if (method === 'POST' && approvalId !== null) {
    const id = approvalId
    const body = await readJson(req)
    const pending = pendingApprovals.get(id)
    if (!pending) {
      json(res, 404, { error: `approval request not found: ${id}` })
      return
    }
    pendingApprovals.delete(id)
    pending.cleanup()
    pending.resolve(body.approved === true)
    json(res, 200, { ok: true })
    return
  }

  // POST /run/stream — run runner.runStream and emit assistant deltas as SSE.
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.runStream) {
    if (activeRunControllers.size >= MAX_ACTIVE_STREAM_RUNS) {
      json(res, 429, { error: 'too many active agent runs' })
      return
    }
    const body = await readJson(req)
    const controller = new AbortController()
    activeRunControllers.add(controller)
    let completed = false
    req.on('close', () => {
      if (!completed) controller.abort()
    })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    writeSse(res, 'start', { ok: true })

    try {
      const cwd = resolveWorkspace(body, getConfig(), opts)
      const ownership = await resolveRunSessionOwnership(sessionIndex, projectIndex, body)
      const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, opts.workplaceDir)
      const reasoning = resolveReasoning(body, getConfig())
      const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
        managedCache: attachmentCache,
        workplaceDir: opts.workplaceDir,
        workspaceDir: cwd,
        projectId: ownership.projectId,
      })
      const inspectAttachmentTool = createInspectAttachmentTool(attachments)
      const text = String(body.text ?? '')
      const result = await runner.runStream(
        {
          text,
          sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
          origin: 'app',
          cwd,
          reasoning,
          attachments,
          additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
          workspaceContext,
          signal: controller.signal,
          onToolEvent: (evt) => writeSse(res, evt.type, evt),
          ...resolveRunPolicy(
            body,
            getConfig(),
            buildSseApprovalBroker((request) => writeSse(res, 'approval_request', request), controller.signal),
          ),
        },
        (delta) => writeSse(res, 'delta', { delta }),
      )

      await updateSessionIndex(sessionIndex, result.sessionId, body, ownership, cwd)
      if (ownership.projectId) await projectIndex.touch(ownership.projectId)
      const artifacts = await appendAgentArtifacts(workspaceArtifactIndex, result, cwd, ownership.projectId)
      if (artifacts.length > 0) {
        await syncWorkspaceResourceChanges(runner, cwd, {
          ...workspaceContext,
          changes: artifacts.map((artifact) => ({ path: artifact.path, source: 'agent' })),
        })
      }
      writeSse(res, 'result', result)
    } catch (err) {
      writeSse(res, 'error', { error: (err as Error).message })
    } finally {
      completed = true
      activeRunControllers.delete(controller)
      res.end()
    }
    return
  }

  // POST /run — run runner.run (origin='app' for local conversations)
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.run) {
    const body = await readJson(req)
    const cwd = resolveWorkspace(body, getConfig(), opts)
    const ownership = await resolveRunSessionOwnership(sessionIndex, projectIndex, body)
    const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, opts.workplaceDir)
    const reasoning = resolveReasoning(body, getConfig())
    const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
      managedCache: attachmentCache,
      workplaceDir: opts.workplaceDir,
      workspaceDir: cwd,
      projectId: ownership.projectId,
    })
    const inspectAttachmentTool = createInspectAttachmentTool(attachments)
    const text = String(body.text ?? '')
    const result = await runner.run({
      text,
      sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
      origin: 'app',
      cwd,
      reasoning,
      attachments,
      additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
      workspaceContext,
      ...resolveRunPolicy(body, getConfig()),
    })
    // Update session index for UI sidebar.
    // Title: only set for NEW sessions — don't overwrite on subsequent messages.
    await updateSessionIndex(sessionIndex, result.sessionId, body, ownership, cwd)
    if (ownership.projectId) await projectIndex.touch(ownership.projectId)
    const artifacts = await appendAgentArtifacts(workspaceArtifactIndex, result, cwd, ownership.projectId)
    if (artifacts.length > 0) {
      await syncWorkspaceResourceChanges(runner, cwd, {
        ...workspaceContext,
        changes: artifacts.map((artifact) => ({ path: artifact.path, source: 'agent' })),
      })
    }
    json(res, 200, result)
    return
  }

  const routeRequest: LocalAppApiRequest = { req, res, url, path, method }
  if (await routeSessions(routeRequest, {
    getRunner,
    getConfig,
    workplaceDir: opts.workplaceDir,
    sessionIndex,
    projectIndex,
    archiveIndex,
    projectRebinding,
  })) return

  if (await routeRuntime(routeRequest, {
    getRunner,
    getConfig,
    setConfig,
    workplaceDir: opts.workplaceDir,
    dataDir: opts.dataDir,
    rebuildRunner: opts.rebuildRunner,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    dataRootManager: opts.dataRootManager,
    selectDataRootTarget: opts.selectDataRootTarget,
    restartApplication: opts.restartApplication,
  })) return

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceSelect) {
    if (!opts.selectWorkspace) {
      json(res, 501, { error: 'workspace picker is not available' })
      return
    }
    const selected = await opts.selectWorkspace()
    json(res, 200, { path: selected })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.attachmentSelect) {
    if (!opts.selectAttachments) {
      json(res, 501, { error: 'attachment picker is not available' })
      return
    }
    const files = await opts.selectAttachments()
    json(res, 200, { files })
    return
  }

  // GET /config/providers — list providers + API key status
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.attachmentImport) {
    const body = await readJson(req, MAX_ATTACHMENT_IMPORT_BODY_BYTES)
    const file = await attachmentCache.importData(body)
    json(res, 200, { file })
    return
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceList) {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? root)
    const payload = await listWorkspaceDirectory(root, target)
    json(res, 200, payload)
    return
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspacePreview) {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? '')
    const payload = await previewWorkspaceFile(root, target)
    json(res, 200, payload)
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceSave) {
    const body = await readJson(req, MAX_WORKSPACE_SAVE_BODY_BYTES)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    const payload = await saveWorkspaceTextFile(root, target, body)
    await workspaceArtifactIndex.append({
      path: target,
      action: 'modified',
      source: 'user',
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(body.sessionId),
    })
    const workspaceContext = await resolveWorkspaceContextForPath(projectIndex, root, opts.workplaceDir)
    await syncWorkspaceResourceChanges(runner, root, {
      ...workspaceContext,
      changes: [{ path: target, source: 'user' }],
    })
    json(res, 200, payload)
    return
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceLayout) {
    json(res, 200, { snapshot: await workspaceLayoutIndex.read() })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceLayout) {
    const body = await readJson(req)
    const snapshot = await workspaceLayoutIndex.save(body)
    json(res, 200, { snapshot })
    return
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceArtifacts) {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const records = await workspaceArtifactIndex.list({
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(url.searchParams.get('sessionId')),
      limit: normalizePositiveInt(url.searchParams.get('limit'), 50, 300),
    })
    json(res, 200, { records })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceOpen) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    const error = await shell.openPath(target)
    if (error) {
      json(res, 500, { error })
      return
    }
    json(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceOpenVscode) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const requestedPath = typeof body.path === 'string' && body.path.trim() ? body.path : root
    const target = resolveWorkspaceTarget(root, requestedPath)
    await openInVSCode(target)
    json(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalSession) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const info = await stat(root)
    if (!info.isDirectory()) throw new HttpError(400, 'workspace root is not a directory')
    const session = await workspaceTerminalSessions.create(root, normalizeTerminalSize(body))
    json(res, 200, session.snapshot())
    return
  }

  if (path.startsWith(LOCAL_APP_API_PREFIXES.terminalSessions)) {
    const rest = path.slice('/workspace/terminal/session/'.length)
    const [encodedSessionId, action = ''] = rest.split('/')
    const terminalSessionId = decodeURIComponent(encodedSessionId ?? '')
    if (!terminalSessionId) {
      json(res, 400, { error: 'terminal session id is required' })
      return
    }

    if (method === 'GET' && action === 'stream') {
      const session = workspaceTerminalSessions.get(terminalSessionId)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const onStdout = (text: string) => writeSse(res, 'stdout', { text })
      const onStderr = (text: string) => writeSse(res, 'stderr', { text })
      const onExit = (event: { exitCode: number | null; signal: string | null }) => writeSse(res, 'exit', event)
      const onError = (err: Error) => writeSse(res, 'error', { error: err.message })
      session.on('stdout', onStdout)
      session.on('stderr', onStderr)
      session.on('exit', onExit)
      session.on('error', onError)
      session.replayTo(res)
      res.on('close', () => {
        session.off('stdout', onStdout)
        session.off('stderr', onStderr)
        session.off('exit', onExit)
        session.off('error', onError)
      })
      return
    }

    if (method === 'POST' && action === 'input') {
      const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
      const command = typeof body.command === 'string' ? body.command.trim() : ''
      if (!command) {
        json(res, 400, { error: 'command is required' })
        return
      }
      if (Buffer.byteLength(command, 'utf8') > MAX_TERMINAL_COMMAND_BYTES) {
        throw new HttpError(413, `命令超过 ${Math.round(MAX_TERMINAL_COMMAND_BYTES / 1024)} KB。`)
      }
      if (command.includes('\u0000')) {
        throw new HttpError(400, 'command contains invalid characters')
      }
      const session = workspaceTerminalSessions.get(terminalSessionId)
      await finalizePendingTerminalCommandCapture(terminalSessionId, terminalActivityIndex, {
        signal: 'next-command',
      })
      startTerminalCommandCapture(session, command, normalizeOptionalSessionId(body.sessionId), terminalActivityIndex)
      try {
        session.writeCommand(command)
      } catch (err) {
        await finalizePendingTerminalCommandCapture(terminalSessionId, terminalActivityIndex, {
          signal: 'send-failed',
        })
        throw err
      }
      json(res, 200, { ok: true })
      return
    }

    if (method === 'POST' && action === 'resize') {
      const body = await readJson(req)
      const session = workspaceTerminalSessions.get(terminalSessionId)
      json(res, 200, session.resize(
        typeof body.cols === 'number' ? body.cols : DEFAULT_TERMINAL_SIZE.cols,
        typeof body.rows === 'number' ? body.rows : DEFAULT_TERMINAL_SIZE.rows,
      ))
      return
    }

    if (method === 'POST' && action === 'interrupt') {
      const session = workspaceTerminalSessions.get(terminalSessionId)
      session.interrupt()
      await finalizePendingTerminalCommandCapture(terminalSessionId, terminalActivityIndex, {
        signal: 'interrupt',
      })
      json(res, 200, { ok: true })
      return
    }

    if (method === 'DELETE' && !action) {
      await finalizePendingTerminalCommandCapture(terminalSessionId, terminalActivityIndex, {
        signal: 'closed',
      })
      workspaceTerminalSessions.close(terminalSessionId)
      res.writeHead(204)
      res.end()
      return
    }
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalRun) {
    const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (!command) {
      json(res, 400, { error: 'command is required' })
      return
    }
    const timeoutMs = clampTerminalTimeout(body.timeoutMs)
    const payload = await runWorkspaceTerminalCommand(root, command, timeoutMs)
    await terminalActivityIndex.append({
      ...payload,
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(body.sessionId),
    })
    json(res, 200, payload)
    return
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.terminalActivity) {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const sessionId = normalizeOptionalSessionId(url.searchParams.get('sessionId'))
    const limitRaw = Number(url.searchParams.get('limit') ?? '30')
    const records = await terminalActivityIndex.list({
      workspacePath: root,
      sessionId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 30,
    })
    json(res, 200, { records })
    return
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalStream) {
    const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (!command) {
      json(res, 400, { error: 'command is required' })
      return
    }
    const timeoutMs = clampTerminalTimeout(body.timeoutMs)
    let completed = false
    let cancelCommand: (() => void) | null = null
    res.on('close', () => {
      if (!completed) cancelCommand?.()
    })
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    try {
      const payload = await runWorkspaceTerminalCommand(root, command, timeoutMs, {
        onStart: (cancel) => {
          cancelCommand = cancel
          writeSse(res, 'start', { command, cwd: root })
        },
        onStdout: (text) => writeSse(res, 'stdout', { text }),
        onStderr: (text) => writeSse(res, 'stderr', { text }),
        onTruncated: () => writeSse(res, 'truncated', { truncated: true }),
      })
      await terminalActivityIndex.append({
        ...payload,
        workspacePath: root,
        sessionId: normalizeOptionalSessionId(body.sessionId),
      })
      writeSse(res, 'result', payload)
    } catch (err) {
      writeSse(res, 'error', { error: (err as Error).message })
    } finally {
      completed = true
      res.end()
    }
    return
  }

  if (await routeExtensions(routeRequest, {
    getPluginHost,
    getConfig,
    setConfig,
    dataDir: opts.dataDir,
    updateRuntimeConfig: opts.updateRuntimeConfig,
  })) return

  if (await routeMemory(routeRequest, {
    getRunner,
    projectIndex,
    getConfig,
    setConfig,
    updateRuntimeConfig: opts.updateRuntimeConfig,
    selectProjectMemoryExport: opts.selectProjectMemoryExport,
    selectMemoryResourceSource: opts.selectMemoryResourceSource,
  })) return

  json(res, 404, { error: `Not found: ${method} ${path}` })
}

function resolveWorkspaceRoot(
  url: URL,
  config: Config,
  opts: LocalAppApiServerOptions,
): string {
  return resolveWorkspaceRootFromValue(url.searchParams.get('root'), config, opts)
}

function resolveWorkspaceRootFromValue(
  value: unknown,
  config: Config,
  opts: LocalAppApiServerOptions,
): string {
  const requested = typeof value === 'string' ? value.trim() : ''
  return resolve(requested || config.agents.defaults.workspace || opts.workplaceDir)
}

function resolveWorkspaceTarget(root: string, value: string): string {
  if (!value.trim()) throw new HttpError(400, 'workspace path is required')
  const target = resolve(root, value)
  if (!isPathInsideOrSame(root, target)) {
    throw new HttpError(403, 'workspace path is outside the selected workspace')
  }
  return target
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function listWorkspaceDirectory(root: string, target: string) {
  const info = await lstat(target)
  if (!info.isDirectory()) throw new HttpError(400, 'workspace path is not a directory')

  const rawEntries = await readdir(target, { withFileTypes: true })
  let hiddenCount = 0
  const visibleEntries = rawEntries
    .filter((entry) => {
      if (entry.isSymbolicLink()) {
        hiddenCount += 1
        return false
      }
      if (entry.isDirectory() && HEAVY_WORKSPACE_DIRS.has(entry.name.toLowerCase())) {
        hiddenCount += 1
        return false
      }
      return true
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  const limited = visibleEntries.slice(0, MAX_WORKSPACE_DIR_ENTRIES)
  const entries = await Promise.all(limited.map(async (entry) => {
    const itemPath = resolve(target, entry.name)
    if (!isPathInsideOrSame(root, itemPath)) return null
    const itemInfo = await lstat(itemPath).catch(() => null)
    if (!itemInfo || itemInfo.isSymbolicLink()) return null
    const kind = itemInfo.isDirectory() ? 'directory' : 'file'
    return {
      name: entry.name,
      path: itemPath,
      relativePath: relative(root, itemPath),
      kind,
      size: kind === 'file' ? itemInfo.size : undefined,
      modifiedAt: itemInfo.mtimeMs,
    }
  }))

  return {
    root,
    path: target,
    relativePath: relative(root, target),
    entries: entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    truncated: visibleEntries.length > limited.length,
    hiddenCount,
  }
}

async function previewWorkspaceFile(root: string, target: string) {
  const info = await stat(target)
  if (!info.isFile()) throw new HttpError(400, 'workspace path is not a file')

  const name = basename(target)
  const lowerName = name.toLowerCase()
  const ext = extname(lowerName)
  const base = {
    path: target,
    name,
    relativePath: relative(root, target),
    size: info.size,
    modifiedAt: info.mtimeMs,
  }

  const surface = classifyWorkspaceFileSurface(lowerName, ext)
  if (surface === 'imagePreview') return { ...base, kind: 'image' as const }
  if (surface === 'pdfPreview') return { ...base, kind: 'pdf' as const }
  if (surface === 'documentCard') {
    return {
      ...base,
      kind: 'unsupported' as const,
      reason: 'Word、PPT、Excel 等 Office 文件当前使用系统默认应用打开，避免把二进制内容放进内置代码编辑器。',
    }
  }
  if (info.size > MAX_TEXT_PREVIEW_BYTES) {
    return {
      ...base,
      kind: 'unsupported' as const,
      reason: `文件超过 ${Math.round(MAX_TEXT_PREVIEW_BYTES / 1024)} KB，当前阶段不内联预览。`,
    }
  }

  if (surface === 'builtinEditor' && WORKSPACE_MARKDOWN_EXTS.has(ext)) {
    return { ...base, kind: 'markdown' as const, content: await readUtf8Preview(target) }
  }

  if (surface === 'builtinEditor') {
    return {
      ...base,
      kind: 'text' as const,
      language: previewLanguageForWorkspaceFile(lowerName, ext),
      content: await readUtf8Preview(target),
    }
  }

  const detectedTextContent = await readUtf8PreviewIfLikely(target)
  if (detectedTextContent !== null) {
    return {
      ...base,
      kind: 'text' as const,
      language: previewLanguageForWorkspaceFile(lowerName, ext),
      content: detectedTextContent,
    }
  }

  return {
    ...base,
    kind: 'unsupported' as const,
    reason: '这个文件看起来不是文本或代码文件，可以用系统默认应用打开。',
  }
}

async function saveWorkspaceTextFile(root: string, target: string, body: Record<string, unknown>) {
  const content = typeof body.content === 'string' ? body.content : null
  if (content === null) throw new HttpError(400, 'content must be a string')
  const contentBytes = Buffer.byteLength(content, 'utf8')
  if (contentBytes > MAX_TEXT_SAVE_BYTES) {
    throw new HttpError(413, `文件超过 ${Math.round(MAX_TEXT_SAVE_BYTES / 1024)} KB，当前阶段不支持内置保存。`)
  }

  const info = await lstat(target)
  if (info.isSymbolicLink()) throw new HttpError(403, 'workspace save does not follow symbolic links')
  if (!info.isFile()) throw new HttpError(400, 'workspace path is not a file')

  const lowerName = basename(target).toLowerCase()
  const ext = extname(lowerName)
  const surface = classifyWorkspaceFileSurface(lowerName, ext)
  if (surface !== 'builtinEditor') {
    if (surface !== 'sniffText' || info.size > MAX_TEXT_PREVIEW_BYTES || await readUtf8PreviewIfLikely(target) === null) {
      throw new HttpError(415, '当前阶段只支持保存文本或 Markdown 文件。')
    }
  }

  const expectedModifiedAt = typeof body.expectedModifiedAt === 'number' ? body.expectedModifiedAt : undefined
  if (expectedModifiedAt !== undefined && info.mtimeMs > expectedModifiedAt + 1) {
    throw new HttpError(409, '文件已被外部修改。请刷新预览后再保存，避免覆盖新的内容。')
  }

  await writeFile(target, content, 'utf8')
  return previewWorkspaceFile(root, target)
}

async function readUtf8Preview(path: string): Promise<string> {
  const content = await readFile(path, 'utf8')
  return content.replace(/\u0000/g, '�')
}

async function readUtf8PreviewIfLikely(path: string): Promise<string | null> {
  const buffer = await readFile(path)
  if (!looksLikeTextBuffer(buffer)) return null
  return buffer.toString('utf8')
}

function looksLikeTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  const sample = buffer.subarray(0, Math.min(TEXT_SNIFF_BYTES, buffer.length))
  let suspiciousControlBytes = 0

  for (const byte of sample) {
    if (byte === 0) return false
    const isTextControl = byte === 9 || byte === 10 || byte === 12 || byte === 13
    if (byte < 32 && !isTextControl) suspiciousControlBytes += 1
  }

  if (suspiciousControlBytes / sample.length > 0.02) return false

  const decoded = sample.toString('utf8')
  const replacementChars = decoded.split('\uFFFD').length - 1
  return replacementChars / Math.max(1, decoded.length) <= 0.01
}

async function openInVSCode(target: string): Promise<void> {
  const command = await resolveVSCodeCommand()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const args = ['--reuse-window', target]
    const child = process.platform === 'win32'
      ? spawn([quoteWindowsShellArg(command), ...args.map(quoteWindowsShellArg)].join(' '), {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      : spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      })

    child.once('error', (err) => {
      rejectPromise(new HttpError(500, `无法启动 VS Code：${err.message}`))
    })
    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolvePromise()
        return
      }
      rejectPromise(new HttpError(500, '无法启动 VS Code。请确认已安装 VS Code，并且 code 命令可用。'))
    })
    child.unref()
  })
}

function clampTerminalTimeout(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TERMINAL_TIMEOUT_MS
  return Math.max(1_000, Math.min(MAX_TERMINAL_TIMEOUT_MS, Math.round(requested)))
}

function normalizeTerminalSize(value: unknown): { cols: number; rows: number } {
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawCols = typeof payload.cols === 'number' && Number.isFinite(payload.cols)
    ? payload.cols
    : DEFAULT_TERMINAL_SIZE.cols
  const rawRows = typeof payload.rows === 'number' && Number.isFinite(payload.rows)
    ? payload.rows
    : DEFAULT_TERMINAL_SIZE.rows
  return {
    cols: Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.round(rawCols))),
    rows: Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.round(rawRows))),
  }
}

function normalizeOptionalSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function startTerminalCommandCapture(
  session: WorkspaceTerminalSession,
  command: string,
  appSessionId: string | undefined,
  terminalActivityIndex: TerminalActivityIndex,
): void {
  const terminalSessionId = session.sessionId
  const startedAtMs = Date.now()
  const capture: PendingTerminalCommandCapture = {
    terminalSessionId,
    command,
    cwd: session.root,
    workspacePath: session.root,
    appSessionId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    stdout: '',
    stderr: '',
    cleanup: () => undefined,
  }

  const onStdout = (text: string) => {
    capture.stdout = appendTerminalCaptureText(capture.stdout, text)
  }
  const onStderr = (text: string) => {
    capture.stderr = appendTerminalCaptureText(capture.stderr, text)
  }
  const onExit = (event: { exitCode: number | null; signal: string | null }) => {
    void finalizePendingTerminalCommandCapture(terminalSessionId, terminalActivityIndex, event)
  }
  capture.cleanup = () => {
    session.off('stdout', onStdout)
    session.off('stderr', onStderr)
    session.off('exit', onExit)
  }
  session.on('stdout', onStdout)
  session.on('stderr', onStderr)
  session.once('exit', onExit)
  pendingTerminalCommandCaptures.set(terminalSessionId, capture)
}

async function finalizePendingTerminalCommandCapture(
  terminalSessionId: string,
  terminalActivityIndex: TerminalActivityIndex,
  result: { exitCode?: number | null; signal?: string | null } = {},
): Promise<void> {
  const capture = pendingTerminalCommandCaptures.get(terminalSessionId)
  if (!capture) return
  pendingTerminalCommandCaptures.delete(terminalSessionId)
  capture.cleanup()

  const endedAtMs = Date.now()
  await terminalActivityIndex.append({
    command: capture.command,
    cwd: capture.cwd,
    workspacePath: capture.workspacePath,
    sessionId: capture.appSessionId,
    startedAt: capture.startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - capture.startedAtMs,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? 'captured',
    timedOut: false,
    truncated: false,
    stdout: capture.stdout,
    stderr: capture.stderr,
  })
}

function appendTerminalCaptureText(current: string, chunk: string): string {
  const next = current + chunk
  if (next.length <= MAX_TERMINAL_OUTPUT_BYTES) return next
  return next.slice(next.length - MAX_TERMINAL_OUTPUT_BYTES)
}

function normalizePositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(raw)) return fallback
  return Math.max(1, Math.min(max, Math.round(raw)))
}

interface WorkspaceTerminalCommandEvents {
  onStart?: (cancel: () => void) => void
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  onTruncated?: () => void
}

async function runWorkspaceTerminalCommand(
  root: string,
  command: string,
  timeoutMs: number,
  events: WorkspaceTerminalCommandEvents = {},
) {
  const commandBytes = Buffer.byteLength(command, 'utf8')
  if (commandBytes > MAX_TERMINAL_COMMAND_BYTES) {
    throw new HttpError(413, `命令超过 ${Math.round(MAX_TERMINAL_COMMAND_BYTES / 1024)} KB。`)
  }
  if (command.includes('\u0000')) {
    throw new HttpError(400, 'command contains invalid characters')
  }

  const info = await stat(root)
  if (!info.isDirectory()) throw new HttpError(400, 'workspace root is not a directory')

  const shellCommand = process.platform === 'win32'
    ? (process.env.ComSpec && process.env.ComSpec.toLowerCase().endsWith('powershell.exe') ? process.env.ComSpec : 'powershell.exe')
    : (process.env.SHELL || '/bin/sh')
  const normalizedCommand = process.platform === 'win32'
    ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`
    : command
  const encodedCommand = process.platform === 'win32'
    ? Buffer.from(normalizedCommand, 'utf16le').toString('base64')
    : ''
  const shellArgs = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand]
    : ['-lc', normalizedCommand]
  const startedAt = performance.now()

  return new Promise<{
    command: string
    cwd: string
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    truncated: boolean
  }>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let truncated = false
    let truncationNotified = false
    let timedOut = false

    function notifyTruncated() {
      truncated = true
      if (truncationNotified) return
      truncationNotified = true
      events.onTruncated?.()
    }

    function appendOutput(target: 'stdout' | 'stderr', chunk: Buffer) {
      const remaining = MAX_TERMINAL_OUTPUT_BYTES - outputBytes
      if (remaining <= 0) {
        notifyTruncated()
        return
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      const text = slice.toString('utf8')
      if (target === 'stdout') {
        stdout += text
        events.onStdout?.(text)
      } else {
        stderr += text
        events.onStderr?.(text)
      }
      outputBytes += slice.length
      if (slice.length < chunk.length) notifyTruncated()
    }

    const child = spawn(shellCommand, shellArgs, {
      cwd: root,
      env: process.env,
      windowsHide: true,
    })
    events.onStart?.(() => {
      if (child.killed) return
      child.kill()
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk))
    child.once('error', (err) => {
      clearTimeout(timeout)
      const message = stderr ? `\n${err.message}` : err.message
      stderr += message
      events.onStderr?.(message)
      resolvePromise({
        command,
        cwd: root,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        truncated,
      })
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        const message = `\n命令超过 ${Math.round(timeoutMs / 1000)} 秒，已停止。`
        stderr += stderr ? message : message.trimStart()
        events.onStderr?.(message)
      }
      resolvePromise({
        command,
        cwd: root,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        truncated,
      })
    })
  })
}

async function resolveVSCodeCommand(): Promise<string> {
  const candidates = vscodeCommandCandidates()
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    if (await pathExists(candidate)) return candidate
  }
  return 'code'
}

function vscodeCommandCandidates(): string[] {
  if (process.platform !== 'win32') return ['/usr/local/bin/code', '/opt/homebrew/bin/code', 'code']
  return [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    'code',
  ].filter(Boolean)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function quoteWindowsShellArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function updateSessionIndex(
  sessionIndex: SessionIndex,
  sessionId: string,
  body: Record<string, unknown>,
  ownership: { scope: SessionScope; projectId?: string },
  workspacePath: string,
): Promise<void> {
  const existing = (await sessionIndex.list()).find((s) => s.id === sessionId)
  const updates: {
    title?: string
    lastMessageAt: number
    mode: string
    scope: SessionScope
    projectId?: string
    workspacePath: string
  } = {
    lastMessageAt: Date.now(),
    mode: normalizePermissionModeId(typeof body.permissionMode === 'string' ? body.permissionMode : String(body.mode ?? '')),
    scope: ownership.scope,
    projectId: ownership.projectId,
    workspacePath,
  }
  if (!existing) {
    updates.title = String(body.text ?? '').slice(0, 60) || 'New session'
  }
  await sessionIndex.upsert(sessionId, updates)
}

async function resolveRunSessionOwnership(
  sessionIndex: SessionIndex,
  projectIndex: ProjectIndex,
  body: Record<string, unknown>,
): Promise<{ scope: SessionScope; projectId?: string }> {
  const requestedScope = isSessionScope(body.sessionScope) ? body.sessionScope : undefined
  const requestedProjectId = typeof body.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : undefined
  const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : undefined
  const existing = requestedSessionId
    ? (await sessionIndex.list()).find((session) => session.id === requestedSessionId)
    : undefined

  if (existing) {
    if (requestedScope && requestedScope !== existing.scope) {
      throw new HttpError(409, 'session ownership cannot be changed')
    }
    if (
      existing.scope === 'project' &&
      requestedProjectId &&
      requestedProjectId !== existing.projectId
    ) {
      throw new HttpError(409, 'session belongs to a different project')
    }
    return { scope: existing.scope, projectId: existing.projectId }
  }

  if (requestedScope !== 'project') return { scope: 'standalone' }
  if (!requestedProjectId) throw new HttpError(400, 'project sessions require projectId')
  const project = (await projectIndex.list()).find((item) => item.id === requestedProjectId)
  if (!project) throw new HttpError(404, `project not found: ${requestedProjectId}`)
  return { scope: 'project', projectId: project.id }
}

function resolveRunWorkspaceContext(
  workspacePath: string,
  ownership: { scope: SessionScope; projectId?: string },
  workplaceDir: string,
): NonNullable<RunInput['workspaceContext']> {
  if (ownership.projectId) return { boundaryKind: 'project', projectId: ownership.projectId }
  return {
    boundaryKind: sameBoundPath(workspacePath, workplaceDir) ? 'agent_workplace' : 'user_workplace',
  }
}

async function resolveWorkspaceContextForPath(
  projectIndex: ProjectIndex,
  workspacePath: string,
  workplaceDir: string,
): Promise<NonNullable<RunInput['workspaceContext']>> {
  const project = (await projectIndex.list()).find((item) => sameBoundPath(item.path, workspacePath))
  return project
    ? { boundaryKind: 'project', projectId: project.id }
    : { boundaryKind: sameBoundPath(workspacePath, workplaceDir) ? 'agent_workplace' : 'user_workplace' }
}

async function syncWorkspaceResourceChanges(
  runner: AgentRunner,
  workspacePath: string,
  options: Parameters<AgentRunner['infra']['memoryService']['syncWorkspaceResources']>[1],
): Promise<void> {
  try {
    await runner.infra.memoryService.syncWorkspaceResources(workspacePath, options)
  } catch (error) {
    console.error(`[workspace-index] incremental sync degraded: ${(error as Error).message}`)
  }
}

async function appendAgentArtifacts(
  artifactIndex: WorkspaceArtifactIndex,
  result: { runId: string; sessionId: string; messages?: Message[] },
  workspacePath: string,
  projectId?: string,
): Promise<WorkspaceArtifactInput[]> {
  const artifacts = extractWorkspaceArtifactsFromMessages(result.messages ?? [], {
    workspacePath,
    sessionId: result.sessionId,
    projectId,
    runId: result.runId,
  })
  if (artifacts.length === 0) return []
  await artifactIndex.appendMany(artifacts)
  return artifacts
}

function extractWorkspaceArtifactsFromMessages(
  messages: Message[],
  context: { workspacePath: string; sessionId: string; projectId?: string; runId: string },
): WorkspaceArtifactInput[] {
  const calls = new Map<string, { name: string; input: unknown }>()
  const results = new Map<string, { ok: boolean }>()

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_calls') {
        for (const call of block.calls) calls.set(call.id, { name: call.name, input: call.input })
      } else if (block.type === 'tool_result') {
        results.set(block.result.callId, { ok: block.result.ok })
      }
    }
  }

  const byPath = new Map<string, WorkspaceArtifactInput>()
  for (const [callId, call] of calls) {
    const result = results.get(callId)
    if (!result?.ok) continue
    const action = workspaceArtifactActionForTool(call.name)
    if (!action) continue
    const filePath = toolInputFilePath(call.input)
    if (!filePath) continue
    const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(context.workspacePath, filePath)
    if (!isPathInsideOrSame(context.workspacePath, resolvedPath)) continue
    byPath.set(resolvedPath, {
      path: resolvedPath,
      action,
      source: 'agent',
      workspacePath: context.workspacePath,
      sessionId: context.sessionId,
      projectId: context.projectId,
      runId: context.runId,
      toolName: call.name,
    })
  }
  return Array.from(byPath.values())
}

function workspaceArtifactActionForTool(name: string): WorkspaceArtifactInput['action'] | null {
  if (name === 'write' || name === 'write_file') return 'created'
  if (name === 'edit' || name === 'edit_file') return 'modified'
  return null
}

function toolInputFilePath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const value = record.file_path ?? record.path ?? record.filePath
  return typeof value === 'string' ? value.trim() : ''
}

function sameWorkspacePath(left: string, right: string): boolean {
  return resolve(left).replace(/[\\/]+$/, '').toLowerCase() === resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function resolveWorkspace(
  body: Record<string, unknown>,
  config: Config,
  opts: LocalAppApiServerOptions,
): string {
  const bodyWorkspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  return bodyWorkspace || config.agents.defaults.workspace || opts.workplaceDir
}

interface ApprovalRequestPayload {
  id: string
  action: string
  detail?: unknown
  permissionMode: string
  source: 'agent'
}

function buildSseApprovalBroker(
  requestApproval: (request: ApprovalRequestPayload) => void,
  signal?: AbortSignal,
): RunApprovalBroker {
  return async ({ action, detail, permissionMode }) => {
    const id = randomUUID()
    return new Promise<boolean>((resolveApproval) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      const settle = (allowed: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        pendingApprovals.delete(id)
        resolveApproval(allowed)
      }
      onAbort = () => settle(false)
      timer = setTimeout(() => settle(false), 120_000)
      while (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
        const oldest = pendingApprovals.values().next().value as PendingApproval | undefined
        if (!oldest) break
        oldest.cleanup()
        oldest.resolve(false)
      }
      pendingApprovals.set(id, { resolve: settle, cleanup })
      if (signal?.aborted) {
        settle(false)
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        requestApproval({ id, action, detail, permissionMode, source: 'agent' })
      } catch {
        settle(false)
      }
    })
  }
}

function settlePendingApprovals(): void {
  for (const pending of pendingApprovals.values()) {
    pending.cleanup()
    pending.resolve(false)
  }
  pendingApprovals.clear()
}
