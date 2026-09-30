import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_PREFERENCES_EVENT,
  APPEARANCE_PREFERENCES_KEY,
  appearanceColorsAreReadable,
  applyAppearancePreferences,
  hydrateAppearancePreferences,
  readAppearancePreferences,
  resolveAppearanceTheme,
  writeAppearancePreferences,
} from './appearance-preferences'

describe('application appearance preferences', () => {
  const values = new Map<string, string>()
  const listeners = new Map<string, (event: unknown) => void>()
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      values: new Map<string, string>(),
      setProperty(name: string, value: string) { this.values.set(name, value) },
      removeProperty(name: string) { this.values.delete(name) },
      getPropertyValue(name: string) { return this.values.get(name) ?? '' },
    },
    addEventListener: vi.fn((name: string, listener: (event: unknown) => void) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name: string, _listener: (event: unknown) => void) => listeners.delete(name)),
    dispatchEvent: vi.fn((event: { type: string }) => {
      listeners.get(event.type)?.(event)
      return true
    }),
  }

  beforeEach(() => {
    values.clear()
    listeners.clear()
    root.style.values.clear()
    root.dataset = {}
    vi.stubGlobal('window', {
      localStorage: {
        get length() { return values.size },
        key(index: number) { return Array.from(values.keys())[index] ?? null },
        getItem(name: string) { return values.get(name) ?? null },
        setItem(name: string, value: string) { values.set(name, value) },
        removeItem(name: string) { values.delete(name) },
        clear() { values.clear() },
      },
      matchMedia: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      littlesheep: { setWindowAppearance: vi.fn() },
    })
    vi.stubGlobal('document', { documentElement: root })
    vi.stubGlobal('CustomEvent', class<T> {
      readonly type: string
      readonly detail: T
      constructor(type: string, init: { detail: T }) { this.type = type; this.detail = init.detail }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('hydrates only supported values and bounds every font size', () => {
    expect(hydrateAppearancePreferences({
      version: 1,
      theme: 'sepia',
      palette: 'custom',
      interfaceFontSize: 90,
      chatFontSize: 11,
      codeFontSize: 16.4,
      terminalFontSize: Number.NaN,
      colors: { accent: 'red', background: '#FFFFFF', surface: '#000000' },
    })).toEqual({
      ...APPEARANCE_DEFAULTS,
      palette: 'custom',
      interfaceFontSize: 22,
      chatFontSize: 12,
      codeFontSize: 16,
      terminalFontSize: 12,
      colors: { accent: '#e2e2e2', background: '#ffffff', surface: '#000000' },
    })
  })

  it('resolves system mode without overriding an explicit choice', () => {
    expect(resolveAppearanceTheme('system', true)).toBe('dark')
    expect(resolveAppearanceTheme('system', false)).toBe('light')
    expect(resolveAppearanceTheme('dark', false)).toBe('dark')
    expect(resolveAppearanceTheme('light', true)).toBe('light')
  })

  it('requires readable text and a visible accent over both user surfaces', () => {
    expect(appearanceColorsAreReadable({ accent: '#176b98', background: '#f2f2f0', surface: '#fafaf9' })).toBe(true)
    expect(appearanceColorsAreReadable({ accent: '#f3f3f3', background: '#f2f2f0', surface: '#fafaf9' })).toBe(false)
    expect(appearanceColorsAreReadable({ accent: '#000000', background: '#000000', surface: '#000000' })).toBe(false)
  })

  it('applies bounded sizes and safe colors to the document root', () => {
    applyAppearancePreferences({
      ...APPEARANCE_DEFAULTS,
      theme: 'system',
      palette: 'custom',
      interfaceFontSize: 18,
      chatFontSize: 20,
      codeFontSize: 17,
      terminalFontSize: 16,
      colors: { accent: '#176b98', background: '#f2f2f0', surface: '#fafaf9' },
    }, false, root as unknown as HTMLElement)
    expect(root.dataset.lsTheme).toBe('light')
    expect(root.dataset.lsThemeMode).toBe('system')
    expect(root.style.getPropertyValue('--ui-font-scale')).toBe(String(18 / 14))
    expect(root.style.getPropertyValue('--chat-message-font-size')).toBe('20px')
    expect(root.style.getPropertyValue('--workspace-code-font-size')).toBe('17px')
    expect(root.style.getPropertyValue('--terminal-font-size')).toBe('16px')
    expect(root.dataset.lsPaletteUsable).toBe('true')
    expect(root.style.getPropertyValue('--ls-custom-accent')).toBe('#176b98')
    expect(window.littlesheep.setWindowAppearance).toHaveBeenCalledWith(false)

    applyAppearancePreferences({
      ...APPEARANCE_DEFAULTS,
      palette: 'custom',
      colors: { accent: '#f2f2f2', background: '#f2f2f0', surface: '#fafaf9' },
    }, false, root as unknown as HTMLElement)
    expect(root.dataset.lsPaletteUsable).toBe('false')
    expect(root.style.getPropertyValue('--ls-custom-background')).toBe('')
  })

  it('follows the OS for a fresh profile and retains dark for a pre-existing UI profile', () => {
    expect(readAppearancePreferences().theme).toBe('system')
    window.localStorage.setItem('littlesheep.ui.appShellState', '{}')
    expect(readAppearancePreferences().theme).toBe('dark')
    window.localStorage.setItem(APPEARANCE_PREFERENCES_KEY, JSON.stringify({ ...APPEARANCE_DEFAULTS, theme: 'light' }))
    expect(readAppearancePreferences().theme).toBe('light')
  })

  it('persists validated preferences and announces the saved copy', () => {
    const listener = vi.fn()
    root.addEventListener(APPEARANCE_PREFERENCES_EVENT, listener)
    const result = writeAppearancePreferences({ ...APPEARANCE_DEFAULTS, theme: 'light', chatFontSize: 19 })
    expect(result.persisted).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_PREFERENCES_KEY) ?? 'null')).toEqual(result.preferences)
    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0]?.[0] as { detail: { persisted: boolean } }).detail.persisted).toBe(true)
    root.removeEventListener(APPEARANCE_PREFERENCES_EVENT, listener)
  })

  it('reports a storage failure without pretending the preference was saved', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const result = writeAppearancePreferences({ ...APPEARANCE_DEFAULTS, theme: 'light' })
    expect(result.persisted).toBe(false)
    expect(result.preferences.theme).toBe('light')
  })
})
