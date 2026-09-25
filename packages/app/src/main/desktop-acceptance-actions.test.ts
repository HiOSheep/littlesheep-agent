// The acceptance surface is reachable over the loopback Local App API, so its
// gate is a real boundary: outside `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` a
// production start must not be able to resize the window or replace its
// document through an HTTP action.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptanceReadyDelayMs, createDesktopAcceptanceActions, type DesktopAcceptanceShell, waitForAcceptanceReadyDelay } from './desktop-acceptance-actions.js'
import { showStartupErrorPageForAcceptance, showStartupPageForAcceptance } from './desktop-visual-acceptance.js'

type AcceptanceWindow = Parameters<typeof showStartupErrorPageForAcceptance>[0]

const ACCEPTANCE_ENV = 'LITTLESHEEP_ELECTRON_ACCEPTANCE'
const READY_DELAY_ENV = 'LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS'

function createShell(overrides: { destroyed?: boolean; window?: boolean } = {}) {
  const { destroyed = false, window = true } = overrides
  const setSize = vi.fn()
  const showStartupError = vi.fn()
  const showStartupPage = vi.fn(() => true)
  const close = vi.fn(() => true)
  const show = vi.fn()
  const allowAcceptanceWindow = vi.fn()
  let maximized = false
  let minimized = false
  const maximize = vi.fn(() => { maximized = true })
  const unmaximize = vi.fn(() => { maximized = false })
  const minimize = vi.fn(() => { minimized = true })
  const restore = vi.fn(() => { minimized = false })
  const currentWindow = vi.fn(() => (
    window
      ? ({
        isDestroyed: () => destroyed,
        setSize,
        isMaximized: () => maximized,
        maximize,
        unmaximize,
        isMinimized: () => minimized,
        minimize,
        restore,
      } as unknown as NonNullable<AcceptanceWindow>)
      : undefined
  ))
  const shell = { close, show, currentWindow, showStartupError, showStartupPage, allowAcceptanceWindow } satisfies DesktopAcceptanceShell
  return { shell, setSize, showStartupError, showStartupPage, close, show, allowAcceptanceWindow, currentWindow, maximize, unmaximize, minimize, restore }
}

function createActions(shell: DesktopAcceptanceShell, quit = vi.fn()) {
  return {
    quit,
    actions: createDesktopAcceptanceActions({
      token: 'acceptance-token',
      snapshot: () => ({}) as never,
      shell,
      quit,
    }),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('desktop acceptance actions', () => {
  it('does not exist outside an isolated acceptance run', () => {
    vi.stubEnv(ACCEPTANCE_ENV, '')
    expect(createActions(createShell().shell).actions).toBeUndefined()

    vi.stubEnv(ACCEPTANCE_ENV, '0')
    expect(createActions(createShell().shell).actions).toBeUndefined()
  })

  it('drives the live window when the acceptance run asks for it', () => {
    vi.stubEnv(ACCEPTANCE_ENV, '1')
    const { shell, setSize, showStartupError, showStartupPage, close, show, allowAcceptanceWindow } = createShell()
    const { actions, quit } = createActions(shell)
    if (!actions) throw new Error('acceptance actions were not created')

    expect(actions.token).toBe('acceptance-token')
    expect(actions.resizeForAcceptance({ width: 1580, height: 900 })).toBe(true)
    expect(setSize).toHaveBeenCalledWith(1580, 900)
    expect(actions.setMaximizedForAcceptance(true)).toBe(true)
    expect(actions.setMaximizedForAcceptance(false)).toBe(true)
    expect(actions.setMinimizedForAcceptance(true)).toBe(true)
    expect(actions.setMinimizedForAcceptance(false)).toBe(true)
    expect(actions.showStartupErrorForAcceptance('bootstrap failed as requested')).toBe(true)
    expect(showStartupError).toHaveBeenCalledTimes(1)
    expect(showStartupError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect((showStartupError.mock.calls[0]?.[0] as Error).message).toBe('bootstrap failed as requested')
    expect(actions.showStartupPageForAcceptance()).toBe(true)
    expect(showStartupPage).toHaveBeenCalledTimes(1)

    expect(actions.close()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    actions.show()
    // Showing is what puts a window on the user's screen, so an acceptance run has to
    // say so explicitly first: `allowAcceptanceWindow()` is what releases the shell's
    // hold-back, and it must happen before `show()` — not after.
    expect(allowAcceptanceWindow).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(allowAcceptanceWindow.mock.invocationCallOrder[0])
      .toBeLessThan((show.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER))
    actions.quit()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('reports a missing or destroyed window instead of throwing', () => {
    vi.stubEnv(ACCEPTANCE_ENV, '1')

    for (const overrides of [{ window: false }, { destroyed: true }]) {
      const { shell, setSize, showStartupError, showStartupPage } = createShell(overrides)
      const { actions } = createActions(shell)
      if (!actions) throw new Error('acceptance actions were not created')

      expect(actions.resizeForAcceptance({ width: 1280, height: 820 })).toBe(false)
      expect(actions.showStartupErrorForAcceptance('boom')).toBe(false)
      expect(actions.showStartupPageForAcceptance()).toBe(false)
      expect(setSize).not.toHaveBeenCalled()
      expect(showStartupError).not.toHaveBeenCalled()
      expect(showStartupPage).not.toHaveBeenCalled()
    }
  })

  it('keeps both page renderers gated even when called directly', () => {
    vi.stubEnv(ACCEPTANCE_ENV, '')
    const showStartupError = vi.fn()
    const showStartupPage = vi.fn()
    const request = { isDestroyed: () => false } as unknown as NonNullable<AcceptanceWindow>

    expect(showStartupErrorPageForAcceptance(request, 'boom', showStartupError)).toBe(false)
    expect(showStartupPageForAcceptance(request, showStartupPage)).toBe(false)
    expect(showStartupError).not.toHaveBeenCalled()
    expect(showStartupPage).not.toHaveBeenCalled()

    vi.stubEnv(ACCEPTANCE_ENV, '1')
    expect(showStartupErrorPageForAcceptance(undefined, 'boom', showStartupError)).toBe(false)
    expect(showStartupPageForAcceptance(undefined, showStartupPage)).toBe(false)
    expect(showStartupError).not.toHaveBeenCalled()
    expect(showStartupPage).not.toHaveBeenCalled()
  })

  it('holds back the readiness publish only in a bounded acceptance window', async () => {
    vi.stubEnv(ACCEPTANCE_ENV, '')
    vi.stubEnv(READY_DELAY_ENV, '6000')
    expect(acceptanceReadyDelayMs()).toBe(0)
    expect(await waitForAcceptanceReadyDelay()).toBe(0)

    vi.stubEnv(ACCEPTANCE_ENV, '1')
    vi.stubEnv(READY_DELAY_ENV, '0')
    expect(acceptanceReadyDelayMs()).toBe(0)

    vi.stubEnv(READY_DELAY_ENV, 'not-a-number')
    expect(acceptanceReadyDelayMs()).toBe(0)

    // Bounded: a bad value must not be able to hang a run for minutes.
    vi.stubEnv(READY_DELAY_ENV, '600000')
    expect(acceptanceReadyDelayMs()).toBe(60_000)

    // A small real value is honoured end to end.
    vi.stubEnv(READY_DELAY_ENV, '40')
    const startedAt = Date.now()
    expect(await waitForAcceptanceReadyDelay()).toBe(40)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35)
  })
})
