// Bounded diagnostics for pages running in the embedded browser.
//
// A workspace HTML page that is *run* (UX-26) can fail the way pages do: a script
// throws, a stylesheet or image 404s, the document itself refuses to load. The user
// must not have to open DevTools to learn that, so Main keeps a small per-URL record
// of what the guest reported and the renderer shows it next to the run controls.
//
// It is deliberately a *record*, not a log: fixed capacity, one entry per event,
// message and source truncated, and entries dropped from the front. Nothing here
// needs the page to be trustworthy — a page can spam its own console, so the cap is
// what keeps the notice meaningful.

export type EmbeddedBrowserDiagnosticKind = 'script' | 'resource' | 'navigation' | 'console'

export interface EmbeddedBrowserDiagnostic {
  kind: EmbeddedBrowserDiagnosticKind
  message: string
  url: string
  sourceId: string
  lineNumber: number
  at: string
}

export const EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT = 40
export const EMBEDDED_BROWSER_DIAGNOSTIC_MESSAGE_MAX = 300

/** Console levels as Electron reports them: verbose, info, warning, error. */
const CONSOLE_LEVEL_ERROR = 3
const CONSOLE_LEVEL_WARNING = 2

const entries: EmbeddedBrowserDiagnostic[] = []
let revision = 0

export interface GuestConsoleMessage {
  url: string
  message: string
  /** Electron's `source`: javascript, network, security, rendering, … */
  source: string
  /** Electron's numeric level: 0 verbose … 3 error. */
  level: number
  sourceId?: string
  lineNumber?: number
}

/**
 * Map Electron's newer named level onto the numeric one this record uses.
 *
 * Electron 36 hands the modern `console-message` details a `level` of
 * `info | warning | error | debug` while the older signature numbered them
 * `verbose | info | warning | error`. Keeping one numeric scale here means the
 * classifier and its tests describe severity once.
 */
export function consoleLevelToNumber(level: string | number): number {
  if (typeof level === 'number') return level
  switch (level) {
    case 'error': return CONSOLE_LEVEL_ERROR
    case 'warning': return CONSOLE_LEVEL_WARNING
    case 'info': return 1
    default: return 0
  }
}

/**
 * Classify a guest console message.
 *
 * Chromium reports a failed subresource as a `network` message whose text starts
 * with "Failed to load resource"; everything else that reached the error level is
 * the page's own doing (a thrown exception, a rejected promise), so the two are
 * separated — "资源失败" and "脚本报错" need different reactions from the user.
 */
export function classifyGuestConsole(message: GuestConsoleMessage): EmbeddedBrowserDiagnosticKind | null {
  const text = message.message.trim()
  if (!text) return null
  if (message.source === 'network' || /^Failed to load resource/iu.test(text)) return 'resource'
  if (message.level >= CONSOLE_LEVEL_ERROR) return 'script'
  if (message.source === 'security' || message.source === 'deprecation' || message.source === 'violation') return 'console'
  if (message.level >= CONSOLE_LEVEL_WARNING) return 'console'
  return null
}

export function recordGuestConsole(message: GuestConsoleMessage): EmbeddedBrowserDiagnostic | null {
  const kind = classifyGuestConsole(message)
  if (!kind) return null
  return push({
    kind,
    message: message.message,
    url: message.url,
    sourceId: message.sourceId ?? '',
    lineNumber: message.lineNumber ?? 0,
  })
}

export function recordGuestLoadFailure(input: {
  url: string
  errorCode: number
  errorDescription: string
}): EmbeddedBrowserDiagnostic {
  const description = input.errorDescription || `错误 ${input.errorCode}`
  return push({
    kind: 'navigation',
    message: `页面加载失败：${description}${input.errorCode ? ` (${input.errorCode})` : ''}`,
    url: input.url,
    sourceId: '',
    lineNumber: 0,
  })
}

/**
 * A subresource the page asked for did not arrive.
 *
 * Chromium reports a 404 stylesheet as a *network* log entry that never reaches
 * `console-message` (measured: a page with a missing stylesheet and image recorded
 * zero resource entries), so these come from the session's web request observers
 * instead — the same place a refused connection after 停止 shows up.
 */
export function recordGuestResourceFailure(input: {
  /** Page the resource belongs to; the referrer when the observer knows it. */
  url: string
  resourceUrl: string
  statusCode: number
  resourceType: string
}): EmbeddedBrowserDiagnostic {
  const status = input.statusCode > 0 ? `HTTP ${input.statusCode}` : '请求失败'
  return push({
    kind: 'resource',
    message: `资源加载失败：${status}（${input.resourceType}）${input.resourceUrl}`,
    url: input.url,
    sourceId: input.resourceUrl,
    lineNumber: 0,
  })
}

/**
 * The page a guest is on, remembered so a resource failure with no referrer can
 * still be attributed to something the renderer can query by URL.
 */
let lastGuestPageUrl = ''

export function rememberGuestPageUrl(url: string): void {
  if (url && !url.startsWith('about:')) lastGuestPageUrl = url
}

export function lastRememberedGuestPageUrl(): string {
  return lastGuestPageUrl
}

/** Entries for one page (exact URL, or every page when omitted), newest last. */
export function listGuestDiagnostics(url?: string): EmbeddedBrowserDiagnostic[] {
  if (!url) return [...entries]
  return entries.filter((entry) => entry.url === url)
}

/** Counts per kind for one page, which is what the compact notice shows. */
export function summarizeGuestDiagnostics(url?: string): Record<EmbeddedBrowserDiagnosticKind, number> {
  const summary: Record<EmbeddedBrowserDiagnosticKind, number> = { script: 0, resource: 0, navigation: 0, console: 0 }
  for (const entry of listGuestDiagnostics(url)) summary[entry.kind] += 1
  return summary
}

export function clearGuestDiagnostics(): void {
  entries.length = 0
  revision += 1
}

/** Bumped on every write; the renderer can poll it cheaply instead of the list. */
export function guestDiagnosticsRevision(): number {
  return revision
}

function push(input: Omit<EmbeddedBrowserDiagnostic, 'at'>): EmbeddedBrowserDiagnostic {
  const entry: EmbeddedBrowserDiagnostic = {
    ...input,
    message: input.message.replace(/\s+/gu, ' ').trim().slice(0, EMBEDDED_BROWSER_DIAGNOSTIC_MESSAGE_MAX),
    url: input.url.slice(0, 2048),
    at: new Date().toISOString(),
  }
  entries.push(entry)
  if (entries.length > EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT) entries.splice(0, entries.length - EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT)
  revision += 1
  return entry
}
