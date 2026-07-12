// @littlesheep/app — local-app-api-server.ts
// Local app API server on 127.0.0.1 (loopback only) exposing AgentRunner.run to the
// renderer process. This is the renderer-main bridge for the desktop app;
// external messaging connectors live in @littlesheep/gateway and are exposed
// here under /channels/*.
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
//   GET    /projects                  — list registered project workspaces
//   POST   /projects/register         — explicitly register an existing folder as a project
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
//   GET    /channels/status           — external channel connection status
//   POST   /channels/reload           — reload external channel connections
//   GET    /gateway/status            — legacy alias for /channels/status
//   POST   /gateway/reload            — legacy alias for /channels/reload

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { closeHttpServer } from './http-server-shutdown.js'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import type { AgentRunner, ExecutionLog } from '@littlesheep/runner'
import { asSessionId, type Message } from '@littlesheep/types'
import type { Config } from '@littlesheep/config'
import { parseModelRef, resolveApiKey, loadConfig, withProviderPresets } from '@littlesheep/config'
import { SessionIndex, type SessionMeta } from './session-index.js'
import { ProjectIndex, type ProjectMeta } from './project-index.js'
import { ArchiveIndex, type ArchivedProjectMeta, type ArchivedSessionMeta } from './archive-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex, type WorkspaceArtifactInput } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import {
  WORKSPACE_MARKDOWN_EXTS,
  classifyWorkspaceFileSurface,
  previewLanguageForWorkspaceFile,
} from './workspace-file-routing.js'
import { workspaceShellConfig } from './workspace-shell.js'
import {
  buildMemoryTreePayload,
  manageRuntimeMemoryNode,
  type MemoryNodeManagementAction,
} from './memory-tree-control.js'
import { saveApiKey, injectKeysIntoEnv, deriveEnvVarName } from './keychain.js'
import {
  getAgentProfile,
  normalizeAgentProfileId,
  normalizePermissionModeId,
} from './modes.js'
import { resolveRunPolicy, type RunApprovalBroker } from './run-policy.js'
import {
  composeRunText,
  importAttachmentData,
  parseAttachments,
  prepareRunAttachments,
  type AttachmentRef,
} from './attachments.js'
import type { GatewayService } from '@littlesheep/gateway'
import {
  coerceReasoningForModelRef,
  isReasoningSupportedForModelRef,
  isRuntimeReasoning,
  type RuntimeReasoning,
} from '../shared/model-capabilities.js'
import { buildHistoryMessages } from '../shared/history-activity.js'
import { isSessionScope, sessionBelongsToProject, type SessionScope } from '../shared/session-scope.js'

const MAX_JSON_BODY_BYTES = 1024 * 1024
const MAX_ATTACHMENT_IMPORT_BODY_BYTES = 36 * 1024 * 1024
const MAX_WORKSPACE_DIR_ENTRIES = 320
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024
const MAX_TEXT_SAVE_BYTES = 1024 * 1024
const MAX_WORKSPACE_SAVE_BODY_BYTES = MAX_TEXT_SAVE_BYTES + 64 * 1024
const MAX_TERMINAL_COMMAND_BYTES = 16 * 1024
const MAX_TERMINAL_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000
const MAX_TERMINAL_TIMEOUT_MS = 300_000
const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 }
const MIN_TERMINAL_COLS = 20
const MAX_TERMINAL_COLS = 360
const MIN_TERMINAL_ROWS = 6
const MAX_TERMINAL_ROWS = 120
const MEMORY_NODE_MANAGEMENT_ACTIONS = new Set<MemoryNodeManagementAction>([
  'archive',
  'restore',
  'delete',
  'promote',
  'demote',
])
const TEXT_SNIFF_BYTES = 64 * 1024
const HEAVY_WORKSPACE_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'target',
])
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// Tracks whether a /channels/reload is in-flight. The local app API server is
// instantiated once per app process, so a module-level flag is safe here.
// Used to detect concurrent reload requests (logged as a warning for
// concurrency diagnosis — does NOT block/queue the second request).
let reloadInProgress = false
const pendingApprovals = new Map<string, (approved: boolean) => void>()

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

  async create(root: string, size = DEFAULT_TERMINAL_SIZE): Promise<WorkspaceTerminalSession> {
    const session = await WorkspaceTerminalSession.create(root, size)
    this.sessions.set(session.sessionId, session)
    session.once('exit', () => {
      windowSetTimeout(() => {
        if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId)
      }, 30_000)
    })
    return session
  }

  get(sessionId: string): WorkspaceTerminalSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new HttpError(404, `terminal session not found: ${sessionId}`)
    return session
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    session.kill()
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
}

