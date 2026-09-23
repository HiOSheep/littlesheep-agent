// The acceptance surface is reachable over the loopback Local App API, so its
// gate is a real boundary: outside `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` a
// production start must not be able to resize the window or replace its
// document through an HTTP action.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopAcceptanceActions, type DesktopAcceptanceShell } from './desktop-acceptance-actions.js'
import { showStartupErrorPageForAcceptance, showStartupPageForAcceptance } from './desktop-visual-acceptance.js'

type AcceptanceWindow = Parameters<typeof showStartupErrorPageForAcceptance>[0]

const ACCEPTANCE_ENV = 'LITTLESHEEP_ELECTRON_ACCEPTANCE'

function createShell(overrides: { destroyed?: boolean; window?: boolean } = {}) {
  const { destroyed = false, window = true } = overrides
  const setSize = vi.fn()
  const showStartupError = vi.fn()
  const showStartupPage = vi.fn(() => true)
  const close = vi.fn(() => true)
  const show = vi.fn()
  const currentWindow = vi.fn(() => (
    window
      ? ({ isDestroyed: () => destroyed, setSize } as unknown as NonNullable<AcceptanceWindow>)
      : undefined
  ))
  const shell = { close, show, currentWindow, showStartupError, showStartupPage } satisfies DesktopAcceptanceShell
  return { shell, setSize, showStartupError, showStartupPage, close, show, currentWindow }
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
    const { shell, setSize, showStartupError, showStartupPage, close, show } = createShell()
    const { actions, quit } = createActions(shell)
    if (!actions) throw new Error('acceptance actions were not created')

    expect(actions.token).toBe('acceptance-token')
    expect(actions.resizeForAcceptance({ width: 1580, height: 900 })).toBe(true)
    expect(setSize).toHaveBeenCalledWith(1580, 900)
    expect(actions.showStartupErrorForAcceptance('bootstrap failed as requested')).toBe(true)
    expect(showStartupError).toHaveBeenCalledTimes(1)
    expect(showStartupError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect((showStartupError.mock.calls[0]?.[0] as Error).message).toBe('bootstrap failed as requested')
    expect(actions.showStartupPageForAcceptance()).toBe(true)
    expect(showStartupPage).toHaveBeenCalledTimes(1)

    expect(actions.close()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    actions.show()
    expect(show).toHaveBeenCalledTimes(1)
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
})
