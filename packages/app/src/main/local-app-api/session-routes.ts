// Session, archive and execution-log replay routes.

import type { AgentRunner, ExecutionLog } from '@littlesheep/runner'
import { asSessionId, type Message } from '@littlesheep/types'
import { buildHistoryMessages } from '../../shared/history-activity.js'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
} from '../../shared/session-project-contracts.js'
import type {
  ArchiveIndex,
  ArchivedProjectMeta,
  ArchivedSessionMeta,
} from '../archive-index.js'
import type { ProjectIndex, ProjectMeta } from '../project-index.js'
import type { SessionIndex, SessionMeta } from '../session-index.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'

export interface SessionRouteContext {
  getRunner: () => AgentRunner
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
}

export async function routeSessions(
  request: LocalAppApiRequest,
  context: SessionRouteContext,
): Promise<boolean> {
  const { res, url, path, method } = request
  const runner = context.getRunner()
  const { sessionIndex, projectIndex, archiveIndex } = context

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.sessions) {
    json(res, 200, { sessions: await sessionIndex.list() })
    return true
  }

  const sessionMessagesId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions, '/messages')
  if (method === 'GET' && sessionMessagesId !== null) {
    const limit = boundedHistoryLimit(url.searchParams.get('limit'))
    const beforeId = url.searchParams.get('before')?.trim() || undefined
    const window = await runner.sessionManager.readWindow(asSessionId(sessionMessagesId), limit, beforeId)
    const messages = window.messages
    const logsByRunId = await loadExecutionLogsByRunId(runner, messages, sessionMessagesId)
    json(res, 200, {
      messages: buildHistoryMessages(messages, logsByRunId),
      hasMore: window.hasMore,
      beforeId: window.beforeId,
    })
    return true
  }

  const replayRunId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runs)
  if (method === 'GET' && replayRunId !== null) {
    const log = await runner.replay(replayRunId)
    if (!log) {
      json(res, 404, { error: `run not found: ${replayRunId}` })
      return true
    }
    json(res, 200, log)
    return true
  }

  const sessionUpdateId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions)
  if (method === 'PATCH' && sessionUpdateId !== null) {
    const existing = (await sessionIndex.list()).find((session) => session.id === sessionUpdateId)
    if (!existing) {
      json(res, 404, { error: `session not found: ${sessionUpdateId}` })
      return true
    }
    const body = await readJson(request.req)
    const title = typeof body.title === 'string' ? normalizeSessionTitle(body.title) : ''
    if (!title) {
      json(res, 400, { error: 'session title is required' })
      return true
    }
    if (title.length > SESSION_TITLE_MAX_LENGTH) {
      json(res, 400, { error: `session title must not exceed ${SESSION_TITLE_MAX_LENGTH} characters` })
      return true
    }
    if (title === existing.title) {
      json(res, 200, { session: existing })
      return true
    }

    await runner.sessionManager.updateMetadata(asSessionId(sessionUpdateId), { title })
    try {
      await sessionIndex.upsert(sessionUpdateId, { title })
    } catch (error) {
      await runner.sessionManager.updateMetadata(asSessionId(sessionUpdateId), { title: existing.title }).catch(() => undefined)
      throw error
    }
    json(res, 200, { session: { ...existing, title } })
    return true
  }

  const sessionDeleteId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions)
  if (method === 'DELETE' && sessionDeleteId !== null) {
    const removed = await sessionIndex.remove(sessionDeleteId)
    if (url.searchParams.get('hard') === '1') {
      await runner.sessionManager.delete(asSessionId(sessionDeleteId))
    } else if (removed) {
      await archiveIndex.archiveSession(removed)
    }
    res.writeHead(204)
    res.end()
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.archive) {
    json(res, 200, await archiveIndex.list())
    return true
  }

  const archivedSessionRestoreId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.archiveSessions, '/restore')
  if (method === 'POST' && archivedSessionRestoreId !== null) {
    const archive = await archiveIndex.list()
    const archivedSession = archive.sessions.find((item) => item.id === archivedSessionRestoreId)
    if (!archivedSession) {
      json(res, 404, { error: `archived session not found: ${archivedSessionRestoreId}` })
      return true
    }
    const archivedProject = findArchivedProjectForSession(archive.projects, archivedSession)
    const restoredProject = archivedProject ? await archiveIndex.restoreProject(archivedProject.id) : undefined
    const session = await archiveIndex.restoreSession(archivedSessionRestoreId)
    if (!session) {
      json(res, 404, { error: `archived session not found: ${archivedSessionRestoreId}` })
      return true
    }
    const activeProject = restoredProject ? toActiveProject(restoredProject) : undefined
    if (activeProject) await projectIndex.upsert(activeProject)
    await sessionIndex.upsert(session.id, toActiveSession(session))
    json(res, 200, { session: toActiveSessionWithId(session), project: activeProject })
    return true
  }

  const archivedProjectRestoreId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.archiveProjects, '/restore')
  if (method === 'POST' && archivedProjectRestoreId !== null) {
    const project = await archiveIndex.restoreProject(archivedProjectRestoreId)
    if (!project) {
      json(res, 404, { error: `archived project not found: ${archivedProjectRestoreId}` })
      return true
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
    return true
  }

  const archivedSessionDeleteId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.archiveSessions)
  if (method === 'DELETE' && archivedSessionDeleteId !== null) {
    const removed = await archiveIndex.removeSession(archivedSessionDeleteId)
    if (!removed) {
      json(res, 404, { error: `archived session not found: ${archivedSessionDeleteId}` })
      return true
    }
    await runner.sessionManager.delete(asSessionId(archivedSessionDeleteId))
    res.writeHead(204)
    res.end()
    return true
  }

  const archivedProjectDeleteId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.archiveProjects)
  if (method === 'DELETE' && archivedProjectDeleteId !== null) {
    const project = await archiveIndex.removeProject(archivedProjectDeleteId)
    if (!project) {
      json(res, 404, { error: `archived project not found: ${archivedProjectDeleteId}` })
      return true
    }
    const sessions = await archiveIndex.removeSessionsForProject(project)
    for (const session of sessions) {
      await runner.sessionManager.delete(asSessionId(session.id))
    }
    res.writeHead(204)
    res.end()
    return true
  }

  return false
}

function boundedHistoryLimit(value: string | null): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 120
  return Math.max(24, Math.min(240, Math.floor(parsed)))
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
