// Agent run, streaming, approval and run-owned resource lifecycle routes.

import { randomUUID } from 'node:crypto'
import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import {
  createInspectAttachmentTool,
  parseAttachments,
  prepareRunAttachments,
} from '../attachments.js'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import type { ProjectIndex } from '../project-index.js'
import { resolveRunPolicy, type RunApprovalBroker } from '../run-policy.js'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import { json, readJson, writeSse, type LocalAppApiRequest } from './http.js'
import { resolveReasoning } from './runtime-routes.js'
import {
  appendAgentArtifacts,
  resolveRunSessionOwnership,
  resolveRunWorkspace,
  resolveRunWorkspaceContext,
  updateSessionIndex,
} from './run-support.js'
import { syncWorkspaceResourceChanges } from './workspace-support.js'

const MAX_ACTIVE_STREAM_RUNS = 16
const MAX_PENDING_APPROVALS = 64

interface PendingApproval {
  resolve: (approved: boolean) => void
  cleanup: () => void
}

interface ApprovalRequestPayload {
  id: string
  action: string
  detail?: unknown
  permissionMode: string
  source: 'agent'
}

export interface RunRouteContext {
  getRunner: () => AgentRunner
  getConfig: () => Config
  workplaceDir: string
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  attachmentCache: ManagedAttachmentCache
}

export class RunRouter {
  private readonly activeControllers = new Set<AbortController>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  async route(request: LocalAppApiRequest, context: RunRouteContext): Promise<boolean> {
    const { req, res, path, method } = request

    const approvalId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.approvals)
    if (method === 'POST' && approvalId !== null) {
      const body = await readJson(req)
      const pending = this.pendingApprovals.get(approvalId)
      if (!pending) {
        json(res, 404, { error: `approval request not found: ${approvalId}` })
        return true
      }
      this.pendingApprovals.delete(approvalId)
      pending.cleanup()
      pending.resolve(body.approved === true)
      json(res, 200, { ok: true })
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.runStream) {
      if (this.activeControllers.size >= MAX_ACTIVE_STREAM_RUNS) {
        json(res, 429, { error: 'too many active agent runs' })
        return true
      }
      const body = await readJson(req)
      const controller = new AbortController()
      this.activeControllers.add(controller)
      let completed = false
      req.on('close', () => {
        if (!completed) controller.abort()
      })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      writeSse(res, 'start', { ok: true })
      try {
        const runner = context.getRunner()
        const cwd = resolveRunWorkspace(body, context.getConfig(), context.workplaceDir)
        const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, body)
        const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
        const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
          managedCache: context.attachmentCache,
          workplaceDir: context.workplaceDir,
          workspaceDir: cwd,
          projectId: ownership.projectId,
        })
        const inspectAttachmentTool = createInspectAttachmentTool(attachments)
        const result = await runner.runStream(
          {
            text: String(body.text ?? ''),
            sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
            origin: 'app',
            cwd,
            reasoning: resolveReasoning(body, context.getConfig()),
            attachments,
            additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
            workspaceContext,
            signal: controller.signal,
            onToolEvent: (event) => writeSse(res, event.type, event),
            ...resolveRunPolicy(
              body,
              context.getConfig(),
              this.buildApprovalBroker(
                (approval) => writeSse(res, 'approval_request', approval),
                controller.signal,
              ),
            ),
          },
          (delta) => writeSse(res, 'delta', { delta }),
        )
        await this.finishRun(context, runner, result, body, ownership, cwd, workspaceContext)
        writeSse(res, 'result', result)
      } catch (error) {
        writeSse(res, 'error', { error: (error as Error).message })
      } finally {
        completed = true
        this.activeControllers.delete(controller)
        res.end()
      }
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.run) {
      const body = await readJson(req)
      const runner = context.getRunner()
      const cwd = resolveRunWorkspace(body, context.getConfig(), context.workplaceDir)
      const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, body)
      const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
      const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
        managedCache: context.attachmentCache,
        workplaceDir: context.workplaceDir,
        workspaceDir: cwd,
        projectId: ownership.projectId,
      })
      const inspectAttachmentTool = createInspectAttachmentTool(attachments)
      const result = await runner.run({
        text: String(body.text ?? ''),
        sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
        origin: 'app',
        cwd,
        reasoning: resolveReasoning(body, context.getConfig()),
        attachments,
        additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
        workspaceContext,
        ...resolveRunPolicy(body, context.getConfig()),
      })
      await this.finishRun(context, runner, result, body, ownership, cwd, workspaceContext)
      json(res, 200, result)
      return true
    }

    return false
  }

  stop(): void {
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
    for (const pending of this.pendingApprovals.values()) {
      pending.cleanup()
      pending.resolve(false)
    }
    this.pendingApprovals.clear()
  }

  private async finishRun(
    context: RunRouteContext,
    runner: AgentRunner,
    result: Awaited<ReturnType<AgentRunner['run']>>,
    body: Record<string, unknown>,
    ownership: { scope: 'standalone' | 'project'; projectId?: string },
    cwd: string,
    workspaceContext: NonNullable<Parameters<AgentRunner['infra']['memoryService']['syncWorkspaceResources']>[1]>,
  ): Promise<void> {
    await updateSessionIndex(context.sessionIndex, result.sessionId, body, ownership, cwd)
    if (ownership.projectId) await context.projectIndex.touch(ownership.projectId)
    const artifacts = await appendAgentArtifacts(
      context.workspaceArtifactIndex,
      result,
      cwd,
      ownership.projectId,
    )
    if (artifacts.length > 0) {
      await syncWorkspaceResourceChanges(runner, cwd, {
        ...workspaceContext,
        changes: artifacts.map((artifact) => ({ path: artifact.path, source: 'agent' })),
      })
    }
  }

  private buildApprovalBroker(
    requestApproval: (request: ApprovalRequestPayload) => void,
    signal?: AbortSignal,
  ): RunApprovalBroker {
    return async ({ action, detail, permissionMode }) => {
      const id = randomUUID()
      return new Promise<boolean>((resolveApproval) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined
        let onAbort: (() => void) | undefined
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          if (onAbort) signal?.removeEventListener('abort', onAbort)
        }
        const settle = (allowed: boolean) => {
          if (settled) return
          settled = true
          cleanup()
          this.pendingApprovals.delete(id)
          resolveApproval(allowed)
        }
        onAbort = () => settle(false)
        timer = setTimeout(() => settle(false), 120_000)
        while (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
          const oldest = this.pendingApprovals.values().next().value as PendingApproval | undefined
          if (!oldest) break
          oldest.cleanup()
          oldest.resolve(false)
        }
        this.pendingApprovals.set(id, { resolve: settle, cleanup })
        if (signal?.aborted) {
          settle(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          requestApproval({ id, action, detail, permissionMode, source: 'agent' })
        } catch {
          settle(false)
        }
      })
    }
  }
}
