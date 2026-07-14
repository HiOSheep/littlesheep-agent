// Renderer-side API client: calls the local app API on 127.0.0.1.
// The base URL is injected by the preload contextBridge.

import type { RuntimeReasoning } from '../shared/model-capabilities'
import type { HistoryMessageRecord } from '../shared/history-activity'
import type { SessionScope } from '../shared/session-scope'
import type { AttachmentRef } from '../shared/attachment-contracts'
import type {
  DataRootStatus,
  ProviderInfo,
  RuntimePatch,
  RuntimeState,
} from '../shared/runtime-api-contracts'
import type { PluginsStatusResponse } from '../shared/plugin-control-contracts'
import type { ChannelConnectionsStatus } from '../shared/channel-control-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../shared/local-app-api-routes'
import type {
  ArchivePayload,
  ArchivedProjectMeta,
  ArchivedSessionMeta,
  ProjectMeta,
  SessionMeta,
} from '../shared/session-project-contracts'
import type {
  TerminalActivityRecord,
  WorkspaceArtifactRecord,
  WorkspaceLayoutSnapshot,
} from '../shared/workspace-contracts'
import type {
  ContextSnapshot,
  ModelRequestSnapshot,
  TaskBook,
  ToolStreamEvent,
  VerificationRecord,
} from '@littlesheep/types'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { PermissionModeId } from '../shared/permission-modes'

export type { AgentProfileId } from '@littlesheep/prompt'
export type { PermissionModeId } from '../shared/permission-modes'
export type { AttachmentRef } from '../shared/attachment-contracts'
export type * from '../shared/memory-control-contracts'
export type * from '../shared/runtime-api-contracts'
export type * from '../shared/plugin-control-contracts'
export type * from '../shared/channel-control-contracts'
export type { HistoryMessageRecord as HistoryMessage } from '../shared/history-activity'
export type {
  ArchivePayload,
  ArchivedProjectMeta,
  ArchivedSessionMeta,
  ProjectMeta,
  SessionMeta,
} from '../shared/session-project-contracts'
export type {
  TerminalActivityRecord,
  WorkspaceArtifactRecord,
  WorkspaceLayoutSnapshot,
} from '../shared/workspace-contracts'
export * from './api/memory'

declare global {
  interface Window {
    littlesheep: {
      apiBase: string
      getPathForFile?: (file: unknown) => string
    }
  }
}

const apiBase: string = window.littlesheep?.apiBase ?? 'http://127.0.0.1:0'

function localApiUrl(path: string): string {
  return `${apiBase}${path}`
}

function localApiStatusError(status: number): Error {
  return new Error(`Local app API error: ${status}`)
}

export interface RunResult {
  runId: string
  sessionId: string
  status: 'ok' | 'error' | 'aborted'
  reply: string
  error?: string
  durationMs: number
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens?: number
    source: 'provider'
  }
  contextSnapshots?: ContextSnapshot[]
  modelRequests?: ModelRequestSnapshot[]
  trace?: { name: string; ok: boolean }[]
  messages?: { role: string; content: unknown[] }[]
  taskBook?: TaskBook
  verificationHistory?: VerificationRecord[]
  taskExecution?: {
    goal: string
    complexity: string
    status: string
    startedAt: string
    endedAt?: string
    summary?: string
    steps: Array<{
      stepId: string
      title?: string
      description: string
      status: string
      startedAt: string
      endedAt?: string
      output?: string
      error?: string
      failureKind?: 'tool_error' | 'permission_denied' | 'not_found' | 'model_error' | 'verification_gap' | 'aborted' | 'unknown'
      attempt?: number
      toolCallIds: string[]
    }>
    replanHistory?: Array<{
      attempt: number
      requestedAt: string
      targetStepIds: string[]
      reason: string
      feedback: string
      preservedStepIds: string[]
      revisedStepIds?: string[]
      decidedAt?: string
      resumedAt?: string
    }>
  }
  clarificationRequest?: {
    id: string
    kind: 'missing_information' | 'ambiguous_request' | 'recovery_decision'
    sourceStage: 'classify' | 'decide' | 'execute' | 'recover' | 'verify'
    createdAt: string
    originalRequest: string
    blockingReason: string
    missingInfo?: string[]
    questions: Array<{
      id: string
      field: string
      prompt: string
      required: boolean
      options?: string[]
      defaultValue?: string
    }>
    prompt?: string
  }
  clarificationResponse?: {
    requestId: string
    answer: string
    answeredAt: string
  }
}

