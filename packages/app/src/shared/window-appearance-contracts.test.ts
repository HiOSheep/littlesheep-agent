import { describe, expect, it } from 'vitest'
import { isWindowAppearance, WINDOW_APPEARANCE_CHANNEL } from './window-appearance-contracts.js'

describe('window appearance contract', () => {
  it('accepts only a boolean resolved appearance fact', () => {
    expect(WINDOW_APPEARANCE_CHANNEL).toBe('littlesheep:window-appearance')
    expect(isWindowAppearance({ isDark: true })).toBe(true)
    expect(isWindowAppearance({ isDark: false })).toBe(true)
    expect(isWindowAppearance({ isDark: 'dark' })).toBe(false)
    expect(isWindowAppearance({ isDark: false, color: '#fff' })).toBe(false)
    expect(isWindowAppearance(null)).toBe(false)
    expect(isWindowAppearance('dark')).toBe(false)
  })
})
