// Resolves Markdown links without granting them navigation or execution authority.

export type ResolvedLinkTarget =
  | { kind: 'web'; href: string }
  | { kind: 'file'; path: string }
  | { kind: 'fragment'; href: string }
  | { kind: 'unsupported'; href: string }

export function resolveLinkTarget(rawHref: string, workspaceRoot: string): ResolvedLinkTarget {
  const href = rawHref.trim()
  if (!href) return { kind: 'unsupported', href }
  if (href.startsWith('#')) return { kind: 'fragment', href }
  if (/^[a-zA-Z]:[\\/]/u.test(href) || href.startsWith('\\\\')) {
    return { kind: 'file', path: normalizeClientPath(safeDecode(href)) }
  }

  let url: URL | undefined
  try {
    url = new URL(href)
  } catch {
    url = undefined
  }
  if (url?.protocol === 'http:' || url?.protocol === 'https:') {
    return { kind: 'web', href: url.href }
  }
  if (url?.protocol === 'file:') {
    return { kind: 'file', path: fileUrlToClientPath(url) }
  }
  if (url) return { kind: 'unsupported', href: url.href }

  return {
    kind: 'file',
    path: joinClientPath(workspaceRoot, safeDecode(href.split(/[?#]/u, 1)[0] ?? href)),
  }
}

function fileUrlToClientPath(url: URL): string {
  const pathname = safeDecode(url.pathname)
  const windowsPath = pathname.replace(/^\/([a-zA-Z]:)/u, '$1').replace(/\//gu, '\\')
  if (url.host && url.host !== 'localhost') return `\\\\${url.host}\\${windowsPath.replace(/^\\+/u, '')}`
  return normalizeClientPath(windowsPath)
}

function joinClientPath(root: string, relativePath: string): string {
  if (!root.trim()) return normalizeClientPath(relativePath)
  const separator = root.includes('\\') || /^[a-zA-Z]:/u.test(root) ? '\\' : '/'
  const joined = `${root.replace(/[\\/]+$/u, '')}${separator}${relativePath.replace(/^[\\/]+/u, '')}`
  return normalizeClientPath(joined, separator)
}

function normalizeClientPath(value: string, preferredSeparator?: '\\' | '/'): string {
  const separator = preferredSeparator ?? (value.includes('\\') || /^[a-zA-Z]:/u.test(value) ? '\\' : '/')
  const normalized = value.replace(/[\\/]+/gu, separator)
  const drive = /^[a-zA-Z]:/u.exec(normalized)?.[0] ?? ''
  const unc = !drive && normalized.startsWith('\\\\')
  const body = drive ? normalized.slice(drive.length) : unc ? normalized.slice(2) : normalized
  const segments: string[] = []
  for (const segment of body.split(separator)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  const prefix = drive ? `${drive}${separator}` : unc ? `${separator}${separator}` : normalized.startsWith(separator) ? separator : ''
  return `${prefix}${segments.join(separator)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