export async function runAgent(
  text: string,
  sessionId?: string,
  permissionMode?: PermissionModeId,
  profile?: AgentProfileId,
): Promise<RunResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.run), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, permissionMode, profile }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RunResult>
}

export interface RunStreamHandlers {
  signal?: AbortSignal
  onDelta: (delta: string) => void
  onApprovalRequest?: (request: ApprovalRequest) => boolean | Promise<boolean>
  onToolEvent?: (evt: ToolStreamEvent) => void
}

export interface ApprovalRequest {
  id: string
  action: string
  detail?: unknown
  permissionMode: PermissionModeId
  source?: 'agent' | 'workspace'
}

export interface RunOptions {
  workspace?: string
  sessionScope?: SessionScope
  projectId?: string
  reasoning?: RuntimeReasoning
  profile?: AgentProfileId
  attachments?: AttachmentRef[]
}

export async function runAgentStream(
  text: string,
  sessionId: string | undefined,
  permissionMode: PermissionModeId | undefined,
  handlers: RunStreamHandlers,
  options: RunOptions = {},
): Promise<RunResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runStream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, permissionMode, ...options }),
    signal: handlers.signal,
  })
  if (!res.ok) throw localApiStatusError(res.status)
  if (!res.body) throw new Error('Local app API stream has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: RunResult | undefined

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (!event) continue
      if (event.name === 'delta') {
        handlers.onDelta(String((event.data as { delta?: string }).delta ?? ''))
      } else if (event.name === 'tool_start' || event.name === 'tool_end') {
        const d = event.data as { callId?: string; name?: string; stepId?: string; input?: unknown; ok?: boolean; output?: string; error?: string }
        handlers.onToolEvent?.({
          type: event.name,
          callId: String(d.callId ?? ''),
          name: String(d.name ?? ''),
          stepId: d.stepId,
          input: d.input,
          ok: d.ok,
          output: d.output,
          error: d.error,
        })
      } else if (
        event.name === 'task_book'
        || event.name === 'step_start'
        || event.name === 'step_done'
        || event.name === 'step_failed'
        || event.name === 'step_skipped'
        || event.name === 'verification_start'
        || event.name === 'verification'
        || event.name === 'final_delta'
      ) {
        handlers.onToolEvent?.(event.data as ToolStreamEvent)
      } else if (event.name === 'approval_request') {
        const d = event.data as ApprovalRequest
        const approved = await handlers.onApprovalRequest?.(d) ?? false
        await respondApproval(String(d.id), approved)
      } else if (event.name === 'result') {
        finalResult = event.data as RunResult
      } else if (event.name === 'error') {
        throw new Error(String((event.data as { error?: string }).error ?? 'stream failed'))
      }
    }
    if (done) break
  }

  if (!finalResult) throw new Error('Local app API stream ended without result')
  return finalResult
}

async function respondApproval(id: string, approved: boolean): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.approvals, id)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
}

function parseSseFrame(frame: string): { name: string; data: unknown } | null {
  let name = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return { name, data: JSON.parse(dataLines.join('\n')) }
}

export async function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.sessions))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ sessions: SessionMeta[] }>
}

export async function listProjects(): Promise<{ projects: ProjectMeta[] }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projects))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ projects: ProjectMeta[] }>
}

export async function createProjectFolder(parentPath: string, name: string): Promise<{ path: string; project: ProjectMeta }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projectCreateFolder), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ path: string; project: ProjectMeta }>
}

export async function registerProject(path: string): Promise<{ project: ProjectMeta }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projectRegister), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ project: ProjectMeta }>
}

