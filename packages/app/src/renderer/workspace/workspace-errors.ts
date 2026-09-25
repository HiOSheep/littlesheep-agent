export function isMissingWorkspacePathError(error: unknown): boolean {
  if (typeof error === 'string') return isMissingWorkspacePathMessage(error)
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && isMissingWorkspacePathMessage(message)
}

export function workspaceErrorMessage(error: unknown, fallback: string): string {
  // A stale tab or deleted temporary workspace is not an actionable user
  // error. The affected view already has an empty/loading state, so keeping
  // this blank prevents OS paths from surfacing in the UI.
  return isMissingWorkspacePathError(error) ? '' : fallback
}

export function missingWorkspaceFileMessage(error: unknown): string {
  return isMissingWorkspacePathError(error)
    ? '文件已不存在或已被移动，请刷新文件树后重试。'
    : ''
}

/**
 * Statuses whose message is already actionable for the person saving.
 *
 * The generic fallback ("稍后重试") is wrong for all of them: a 409 means retrying
 * cannot work until the file is reloaded, a 413/415 means this file is not editable
 * here, and a 403 means the path is not ours to write. The server's own sentence says
 * what to do, so that is what the pane shows (UX-25 item 3).
 */
const ACTIONABLE_SAVE_STATUSES = new Set([403, 409, 413, 415])

export function workspaceSaveErrorMessage(error: unknown, fallback: string): string {
  const missing = missingWorkspaceFileMessage(error)
  if (missing) return missing
  const status = (error as { status?: unknown } | null)?.status
  const message = error instanceof Error ? error.message.trim() : ''
  if (typeof status === 'number' && ACTIONABLE_SAVE_STATUSES.has(status) && message) return message
  return fallback
}

function isMissingWorkspacePathMessage(message: string): boolean {
  return /(?:\bENOENT\b|no such file or directory)/iu.test(message)
}
