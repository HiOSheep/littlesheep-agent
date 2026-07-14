// Renderer-side API client: calls the local app API on 127.0.0.1.
// The base URL is injected by the preload contextBridge.

import type { RuntimeReasoning } from '../shared/model-capabilities'
import type { HistoryActivity } from '../shared/history-activity'
import type { SessionScope } from '../shared/session-scope'
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

declare global {
  interface Window {
    littlesheep: {
      apiBase: string
      getPathForFile?: (file: unknown) => string
    }
  }
}

const apiBase: string = window.littlesheep?.apiBase ?? 'http://127.0.0.1:0'

function localApiStatusError(status: number): Error {
  return new Error(`Local app API error: ${status}`)
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  lastMessageAt: number
  mode: string
  scope: SessionScope
  projectId?: string
  workspacePath?: string
}

export interface ProjectMeta {
  id: string
  name: string
  path: string
  createdAt: string
  lastActiveAt: string
  identityVersion?: 2
  previousPaths?: string[]
  pathUpdatedAt?: string
}

export interface ArchivedSessionMeta extends SessionMeta {
  archivedAt: number
}

export interface ArchivedProjectMeta extends ProjectMeta {
  archivedAt: number
}

export interface ArchivePayload {
  projects: ArchivedProjectMeta[]
  sessions: ArchivedSessionMeta[]
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
  const res = await fetch(`${apiBase}/run`, {
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

export interface AttachmentRef {
  path: string
  name?: string
  kind?: 'image' | 'document' | 'file'
  mimeType?: string
  size?: number
  cacheId?: string
  contentHash?: string
  ownership?: 'cache' | 'agent_workplace' | 'user_workplace' | 'project' | 'external'
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
  const res = await fetch(`${apiBase}/run/stream`, {
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
  const res = await fetch(`${apiBase}/approvals/${encodeURIComponent(id)}`, {
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
  const res = await fetch(`${apiBase}/sessions`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ sessions: SessionMeta[] }>
}

export async function listProjects(): Promise<{ projects: ProjectMeta[] }> {
  const res = await fetch(`${apiBase}/projects`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ projects: ProjectMeta[] }>
}

export async function createProjectFolder(parentPath: string, name: string): Promise<{ path: string; project: ProjectMeta }> {
  const res = await fetch(`${apiBase}/projects/create-folder`, {
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
  const res = await fetch(`${apiBase}/projects/register`, {
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
  const res = await fetch(`${apiBase}/projects/${encodeURIComponent(id)}/rebind`, {
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
  const res = await fetch(`${apiBase}/projects/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteSession(id: string, opts: { hard?: boolean } = {}): Promise<void> {
  const suffix = opts.hard ? '?hard=1' : ''
  const res = await fetch(`${apiBase}/sessions/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function listArchive(): Promise<ArchivePayload> {
  const res = await fetch(`${apiBase}/archive`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ArchivePayload>
}

export async function restoreArchivedSession(id: string): Promise<{ session: SessionMeta; project?: ProjectMeta }> {
  const res = await fetch(`${apiBase}/archive/sessions/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ session: SessionMeta; project?: ProjectMeta }>
}

export async function restoreArchivedProject(id: string): Promise<{ project: ProjectMeta; sessions: SessionMeta[] }> {
  const res = await fetch(`${apiBase}/archive/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ project: ProjectMeta; sessions: SessionMeta[] }>
}

export async function deleteArchivedSession(id: string): Promise<void> {
  const res = await fetch(`${apiBase}/archive/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteArchivedProject(id: string): Promise<void> {
  const res = await fetch(`${apiBase}/archive/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export interface HistoryMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  durationMs?: number
  activityCollapsed?: boolean
  activity?: HistoryActivity
}

export async function getSessionMessages(id: string): Promise<HistoryMessage[]> {
  const res = await fetch(`${apiBase}/sessions/${id}/messages`)
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { messages: HistoryMessage[] }
  return data.messages
}

// ─── Settings / API Key ──────────────────────────────────────────────────

export interface ProviderInfo {
  id: string
  name?: string
  baseURL: string
  /** Env var name (e.g. "DEEPSEEK_API_KEY"), or null if hardcoded/none. */
  envVar: string | null
  /** Whether the key is currently set (env var resolves to a value). */
  hasKey: boolean
  /** Where the key comes from: env var reference, literal string, or none. */
  source: 'env' | 'literal' | 'none'
}

/** GET /config/providers — list providers + API key status. */
export async function getProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${apiBase}/config/providers`)
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { providers: ProviderInfo[] }
  return data.providers
}

export interface RuntimeProvider {
  id: string
  name: string
  baseURL: string
  models: string[]
  envVar: string | null
  requiresKey: boolean
  hasKey: boolean
}

export interface RuntimeState {
  model: string
  reasoning: RuntimeReasoning
  profile: AgentProfileId
  contextCompressionThresholdRatio: number
  workspace: string
  workplace: string
  providers: RuntimeProvider[]
}

export interface DataRootMigrationState {
  id: string
  sourceDir: string
  targetDir: string
  stageDir: string
  phase: 'requested' | 'copying' | 'verifying' | 'committing' | 'failed'
  createdAt: string
  updatedAt: string
  attempts: number
  error?: string
  fileCount?: number
  totalBytes?: number
  manifestHash?: string
}

export interface DataRootRollbackState {
  id: string
  fromDir: string
  toDir: string
  createdAt: string
  error?: string
}

export interface DataRootStatus {
  managed: boolean
  currentDataDir: string
  defaultDataDir: string
  locatorPath: string
  environmentOverride?: string
  previousDataDir?: string
  pendingMigration?: DataRootMigrationState
  pendingRollback?: DataRootRollbackState
  lastMigration?: {
    id: string
    sourceDir: string
    targetDir: string
    completedAt: string
    fileCount: number
    totalBytes: number
    manifestHash: string
  }
  requiresRestart: boolean
  canRollback: boolean
}

export async function getRuntime(): Promise<RuntimeState> {
  const res = await fetch(`${apiBase}/runtime`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RuntimeState>
}

export async function updateRuntime(patch: Partial<Pick<RuntimeState, 'model' | 'reasoning' | 'profile' | 'contextCompressionThresholdRatio' | 'workspace'>>): Promise<RuntimeState> {
  const res = await fetch(`${apiBase}/runtime`, {
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
  const res = await fetch(`${apiBase}/data-root`)
  return parseDataRootResponse(res)
}

export async function selectDataRootTarget(): Promise<string | null> {
  const res = await fetch(`${apiBase}/data-root/select`, { method: 'POST' })
  if (!res.ok) throw await localApiResponseError(res)
  const data = await res.json() as { path: string | null }
  return data.path
}

export async function requestDataRootMigration(targetDir: string): Promise<DataRootStatus> {
  const res = await fetch(`${apiBase}/data-root/migration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDir }),
  })
  return parseDataRootResponse(res)
}

export async function cancelDataRootOperation(): Promise<DataRootStatus> {
  const res = await fetch(`${apiBase}/data-root/migration`, { method: 'DELETE' })
  return parseDataRootResponse(res)
}

export async function requestDataRootRollback(): Promise<DataRootStatus> {
  const res = await fetch(`${apiBase}/data-root/rollback`, { method: 'POST' })
  return parseDataRootResponse(res)
}

export async function restartApplication(): Promise<void> {
  const res = await fetch(`${apiBase}/application/restart`, { method: 'POST' })
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
  const res = await fetch(`${apiBase}/workspace/select`, { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { path: string | null }
  return data.path
}

export async function selectAttachments(): Promise<AttachmentRef[]> {
  const res = await fetch(`${apiBase}/attachments/select`, { method: 'POST' })
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

export interface WorkspaceArtifactRecord {
  id: string
  path: string
  name: string
  action: 'created' | 'modified' | 'attached'
  source: 'agent' | 'user'
  workspacePath: string
  sessionId?: string
  projectId?: string
  runId?: string
  toolName?: string
  createdAt: string
}

export interface WorkspaceLayoutSnapshot {
  version: 1
  updatedAt: string
  workspacePath: string
  sessionId?: string
  width: number
  collapsed: boolean
  fullscreen: boolean
  activeTab: string
  openTabs: string[]
  openRequest: { root: string; path: string } | null
  fileNavigatorCollapsed: boolean
  drafts: Record<string, {
    path: string
    modifiedAt?: number
    editorText: string
    savedText: string
    editing: boolean
  }>
}

function workspaceQuery(root: string, path?: string): string {
  const params = new URLSearchParams({ root })
  if (path) params.set('path', path)
  return params.toString()
}

export async function listWorkspaceDirectory(root: string, path?: string): Promise<WorkspaceDirectory> {
  const res = await fetch(`${apiBase}/workspace/list?${workspaceQuery(root, path)}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceDirectory>
}

export async function previewWorkspaceFile(root: string, path: string): Promise<WorkspacePreview> {
  const res = await fetch(`${apiBase}/workspace/preview?${workspaceQuery(root, path)}`)
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
  const res = await fetch(`${apiBase}/workspace/save`, {
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
  const res = await fetch(`${apiBase}/workspace/layout`)
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
  const res = await fetch(`${apiBase}/workspace/layout`, {
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
  const res = await fetch(`${apiBase}/workspace/artifacts?${params.toString()}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { records: WorkspaceArtifactRecord[] }
  return data.records
}

export async function openWorkspacePath(root: string, path: string): Promise<void> {
  const res = await fetch(`${apiBase}/workspace/open`, {
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
  const res = await fetch(`${apiBase}/workspace/open-vscode`, {
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

export interface TerminalActivityRecord {
  id: string
  command: string
  cwd: string
  workspacePath: string
  sessionId?: string
  startedAt: string
  endedAt: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  truncated: boolean
  stdoutPreview: string
  stderrPreview: string
}

export async function runWorkspaceCommand(root: string, command: string, sessionId?: string): Promise<WorkspaceCommandResult> {
  const res = await fetch(`${apiBase}/workspace/terminal/run`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/stream`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/activity?${params.toString()}`)
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
  const res = await fetch(`${apiBase}/workspace/terminal/session`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/session/${encodeURIComponent(terminalSessionId)}/stream`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/session/${encodeURIComponent(terminalSessionId)}/input`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/session/${encodeURIComponent(terminalSessionId)}/resize`, {
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
  const res = await fetch(`${apiBase}/workspace/terminal/session/${encodeURIComponent(terminalSessionId)}/interrupt`, {
    method: 'POST',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function closeWorkspaceTerminalSession(terminalSessionId: string): Promise<void> {
  const res = await fetch(`${apiBase}/workspace/terminal/session/${encodeURIComponent(terminalSessionId)}`, {
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
  const res = await fetch(`${apiBase}/attachments/import`, {
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
  const res = await fetch(`${apiBase}/config/apikey`, {
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

export interface ChannelStatus {
  type: string
  displayName: string
  running: boolean
  requiredSecrets: string[]
}

export interface ConfiguredChannel {
  id: string
  type: string
  enabled: boolean
  name?: string
}

export interface ChannelConnectionsStatus {
  started: boolean
  channels: ChannelStatus[]
  configured: ConfiguredChannel[]
  failures: Array<{ id: string; type: string; error: string }>
}

/** GET /channels/status — external channel service status + channel list. */
export async function getChannelConnectionsStatus(): Promise<ChannelConnectionsStatus> {
  const res = await fetch(`${apiBase}/channels/status`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ChannelConnectionsStatus>
}

/** POST /channels/reload — reload config from disk + restart all external channels. */
export async function reloadChannelConnections(): Promise<{ ok: boolean }> {
  const res = await fetch(`${apiBase}/channels/reload`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ ok: boolean }>
}

export type PluginRuntimeState = 'disabled' | 'inactive' | 'activating' | 'active' | 'blocked' | 'failed'

export interface PluginStatus {
  id: string
  name: string
  version: string
  description: string
  publisher?: string
  source: 'builtin' | 'local'
  location?: string
  enabled: boolean
  state: PluginRuntimeState
  capabilities: string[]
  permissions: string[]
  activationEvents: string[]
  contributes: { channels: string[]; tools: string[]; skills: string[] }
  error?: string
}

export interface PluginDiagnostic {
  source: string
  message: string
}

export interface PluginsStatusResponse {
  started: boolean
  allowLocalCode: boolean
  plugins: PluginStatus[]
  diagnostics: PluginDiagnostic[]
}

export async function getPluginsStatus(): Promise<PluginsStatusResponse> {
  const res = await fetch(`${apiBase}/plugins`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<PluginsStatusResponse>
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${apiBase}/plugins/${encodeURIComponent(pluginId)}/enabled`, {
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
  const res = await fetch(`${apiBase}/plugins/local-code`, {
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
  const res = await fetch(`${apiBase}/plugins/reload`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

// ─── Memory & Skills ──────────────────────────────────────────────────────

export interface SkillMeta {
  name: string
  description: string
}

export interface SkillDetail {
  name: string
  description: string
  body: string
}

export interface MemoryOverview {
  dailyDates: string[]
  longTerm: string
  experienceCount: number
}

export interface MemoryTreeBranchOverview {
  id: MemoryTreeBranchId
  title: string
  tier: string
  status: 'active' | 'empty'
  count: number
  indexedCount: number
  archivedCount: number
  source: string
  description: string
  whenToUse: string
  searchHints: string[]
}

export type MemoryTreeBranchId = 'long-term' | 'project' | 'daily' | 'experience'
export type MemoryResourceKind =
  | 'agent-instructions'
  | 'persona'
  | 'user-profile'
  | 'tool-guidance'
  | 'legacy-memory'
  | 'skill'
  | 'project-guideline'
  | 'ui-guideline'
  | 'taskbook'
  | 'knowledge'
  | 'summary-memory'
  | 'attachment-manifest'
  | 'attachment'
  | 'runtime-event-ledger'
  | 'workspace-index'
  | 'project-memory-projection'
export type MemoryResourceStatus = 'active' | 'missing' | 'disabled' | 'conflict'
export type MemoryResourceManagementAction = 'disable' | 'restore' | 'remove' | 'rebind'
export type MemoryTreeNodeStatus = 'active' | 'archived'
export type MemoryTreeManagementAction = 'archive' | 'restore' | 'delete' | 'promote' | 'demote'

export interface MemoryTreeWriteAudit {
  id: string
  intentId: string
  sourceRunId: string
  branch: MemoryTreeBranchId
  at: string
  decision: 'created' | 'merged' | 'reinforced' | 'rejected' | 'queued'
  nodeId?: string
  reason: string
}

export interface MemoryTreeManagementAudit {
  id: string
  nodeId: string
  branch: MemoryTreeBranchId
  action: MemoryTreeManagementAction
  at: string
  reason: string
  fromStatus: 'active' | 'archived' | 'deleted'
  toStatus: 'active' | 'archived' | 'deleted'
  fromTier: 1 | 2 | 3
  toTier: 1 | 2 | 3
}

export interface MemoryResourceManagementAudit {
  id: string
  resourceId: string
  resourceKind: MemoryResourceKind
  registryGroup: string
  action: 'disable' | 'restore' | 'mark-missing' | 'mark-conflict' | 'remove' | 'rebind'
  actor: 'user' | 'system'
  at: string
  reason: string
  fromStatus: MemoryResourceStatus
  toStatus?: MemoryResourceStatus
  fromSourcePath?: string
  toSourcePath?: string
}

export interface MemoryTreeRecentHit {
  runId: string
  sessionId: string
  at: string
  action: 'expand' | 'deep_search'
  query?: string
  reason?: string
}

export interface MemoryTreeNodeOverview {
  id: string
  branch: MemoryTreeBranchId
  parentNodeId?: string
  childCount: number
  scope: 'global' | 'workspace' | 'project' | 'session'
  scopeKey?: string
  project?: { id: string; name: string; path: string }
  tier: 1 | 2 | 3
  summary: string
  content: string
  retrievalKeys: string[]
  importance: number
  confidence: number
  reason: string
  sourceRunIds: string[]
  sourceStages: Array<'evolve' | 'capture' | 'tool' | 'migration'>
  sourceRefs: string[]
  status: MemoryTreeNodeStatus
  createdAt: string
  updatedAt: string
  hitCount: number
  recentHits: MemoryTreeRecentHit[]
  writeHistory: MemoryTreeWriteAudit[]
  managementHistory: MemoryTreeManagementAudit[]
}

export interface MemoryTreeProjectOverview {
  id: string
  name: string
  path: string
  lastActiveAt: string
  projection?: ProjectMemoryProjectionState
}

export interface ProjectMemoryProjectionState {
  projectId: string
  enabled: boolean
  projectionPath: string
  projectionExists: boolean
  safeToRemove: boolean
  status: 'disabled' | 'missing' | 'ready' | 'stale' | 'conflict'
  gitRepository: boolean
  gitIgnored: boolean
  gitIgnorePattern: string
  sourceRevision?: string
  entryCount?: number
  omittedEntryCount?: number
  lastSyncedAt?: string
  conflictReason?: string
}

export type ProjectMemoryProjectionAction =
  | { action: 'enable'; overwriteExisting?: boolean }
  | { action: 'sync'; force?: boolean }
  | { action: 'disable'; removeProjection?: boolean }
  | { action: 'export' }

export interface ProjectMemoryProjectionExportResult {
  outputPath: string
  entryCount: number
  omittedEntryCount: number
  contentHash: string
  generatedAt: string
}

export interface MemoryTreeOverview {
  generatedAt: string
  totals: {
    branches: number
    projects: number
    dailyMemories: number
    experiences: number
    longTermChars: number
    indexedMemories: number
    archivedMemories: number
    deletedMemories: number
    recoveryQueue: number
    registeredResources: number
    activeResources: number
  }
  branches: MemoryTreeBranchOverview[]
  nodes: MemoryTreeNodeOverview[]
  projects: MemoryTreeProjectOverview[]
  resources: Array<{
    id: string
    kind: MemoryResourceKind
    title: string
    description: string
    tier: 0 | 1 | 2 | 3
    branch?: MemoryTreeBranchId
    scope: 'global' | 'workspace' | 'project' | 'session' | 'run'
    scopeKey?: string
    authority: 'authoritative' | 'derived' | 'compatibility' | 'external'
    privacy: 'private' | 'project-private' | 'shareable' | 'public'
    sourceKind: 'file' | 'memory-node' | 'session-summary' | 'attachment' | 'runtime-event' | 'workspace-index'
    sourcePath?: string
    indexKeys: string[]
    status: MemoryResourceStatus
    registryGroup: string
    owner?: {
      kind: 'builtin' | 'user' | 'external' | 'plugin'
      id: string
      controller: 'skill-loader' | 'plugin-host'
    }
    updatedAt: string
    managementHistory: MemoryResourceManagementAudit[]
  }>
  dailyDates: string[]
  longTermExcerpt: string
  recentAccesses: Array<MemoryTreeRecentHit & {
    nodeId: string
    summary: string
    branch: MemoryTreeBranchId
  }>
  migration: null | {
    id: string
    completedAt: string
    sourceCount: number
    created: number
    merged: number
    reinforced: number
    rejected: number
  }
  learningPolicy: {
    experienceWriteThreshold: number
  }
}

export async function listSkills(): Promise<SkillMeta[]> {
  const res = await fetch(`${apiBase}/skills`)
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { skills: SkillMeta[] }
  return data.skills
}

export async function readSkill(name: string): Promise<SkillDetail> {
  const res = await fetch(`${apiBase}/skills/${encodeURIComponent(name)}`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<SkillDetail>
}

export async function getMemoryOverview(): Promise<MemoryOverview> {
  const res = await fetch(`${apiBase}/memory`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryOverview>
}

export async function getMemoryTreeOverview(): Promise<MemoryTreeOverview> {
  const res = await fetch(`${apiBase}/memory/tree`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryTreeOverview>
}

export async function updateMemoryLearningPolicy(experienceWriteThreshold: number): Promise<{ experienceWriteThreshold: number }> {
  const res = await fetch(`${apiBase}/memory/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experienceWriteThreshold }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ experienceWriteThreshold: number }>
}

export async function manageMemoryTreeNode(
  nodeId: string,
  action: MemoryTreeManagementAction,
): Promise<{ node: { id: string; status: 'active' | 'archived' | 'deleted'; tier: 1 | 2 | 3 }; audit: MemoryTreeManagementAudit }> {
  const res = await fetch(`${apiBase}/memory/tree/nodes/${encodeURIComponent(nodeId)}/manage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Local app API error: ${res.status}`)
  }
  return res.json() as Promise<{
    node: { id: string; status: 'active' | 'archived' | 'deleted'; tier: 1 | 2 | 3 }
    audit: MemoryTreeManagementAudit
  }>
}

export async function manageMemoryTreeResource(
  resourceId: string,
  action: MemoryResourceManagementAction,
  options: { sourcePath?: string } = {},
): Promise<{
  cancelled: boolean
  resource?: { id: string; status: MemoryResourceStatus }
  audit?: MemoryResourceManagementAudit
  changed?: boolean
  removed?: boolean
}> {
  const res = await fetch(`${apiBase}/memory/tree/resources/${encodeURIComponent(resourceId)}/manage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...options }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Local app API error: ${res.status}`)
  }
  return res.json() as Promise<{
    cancelled: boolean
    resource?: { id: string; status: MemoryResourceStatus }
    audit?: MemoryResourceManagementAudit
    changed?: boolean
    removed?: boolean
  }>
}

export async function updateProjectMemoryProjection(
  projectId: string,
  action: ProjectMemoryProjectionAction,
): Promise<ProjectMemoryProjectionState | { cancelled: boolean; export?: ProjectMemoryProjectionExportResult }> {
  const res = await fetch(`${apiBase}/memory/projects/${encodeURIComponent(projectId)}/projection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<ProjectMemoryProjectionState | { cancelled: boolean; export?: ProjectMemoryProjectionExportResult }>
}
