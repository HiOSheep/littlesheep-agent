// Interactive terminal sessions, command activity capture and terminal HTTP routes.

import { stat } from 'node:fs/promises'
import type { Config } from '@littlesheep/config'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
} from '../../shared/local-app-api-routes.js'
import type { TerminalActivityIndex } from '../terminal-activity-index.js'
import { HttpError, json, readJson, writeSse, type LocalAppApiRequest } from './http.js'
import {
  clampTerminalTimeout,
  MAX_TERMINAL_COMMAND_BYTES,
  runWorkspaceTerminalCommand,
} from './terminal-command.js'
import {
  DEFAULT_TERMINAL_SIZE,
  normalizeTerminalSize,
  WorkspaceTerminalSessionManager,
} from './terminal-session.js'
import { TerminalCommandCaptureStore } from './terminal-capture.js'
import {
  normalizeOptionalSessionId,
  resolveWorkspaceRoot,
  resolveWorkspaceRootFromValue,
} from './workspace-support.js'

export interface TerminalRouteContext {
  getConfig: () => Config
  workplaceDir: string
  terminalActivityIndex: TerminalActivityIndex
}

export class TerminalRouter {
  private readonly sessions = new WorkspaceTerminalSessionManager()
  private readonly captures = new TerminalCommandCaptureStore()

  async route(request: LocalAppApiRequest, context: TerminalRouteContext): Promise<boolean> {
    const { req, res, url, path, method } = request
    const activityIndex = context.terminalActivityIndex

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalSession) {
      const body = await readJson(req)
      const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
      const info = await stat(root)
      if (!info.isDirectory()) throw new HttpError(400, 'workspace root is not a directory')
      const session = await this.sessions.create(root, normalizeTerminalSize(body))
      json(res, 200, session.snapshot())
      return true
    }

    if (path.startsWith(LOCAL_APP_API_PREFIXES.terminalSessions)) {
      const rest = path.slice(LOCAL_APP_API_PREFIXES.terminalSessions.length)
      const [encodedSessionId, action = ''] = rest.split('/')
      const terminalSessionId = decodeURIComponent(encodedSessionId ?? '')
      if (!terminalSessionId) {
        json(res, 400, { error: 'terminal session id is required' })
        return true
      }

      if (method === 'GET' && action === 'stream') {
        const session = this.sessions.get(terminalSessionId)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const onStdout = (text: string) => writeSse(res, 'stdout', { text })
        const onStderr = (text: string) => writeSse(res, 'stderr', { text })
        const onExit = (event: { exitCode: number | null; signal: string | null }) => writeSse(res, 'exit', event)
        const onError = (error: Error) => writeSse(res, 'error', { error: error.message })
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
        return true
      }

      if (method === 'POST' && action === 'input') {
        const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
        const command = typeof body.command === 'string' ? body.command.trim() : ''
        if (!command) {
          json(res, 400, { error: 'command is required' })
          return true
        }
        if (Buffer.byteLength(command, 'utf8') > MAX_TERMINAL_COMMAND_BYTES) {
          throw new HttpError(413, `命令超过 ${Math.round(MAX_TERMINAL_COMMAND_BYTES / 1024)} KB。`)
        }
        if (command.includes('\u0000')) throw new HttpError(400, 'command contains invalid characters')
        const session = this.sessions.get(terminalSessionId)
        await this.captures.finalize(terminalSessionId, activityIndex, { signal: 'next-command' })
        this.captures.start(session, command, normalizeOptionalSessionId(body.sessionId), activityIndex)
        try {
          session.writeCommand(command)
        } catch (error) {
          await this.captures.finalize(terminalSessionId, activityIndex, { signal: 'send-failed' })
          throw error
        }
        json(res, 200, { ok: true })
        return true
      }

      if (method === 'POST' && action === 'resize') {
        const body = await readJson(req)
        const session = this.sessions.get(terminalSessionId)
        json(res, 200, session.resize(
          typeof body.cols === 'number' ? body.cols : DEFAULT_TERMINAL_SIZE.cols,
          typeof body.rows === 'number' ? body.rows : DEFAULT_TERMINAL_SIZE.rows,
        ))
        return true
      }

      if (method === 'POST' && action === 'interrupt') {
        this.sessions.get(terminalSessionId).interrupt()
        await this.captures.finalize(terminalSessionId, activityIndex, { signal: 'interrupt' })
        json(res, 200, { ok: true })
        return true
      }

      if (method === 'DELETE' && !action) {
        await this.captures.finalize(terminalSessionId, activityIndex, { signal: 'closed' })
        this.sessions.close(terminalSessionId)
        res.writeHead(204)
        res.end()
        return true
      }
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalRun) {
      const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
      const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
      const command = typeof body.command === 'string' ? body.command.trim() : ''
      if (!command) {
        json(res, 400, { error: 'command is required' })
        return true
      }
      const payload = await runWorkspaceTerminalCommand(root, command, clampTerminalTimeout(body.timeoutMs))
      await activityIndex.append({
        ...payload,
        workspacePath: root,
        sessionId: normalizeOptionalSessionId(body.sessionId),
      })
      json(res, 200, payload)
      return true
    }

    if (method === 'GET' && path === LOCAL_APP_API_ROUTES.terminalActivity) {
      const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
      const sessionId = normalizeOptionalSessionId(url.searchParams.get('sessionId'))
      const limitRaw = Number(url.searchParams.get('limit') ?? '30')
      const records = await activityIndex.list({
        workspacePath: root,
        sessionId,
        limit: Number.isFinite(limitRaw) ? limitRaw : 30,
      })
      json(res, 200, { records })
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.terminalStream) {
      const body = await readJson(req, MAX_TERMINAL_COMMAND_BYTES + 4096)
      const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
      const command = typeof body.command === 'string' ? body.command.trim() : ''
      if (!command) {
        json(res, 400, { error: 'command is required' })
        return true
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
        await activityIndex.append({
          ...payload,
          workspacePath: root,
          sessionId: normalizeOptionalSessionId(body.sessionId),
        })
        writeSse(res, 'result', payload)
      } catch (error) {
        writeSse(res, 'error', { error: (error as Error).message })
      } finally {
        completed = true
        res.end()
      }
      return true
    }

    return false
  }

  stop(): void {
    this.captures.stop()
    this.sessions.closeAll()
  }
}
