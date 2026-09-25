// Attachment import, workspace file, layout and artifact routes.

import { shell } from 'electron'
import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import type { AttachmentRef } from '../attachments.js'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import type { ProjectIndex } from '../project-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import type { WorkspaceLayoutIndex } from '../workspace-layout-index.js'
import { HttpError, json, readJson, resolveRunner, type LocalAppApiRequest } from './http.js'
import { openInVSCode } from './vscode-launcher.js'
import {
  listWorkspaceDirectory,
  MAX_TEXT_SAVE_BYTES,
  previewWorkspaceFile,
  saveWorkspaceTextFile,
} from './workspace-file-service.js'
import { workspaceGitReviewCache } from './workspace-git-review-cache.js'
import type { WorkspacePreviewServers } from './workspace-preview-server.js'
import {
  normalizeOptionalSessionId,
  normalizePositiveInt,
  resolveActiveWorkspaceRoot,
  resolveWorkspaceContextForPath,
  resolveWorkspaceRoot,
  resolveWorkspaceRootFromValue,
  resolveWorkspaceTarget,
  syncWorkspaceResourceChanges,
} from './workspace-support.js'

const MAX_ATTACHMENT_IMPORT_BODY_BYTES = 36 * 1024 * 1024
const MAX_WORKSPACE_SAVE_BODY_BYTES = MAX_TEXT_SAVE_BYTES + 64 * 1024

export interface WorkspaceRouteContext {
  getRunner: () => AgentRunner | undefined
  getConfig: () => Config
  workplaceDir: string
  projectIndex: ProjectIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  workspaceLayoutIndex: WorkspaceLayoutIndex
  workspacePreviewServers: WorkspacePreviewServers
  attachmentCache: ManagedAttachmentCache
  selectWorkspace?: () => Promise<string | null>
  selectAttachments?: () => Promise<AttachmentRef[]>
}

export async function routeWorkspace(
  request: LocalAppApiRequest,
  context: WorkspaceRouteContext,
): Promise<boolean> {
  const { req, res, url, path, method } = request

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceSelect) {
    if (!context.selectWorkspace) {
      json(res, 501, { error: 'workspace picker is not available' })
      return true
    }
    json(res, 200, { path: await context.selectWorkspace() })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.attachmentSelect) {
    if (!context.selectAttachments) {
      json(res, 501, { error: 'attachment picker is not available' })
      return true
    }
    json(res, 200, { files: await context.selectAttachments() })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.attachmentImport) {
    const body = await readJson(req, MAX_ATTACHMENT_IMPORT_BODY_BYTES)
    json(res, 200, { file: await context.attachmentCache.importData(body) })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceList) {
    const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? root)
    json(res, 200, await listWorkspaceDirectory(root, target))
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspacePreview) {
    const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? '')
    json(res, 200, await previewWorkspaceFile(root, target))
    return true
  }

  // Running a workspace HTML page: a bounded loopback static service scoped to the
  // selected workspace. The renderer opens the returned URL in the embedded browser.
  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspacePreviewServer) {
    const body = await readJson(req, 64 * 1024)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    json(res, 200, await context.workspacePreviewServers.start(root, target))
    return true
  }

  if (method === 'DELETE' && path === LOCAL_APP_API_ROUTES.workspacePreviewServer) {
    const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    json(res, 200, await context.workspacePreviewServers.stop(root))
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspacePreviewServer) {
    json(res, 200, { servers: context.workspacePreviewServers.list() })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceReview) {
    const root = resolveActiveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    json(res, 200, await withRequestAbortSignal(req, res, (signal) => (
      workspaceGitReviewCache.readSnapshot(root, {
        signal,
        force: url.searchParams.get('force') === '1',
      })
    )))
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceReviewDiff) {
    const root = resolveActiveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? '')
    const revision = url.searchParams.get('revision') ?? ''
    if (!revision) throw new HttpError(400, 'Git 审阅 revision 缺失。')
    json(res, 200, await withRequestAbortSignal(
      req,
      res,
      (signal) => workspaceGitReviewCache.readDiff(root, target, revision, { signal }),
    ))
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceSave) {
    const body = await readJson(req, MAX_WORKSPACE_SAVE_BODY_BYTES)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    const payload = await saveWorkspaceTextFile(root, target, body)
    await context.workspaceArtifactIndex.append({
      path: target,
      action: 'modified',
      source: 'user',
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(body.sessionId),
    })
    const workspaceContext = await resolveWorkspaceContextForPath(
      context.projectIndex,
      root,
      context.workplaceDir,
    )
    await syncWorkspaceResourceChanges(resolveRunner(context.getRunner), root, {
      ...workspaceContext,
      changes: [{ path: target, source: 'user' }],
    })
    json(res, 200, payload)
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceLayout) {
    const sessionId = normalizeOptionalSessionId(url.searchParams.get('sessionId'))
    json(res, 200, { snapshot: await context.workspaceLayoutIndex.read(sessionId ?? null) })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceLayout) {
    const body = await readJson(req)
    json(res, 200, { snapshot: await context.workspaceLayoutIndex.save(body) })
    return true
  }

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceArtifacts) {
    const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    const records = await context.workspaceArtifactIndex.list({
      workspacePath: root,
      sessionId: normalizeOptionalSessionId(url.searchParams.get('sessionId')),
      limit: normalizePositiveInt(url.searchParams.get('limit'), 50, 300),
    })
    json(res, 200, { records })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceOpen) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    const error = await shell.openPath(target)
    if (error) {
      json(res, 500, { error })
      return true
    }
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.externalOpen) {
    const body = await readJson(req)
    const href = normalizeExternalHref(body.href)
    if (/^https?:$/iu.test(new URL(href).protocol)) {
      throw new HttpError(409, '网页链接必须通过 LS 内置浏览器打开。')
    }
    await shell.openExternal(href)
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceOpenVscode) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const requestedPath = typeof body.path === 'string' && body.path.trim() ? body.path : root
    await openInVSCode(resolveWorkspaceTarget(root, requestedPath))
    json(res, 200, { ok: true })
    return true
  }

  return false
}

function normalizeExternalHref(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'external href is required')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HttpError(400, 'external href must be an absolute URL')
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
    throw new HttpError(400, `external protocol is not allowed: ${url.protocol}`)
  }
  return url.href
}

async function withRequestAbortSignal<T>(
  req: LocalAppApiRequest['req'],
  res: LocalAppApiRequest['res'],
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (req.aborted || res.destroyed) controller.abort()
  else {
    req.once('aborted', abort)
    res.once('close', abort)
  }
  try {
    return await task(controller.signal)
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}
