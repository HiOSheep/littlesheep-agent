// Project, session, archive and execution-log replay routes.

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Config } from '@littlesheep/config'
import type { AgentRunner, ExecutionLog } from '@littlesheep/runner'
import { asSessionId, type Message } from '@littlesheep/types'
import { buildHistoryMessages } from '../../shared/history-activity.js'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import { sessionBelongsToProject } from '../../shared/session-scope.js'
import type {
  ArchiveIndex,
  ArchivedProjectMeta,
  ArchivedSessionMeta,
} from '../archive-index.js'
import {
  ProjectPathConflictError,
  type ProjectIndex,
  type ProjectMeta,
} from '../project-index.js'
import type { ProjectRebindingService } from '../project-rebinding.js'
import type { SessionIndex, SessionMeta } from '../session-index.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'
import { buildRuntimePayload } from './runtime-routes.js'

export interface SessionRouteContext {
  getRunner: () => AgentRunner
  getConfig: () => Config
  workplaceDir: string
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
  projectRebinding: ProjectRebindingService
}

export async function routeSessions(
  request: LocalAppApiRequest,
  context: SessionRouteContext,
): Promise<boolean> {
  const { req, res, url, path, method } = request
  const runner = context.getRunner()
  const { sessionIndex, projectIndex, archiveIndex } = context

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.projects) {
    json(res, 200, { projects: await projectIndex.list() })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.projectRegister) {
    const body = await readJson(req)
    const requestedPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!requestedPath) {
      json(res, 400, { error: 'project path is required' })
      return true
    }
    const folderPath = resolve(requestedPath)
    try {
      const info = await stat(folderPath)
      if (!info.isDirectory()) {
        json(res, 400, { error: 'project path is not a directory' })
        return true
      }
    } catch {
      json(res, 404, { error: 'project path does not exist' })
      return true
    }
    const archivedProject = await archiveIndex.findProjectByPath(folderPath)
    if (archivedProject) {
      json(res, 409, { error: `project path belongs to archived project: ${archivedProject.id}` })
      return true
    }
    json(res, 200, { project: await projectIndex.ensure(folderPath) })
    return true
  }

  const projectRebindId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.projects, '/rebind')
  if (method === 'POST' && projectRebindId !== null) {
    const body = await readJson(req)
    const requestedPath = typeof body.path === 'string' ? body.path.trim() : ''
    if (!requestedPath) {
      json(res, 400, { error: 'project path is required' })
      return true
    }
    const folderPath = resolve(requestedPath)
    try {
      const info = await stat(folderPath)
      if (!info.isDirectory()) {
        json(res, 400, { error: 'project path is not a directory' })
        return true
      }
    } catch {
      json(res, 404, { error: 'project path does not exist' })
      return true
    }
    try {
      const result = await context.projectRebinding.rebind(projectRebindId, folderPath)
      json(res, 200, {
        ...result,
        runtime: buildRuntimePayload(context.getConfig(), context.workplaceDir),
      })
    } catch (error) {
      if (error instanceof ProjectPathConflictError) {
        json(res, 409, { error: error.message, conflictingProjectId: error.existingProjectId })
        return true
      }
      throw error
    }
    return true
  }

  const projectDeleteId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.projects)
  if (method === 'DELETE' && projectDeleteId !== null) {
    const removed = await projectIndex.remove(projectDeleteId)
    if (!removed) {
      json(res, 404, { error: `project not found: ${projectDeleteId}` })
      return true
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
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.projectCreateFolder) {
    const body = await readJson(req)
    const parentPath = typeof body.parentPath === 'string' ? body.parentPath.trim() : ''
    const rawName = typeof body.name === 'string' ? body.name.trim() : ''
    if (!parentPath || !rawName) {
      json(res, 400, { error: 'parentPath and name are required' })
      return true
    }
    const folderName = sanitizeFolderName(rawName)
    if (!folderName) {
      json(res, 400, { error: 'folder name is invalid' })
      return true
    }
    const parent = resolve(parentPath)
    const folderPath = resolve(join(parent, folderName))
    if (!isPathInside(parent, folderPath)) {
      json(res, 400, { error: 'folder path escapes selected parent' })
      return true
    }
    const archivedProject = await archiveIndex.findProjectByPath(folderPath)
    if (archivedProject) {
      json(res, 409, { error: `project path belongs to archived project: ${archivedProject.id}` })
      return true
    }
    try {
      await mkdir(folderPath, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        json(res, 409, { error: 'folder already exists' })
        return true
      }
      throw error
    }
    const project = await projectIndex.ensure(folderPath)
    json(res, 200, { path: folderPath, project })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.sessions) {
    json(res, 200, { sessions: await sessionIndex.list() })
    return true
  }

  const sessionMessagesId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions, '/messages')
  if (method === 'GET' && sessionMessagesId !== null) {
    const messages = await runner.sessionManager.read(asSessionId(sessionMessagesId))
    const logsByRunId = await loadExecutionLogsByRunId(runner, messages, sessionMessagesId)
    json(res, 200, { messages: buildHistoryMessages(messages, logsByRunId) })
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
  const pathFromParent = relative(parent, child)
  return pathFromParent.length > 0 && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent)
}
