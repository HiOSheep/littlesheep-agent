import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT,
  EMBEDDED_BROWSER_DIAGNOSTIC_MESSAGE_MAX,
  classifyGuestConsole,
  clearGuestDiagnostics,
  guestDiagnosticsRevision,
  lastRememberedGuestPageUrl,
  listGuestDiagnostics,
  recordGuestConsole,
  recordGuestLoadFailure,
  recordGuestResourceFailure,
  rememberGuestPageUrl,
  summarizeGuestDiagnostics,
} from './embedded-browser-diagnostics'

const page = 'http://127.0.0.1:41234/token/canvas-game.html'

beforeEach(() => {
  clearGuestDiagnostics()
})

describe('embedded browser diagnostics', () => {
  it('separates a thrown script error from a failed resource', () => {
    expect(classifyGuestConsole({ url: page, message: 'Uncaught TypeError: x is not a function', source: 'javascript', level: 3 })).toBe('script')
    expect(classifyGuestConsole({ url: page, message: 'Failed to load resource: the server responded with a status of 404 (Not Found)', source: 'network', level: 3 })).toBe('resource')
    // A network message is a resource failure even when Chromium logs it as an error.
    expect(classifyGuestConsole({ url: page, message: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', source: 'other', level: 3 })).toBe('resource')
    expect(classifyGuestConsole({ url: page, message: 'Deprecated feature used', source: 'deprecation', level: 2 })).toBe('console')
    expect(classifyGuestConsole({ url: page, message: 'hello', source: 'console-api', level: 1 })).toBeNull()
    expect(classifyGuestConsole({ url: page, message: '   ', source: 'javascript', level: 3 })).toBeNull()
  })

  it('records a load failure as a navigation problem the user can read', () => {
    const entry = recordGuestLoadFailure({ url: page, errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED' })

    expect(entry.kind).toBe('navigation')
    expect(entry.message).toContain('NAME_NOT_RESOLVED')
    expect(entry.message).toContain('-105')
    expect(listGuestDiagnostics(page)).toHaveLength(1)
  })

  it('records a subresource failure the console never reports', () => {
    // Measured: a missing stylesheet and image produce no `console-message` at all,
    // so these come from the session's web request observers.
    recordGuestResourceFailure({
      url: page,
      resourceUrl: 'http://127.0.0.1:41234/token/missing-style.css',
      statusCode: 404,
      resourceType: 'stylesheet',
    })
    recordGuestResourceFailure({ url: page, resourceUrl: 'http://127.0.0.1:41234/token/game.js', statusCode: 0, resourceType: 'script' })

    const [missing, refused] = listGuestDiagnostics(page)
    expect(missing?.kind).toBe('resource')
    expect(missing?.message).toContain('HTTP 404')
    expect(missing?.message).toContain('missing-style.css')
    expect(missing?.sourceId).toBe('http://127.0.0.1:41234/token/missing-style.css')
    // A refused connection has no status code; the message must still say what happened.
    expect(refused?.message).toContain('请求失败')
  })

  it('remembers the page a guest is on so an unattributed failure still has an owner', () => {
    rememberGuestPageUrl('about:blank')
    expect(lastRememberedGuestPageUrl()).toBe('')
    rememberGuestPageUrl(page)
    expect(lastRememberedGuestPageUrl()).toBe(page)
  })

  it('filters by page and summarizes per kind', () => {
    recordGuestConsole({ url: page, message: 'Uncaught Error: boom', source: 'javascript', level: 3, sourceId: 'run.js', lineNumber: 12 })
    recordGuestConsole({ url: page, message: 'Failed to load resource: 404', source: 'network', level: 3, sourceId: 'style.css' })
    recordGuestConsole({ url: 'http://127.0.0.1:41234/other', message: 'Uncaught Error: elsewhere', source: 'javascript', level: 3 })

    expect(summarizeGuestDiagnostics(page)).toEqual({ script: 1, resource: 1, navigation: 0, console: 0 })
    expect(listGuestDiagnostics()).toHaveLength(3)
    expect(listGuestDiagnostics(page).map((entry) => entry.sourceId)).toEqual(['run.js', 'style.css'])
    expect(listGuestDiagnostics(page)[0]).toMatchObject({ kind: 'script', lineNumber: 12 })
  })

  it('stays bounded and truncates what a page can spam', () => {
    for (let index = 0; index < EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT + 15; index += 1) {
      recordGuestConsole({ url: page, message: `Uncaught Error: ${index} ${'x'.repeat(500)}`, source: 'javascript', level: 3 })
    }

    const entries = listGuestDiagnostics(page)
    expect(entries).toHaveLength(EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT)
    // The oldest are dropped, the newest kept.
    expect(entries.at(-1)?.message).toContain(`${EMBEDDED_BROWSER_DIAGNOSTIC_LIMIT + 14}`)
    expect(entries[0]?.message.length).toBeLessThanOrEqual(EMBEDDED_BROWSER_DIAGNOSTIC_MESSAGE_MAX)
  })

  it('bumps a revision so the renderer can poll cheaply', () => {
    const before = guestDiagnosticsRevision()
    recordGuestConsole({ url: page, message: 'Uncaught Error: boom', source: 'javascript', level: 3 })
    expect(guestDiagnosticsRevision()).toBe(before + 1)
    // Messages the notice never shows do not bump it.
    recordGuestConsole({ url: page, message: 'hello', source: 'console-api', level: 1 })
    expect(guestDiagnosticsRevision()).toBe(before + 1)
    clearGuestDiagnostics()
    expect(guestDiagnosticsRevision()).toBe(before + 2)
  })
})
