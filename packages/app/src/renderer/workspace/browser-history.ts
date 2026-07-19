// The embedded browser owns this bounded history. It is deliberately separate
// from the application navigation stack and stores one URL per semantic page;
// transient anchors, tracking parameters, and in-page UI state replace the
// current entry instead of becoming invisible back/forward steps.

export const MAX_WORKSPACE_BROWSER_HISTORY = 50

export interface WorkspaceBrowserHistory {
  entries: string[]
  index: number
}

type BrowserHistoryIdentityResolver = (url: URL, hostname: string) => string | null

const SEMANTIC_QUERY_KEYS = new Set([
  'aid',
  'article',
  'article_id',
  'bvid',
  'id',
  'item',
  'item_id',
  'keyword',
  'post',
  'post_id',
  'product',
  'product_id',
  'q',
  'query',
  'search_query',
  'sku',
  'v',
  'vid',
  'video',
  'video_id',
  'wd',
])

const SITE_HISTORY_IDENTITY_RESOLVERS: BrowserHistoryIdentityResolver[] = [
  resolveBilibiliHistoryIdentity,
  resolveYouTubeHistoryIdentity,
]

export function createWorkspaceBrowserHistory(initialUrl = ''): WorkspaceBrowserHistory {
  const url = normalizeBrowserUrl(initialUrl)
  return url ? { entries: [url], index: 0 } : { entries: [], index: -1 }
}

export function appendWorkspaceBrowserHistory(
  state: WorkspaceBrowserHistory,
  url: string,
): WorkspaceBrowserHistory {
  const normalized = normalizeBrowserUrl(url)
  if (!normalized) return state
  const currentUrl = state.entries[state.index]
  if (currentUrl === normalized) return state
  if (currentUrl && browserUrlsShareHistoryEntry(currentUrl, normalized)) {
    return replaceWorkspaceBrowserHistory(state, normalized)
  }
  const entries = state.entries.slice(0, Math.max(0, state.index + 1))
  entries.push(normalized)
  const overflow = Math.max(0, entries.length - MAX_WORKSPACE_BROWSER_HISTORY)
  if (overflow > 0) entries.splice(0, overflow)
  return { entries, index: entries.length - 1 }
}

export function replaceWorkspaceBrowserHistory(
  state: WorkspaceBrowserHistory,
  url: string,
): WorkspaceBrowserHistory {
  const normalized = normalizeBrowserUrl(url)
  if (!normalized) return state
  if (state.index < 0 || state.index >= state.entries.length) return appendWorkspaceBrowserHistory(state, normalized)
  if (state.entries[state.index] === normalized) return state
  const entries = [...state.entries]
  entries[state.index] = normalized
  return { entries, index: state.index }
}

export function moveWorkspaceBrowserHistory(
  state: WorkspaceBrowserHistory,
  delta: number,
): WorkspaceBrowserHistory {
  const step = normalizeHistoryDelta(delta)
  if (step === 0) return state
  const index = Math.min(Math.max(state.index + step, 0), state.entries.length - 1)
  if (state.index < 0 || index === state.index) return state
  return { entries: state.entries, index }
}

export function compactWorkspaceBrowserHistory(
  state: WorkspaceBrowserHistory,
): WorkspaceBrowserHistory {
  if (state.entries.length === 0) return { entries: [], index: -1 }
  const requestedIndex = Math.min(
    Math.max(normalizeHistoryIndex(state.index, state.entries.length), 0),
    state.entries.length - 1,
  )
  const entries: string[] = []
  let index = -1

  for (let sourceIndex = 0; sourceIndex < state.entries.length; sourceIndex += 1) {
    const normalized = normalizeBrowserUrl(state.entries[sourceIndex] ?? '')
    if (!normalized) continue
    const previous = entries.at(-1)
    if (previous && browserUrlsShareHistoryEntry(previous, normalized)) {
      entries[entries.length - 1] = normalized
    } else {
      entries.push(normalized)
    }
    if (sourceIndex <= requestedIndex) index = entries.length - 1
  }

  if (entries.length === 0) return { entries: [], index: -1 }
  const overflow = Math.max(0, entries.length - MAX_WORKSPACE_BROWSER_HISTORY)
  if (overflow > 0) entries.splice(0, overflow)
  return {
    entries,
    index: Math.min(Math.max(index - overflow, 0), entries.length - 1),
  }
}