export async function rebindProject(
  id: string,
  path: string,
): Promise<{ project: ProjectMeta; sessions: SessionMeta[]; recovered: boolean; runtime: RuntimeState }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.projects, id, '/rebind')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{
    project: ProjectMeta
    sessions: SessionMeta[]
    recovered: boolean
    runtime: RuntimeState
  }>
}

export async function deleteProject(id: string, opts: { hard?: boolean } = {}): Promise<void> {
  const suffix = opts.hard ? '?hard=1' : ''
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.projects, id, suffix)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteSession(id: string, opts: { hard?: boolean } = {}): Promise<void> {
  const suffix = opts.hard ? '?hard=1' : ''
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id, suffix)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function listArchive(): Promise<ArchivePayload> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.archive))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ArchivePayload>
}

export async function restoreArchivedSession(id: string): Promise<{ session: SessionMeta; project?: ProjectMeta }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveSessions, id, '/restore')), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ session: SessionMeta; project?: ProjectMeta }>
}

export async function restoreArchivedProject(id: string): Promise<{ project: ProjectMeta; sessions: SessionMeta[] }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveProjects, id, '/restore')), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ project: ProjectMeta; sessions: SessionMeta[] }>
}

export async function deleteArchivedSession(id: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveSessions, id)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteArchivedProject(id: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveProjects, id)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function getSessionMessages(id: string): Promise<HistoryMessageRecord[]> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id, '/messages')))
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { messages: HistoryMessageRecord[] }
  return data.messages
}

// ─── Settings / API Key ──────────────────────────────────────────────────

/** GET /config/providers — list providers + API key status. */
export async function getProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configProviders))
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { providers: ProviderInfo[] }
  return data.providers
}

export async function getRuntime(): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runtime))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RuntimeState>
}

export async function updateRuntime(patch: RuntimePatch): Promise<RuntimeState> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runtime), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<RuntimeState>
}

export async function getDataRootStatus(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRoot))
  return parseDataRootResponse(res)
}

export async function selectDataRootTarget(): Promise<string | null> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootSelect), { method: 'POST' })
  if (!res.ok) throw await localApiResponseError(res)
  const data = await res.json() as { path: string | null }
  return data.path
}

export async function requestDataRootMigration(targetDir: string): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootMigration), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDir }),
  })
  return parseDataRootResponse(res)
}

export async function cancelDataRootOperation(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootMigration), { method: 'DELETE' })
  return parseDataRootResponse(res)
}

export async function requestDataRootRollback(): Promise<DataRootStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.dataRootRollback), { method: 'POST' })
  return parseDataRootResponse(res)
}

export async function restartApplication(): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.applicationRestart), { method: 'POST' })
  if (!res.ok) throw await localApiResponseError(res)
}

async function parseDataRootResponse(res: Response): Promise<DataRootStatus> {
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<DataRootStatus>
}

async function localApiResponseError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => null) as { error?: string } | null
  return new Error(data?.error ?? `Local app API error: ${res.status}`)
}

export async function selectWorkspace(): Promise<string | null> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceSelect), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { path: string | null }
  return data.path
}

export async function selectAttachments(): Promise<AttachmentRef[]> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.attachmentSelect), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { files: AttachmentRef[] }
  return data.files
}

export interface WorkspaceEntry {
  name: string
  path: string
  relativePath: string
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
}

export interface WorkspaceDirectory {
  root: string
  path: string
  relativePath: string
  entries: WorkspaceEntry[]
  truncated: boolean
  hiddenCount: number
}

export type WorkspacePreview =
  | {
    kind: 'text'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    language: string
    content: string
  }
  | {
    kind: 'markdown'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    content: string
  }
  | {
    kind: 'image' | 'pdf' | 'unsupported'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    reason?: string
  }

function workspaceQuery(root: string, path?: string): string {
  const params = new URLSearchParams({ root })
  if (path) params.set('path', path)
  return params.toString()
}

