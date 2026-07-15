export function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return path
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatRelativeDate(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return value
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))}分`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时`
  return `${Math.floor(elapsed / day)}天`
}
