// Session ownership, workspace scope and artifact helpers shared by run routes.

import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { getProvider, parseModelRef, type Config } from '@littlesheep/config'
import { asSessionId, type SessionId } from '@littlesheep/types'
import type { AgentRunner, RunnerResult, RunInput } from '@littlesheep/runner'
import type { Message } from '@littlesheep/types'
import { isSessionScope, type SessionScope } from '../../shared/session-scope.js'
import {
  normalizePermissionSelectionId,
  isPermissionSelectionPreset,
  type PermissionSelectionId,
} from '../../shared/permission-modes.js'
import { sameBoundPath } from '../path-rebinding.js'
import type { ProjectIndex } from '../project-index.js'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex, WorkspaceArtifactInput } from '../workspace-artifact-index.js'
import { HttpError } from './http.js'
import { isPathInsideOrSame, syncWorkspaceResourceChanges } from './workspace-support.js'

export interface RunResourceContext {
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
}

/** Persist Main-owned policy before execution so a first-turn crash is recoverable. */
export async function bindRunSessionPolicy(
  sessionIndex: SessionIndex,
  body: Record<string, unknown>,
  ownership: { scope: SessionScope; projectId?: string },
  workspacePath: string,
  existingSessionId?: SessionId,
): Promise<{ sessionId: SessionId; body: Record<string, unknown> }> {
  const sessionId = existingSessionId ?? asSessionId(randomUUID())
  if (!existingSessionId) {
    const now = Date.now()
    await sessionIndex.upsert(String(sessionId), {
      title: String(body.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60) || 'New session',
      createdAt: now,
      lastMessageAt: now,
      mode: normalizePermissionSelectionId(typeof body.permissionPreset === 'string' ? body.permissionPreset : undefined),
      permissionVersion: 2,
      scope: ownership.scope,
      projectId: ownership.projectId,
      workspacePath,
    })
  }
  return { sessionId, body: { ...body, sessionId: String(sessionId) } }
}

export function assertClientMemoryAuthorizationAbsent(body: Record<string, unknown>): void {
  if (['memoryAccessPolicy', 'memoryAccessGrant', 'memoryAccessContext', 'memoryPolicy', 'memoryAccessEnforcement', 'memoryOwnershipBindings'].some((key) => key in body)) {
    throw new HttpError(400, 'memory authorization cannot be supplied by the client')
  }
}

/**
 * Keep older/partial run callers aligned with the session's persisted policy.
 * An explicit permissionMode may narrow a run, but cannot raise an existing
 * session above its persisted authority. Permission upgrades use the dedicated
 * session mutation route; new sessions can still start from their chosen mode.
 */
export async function withPersistedSessionPermissionMode(
  sessionIndex: SessionIndex,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const existing = sessionId
    ? (await sessionIndex.list()).find((session) => session.id === sessionId)
    : undefined
  if (body.permissionMode !== undefined || isLegacyPermissionMode(body.mode)
    || isPermissionSelectionPreset(body.mode)) {
    throw new HttpError(400, 'legacy permission modes are no longer accepted; choose a current permission preset')
  }
  if (body.permissionPreset !== undefined && !isPermissionSelectionPreset(body.permissionPreset)) {
    throw new HttpError(400, 'permission preset is invalid')
  }
  if (sessionId && !existing) {
    throw new HttpError(409, 'session permission state is unavailable; reload the session before running')
  }
  const requestedPreset = isPermissionSelectionPreset(body.permissionPreset) ? body.permissionPreset : undefined
  if (!existing) return { ...body, permissionPreset: requestedPreset ?? 'workspace-write' }

  const storedPreset = normalizePermissionSelectionId(existing.mode)
  const selectedPreset = requestedPreset ?? storedPreset
  const rank = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 } as const
  const effectivePreset = rank[selectedPreset] <= rank[storedPreset] ? selectedPreset : storedPreset
  return { ...body, permissionPreset: effectivePreset }
}

export async function finishRunResources(
  context: RunResourceContext,
  runner: AgentRunner,
  result: RunnerResult,
  body: Record<string, unknown>,
  ownership: { scope: SessionScope; projectId?: string },
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
    mode: PermissionSelectionId
    permissionVersion: 2
    scope: SessionScope
    projectId?: string
    workspacePath: string
  } = {
    lastMessageAt: Date.now(),
    mode: normalizePermissionSelectionId(existing?.mode ?? explicitPermissionSelection(body) ?? 'workspace-write'),
    permissionVersion: 2,
    scope: ownership.scope,
    projectId: ownership.projectId,
    workspacePath,
  }
  if (!existing) updates.title = String(body.text ?? '').slice(0, 60) || 'New session'
  await sessionIndex.upsert(sessionId, updates)
}

