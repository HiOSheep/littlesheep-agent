// Interactive workspace terminal sessions and bounded replay history.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { HttpError, writeSse } from './http.js'
import { createWorkspaceTerminalProcess, type WorkspaceTerminalProcess } from './terminal-process.js'

const MAX_TERMINAL_OUTPUT_BYTES = 512 * 1024
const MAX_WORKSPACE_TERMINAL_SESSIONS = 16
export const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 }
const MIN_TERMINAL_COLS = 20
const MAX_TERMINAL_COLS = 360
const MIN_TERMINAL_ROWS = 6
const MAX_TERMINAL_ROWS = 120

export interface WorkspaceTerminalSessionSnapshot {
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

export class WorkspaceTerminalSession extends EventEmitter<WorkspaceTerminalSessionEvents> {
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
    terminal.onData((stream, text) => this.pushOutput(stream, text))
    terminal.onError((error) => this.emit('error', error))
    terminal.onExit((event) => {
      this.exited = true
      this.exitInfo = event
      this.emit('exit', event)
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
    for (const item of this.outputHistory) writeSse(res, item.stream, { text: item.text })
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
    if (!this.exited) this.terminal.interrupt()
  }

  kill(): void {
    if (!this.exited) this.terminal.kill()
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

export class WorkspaceTerminalSessionManager {
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
      const timer = setTimeout(() => {
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

export function normalizeTerminalSize(value: unknown): { cols: number; rows: number } {
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
