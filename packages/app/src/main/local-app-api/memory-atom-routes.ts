// Advanced Memory v3 atom management and evidence export routes.

import type { AgentRunner } from '@littlesheep/runner'
import {
  LOCAL_APP_API_PREFIXES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import type { MemoryAtomManagementRequest } from '../../shared/memory-control-contracts.js'
import {
  exportRuntimeMemoryAtom,
  manageRuntimeMemoryAtom,
  suggestedMemoryAtomExportName,
} from '../memory-atom-control.js'
import { json, readJson, type LocalAppApiRequest } from './http.js'

export interface MemoryAtomRouteContext {
  runner: AgentRunner
  selectMemoryAtomExport?: (suggestedName: string) => Promise<string | null>
}

const MANAGEMENT_ACTIONS = new Set<MemoryAtomManagementRequest['action']>([
  'move',
  'merge',
  'invalidate',
  'reactivate',
])

export async function routeMemoryAtom(
  request: LocalAppApiRequest,
  context: MemoryAtomRouteContext,
): Promise<boolean> {
  const { req, res, path, method } = request
  const managedAtomId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryNodes, '/manage-atom')
  if (method === 'POST' && managedAtomId !== null) {
    const parsed = parseAtomManagementRequest(managedAtomId, await readJson(req))
    if ('error' in parsed) {
      json(res, 400, { error: parsed.error })
      return true
    }
    const outcome = await manageRuntimeMemoryAtom(context.runner, parsed.request)
    if (outcome.status === 'not_found') {
      json(res, 404, { error: `memory atom not found: ${managedAtomId}` })
      return true
    }
    if (outcome.status === 'unsupported' || outcome.status === 'invalid') {
      json(res, 409, { error: outcome.error })
      return true
    }
    json(res, 200, outcome.result)
    return true
  }

  const exportedAtomId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.memoryNodes, '/export')
  if (method !== 'POST' || exportedAtomId === null) return false
  if (!context.selectMemoryAtomExport) {
    json(res, 501, { error: 'memory atom export dialog is unavailable' })
    return true
  }
  const node = await context.runner.infra.memoryService.getNode(exportedAtomId)
  if (!node || node.isBranchRoot) {
    json(res, 404, { error: `memory atom not found: ${exportedAtomId}` })
    return true
  }
  const outputPath = await context.selectMemoryAtomExport(
    suggestedMemoryAtomExportName(exportedAtomId, node.summary),
  )
  if (!outputPath) {
    json(res, 200, { cancelled: true })
    return true
  }
  const exported = await exportRuntimeMemoryAtom(context.runner, exportedAtomId, outputPath)
  if (!exported) {
    json(res, 409, { error: 'single-atom evidence export requires the Memory v3 backend' })
    return true
  }
  json(res, 200, { cancelled: false, export: exported })
  return true
}

function parseAtomManagementRequest(
  atomId: string,
  body: Record<string, unknown>,
): { request: MemoryAtomManagementRequest } | { error: string } {
  const action = typeof body.action === 'string' ? body.action : ''
  if (!MANAGEMENT_ACTIONS.has(action as MemoryAtomManagementRequest['action'])) {
    return { error: 'action must be move, merge, invalidate or reactivate' }
  }
  const expectedRevision = body.expectedRevision
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
    return { error: 'expectedRevision must be a positive integer' }
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return { error: 'reason is required' }
  if (action === 'move') {
    if (body.parentNodeId !== undefined && body.parentNodeId !== null && typeof body.parentNodeId !== 'string') {
      return { error: 'parentNodeId must be a string or null' }
    }
    return {
      request: {
        action,
        atomId,
        expectedRevision: Number(expectedRevision),
        parentNodeId: typeof body.parentNodeId === 'string' && body.parentNodeId.trim()
          ? body.parentNodeId.trim()
          : undefined,
        reason,
      },
    }
  }
  if (action === 'merge') {
    const targetAtomId = typeof body.targetAtomId === 'string' ? body.targetAtomId.trim() : ''
    if (!targetAtomId) return { error: 'targetAtomId is required for merge' }
    if (!Number.isInteger(body.targetExpectedRevision) || Number(body.targetExpectedRevision) < 1) {
      return { error: 'targetExpectedRevision must be a positive integer' }
    }
    return {
      request: {
        action,
        atomId,
        expectedRevision: Number(expectedRevision),
        targetAtomId,
        targetExpectedRevision: Number(body.targetExpectedRevision),
        reason,
      },
    }
  }
  return {
    request: {
      action: action as 'invalidate' | 'reactivate',
      atomId,
      expectedRevision: Number(expectedRevision),
      reason,
    },
  }
}
