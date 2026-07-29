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
import { json, readJson, type LocalAppApiRequest } from './http.js'

const ACTIVE_RUN_ACTIONS: ReadonlySet<RuntimeActiveRunAction> = new Set(['pause', 'resume', 'interrupt'])
const MAX_CONTROL_REASON_LENGTH = 1_024

export interface ApplicationLifecycleRouteContext {
  getRunner: () => AgentRunner
  listActiveRuns?: () => RuntimeActiveRunSnapshot[]
  controlActiveRun?: (
    runId: string,
    action: RuntimeActiveRunAction,
    reason?: string,
  ) => RuntimeActiveRunActionOutcome
}

export async function routeApplicationLifecycle(
  request: LocalAppApiRequest,
  context: ApplicationLifecycleRouteContext,
): Promise<boolean> {
  const { path, method, req, res } = request
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.activeRuns) {
    const runs = context.listActiveRuns?.() ?? context.getRunner().activeRuns?.list() ?? []
    json(res, 200, { runs })
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
