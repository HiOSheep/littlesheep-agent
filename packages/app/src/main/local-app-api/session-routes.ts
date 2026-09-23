// Session, archive and execution-log replay routes.

import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { prepareAuthoritativeExecutionLog, type AgentRunner, type ExecutionLog } from '@littlesheep/runner'
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
import {
  getPermissionMode,
  normalizePermissionModeId,
} from '../../shared/permission-modes.js'
import type {
  ArchiveIndex,
  ArchivedProjectMeta,
  ArchivedSessionMeta,
} from '../archive-index.js'
import type { ProjectIndex, ProjectMeta } from '../project-index.js'
import type { SessionIndex, SessionMeta } from '../session-index.js'
import type { SessionContextUsageRecord } from '../../shared/context-usage-contracts.js'
import type { CompactionOperationRecord } from '../../shared/compaction-operation-contracts.js'
import { json, readJson, resolveRunner, type LocalAppApiRequest } from './http.js'

/** Bounded like the other session fields: a path, not a document. */
const SESSION_WORKSPACE_PATH_MAX_LENGTH = 4_096

export interface SessionRouteContext {
  getRunner: () => AgentRunner | undefined
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  archiveIndex: ArchiveIndex
  mutateSession?: <T>(operation: () => Promise<T>) => Promise<T>
}

