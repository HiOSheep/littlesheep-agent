import { describe, expect, it } from 'vitest'
import { decideLastWindowClose } from './close-policy.js'

describe('decideLastWindowClose', () => {
  it('keeps the application visible in the tray according to the selected policy', () => {
    expect(decideLastWindowClose({
      policy: 'always-background',
      activeRunCount: 0,
      trayAvailable: true,
    })).toBe('hide')
    expect(decideLastWindowClose({
      policy: 'background-while-active',
      activeRunCount: 1,
      trayAvailable: true,
    })).toBe('hide')
    expect(decideLastWindowClose({
      policy: 'background-while-active',
      activeRunCount: 0,
      trayAvailable: true,
    })).toBe('quit')
    expect(decideLastWindowClose({
      policy: 'always-quit',
      activeRunCount: 3,
      trayAvailable: true,
    })).toBe('quit')
  })

  it('never creates an invisible background process when no tray is available', () => {
    expect(decideLastWindowClose({
      policy: 'always-background',
      activeRunCount: 2,
      trayAvailable: false,
    })).toBe('quit')
  })
})
