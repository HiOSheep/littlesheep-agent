// Session ownership, workspace scope and artifact helpers shared by run routes.

import { isAbsolute, resolve } from 'node:path'
import type { Config } from '@littlesheep/config'
import type { AgentRunner, RunInput } from '@littlesheep/runner'
import type { Message } from '@littlesheep/types'
import { isSessionScope, type SessionScope } from '../../shared/session-scope.js'
import { normalizePermissionModeId } from '../modes.js'
import { sameBoundPath } from '../path-rebinding.js'
import type { ProjectIndex } from '../project-index.js'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex, WorkspaceArtifactInput } from '../workspace-artifact-index.js'
import { HttpError } from './http.js'
import { isPathInsideOrSame } from './workspace-support.js'

export async function updateSessionIndex(
  sessionIndex: SessionIndex,
  sessionId: string,
  body: Record<string, unknown>,
  ownership: { scope: SessionScope; projectId?: string },
  workspacePath: string,
): Promise<void> {
  const existing = (await sessionIndex.list()).find((session) => session.id === sessionId)
  const updates: {
    title?: string
    lastMessageAt: number
    mode: string
    scope: SessionScope
    projectId?: string
    workspacePath: string
  } = {
    lastMessageAt: Date.now(),
    mode: normalizePermissionModeId(typeof body.permissionMode === 'string' ? body.permissionMode : String(body.mode ?? '')),
    scope: ownership.scope,
    projectId: ownership.projectId,
    workspacePath,
  }
  if (!existing) updates.title = String(body.text ?? '').slice(0, 60) || 'New session'
  await sessionIndex.upsert(sessionId, updates)
}

export async function resolveRunSessionOwnership(
  sessionIndex: SessionIndex,
  projectIndex: ProjectIndex,
  body: Record<string, unknown>,
): Promise<{ scope: SessionScope; projectId?: string }> {
  const requestedScope = isSessionScope(body.sessionScope) ? body.sessionScope : undefined
  const requestedProjectId = typeof body.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : undefined
  const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : undefined
  const existing = requestedSessionId
    ? (await sessionIndex.list()).find((session) => session.id === requestedSessionId)
    : undefined
  if (existing) {
    if (requestedScope && requestedScope !== existing.scope) {
      throw new HttpError(409, 'session ownership cannot be changed')
    }
    if (existing.scope === 'project' && requestedProjectId && requestedProjectId !== existing.projectId) {
      throw new HttpError(409, 'session belongs to a different project')
    }
    return { scope: existing.scope, projectId: existing.projectId }
  }
  if (requestedScope !== 'project') return { scope: 'standalone' }
  if (!requestedProjectId) throw new HttpError(400, 'project sessions require projectId')
  const project = (await projectIndex.list()).find((item) => item.id === requestedProjectId)
  if (!project) throw new HttpError(404, `project not found: ${requestedProjectId}`)
  return { scope: 'project', projectId: project.id }
}

export function resolveRunWorkspaceContext(
  workspacePath: string,
  ownership: { scope: SessionScope; projectId?: string },
  workplaceDir: string,
): NonNullable<RunInput['workspaceContext']> {
  if (ownership.projectId) return { boundaryKind: 'project', projectId: ownership.projectId }
  return {
    boundaryKind: sameBoundPath(workspacePath, workplaceDir) ? 'agent_workplace' : 'user_workplace',
  }
}

export async function appendAgentArtifacts(
  artifactIndex: WorkspaceArtifactIndex,
  result: { runId: string; sessionId: string; messages?: Message[] },
  workspacePath: string,
  projectId?: string,
): Promise<WorkspaceArtifactInput[]> {
  const artifacts = extractWorkspaceArtifactsFromMessages(result.messages ?? [], {
    workspacePath,
    sessionId: result.sessionId,
    projectId,
    runId: result.runId,
  })
  if (artifacts.length === 0) return []
  await artifactIndex.appendMany(artifacts)
  return artifacts
}

export function resolveRunWorkspace(
  body: Record<string, unknown>,
  config: Config,
  workplaceDir: string,
): string {
  const bodyWorkspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  return bodyWorkspace || config.agents.defaults.workspace || workplaceDir
}

function extractWorkspaceArtifactsFromMessages(
  messages: Message[],
  context: { workspacePath: string; sessionId: string; projectId?: string; runId: string },
): WorkspaceArtifactInput[] {
  const calls = new Map<string, { name: string; input: unknown }>()
  const results = new Map<string, { ok: boolean }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_calls') {
        for (const call of block.calls) calls.set(call.id, { name: call.name, input: call.input })
      } else if (block.type === 'tool_result') {
        results.set(block.result.callId, { ok: block.result.ok })
      }
    }
  }
  const byPath = new Map<string, WorkspaceArtifactInput>()
  for (const [callId, call] of calls) {
    if (!results.get(callId)?.ok) continue
    const action = workspaceArtifactActionForTool(call.name)
    if (!action) continue
    const filePath = toolInputFilePath(call.input)
    if (!filePath) continue
    const resolvedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(context.workspacePath, filePath)
    if (!isPathInsideOrSame(context.workspacePath, resolvedPath)) continue
    byPath.set(resolvedPath, {
      path: resolvedPath,
      action,
      source: 'agent',
      workspacePath: context.workspacePath,
      sessionId: context.sessionId,
      projectId: context.projectId,
      runId: context.runId,
      toolName: call.name,
    })
  }
  return Array.from(byPath.values())
}

function workspaceArtifactActionForTool(name: string): WorkspaceArtifactInput['action'] | null {
  if (name === 'write' || name === 'write_file') return 'created'
  if (name === 'edit' || name === 'edit_file') return 'modified'
  return null
}

function toolInputFilePath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const value = record.file_path ?? record.path ?? record.filePath
  return typeof value === 'string' ? value.trim() : ''
}