export async function routeSessions(
  request: LocalAppApiRequest,
  context: SessionRouteContext,
): Promise<boolean> {
  const { res, url, path, method } = request
  const { sessionIndex, projectIndex, archiveIndex } = context

  // Session metadata comes from the UI index and must stay readable while the
  // Runner is still starting; only the branches below resolve it, lazily.
  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.sessions) {
    json(res, 200, { sessions: await sessionIndex.list() })
    return true
  }

  const sessionMessagesId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions, '/messages')
  if (method === 'GET' && sessionMessagesId !== null) {
    const runner = resolveRunner(context.getRunner)
    const limit = boundedHistoryLimit(url.searchParams.get('limit'))
    const beforeId = url.searchParams.get('before')?.trim() || undefined
    const window = await runner.sessionManager.readWindow(asSessionId(sessionMessagesId), limit, beforeId)
    const messages = window.messages
    const logsByRunId = await loadExecutionLogsByRunId(runner, messages, sessionMessagesId)
    const compactionOperations: readonly CompactionOperationRecord[] | undefined = runner.compactionOperationHistory
      ? await runner.compactionOperationHistory(asSessionId(sessionMessagesId)).catch(() => undefined)
      : undefined
    json(res, 200, {
      messages: buildHistoryMessages(messages, logsByRunId),
      hasMore: window.hasMore,
      beforeId: window.beforeId,
      contextUsage: buildSessionContextUsageRecord(logsByRunId.values(), sessionMessagesId),
      ...(compactionOperations ? { compactionOperations } : {}),
    })
    return true
  }

  const sessionCompactionOpsId = matchLocalAppApiItemPath(
    path,
    LOCAL_APP_API_PREFIXES.sessions,
    '/compaction-operations',
  )
  if (method === 'GET' && sessionCompactionOpsId !== null) {
    const runner = resolveRunner(context.getRunner)
    if (!runner.compactionOperationHistory) {
      json(res, 503, { error: 'compaction operation history is unavailable' })
      return true
    }
    const operations: readonly CompactionOperationRecord[] = await runner.compactionOperationHistory(
      asSessionId(sessionCompactionOpsId),
    )
    json(res, 200, { operations })
    return true
  }

  const replayRunId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runs)
  const replayFinalReplyRunId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runs, '/final-reply')
  if (method === 'GET' && replayFinalReplyRunId !== null) {
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (!sessionId) {
      json(res, 400, { error: 'sessionId is required for durable final-reply replay' })
      return true
    }
    const runner = resolveRunner(context.getRunner)
    if (!runner.replayDurableFinalReply) {
      json(res, 503, { error: 'durable final-reply replay is unavailable' })
      return true
    }
    try {
      // This endpoint deliberately returns the Harness settlement projection,
      // never an execution-log or stream reconstruction.
      const replay = await runner.replayDurableFinalReply(asSessionId(sessionId), replayFinalReplyRunId)
      json(res, 200, replay)
    } catch (error) {
      json(res, 503, { error: `durable final-reply replay failed: ${(error as Error).message}` })
    }
    return true
  }
  if (method === 'GET' && replayRunId !== null) {
    const runner = resolveRunner(context.getRunner)
    const log = await runner.replay(replayRunId)
    if (!log) {
      json(res, 404, { error: `run not found: ${replayRunId}` })
      return true
    }
    json(res, 200, await prepareAuthoritativeExecutionLog(runner, log))
    return true
  }

  const sessionUpdateId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions)
  if (method === 'PATCH' && sessionUpdateId !== null) {
    const body = await readJson(request.req)
    const mutateSession = context.mutateSession ?? (<T>(operation: () => Promise<T>) => operation())
    return mutateSession(async () => {
      const existing = (await sessionIndex.list()).find((session) => session.id === sessionUpdateId)
      if (!existing) {
        json(res, 404, { error: `session not found: ${sessionUpdateId}` })
        return true
      }
      const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title')
      const hasMode = Object.prototype.hasOwnProperty.call(body, 'mode')
      const hasWorkspace = Object.prototype.hasOwnProperty.call(body, 'workspacePath')
      if (!hasTitle && !hasMode && !hasWorkspace) {
        json(res, 400, { error: 'session title, permission mode or workspace path is required' })
        return true
      }
      const title = hasTitle
        ? typeof body.title === 'string' ? normalizeSessionTitle(body.title) : ''
        : existing.title
      if (hasTitle) {
        if (!title) {
          json(res, 400, { error: 'session title is required' })
          return true
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          json(res, 400, { error: `session title must not exceed ${SESSION_TITLE_MAX_LENGTH} characters` })
          return true
        }
      }
      let mode = existing.mode
      if (hasMode) {
        const requestedMode = typeof body.mode === 'string' ? body.mode.trim() : ''
        const isLegacyMode = requestedMode === 'full-access'
          || requestedMode === 'info'
          || requestedMode === 'physical'
          || requestedMode === 'coding'
        if (!getPermissionMode(requestedMode) && !isLegacyMode) {
          json(res, 400, { error: 'session permission mode is invalid' })
          return true
        }
        mode = normalizePermissionModeId(requestedMode)
      }
      // The explicit switch of where one session works. A project-bound session
      // otherwise follows its project, so this is the deliberate way to move it;
      // a standalone session already follows the request and the saved default,
      // and recording a directory for it here would claim a binding runs ignore.
      let workspacePath = existing.workspacePath
      if (hasWorkspace) {
        if (existing.scope !== 'project') {
          json(res, 400, { error: 'only a project session has a workspace of its own' })
          return true
        }
        const requested = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : ''
        if (!requested || !isAbsolute(requested)) {
          json(res, 400, { error: 'session workspace path must be absolute' })
          return true
        }
        const normalized = resolve(requested)
        if (normalized.length > SESSION_WORKSPACE_PATH_MAX_LENGTH) {
          json(res, 400, { error: 'session workspace path is too long' })
          return true
        }
        let directory = false
        try {
          directory = statSync(normalized).isDirectory()
        } catch {
          directory = false
        }
        if (!directory) {
          json(res, 400, { error: `session workspace is not an existing directory: ${normalized}` })
          return true
        }
        workspacePath = normalized
      }
      if (title === existing.title && mode === existing.mode && workspacePath === existing.workspacePath) {
        json(res, 200, { session: existing })
        return true
      }

      const titleChanged = title !== existing.title
      const runner = titleChanged ? resolveRunner(context.getRunner) : undefined
      if (runner) await runner.sessionManager.updateMetadata(asSessionId(sessionUpdateId), { title })
      try {
        await sessionIndex.upsert(sessionUpdateId, {
          ...(titleChanged ? { title } : {}),
          ...(mode !== existing.mode ? { mode } : {}),
          ...(workspacePath !== existing.workspacePath ? { workspacePath } : {}),
        })
      } catch (error) {
        if (runner) {
          await runner.sessionManager.updateMetadata(asSessionId(sessionUpdateId), { title: existing.title }).catch(() => undefined)
        }
        throw error
      }
      const persisted = (await sessionIndex.list()).find((session) => session.id === sessionUpdateId)
      json(res, 200, { session: persisted ?? { ...existing, title, mode, workspacePath } })
      return true
    })
  }

  const sessionDeleteId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.sessions)
  if (method === 'DELETE' && sessionDeleteId !== null) {
    const removed = await sessionIndex.remove(sessionDeleteId)
    if (url.searchParams.get('hard') === '1') {
      await resolveRunner(context.getRunner).sessionManager.delete(asSessionId(sessionDeleteId))
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
    await resolveRunner(context.getRunner).sessionManager.delete(asSessionId(archivedSessionDeleteId))
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
    const runner = resolveRunner(context.getRunner)
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
    let log = await runner.replay(runId)
    if (log && log.sessionId !== sessionId) continue
    if (!log) {
      // A crash may leave durable run facts and user input without an audit
      // log. Still consult the settlement; never hide recovery behind a 404.
      const related = messages.filter((message) => message.runId === runId)
      const timestamp = related.at(-1)!.timestamp
      log = {
        runId, sessionId, status: 'error', model: '', inboundText: '', reply: '',
        startedAt: timestamp, endedAt: timestamp, durationMs: 0, trace: [], toolCalls: [],
      }
      const projected = await prepareAuthoritativeExecutionLog(runner, log)
      if (!projected.runtimeStatus && projected.durableHarnessMode !== 'next') continue
      logs.set(runId, projected)
    } else {
      logs.set(log.runId, await prepareAuthoritativeExecutionLog(runner, log))
    }
  }
  return logs
}