export async function listWorkspaceDirectory(root: string, path?: string): Promise<WorkspaceDirectory> {
  const res = await fetch(`${localApiUrl(LOCAL_APP_API_ROUTES.workspaceList)}?${workspaceQuery(root, path)}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceDirectory>
}

export async function previewWorkspaceFile(root: string, path: string): Promise<WorkspacePreview> {
  const res = await fetch(`${localApiUrl(LOCAL_APP_API_ROUTES.workspacePreview)}?${workspaceQuery(root, path)}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspacePreview>
}

export async function saveWorkspaceFile(
  root: string,
  path: string,
  content: string,
  expectedModifiedAt?: number,
  sessionId?: string,
): Promise<WorkspacePreview> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceSave), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path, content, expectedModifiedAt, sessionId }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspacePreview>
}

export async function readWorkspaceLayoutSnapshot(): Promise<WorkspaceLayoutSnapshot | null> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceLayout))
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { snapshot: WorkspaceLayoutSnapshot | null }
  return data.snapshot
}

export async function saveWorkspaceLayoutSnapshot(
  snapshot: Omit<WorkspaceLayoutSnapshot, 'version' | 'updatedAt'>,
): Promise<WorkspaceLayoutSnapshot> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceLayout), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { snapshot: WorkspaceLayoutSnapshot }
  return data.snapshot
}

export async function listWorkspaceArtifacts(
  root: string,
  sessionId?: string,
  limit = 50,
): Promise<WorkspaceArtifactRecord[]> {
  const params = new URLSearchParams({ root, limit: String(limit) })
  if (sessionId) params.set('sessionId', sessionId)
  const res = await fetch(`${localApiUrl(LOCAL_APP_API_ROUTES.workspaceArtifacts)}?${params.toString()}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { records: WorkspaceArtifactRecord[] }
  return data.records
}

export async function openWorkspacePath(root: string, path: string): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceOpen), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function openWorkspacePathInVSCode(root: string, path?: string): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.workspaceOpenVscode), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path: path ?? root }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export interface WorkspaceCommandResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

export async function runWorkspaceCommand(root: string, command: string, sessionId?: string): Promise<WorkspaceCommandResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.terminalRun), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, command, sessionId }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceCommandResult>
}

export interface WorkspaceCommandStreamHandlers {
  signal?: AbortSignal
  onStart?: (event: { command: string; cwd: string }) => void
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  onTruncated?: () => void
}

export async function runWorkspaceCommandStream(
  root: string,
  command: string,
  sessionId?: string,
  handlers: WorkspaceCommandStreamHandlers = {},
): Promise<WorkspaceCommandResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.terminalStream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, command, sessionId }),
    signal: handlers.signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  if (!res.body) throw new Error('Local app API terminal stream has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: WorkspaceCommandResult | undefined

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (!event) continue
      if (event.name === 'start') {
        const data = event.data as { command?: string; cwd?: string }
        handlers.onStart?.({ command: String(data.command ?? command), cwd: String(data.cwd ?? root) })
      } else if (event.name === 'stdout') {
        handlers.onStdout?.(String((event.data as { text?: string }).text ?? ''))
      } else if (event.name === 'stderr') {
        handlers.onStderr?.(String((event.data as { text?: string }).text ?? ''))
      } else if (event.name === 'truncated') {
        handlers.onTruncated?.()
      } else if (event.name === 'result') {
        finalResult = event.data as WorkspaceCommandResult
      } else if (event.name === 'error') {
        throw new Error(String((event.data as { error?: string }).error ?? 'terminal stream failed'))
      }
    }
    if (done) break
  }

  if (!finalResult) throw new Error('Local app API terminal stream ended without result')
  return finalResult
}

export async function listWorkspaceTerminalActivity(
  root: string,
  sessionId?: string,
  limit = 12,
): Promise<TerminalActivityRecord[]> {
  const params = new URLSearchParams({ root, limit: String(limit) })
  if (sessionId) params.set('sessionId', sessionId)
  const res = await fetch(`${localApiUrl(LOCAL_APP_API_ROUTES.terminalActivity)}?${params.toString()}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { records: TerminalActivityRecord[] }
  return data.records
}

export interface WorkspaceTerminalSession {
  sessionId: string
  cwd: string
  shell: string
  backend?: 'pty' | 'spawn'
  cols: number
  rows: number
}

export interface WorkspaceTerminalSessionHandlers {
  signal?: AbortSignal
  onStart?: (event: WorkspaceTerminalSession) => void
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  onExit?: (event: { exitCode: number | null; signal: string | null }) => void
  onError?: (message: string) => void
}

export async function createWorkspaceTerminalSession(
  root: string,
  size?: { cols: number; rows: number },
): Promise<WorkspaceTerminalSession> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.terminalSession), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, cols: size?.cols, rows: size?.rows }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceTerminalSession>
}

