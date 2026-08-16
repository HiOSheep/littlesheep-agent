// Workspace command and interactive terminal clients.

import type { TerminalActivityRecord } from '../../shared/workspace-contracts'
import type { PermissionModeId } from '../../shared/permission-modes'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import { localApiStatusError, localApiUrl, parseSseFrame } from './common'

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

export async function runWorkspaceCommand(
  root: string,
  command: string,
  sessionId?: string,
  options: { permissionMode?: PermissionModeId; approved?: boolean } = {},
): Promise<WorkspaceCommandResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.terminalRun), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, command, sessionId, ...options }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw localApiStatusError(res.status, (data as { error: string }).error)
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
  options: { permissionMode?: PermissionModeId; approved?: boolean } = {},
): Promise<WorkspaceCommandResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.terminalStream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, command, sessionId, ...options }),
    signal: handlers.signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw localApiStatusError(res.status, (data as { error: string }).error)
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
    throw localApiStatusError(res.status, (data as { error: string }).error)
  }
  const data = await res.json() as { records: TerminalActivityRecord[] }
  return data.records
}

export interface WorkspaceTerminalSession {
  sessionId: string
  cwd: string
  source: 'workspace-user'
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
    throw localApiStatusError(res.status, (data as { error: string }).error)
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
    throw localApiStatusError(res.status, (data as { error: string }).error)
  }
}

/** Send raw xterm input to the PTY without synthesizing a command form. */
export async function writeWorkspaceTerminalInput(
  terminalSessionId: string,
  data: string,
  appSessionId?: string,
): Promise<{ completed: number }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.terminalSessions, terminalSessionId, '/input')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, sessionId: appSessionId }),
  })
  if (!res.ok) {
    const response = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw localApiStatusError(res.status, (response as { error: string }).error)
  }
  const response = await res.json().catch(() => ({ completed: 0 })) as { completed?: number }
  return { completed: typeof response.completed === 'number' ? response.completed : 0 }
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