function explicitPermissionSelection(body: Record<string, unknown>): PermissionSelectionId | undefined {
  if (isPermissionSelectionPreset(body.permissionPreset)) return body.permissionPreset
  return undefined
}

function isLegacyPermissionMode(value: unknown): boolean {
  return value === 'full' || value === 'research' || value === 'restricted'
    || value === 'info' || value === 'physical'
}

export async function resolveRunSessionOwnership(
  sessionIndex: SessionIndex,
  projectIndex: ProjectIndex,
  body: Record<string, unknown>,
): Promise<{ scope: SessionScope; projectId?: string }> {
  assertClientMemoryAuthorizationAbsent(body)
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
    if (requestedProjectId && requestedProjectId !== existing.projectId) {
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

/**
 * The one workspace fact for this run.
 *
 * Normalized here, at the run entry, because everything downstream reads this
 * single value: the prompt's `# Workspace` section, the tool working directory,
 * permission classification, artifact ownership and the workspace resource
 * index. Resolving it twice — once from the request and once from
 * `agents.defaults.workspace` — is what let the model describe one directory
 * while its tools wrote into another.
 *
 * A **project-bound session runs where its project is**, so its own directory
 * outranks the request: the renderer sends the runtime's current workspace with
 * every run, and that value is a *default* for sessions that have no binding of
 * their own. Without this a saved default (or a session switch in another
 * window) silently moved a project's session into another directory, and the
 * run-completion bookkeeping then rewrote the session's recorded directory to
 * match. Switching a project session's directory stays possible, but as an
 * explicit act on the session (or on the project, which rebinds its sessions).
 */
export interface RunWorkspaceFacts {
  /** The directory the session's project lives in. */
  projectPath?: string
  /** The directory this session last worked in. */
  sessionWorkspacePath?: string
}

export function resolveRunWorkspace(
  body: Record<string, unknown>,
  config: Config,
  workplaceDir: string,
  facts: RunWorkspaceFacts = {},
): string {
  const bound = facts.sessionWorkspacePath?.trim() || facts.projectPath?.trim() || ''
  if (bound) return normalizeWorkspacePath(bound)
  const bodyWorkspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  const configured = typeof config.agents?.defaults?.workspace === 'string'
    ? config.agents.defaults.workspace.trim()
    : ''
  return normalizeWorkspacePath(bodyWorkspace || configured || workplaceDir)
}

/**
 * Resolve the run's directory together with the session's ownership.
 *
 * Only a project-bound session has a directory of its own; a standalone session
 * keeps following the request and then the configured default, so saving a new
 * default still moves an ordinary chat.
 */
export async function resolveOwnedRunWorkspace(
  context: RunResourceContext,
  body: Record<string, unknown>,
  ownership: { scope: SessionScope; projectId?: string },
  config: Config,
  workplaceDir: string,
): Promise<string> {
  const project = ownership.projectId
    ? (await context.projectIndex.list()).find((item) => item.id === ownership.projectId) : undefined
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const session = sessionId
    ? (await context.sessionIndex.list()).find((item) => item.id === sessionId)
    : undefined
  return resolveRunWorkspace(body, config, workplaceDir, {
    projectPath: project?.path,
    sessionWorkspacePath: session?.workspacePath,
  })
}

/** Establish the user-selected directory before Main snapshots its file permissions. */
export async function prepareRunWorkspace(path: string, body: Record<string, unknown>): Promise<string> {
  try {
    // Creating the selected root is part of workspace-write, never an implicit
    // upgrade of a read-only run or a fallback into LS's data directory.
    if (body.permissionPreset === 'workspace-write') await mkdir(path, { recursive: true })
    if (!(await stat(path)).isDirectory()) throw new Error('目标不是文件夹')
    return await realpath(path)
  } catch (error) {
    throw new HttpError(400, `工作区无法使用：${path}。请在工作区设置中选择可访问的文件夹。${(error as Error).message}`)
  }
}

function normalizeWorkspacePath(selected: string): string {
  try {
    return resolve(selected)
  } catch {
    return selected
  }
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

/** A conversation may select a configured model without mutating the host default. */
export function resolveRunModelRef(body: Record<string, unknown>, config: Config): string | undefined {
  if (body.model === undefined) return undefined
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256) {
    throw new HttpError(400, 'conversation model must be a configured model reference')
  }
  const ref = body.model.trim()
  const parsed = parseModelRef(ref)
  const provider = getProvider(config, parsed.provider)
  if (!provider || provider.models?.length && !provider.models.some(entry => (typeof entry === 'string' ? entry : entry.id) === parsed.model)) {
    throw new HttpError(400, '所选模型不在当前供应商配置中，请重新选择模型。')
  }
  return ref
}
