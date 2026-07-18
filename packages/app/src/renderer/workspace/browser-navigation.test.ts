import { describe, expect, it } from 'vitest'
import { canStartBrowserNavigation } from './browser-navigation'

describe('embedded browser navigation lifecycle', () => {
  it('waits for the guest dom-ready boundary before calling loadURL', () => {
    const pending = { sequence: 1, started: false }

    expect(canStartBrowserNavigation(pending, 1, false, true)).toBe(false)
    expect(canStartBrowserNavigation(pending, 1, true, true)).toBe(true)
  })

  it('rejects stale, started, detached, or wrong-sequence navigations', () => {
    expect(canStartBrowserNavigation(null, 1, true, true)).toBe(false)
    expect(canStartBrowserNavigation({ sequence: 2, started: false }, 1, true, true)).toBe(false)
    expect(canStartBrowserNavigation({ sequence: 1, started: true }, 1, true, true)).toBe(false)
    expect(canStartBrowserNavigation({ sequence: 1, started: false }, 1, true, false)).toBe(false)
  })
})
