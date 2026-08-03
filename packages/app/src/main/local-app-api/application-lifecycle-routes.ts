// Desktop lifecycle status and active-run controls.

import type { AgentRunner } from '@littlesheep/runner'
import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunActionOutcome,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import { json, openSse, readJson, writeSse, type LocalAppApiRequest } from './http.js'
import { hasBearerToken } from './bearer-auth.js'
import type { LocalAppApiServerOptions } from './contracts.js'

const ACTIVE_RUN_ACTIONS: ReadonlySet<RuntimeActiveRunAction> = new Set(['pause', 'resume', 'interrupt'])
const MAX_CONTROL_REASON_LENGTH = 1_024

export interface ApplicationLifecycleRouteContext {
  getRunner: () => AgentRunner
  listActiveRuns?: () => RuntimeActiveRunSnapshot[]
  subscribeActiveRuns?: (
    listener: (runs: RuntimeActiveRunSnapshot[]) => void,
  ) => () => void
  controlActiveRun?: (
    runId: string,
    action: RuntimeActiveRunAction,
    reason?: string,
  ) => RuntimeActiveRunActionOutcome
  desktopAcceptance?: LocalAppApiServerOptions['desktopAcceptance']
}

export async function routeApplicationLifecycle(
  request: LocalAppApiRequest,
  context: ApplicationLifecycleRouteContext,
): Promise<boolean> {
  const { path, method, req, res } = request
  if (path === LOCAL_APP_API_ROUTES.desktopAcceptance && context.desktopAcceptance) {
    if (!hasBearerToken(req.headers.authorization, context.desktopAcceptance.token)) {
      json(res, 401, { error: 'Desktop acceptance authorization failed.' })
      return true
    }
    if (method === 'GET') {
      json(res, 200, { snapshot: context.desktopAcceptance.snapshot() })
      return true
    }
    if (method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' })
      return true
    }
    const body = await readJson(req, 4 * 1024)
    if (body.action === 'close') {
      const accepted = context.desktopAcceptance.close()
      json(res, accepted ? 200 : 409, {
        accepted,
        snapshot: context.desktopAcceptance.snapshot(),
      })
      return true
    }
    if (body.action === 'show') {
      context.desktopAcceptance.show()
      json(res, 200, { accepted: true, snapshot: context.desktopAcceptance.snapshot() })
      return true
    }
    if (body.action === 'quit') {
      json(res, 202, { accepted: true })
      setImmediate(() => context.desktopAcceptance?.quit())
      return true
    }
    json(res, 400, { error: 'Desktop acceptance action must be close, show, or quit.' })
    return true
  }
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.activeRuns) {
    const runs = context.listActiveRuns?.() ?? context.getRunner().activeRuns?.list() ?? []
    json(res, 200, { runs })
    return true
  }
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.activeRunsStream) {
    const activeRuns = context.getRunner().activeRuns
    const subscribe = context.subscribeActiveRuns
      ?? (activeRuns ? activeRuns.subscribe.bind(activeRuns) : undefined)
    if (!subscribe) {
      json(res, 503, { error: 'active run subscription is unavailable' })
      return true
    }
    const stopHeartbeat = openSse(res)
    let closed = false
    let unsubscribe: (() => void) | null = null
    const cleanup = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
      stopHeartbeat()
      req.removeListener('aborted', cleanup)
      res.removeListener('close', cleanup)
    }
    req.once('aborted', cleanup)
    res.once('close', cleanup)
    try {
      const release = subscribe((runs) => {
        if (!closed && !res.destroyed) writeSse(res, 'active_runs', { runs })
      })
      unsubscribe = release
      if (closed) release()
    } catch (error) {
      if (!res.destroyed) writeSse(res, 'error', { error: (error as Error).message })
      res.end()
      cleanup()
    }
    return true
  }

  const runId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.activeRuns, '/control')
  if (method === 'POST' && runId !== null) {
    const body = await readJson(req)
    const action = body.action
    if (typeof action !== 'string' || !ACTIVE_RUN_ACTIONS.has(action as RuntimeActiveRunAction)) {
      json(res, 400, { error: 'active run action must be pause, resume, or interrupt' })
      return true
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      json(res, 400, { error: 'active run control reason must be a string' })
      return true
    }
    const reason = typeof body.reason === 'string'
      ? body.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTROL_REASON_LENGTH)
      : undefined
    const outcome = context.controlActiveRun?.(runId, action as RuntimeActiveRunAction, reason)
      ?? context.getRunner().activeRuns?.request(runId, action as RuntimeActiveRunAction, reason)
      ?? inactiveOutcome(runId, action as RuntimeActiveRunAction)
    const status = outcome.kind === 'accepted'
      ? 202
      : outcome.reason === 'run-not-active' ? 404 : 409
    json(res, status, { outcome })
    return true
  }

  return false
}

function inactiveOutcome(runId: string, action: RuntimeActiveRunAction): RuntimeActiveRunActionOutcome {
  return {
    kind: 'rejected',
    action,
    reason: 'run-not-active',
    message: `Run is not active: ${runId}`,
  }
}