/**
 * Select the newest displayable counter for one session and strip the
 * context items before sending it to the renderer. The full context snapshot
 * remains in the durable execution log for diagnostics, but the history API
 * only needs token ledgers and request-to-snapshot associations.
 */
export function buildSessionContextUsageRecord(
  logs: Iterable<ExecutionLog>,
  sessionId: string,
): SessionContextUsageRecord | undefined {
  const sessionLogs = [...logs].filter((log) => log.sessionId === sessionId)
  const candidate = sessionLogs
    .filter((log) => hasDisplayableContextUsage(log))
    .sort((left, right) => executionLogTimestamp(left) - executionLogTimestamp(right))
    .at(-1)
  if (!candidate) return undefined

  return {
    modelRef: candidate.model,
    usage: candidate.usage,
    // Summed over the session's runs, from the same provider fields the ledger
    // judges: cached tokens over prompt tokens, cold start included.
    sessionCache: sessionCumulativeCache(sessionLogs),
    contextSnapshots: candidate.contextSnapshots?.map((snapshot) => ({
      id: snapshot.id,
      provider: snapshot.provider,
      model: snapshot.model,
      providerUsage: snapshot.providerUsage,
      localTokenLedger: snapshot.localTokenLedger,
    })),
    modelRequests: candidate.modelRequests?.map((request) => ({
      provider: request.provider,
      model: request.model,
      stage: request.stage,
      contextSnapshotId: request.contextSnapshotId,
    })),
  }
}

/**
 * The session's cumulative cache reuse.
 *
 * Only runs that reported provider usage contribute tokens; a run without usage
 * adds to `requestsWithoutUsage` instead of being counted as a miss. Compaction and
 * other detached calls are not part of a run's `usage`, so they stay out of this
 * number exactly as they stay out of the session red line.
 */
function sessionCumulativeCache(logs: readonly ExecutionLog[]): SessionContextUsageRecord['sessionCache'] {
  let inputTokens = 0
  let cachedTokens = 0
  let uncachedTokens = 0
  let measuredRequests = 0
  let requestsWithoutUsage = 0
  for (const log of logs) {
    const usage = log.usage
    if (!usage || usage.source !== 'provider') continue
    const requests = usage.requestCount ?? usage.usageReportedRequestCount ?? 0
    const reported = usage.usageReportedRequestCount ?? requests
    requestsWithoutUsage += Math.max(0, requests - reported)
    if (usage.promptTokens <= 0 || usage.cachedPromptTokens === undefined) continue
    inputTokens += usage.promptTokens
    cachedTokens += usage.cachedPromptTokens
    uncachedTokens += usage.uncachedPromptTokens
      ?? Math.max(0, usage.promptTokens - usage.cachedPromptTokens)
    measuredRequests += reported
  }
  if (measuredRequests === 0 && requestsWithoutUsage === 0) return undefined
  return {
    inputTokens,
    cachedTokens,
    uncachedTokens,
    measuredRequests,
    requestsWithoutUsage,
    ...(inputTokens > 0 ? { hitPercent: (cachedTokens / inputTokens) * 100 } : {}),
  }
}

function hasDisplayableContextUsage(log: ExecutionLog): boolean {
  return log.usage?.source === 'provider'
    || (log.contextSnapshots ?? []).some((snapshot) => Boolean(snapshot.providerUsage || snapshot.localTokenLedger))
}

function executionLogTimestamp(log: ExecutionLog): number {
  const endedAt = Date.parse(log.endedAt)
  if (Number.isFinite(endedAt)) return endedAt
  const startedAt = Date.parse(log.startedAt)
  return Number.isFinite(startedAt) ? startedAt : 0
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
