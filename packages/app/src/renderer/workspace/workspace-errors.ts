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

function isMissingWorkspacePathMessage(message: string): boolean {
  return /(?:\bENOENT\b|no such file or directory)/iu.test(message)
}
