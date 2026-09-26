// @littlesheep/app - open-with-routes.ts
// The two Local App API routes behind "open with": list what this machine can open a file with,
// and start one of those handlers. They live in their own file because the workspace router is a
// 300-line composition surface and this pair is self-contained.
//
// Security boundary: the renderer sends a handler **id**, never a command line. Both routes
// re-resolve the handler from a fresh discovery, so a stale list cannot make Main start anything
// else, and an id that is no longer registered is refused instead of guessed.

import { spawn } from 'node:child_process'
import { shell } from 'electron'
import type { Config } from '@littlesheep/config'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { discoverOpenWithHandlers, resolveOpenWithInvocation } from '../workspace-open-with.js'
import { HttpError, json, readJson, type LocalAppApiRequest } from './http.js'
import { resolveWorkspaceRoot, resolveWorkspaceRootFromValue, resolveWorkspaceTarget } from './workspace-support.js'

export interface OpenWithRouteContext {
  getConfig: () => Config
  workplaceDir: string
}

/** Per-extension cache: discovery shells out to `reg.exe`, and a preview must not pay for it twice. */
const cache = new Map<string, Awaited<ReturnType<typeof discoverOpenWithHandlers>>>()
const CACHE_LIMIT = 32

export async function routeOpenWith(
  request: LocalAppApiRequest,
  context: OpenWithRouteContext,
): Promise<boolean> {
  const { req, res, path, method, url } = request

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.workspaceOpenWith) {
    const root = resolveWorkspaceRoot(url, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, url.searchParams.get('path') ?? '')
    const extension = extensionOf(target)
    const cached = extension ? cache.get(extension) : undefined
    const handlers = cached ?? await discoverOpenWithHandlers(target)
    if (extension && !cached) {
      if (cache.size >= CACHE_LIMIT) cache.clear()
      cache.set(extension, handlers)
    }
    json(res, 200, { handlers })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceOpenWith) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    const handlerId = typeof body.handlerId === 'string' ? body.handlerId : ''
    const handler = (await discoverOpenWithHandlers(target)).find((candidate) => candidate.id === handlerId)
    if (!handler) throw new HttpError(400, '这个打开方式在这台机器上已不可用，请重新选择。')
    const invocation = resolveOpenWithInvocation(handler.command, target)
    if (!invocation) throw new HttpError(400, '这个打开方式没有可用的启动命令，请重新选择。')
    const child = spawn(invocation.executable, invocation.args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    json(res, 200, { ok: true })
    return true
  }

  if (method === 'POST' && path === LOCAL_APP_API_ROUTES.workspaceReveal) {
    const body = await readJson(req)
    const root = resolveWorkspaceRootFromValue(body.root, context.getConfig(), context.workplaceDir)
    const target = resolveWorkspaceTarget(root, typeof body.path === 'string' ? body.path : '')
    // Revealing is the file manager's own "show in folder": it never opens or edits the file, so
    // there is nothing to report back beyond a missing target.
    shell.showItemInFolder(target)
    json(res, 200, { ok: true })
    return true
  }

  return false
}

function extensionOf(target: string): string {
  const name = target.replace(/\\/gu, '/').split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}