export function browserUrlsShareHistoryEntry(left: string, right: string): boolean {
  const leftIdentity = getBrowserHistoryIdentity(left)
  return Boolean(leftIdentity) && leftIdentity === getBrowserHistoryIdentity(right)
}

export function getBrowserHistoryIdentity(value: string): string {
  const normalized = normalizeBrowserUrl(value)
  if (!normalized) return ''
  const url = new URL(normalized)
  const hostname = normalizeHistoryHostname(url.hostname)

  for (const resolveIdentity of SITE_HISTORY_IDENTITY_RESOLVERS) {
    const identity = resolveIdentity(url, hostname)
    if (identity) return identity
  }

  const port = url.port ? `:${url.port}` : ''
  return `${hostname}${port}${normalizeHistoryPath(url.pathname)}${semanticQueryIdentity(url)}${hashRouteIdentity(url.hash)}`
}

function normalizeHistoryDelta(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.trunc(value)
}

function normalizeHistoryIndex(value: number, entryCount: number): number {
  if (!Number.isFinite(value)) return entryCount - 1
  return Math.trunc(value)
}

function resolveBilibiliHistoryIdentity(url: URL, hostname: string): string | null {
  if (hostname !== 'bilibili.com' && !hostname.endsWith('.bilibili.com')) return null
  const match = url.pathname.match(/^\/video\/(BV[0-9a-z]+|av\d+)(?:\/|$)/iu)
  if (!match?.[1]) return null
  const id = /^bv/iu.test(match[1]) ? `BV${match[1].slice(2)}` : match[1].toLowerCase()
  return `bilibili:video:${id}`
}

function resolveYouTubeHistoryIdentity(url: URL, hostname: string): string | null {
  if (hostname === 'youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0]
    return videoId ? `youtube:video:${videoId}` : null
  }
  if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return null
  const pathMatch = url.pathname.match(/^\/(?:embed|live|shorts)\/([^/?#]+)/iu)
  const videoId = pathMatch?.[1] ?? (normalizeHistoryPath(url.pathname) === '/watch' ? url.searchParams.get('v') : null)
  return videoId ? `youtube:video:${videoId}` : null
}

function normalizeHistoryHostname(value: string): string {
  return value.toLowerCase().replace(/^www\./u, '')
}

function normalizeHistoryPath(value: string): string {
  const normalized = value.replace(/\/{2,}/gu, '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized || '/'
}

function semanticQueryIdentity(url: URL): string {
  const entries = [...url.searchParams.entries()]
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .filter(([key, value]) => SEMANTIC_QUERY_KEYS.has(key) && Boolean(value))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ))
  if (entries.length === 0) return ''
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
}

function hashRouteIdentity(hash: string): string {
  const value = hash.slice(1)
  if (!value.startsWith('/') && !value.startsWith('!/')) return ''
  try {
    const route = new URL(value.startsWith('!') ? value.slice(1) : value, 'https://littlesheep.invalid')
    return `#${normalizeHistoryPath(route.pathname)}${semanticQueryIdentity(route)}`
  } catch {
    return ''
  }
}

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input) return ''
  const normalized = /^https?:\/\//iu.test(input) ? input : `https://${input}`
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

// Navigation events come from Chromium and must already contain a web URL.
// In particular, do not turn about:blank or another non-web scheme into a
// synthetic https URL and accidentally add it to the browser history.
export function normalizeBrowserEventUrl(value: string): string {
  const input = value.trim()
  if (!/^https?:\/\//iu.test(input)) return ''
  return normalizeBrowserUrl(input)
}