export async function streamWorkspaceTerminalSession(
  terminalSessionId: string,
  handlers: WorkspaceTerminalSessionHandlers,
): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId, '/stream')), {
    signal: handlers.signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  if (!res.body) throw new Error('Local app API terminal session stream has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (!event) continue
      if (event.name === 'start') {
        handlers.onStart?.(event.data as WorkspaceTerminalSession)
      } else if (event.name === 'stdout') {
        handlers.onStdout?.(String((event.data as { text?: string }).text ?? ''))
      } else if (event.name === 'stderr') {
        handlers.onStderr?.(String((event.data as { text?: string }).text ?? ''))
      } else if (event.name === 'exit') {
        handlers.onExit?.(event.data as { exitCode: number | null; signal: string | null })
      } else if (event.name === 'error') {
        handlers.onError?.(String((event.data as { error?: string }).error ?? 'terminal session failed'))
      }
    }
    if (done) break
  }
}

export async function writeWorkspaceTerminalSession(
  terminalSessionId: string,
  command: string,
  appSessionId?: string,
): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId, '/input')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, sessionId: appSessionId }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function resizeWorkspaceTerminalSession(
  terminalSessionId: string,
  cols: number,
  rows: number,
): Promise<WorkspaceTerminalSession> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId, '/resize')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceTerminalSession>
}

export async function interruptWorkspaceTerminalSession(terminalSessionId: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId, '/interrupt')), {
    method: 'POST',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function closeWorkspaceTerminalSession(terminalSessionId: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId)), {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

/** POST /config/apikey — save API key (encrypted) + rebuild runner. */
export function getPathForFile(file: File): string {
  return window.littlesheep?.getPathForFile?.(file) ?? ''
}

export async function importAttachment(file: File): Promise<AttachmentRef> {
  const dataUrl = await readFileAsDataUrl(file)
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.attachmentImport), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name || defaultAttachmentName(file),
      mimeType: file.type,
      dataUrl,
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { file: AttachmentRef }
  return data.file
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read attachment'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

function defaultAttachmentName(file: File): string {
  if (file.type === 'image/png') return 'clipboard.png'
  if (file.type === 'image/jpeg') return 'clipboard.jpg'
  return 'clipboard-file'
}

export async function saveApiKey(envVar: string, key: string): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.configApiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envVar, key }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

// ─── External Channel Connections ─────────────────────────────────────────

/** GET /channels/status — external channel service status + channel list. */
export async function getChannelConnectionsStatus(): Promise<ChannelConnectionsStatus> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.channelsStatus))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ChannelConnectionsStatus>
}

/** POST /channels/reload — reload config from disk + restart all external channels. */
export async function reloadChannelConnections(): Promise<{ ok: boolean }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.channelsReload), { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ ok: boolean }>
}

export async function getPluginsStatus(): Promise<PluginsStatusResponse> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.plugins))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<PluginsStatusResponse>
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.plugins, pluginId, '/enabled')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function setLocalPluginCodeAllowed(allowed: boolean): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.pluginsLocalCode), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function reloadPlugins(): Promise<void> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.pluginsReload), { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}
