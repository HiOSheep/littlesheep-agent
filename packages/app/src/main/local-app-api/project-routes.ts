// Project registration, rebinding, archive transition and folder creation routes.

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import { sessionBelongsToProject } from '../../shared/session-scope.js'
import type { ArchiveIndex } from '../archive-index.js'
import { ProjectPathConflictError, type ProjectIndex } from '../project-index.js'
import type { ProjectRebindingService } from '../project-rebinding.js'
import type { SessionIndex } from '../session-index.js'
import { json, readJson, resolveRunner, type LocalAppApiRequest } from './http.js'
import { buildRuntimePayload } from './runtime-routes.js'

export interface ProjectRouteContext {
  getRunner: () => AgentRunner | undefined
  getConfig: () => Config
  workplaceDir: string
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
  projectRebinding: ProjectRebindingService
}

export async function routeProjects(
  request: LocalAppApiRequest,
  context: ProjectRouteContext,
): Promise<boolean> {
  const { req, res, url, path, method } = request
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
      const runner = resolveRunner(context.getRunner)
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

  return false
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
