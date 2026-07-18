// The embedded browser owns this bounded history. It is deliberately separate
// from the application navigation stack and contains URLs only, never page data.

export const MAX_WORKSPACE_BROWSER_HISTORY = 50

export interface WorkspaceBrowserHistory {
  entries: string[]
  index: number
}

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
  if (state.entries[state.index] === normalized) return state
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

function normalizeHistoryDelta(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.trunc(value)
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