export interface LocalAppApiServer {
  readonly port: number
  /** Hot-swap the runner (used after API key rebuild). */
  setRunner(r: AgentRunner): void
  /** Inject the external channel gateway service reference. */
  setChannelGatewayService(gs: GatewayService): void
  /** Update the config reference (used by /channels/reload endpoint). */
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
  // Mutable external channel gateway reference — injected after createGatewayService.
  let currentChannelGatewayService: GatewayService | null = null
  let currentConfig: Config = opts.config

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

      route(req, res, () => currentRunner, () => currentChannelGatewayService, () => currentConfig, (c: Config) => { currentConfig = c }, opts).catch((err) => {
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
        setChannelGatewayService: (gs: GatewayService) => {
          currentChannelGatewayService = gs
        },
        setConfig: (c: Config) => {
          currentConfig = c
        },
        stop: () => closeHttpServer(server),
      })
    })
  })
}

type RunnerGetter = () => AgentRunner
type ChannelGatewayServiceGetter = () => GatewayService | null

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  getRunner: RunnerGetter,
  getChannelGatewayService: ChannelGatewayServiceGetter,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  opts: LocalAppApiServerOptions,
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

  if (method === 'POST' && path.startsWith('/approvals/')) {
    const id = decodeURIComponent(path.slice('/approvals/'.length))
    const body = await readJson(req)
    const resolveApproval = pendingApprovals.get(id)
    if (!resolveApproval) {
      json(res, 404, { error: `approval request not found: ${id}` })
      return
    }
    pendingApprovals.delete(id)
    resolveApproval(body.approved === true)
    json(res, 200, { ok: true })
    return
  }

  // POST /run/stream — run runner.runStream and emit assistant deltas as SSE.
  if (method === 'POST' && path === '/run/stream') {
    const body = await readJson(req)
    const controller = new AbortController()
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
      const reasoning = resolveReasoning(body, getConfig())
      const attachments = await prepareRunAttachments(parseAttachments(body.attachments))
      const text = await composeRunText(String(body.text ?? ''), attachments)
      const result = await runner.runStream(
        {
          text,
          sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
          origin: 'app',
          cwd,
          reasoning,
          attachments,
          signal: controller.signal,
          onToolEvent: (evt) => writeSse(res, evt.type, evt),
          ...resolveRunPolicy(
            body,
            getConfig(),
            buildSseApprovalBroker((request) => writeSse(res, 'approval_request', request)),
          ),
        },
        (delta) => writeSse(res, 'delta', { delta }),
      )

      await updateSessionIndex(sessionIndex, result.sessionId, body, ownership, cwd)
      if (ownership.projectId) await projectIndex.touch(ownership.projectId)
      await appendAgentArtifacts(workspaceArtifactIndex, result, cwd, ownership.projectId)
      writeSse(res, 'result', result)
    } catch (err) {
      writeSse(res, 'error', { error: (err as Error).message })
    } finally {
      completed = true
      res.end()
    }
    return
  }

  // POST /run — run runner.run (origin='app' for local conversations)
  if (method === 'POST' && path === '/run') {
    const body = await readJson(req)
    const cwd = resolveWorkspace(body, getConfig(), opts)
    const ownership = await resolveRunSessionOwnership(sessionIndex, projectIndex, body)
    const reasoning = resolveReasoning(body, getConfig())
    const attachments = await prepareRunAttachments(parseAttachments(body.attachments))
    const text = await composeRunText(String(body.text ?? ''), attachments)
    const result = await runner.run({
      text,
      sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
      origin: 'app',
      cwd,
      reasoning,
      attachments,
      ...resolveRunPolicy(body, getConfig()),
    })
    // Update session index for UI sidebar.
    // Title: only set for NEW sessions — don't overwrite on subsequent messages.
    await updateSessionIndex(sessionIndex, result.sessionId, body, ownership, cwd)
    if (ownership.projectId) await projectIndex.touch(ownership.projectId)
    await appendAgentArtifacts(workspaceArtifactIndex, result, cwd, ownership.projectId)
    json(res, 200, result)
    return
  }

  if (method === 'GET' && path === '/projects') {
    const projects = await projectIndex.list()
    json(res, 200, { projects })
    return
  }

  if (method === 'POST' && path === '/projects/register') {
    const body = await readJson(req)
    const requestedPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!requestedPath) {
      json(res, 400, { error: 'project path is required' })
      return
    }
    const folderPath = resolve(requestedPath)
    try {
      const info = await stat(folderPath)
      if (!info.isDirectory()) {
        json(res, 400, { error: 'project path is not a directory' })
        return
      }
    } catch {
      json(res, 404, { error: 'project path does not exist' })
      return
    }
    const project = await projectIndex.ensure(folderPath)
    json(res, 200, { project })
    return
  }

  if (method === 'DELETE' && path.startsWith('/projects/')) {
    const id = decodeURIComponent(path.slice('/projects/'.length))
    const removed = await projectIndex.remove(id)
    if (!removed) {
      json(res, 404, { error: `project not found: ${id}` })
      return
    }

    const sessions = await sessionIndex.list()
    const projectSessions = sessions.filter((session) => sessionBelongsToProject(session, removed.id))

    if (url.searchParams.get('hard') === '1') {
      for (const session of projectSessions) {
        await sessionIndex.remove(session.id)
        await runner.sessionManager.delete(asSessionId(session.id))
      }
    } else {
      const archivedAt = Date.now()
      await archiveIndex.archiveProject(removed, archivedAt)
      for (const session of projectSessions) {
        await archiveIndex.archiveSession(session, archivedAt)
        await sessionIndex.remove(session.id)
      }
    }

    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'POST' && path === '/projects/create-folder') {
    const body = await readJson(req)
    const parentPath = typeof body.parentPath === 'string' ? body.parentPath.trim() : ''
    const rawName = typeof body.name === 'string' ? body.name.trim() : ''
    if (!parentPath || !rawName) {
      json(res, 400, { error: 'parentPath and name are required' })
      return
    }

    const folderName = sanitizeFolderName(rawName)
    if (!folderName) {
      json(res, 400, { error: 'folder name is invalid' })
      return
    }

    const parent = resolve(parentPath)
    const folderPath = resolve(join(parent, folderName))
    if (!isPathInside(parent, folderPath)) {
      json(res, 400, { error: 'folder path escapes selected parent' })
      return
    }

    try {
      await mkdir(folderPath, { recursive: false })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        json(res, 409, { error: 'folder already exists' })
        return
      }
      throw err
    }
    const project = await projectIndex.ensure(folderPath)
    json(res, 200, { path: folderPath, project })
    return
  }

  // GET /sessions — list sessions for sidebar
  if (method === 'GET' && path === '/sessions') {
    const sessions = await sessionIndex.list()
    json(res, 200, { sessions })
    return
  }

  // GET /sessions/:id/messages — read session message history
  if (method === 'GET' && path.startsWith('/sessions/') && path.endsWith('/messages')) {
    const id = path.slice('/sessions/'.length, -'/messages'.length)
    const messages = await runner.sessionManager.read(asSessionId(id))
    const logsByRunId = await loadExecutionLogsByRunId(runner, messages, id)
    // Transform to UI-friendly format: filter to user/assistant, extract text
    // and rehydrate completed agent activity from durable execution logs.
    const history = buildHistoryMessages(messages, logsByRunId)
    json(res, 200, { messages: history })
    return
  }

  // GET /runs/:runId — replay an execution log
  if (method === 'GET' && path.startsWith('/runs/')) {
    const runId = path.slice('/runs/'.length)
    const log = await runner.replay(runId)
    if (!log) {
      json(res, 404, { error: `run not found: ${runId}` })
      return
    }
    json(res, 200, log)
    return
  }

  // DELETE /sessions/:id — archive or hard-delete session from the sidebar.
  if (method === 'DELETE' && path.startsWith('/sessions/')) {
    const id = decodeURIComponent(path.slice('/sessions/'.length))
    const removed = await sessionIndex.remove(id)
    if (url.searchParams.get('hard') === '1') {
      await runner.sessionManager.delete(asSessionId(id))
    } else if (removed) {
      await archiveIndex.archiveSession(removed)
    }
    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'GET' && path === '/archive') {
    json(res, 200, await archiveIndex.list())
    return
  }

  if (method === 'POST' && path.startsWith('/archive/sessions/') && path.endsWith('/restore')) {
    const id = decodeURIComponent(path.slice('/archive/sessions/'.length, -'/restore'.length))
    const archive = await archiveIndex.list()
    const archivedSession = archive.sessions.find((item) => item.id === id)
    if (!archivedSession) {
      json(res, 404, { error: `archived session not found: ${id}` })
      return
    }
    const archivedProject = findArchivedProjectForSession(archive.projects, archivedSession)
    const restoredProject = archivedProject ? await archiveIndex.restoreProject(archivedProject.id) : undefined
    const session = await archiveIndex.restoreSession(id)
    if (!session) {
      json(res, 404, { error: `archived session not found: ${id}` })
      return
    }
    const activeProject = restoredProject ? toActiveProject(restoredProject) : undefined
    if (activeProject) await projectIndex.upsert(activeProject)
    await sessionIndex.upsert(session.id, toActiveSession(session))
    json(res, 200, { session: toActiveSessionWithId(session), project: activeProject })
    return
  }

  if (method === 'POST' && path.startsWith('/archive/projects/') && path.endsWith('/restore')) {
    const id = decodeURIComponent(path.slice('/archive/projects/'.length, -'/restore'.length))
    const project = await archiveIndex.restoreProject(id)
    if (!project) {
      json(res, 404, { error: `archived project not found: ${id}` })
      return
    }
    const activeProject = toActiveProject(project)
    await projectIndex.upsert(activeProject)
    const restoredSessions = await archiveIndex.restoreSessionsForProject(activeProject)
    for (const session of restoredSessions) {
      await sessionIndex.upsert(session.id, toActiveSession(session))
    }
    json(res, 200, {
      project: activeProject,
      sessions: restoredSessions.map(toActiveSessionWithId),
    })
    return
  }

  if (method === 'DELETE' && path.startsWith('/archive/sessions/')) {
    const id = decodeURIComponent(path.slice('/archive/sessions/'.length))
    const removed = await archiveIndex.removeSession(id)
    if (!removed) {
      json(res, 404, { error: `archived session not found: ${id}` })
      return
    }
    await runner.sessionManager.delete(asSessionId(id))
    res.writeHead(204)
    res.end()
    return
  }

  if (method === 'DELETE' && path.startsWith('/archive/projects/')) {
    const id = decodeURIComponent(path.slice('/archive/projects/'.length))
    const project = await archiveIndex.removeProject(id)
    if (!project) {
      json(res, 404, { error: `archived project not found: ${id}` })
      return
    }
    const sessions = await archiveIndex.removeSessionsForProject(project)
    for (const session of sessions) {
      await runner.sessionManager.delete(asSessionId(session.id))
    }
    res.writeHead(204)
    res.end()
    return
  }

  // GET /state — runner state
  if (method === 'GET' && path === '/state') {
    json(res, 200, runner.state)
    return
  }

  if (method === 'GET' && path === '/runtime') {
    json(res, 200, buildRuntimePayload(getConfig(), opts.workplaceDir))
    return
  }

  if (method === 'POST' && path === '/runtime') {
    const body = await readJson(req)
    const current = getConfig()
    const nextDefaults = { ...current.agents.defaults }

    if (typeof body.model === 'string' && body.model.trim()) {
      const model = body.model.trim()
      const validation = validateModelRef(current, model)
      if (validation) {
        json(res, 400, { error: validation })
        return
      }
      nextDefaults.model = model
    }

    if (typeof body.reasoning === 'string' && body.reasoning.trim()) {
      const reasoning = body.reasoning.trim()
      if (!isReasoning(reasoning)) {
        json(res, 400, { error: `invalid reasoning value: ${reasoning}` })
        return
      }
      if (!isReasoningSupportedForModelRef(reasoning, nextDefaults.model)) {
        json(res, 400, { error: `reasoning "${reasoning}" is not supported by model "${nextDefaults.model}"` })
        return
      }
      nextDefaults.reasoning = reasoning
    }

    if (typeof body.profile === 'string' && body.profile.trim()) {
      const profile = body.profile.trim()
      if (!getAgentProfile(profile)) {
        json(res, 400, { error: `invalid profile value: ${profile}` })
        return
      }
      nextDefaults.profile = normalizeAgentProfileId(profile)
    }

    nextDefaults.reasoning = coerceReasoningForModelRef(nextDefaults.reasoning, nextDefaults.model)

    if (Object.prototype.hasOwnProperty.call(body, 'workspace')) {
      const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
      nextDefaults.workspace = workspace || opts.workplaceDir
    }

    const next: Config = {
      ...current,
      agents: {
        ...current.agents,
        defaults: nextDefaults,
      },
    }
    setConfig(next)
    await opts.updateRuntimeConfig(next)
    json(res, 200, buildRuntimePayload(next, opts.workplaceDir))
    return
  }

  if (method === 'POST' && path === '/workspace/select') {
    if (!opts.selectWorkspace) {
      json(res, 501, { error: 'workspace picker is not available' })
      return
    }
    const selected = await opts.selectWorkspace()
    json(res, 200, { path: selected })
    return
  }

  if (method === 'POST' && path === '/attachments/select') {
    if (!opts.selectAttachments) {
      json(res, 501, { error: 'attachment picker is not available' })
      return
    }
    const files = await opts.selectAttachments()
    json(res, 200, { files })
    return
  }

  // GET /config/providers — list providers + API key status
  if (method === 'POST' && path === '/attachments/import') {
    const body = await readJson(req, MAX_ATTACHMENT_IMPORT_BODY_BYTES)
    const file = await importAttachmentData(opts.workplaceDir, body)
    json(res, 200, { file })
    return
  }

  if (method === 'GET' && path === '/workspace/list') {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? root)
    const payload = await listWorkspaceDirectory(root, target)
    json(res, 200, payload)
    return
  }

  if (method === 'GET' && path === '/workspace/preview') {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? '')
    const payload = await previewWorkspaceFile(root, target)
    json(res, 200, payload)
    return
  }

  if (method === 'POST' && path === '/workspace/save') {
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
    json(res, 200, payload)
    return
  }

  if (method === 'GET' && path === '/workspace/layout') {
    json(res, 200, { snapshot: await workspaceLayoutIndex.read() })
    return
  }

  if (method === 'POST' && path === '/workspace/layout') {
    const body = await readJson(req)
    const snapshot = await workspaceLayoutIndex.save(body)
    json(res, 200, { snapshot })
    return
  }

  if (method === 'GET' && path === '/workspace/artifacts') {
    const root = resolveWorkspaceRoot(url, getConfig(), opts)
    const records = await workspaceArtifactIndex.list({
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(url.searchParams.get('sessionId')),
      limit: normalizePositiveInt(url.searchParams.get('limit'), 50, 300),
    })
    json(res, 200, { records })
    return
  }

  if (method === 'POST' && path === '/workspace/open') {
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

  if (method === 'POST' && path === '/workspace/open-vscode') {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const requestedPath = typeof body.path === 'string' && body.path.trim() ? body.path : root
    const target = resolveWorkspaceTarget(root, requestedPath)
    await openInVSCode(target)
    json(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && path === '/workspace/terminal/session') {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, getConfig(), opts)
    const info = await stat(root)
    if (!info.isDirectory()) throw new HttpError(400, 'workspace root is not a directory')
    const session = await workspaceTerminalSessions.create(root, normalizeTerminalSize(body))
    json(res, 200, session.snapshot())
    return
  }

  if (path.startsWith('/workspace/terminal/session/')) {
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

  if (method === 'POST' && path === '/workspace/terminal/run') {
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

  if (method === 'GET' && path === '/workspace/terminal/activity') {
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

  if (method === 'POST' && path === '/workspace/terminal/stream') {
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

  if (method === 'GET' && path === '/config/providers') {
    const providers = getConfig().providers.map((p) => {
      const envVar = deriveEnvVarName(p.apiKey)
      const source: 'env' | 'literal' | 'none' = !p.apiKey
        ? 'none'
        : p.apiKey.startsWith('$')
          ? 'env'
          : 'literal'
      const hasKey = envVar ? !!resolveApiKey(p.apiKey) : false
      return {
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        envVar,
        hasKey,
        source,
      }
    })
    json(res, 200, { providers })
    return
  }

  // POST /config/apikey — save API key + rebuild runner
  if (method === 'POST' && path === '/config/apikey') {
    const body = await readJson(req)
    const envVar = String(body.envVar ?? '').trim()
    const key = String(body.key ?? '').trim()
    if (!envVar || !key) {
      json(res, 400, { error: 'envVar and key are required' })
      return
    }
    // 1. Encrypt and persist to keys.json
    await saveApiKey(opts.dataDir, envVar, key)
    // 2. Inject into process.env (immediate effect)
    injectKeysIntoEnv({ [envVar]: key })
    // 3. Rebuild runner (new LLM client picks up the new key from env)
    await opts.rebuildRunner()
    json(res, 200, { ok: true })
    return
  }

  // GET /channels/status — external channel connection status.
  // /gateway/status remains as a legacy alias for older renderers.
  if (method === 'GET' && (path === '/channels/status' || path === '/gateway/status')) {
    const gs = getChannelGatewayService()
    if (!gs) {
      json(res, 200, { started: false, channels: [], configured: [] })
      return
    }
    const plugins = gs.list()
    const configured = (getConfig().channels?.channels ?? []).map((c) => ({
      id: c.id,
      type: c.type,
      enabled: c.enabled,
      name: c.name,
    }))
    json(res, 200, {
      started: gs.started,
      channels: plugins.map((p) => ({
        type: p.type,
        displayName: p.displayName,
        running: p.running,
        requiredSecrets: p.requiredSecrets,
      })),
      configured,
    })
    return
  }

  // POST /channels/reload — reload config from disk + restart external channels.
  // /gateway/reload remains as a legacy alias for older renderers.
  if (method === 'POST' && (path === '/channels/reload' || path === '/gateway/reload')) {
    const gs = getChannelGatewayService()
    if (!gs) {
      json(res, 400, { error: 'external channel service is not available' })
      return
    }
    // Short request id for log correlation across phases.
    const reqId = Math.random().toString(36).slice(2, 8)
    const t0 = performance.now()
    if (reloadInProgress) {
      console.warn(
        `[local-app-api] [channels:reload:${reqId}] WARNING: concurrent reload detected — another reload is in progress`,
      )
    }
    reloadInProgress = true
    try {
      // 1. Reload config from disk (~/.littlesheep/config.json)
      const cfgT0 = performance.now()
      const newConfig = withProviderPresets(await loadConfig({ dataDir: opts.dataDir }))
      console.log(
        `[local-app-api] [channels:reload:${reqId}] config loaded from disk (${(performance.now() - cfgT0).toFixed(1)}ms)`,
      )
      // 2. Update server's config reference (so /channels/status reflects new config)
      setConfig(newConfig)
      // 3. Update external channel gateway service's config reference
      gs.setConfig(newConfig)
      // 4. Atomic reload: stop all channels, start with new config
      const reloadT0 = performance.now()
      await gs.reload()
      console.log(
        `[local-app-api] [channels:reload:${reqId}] service reload complete (${(performance.now() - reloadT0).toFixed(1)}ms)`,
      )
      json(res, 200, { ok: true })
      console.log(
        `[local-app-api] [channels:reload:${reqId}] total (${(performance.now() - t0).toFixed(1)}ms)`,
      )
      return
    } catch (err) {
      console.error(
        `[local-app-api] [channels:reload:${reqId}] failed (${(performance.now() - t0).toFixed(1)}ms): ${(err as Error).message}`,
      )
      json(res, 500, { error: `reload failed: ${(err as Error).message}` })
      return
    } finally {
      reloadInProgress = false
    }
  }

  // GET /skills — list loaded skills
  if (method === 'GET' && path === '/skills') {
    const skills = runner.infra.skillLoader.index.skills.map((s) => ({
      name: s.name,
      description: s.description,
    }))
    json(res, 200, { skills })
    return
  }

  // GET /skills/:name — read a skill's SKILL.md body
  if (method === 'GET' && path.startsWith('/skills/')) {
    const name = path.slice('/skills/'.length)
    const skill = runner.infra.skillLoader.index.skills.find((s) => s.name === name)
    if (!skill) { json(res, 404, { error: `skill not found: ${name}` }); return }
    const body = await runner.infra.skillLoader.loadBody(name)
    json(res, 200, { name: skill.name, description: skill.description, body: body ?? '' })
    return
  }

  // GET /memory — list daily memory dates + long-term excerpt
  if (method === 'POST' && path === '/memory/policy') {
    const body = await readJson(req)
    const threshold = typeof body.experienceWriteThreshold === 'number'
      ? body.experienceWriteThreshold
      : Number.NaN
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      json(res, 400, { error: 'experienceWriteThreshold must be a number between 0 and 1' })
      return
    }
    const current = getConfig()
    const next: Config = {
      ...current,
      memory: {
        ...current.memory,
        experienceWriteThreshold: threshold,
      },
    }
    setConfig(next)
    await opts.updateRuntimeConfig(next)
    json(res, 200, { experienceWriteThreshold: threshold })
    return
  }

  const memoryNodeManagementMatch = path.match(/^\/memory\/tree\/nodes\/([^/]+)\/manage$/)
  if (method === 'POST' && memoryNodeManagementMatch) {
    const nodeId = decodeURIComponent(memoryNodeManagementMatch[1]!)
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    if (!MEMORY_NODE_MANAGEMENT_ACTIONS.has(action as MemoryNodeManagementAction)) {
      json(res, 400, { error: 'action must be archive, restore, delete, promote or demote' })
      return
    }
    const outcome = await manageRuntimeMemoryNode(
      runner,
      nodeId,
      action as MemoryNodeManagementAction,
      typeof body.reason === 'string' ? body.reason : undefined,
    )
    if (outcome.status === 'not_found') {
      json(res, 404, { error: `memory node not found: ${nodeId}` })
      return
    }
    if (outcome.status === 'invalid') {
      json(res, 409, { error: outcome.error })
      return
    }
    json(res, 200, { node: outcome.node, audit: outcome.audit })
    return
  }

  if (method === 'GET' && path === '/memory/tree') {
    json(res, 200, await buildMemoryTreePayload(runner, projectIndex, getConfig()))
    return
  }

  if (method === 'GET' && path === '/memory') {
    const store = runner.infra.memoryStore
    const dailyDates = await store.listDailyDates()
    let longTerm = ''
    try { longTerm = await store.readLongTerm() } catch { /* not created yet */ }
    json(res, 200, {
      dailyDates: dailyDates.slice(-30),
      longTerm: longTerm.slice(0, 2000),
      experienceCount: (await runner.infra.experienceStore.list()).length,
    })
    return
  }

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

async function appendAgentArtifacts(
  artifactIndex: WorkspaceArtifactIndex,
  result: { runId: string; sessionId: string; messages?: Message[] },
  workspacePath: string,
  projectId?: string,
): Promise<void> {
  const artifacts = extractWorkspaceArtifactsFromMessages(result.messages ?? [], {
    workspacePath,
    sessionId: result.sessionId,
    projectId,
    runId: result.runId,
  })
  if (artifacts.length === 0) return
  await artifactIndex.appendMany(artifacts)
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

async function loadExecutionLogsByRunId(
  runner: AgentRunner,
  messages: Message[],
  sessionId: string,
): Promise<Map<string, ExecutionLog>> {
  const logs = new Map<string, ExecutionLog>()
  const runIds = [...new Set(messages.map((message) => message.runId).filter((runId): runId is string => !!runId))]
  for (const runId of runIds) {
    const log = await runner.replay(runId)
    if (!log || log.sessionId !== sessionId) continue
    logs.set(log.runId, log)
  }
  return logs
}

function toActiveProject(project: ArchivedProjectMeta): ProjectMeta {
  const { archivedAt: _archivedAt, ...activeProject } = project
  return activeProject
}

function toActiveSession(session: ArchivedSessionMeta): Partial<Omit<SessionMeta, 'id'>> {
  const { id: _id, archivedAt: _archivedAt, ...activeSession } = session
  return activeSession
}

function toActiveSessionWithId(session: ArchivedSessionMeta): SessionMeta {
  const { archivedAt: _archivedAt, ...activeSession } = session
  return activeSession
}

function findArchivedProjectForSession(
  projects: ArchivedProjectMeta[],
  session: ArchivedSessionMeta,
): ArchivedProjectMeta | undefined {
  if (session.scope !== 'project' || !session.projectId) return undefined
  return projects.find((project) => project.id === session.projectId)
}

function buildRuntimePayload(config: Config, workplaceDir: string) {
  return {
    model: config.agents.defaults.model,
    reasoning: coerceReasoningForModelRef(config.agents.defaults.reasoning, config.agents.defaults.model),
    profile: normalizeAgentProfileId(config.agents.defaults.profile),
    workspace: config.agents.defaults.workspace || workplaceDir,
    workplace: workplaceDir,
    providers: config.providers.map((p) => {
      const envVar = deriveEnvVarName(p.apiKey)
      const requiresKey = !!p.apiKey
      const hasKey = !requiresKey || !!resolveApiKey(p.apiKey)
      return {
        id: p.id,
        name: p.name ?? p.id,
        baseURL: p.baseURL,
        models: p.models ?? [],
        envVar,
        requiresKey,
        hasKey,
      }
    }),
  }
}

function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return ''
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return ''
  return cleaned
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function sameWorkspacePath(left: string, right: string): boolean {
  return resolve(left).replace(/[\\/]+$/, '').toLowerCase() === resolve(right).replace(/[\\/]+$/, '').toLowerCase()
}

function validateModelRef(config: Config, modelRef: string): string | null {
  let providerId: string
  let model: string
  try {
    const parsed = parseModelRef(modelRef)
    providerId = parsed.provider
    model = parsed.model
  } catch (err) {
    return (err as Error).message
  }
  const provider = config.providers.find((p) => p.id === providerId)
  if (!provider) return `unknown provider: ${providerId}`
  if (provider.models && provider.models.length > 0 && !provider.models.includes(model)) {
    return `model "${model}" is not listed for provider "${providerId}"`
  }
  if (provider.apiKey && !resolveApiKey(provider.apiKey)) {
    return `provider "${provider.name ?? provider.id}" has no API key yet`
  }
  return null
}

function isReasoning(value: string): value is RuntimeReasoning {
  return isRuntimeReasoning(value)
}

function resolveReasoning(
  body: Record<string, unknown>,
  config: Config,
): Config['agents']['defaults']['reasoning'] {
  const value = typeof body.reasoning === 'string' ? body.reasoning : ''
  const requested = isReasoning(value) ? value : config.agents.defaults.reasoning
  return coerceReasoningForModelRef(requested, config.agents.defaults.model)
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
): RunApprovalBroker {
  return async ({ action, detail, permissionMode }) => {
    const id = randomUUID()
    return new Promise<boolean>((resolveApproval) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id)
        resolveApproval(false)
      }, 120_000)
      pendingApprovals.set(id, (allowed) => {
        clearTimeout(timer)
        resolveApproval(allowed)
      })
      requestApproval({ id, action, detail, permissionMode, source: 'agent' })
    })
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function readJson(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
      req.destroy()
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'request body too large'))
        return
      }
      data += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
