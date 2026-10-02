export type AppearanceThemeMode = 'system' | 'light' | 'dark'
export type AppearancePalette = 'neutral' | 'ocean' | 'forest' | 'custom'

export interface AppearanceColors {
  accent: string
  background: string
  surface: string
}

export interface AppearancePreferences {
  version: 1
  theme: AppearanceThemeMode
  palette: AppearancePalette
  interfaceFontSize: number
  chatFontSize: number
  codeFontSize: number
  terminalFontSize: number
  colors: AppearanceColors
}

export const APPEARANCE_PREFERENCES_KEY = 'littlesheep.ui.appearance.v1'
export const APPEARANCE_PREFERENCES_EVENT = 'littlesheep:appearance-preferences'
export interface AppearancePreferencesEventDetail {
  preferences: AppearancePreferences
  persisted: boolean
}
export interface AppearancePreferencesWriteResult {
  preferences: AppearancePreferences
  persisted: boolean
}

export const APPEARANCE_DEFAULTS: AppearancePreferences = {
  version: 1,
  theme: 'system',
  palette: 'neutral',
  interfaceFontSize: 14,
  chatFontSize: 14,
  codeFontSize: 13,
  terminalFontSize: 12,
  colors: { accent: '#e2e2e2', background: '#141414', surface: '#202020' },
}

export const APPEARANCE_PALETTES: Record<Exclude<AppearancePalette, 'custom'>, AppearanceColors> = {
  neutral: { accent: '#e2e2e2', background: '#141414', surface: '#202020' },
  ocean: { accent: '#61b8e8', background: '#111a20', surface: '#1c2a32' },
  forest: { accent: '#78c79a', background: '#141d18', surface: '#202d25' },
}

export function hydrateAppearancePreferences(input: unknown): AppearancePreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...APPEARANCE_DEFAULTS, colors: { ...APPEARANCE_DEFAULTS.colors } }
  const value = input as Record<string, unknown>
  if (value.version !== 1) return { ...APPEARANCE_DEFAULTS, colors: { ...APPEARANCE_DEFAULTS.colors } }
  const colors = value.colors && typeof value.colors === 'object' && !Array.isArray(value.colors)
    ? value.colors as Record<string, unknown>
    : {}
  return {
    version: 1,
    theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
    palette: value.palette === 'ocean' || value.palette === 'forest' || value.palette === 'custom' ? value.palette : 'neutral',
    interfaceFontSize: boundedNumber(value.interfaceFontSize, 14, 12, 22),
    chatFontSize: boundedNumber(value.chatFontSize, 14, 12, 22),
    codeFontSize: boundedNumber(value.codeFontSize, 13, 11, 22),
    terminalFontSize: boundedNumber(value.terminalFontSize, 12, 11, 22),
    colors: {
      accent: normalizeHex(colors.accent) ?? APPEARANCE_DEFAULTS.colors.accent,
      background: normalizeHex(colors.background) ?? APPEARANCE_DEFAULTS.colors.background,
      surface: normalizeHex(colors.surface) ?? APPEARANCE_DEFAULTS.colors.surface,
    },
  }
}

export function normalizeHex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : null
}

export function resolveAppearanceTheme(
  mode: AppearanceThemeMode,
  systemPrefersDark: boolean,
): 'dark' | 'light' {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
}

export function isAppearanceDark(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  if (root.dataset.lsPalette === 'custom' && root.dataset.lsPaletteUsable === 'true') {
    // Judge the surface the reader actually looks at, not the text colour. This used to accept only
    // an exact `#ffffff` text as "dark", so a custom palette with a light background and near-white
    // text was classified as dark, and every consumer that picks its own palette from this answer
    // (Markdown syntax highlighting, mermaid diagrams) drew dark-theme text straight onto that light
    // background - white on white (reported 2026-10-02).
    const background = root.style.getPropertyValue('--ls-custom-background').trim()
    if (/^#[0-9a-f]{6}$/iu.test(background)) return relativeLuminance(background) < 0.5
    return root.style.getPropertyValue('--ls-custom-text').trim().toLowerCase() === '#ffffff'
  }
  return root.dataset.lsTheme !== 'light'
}

/** Resolve a semantic CSS color to a concrete color accepted by canvas-based editors. */
export function readAppearanceCssColor(property: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback
  const root = document.documentElement
  const probe = document.createElement('span')
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  probe.style.color = `var(${property})`
  root.append(probe)
  try {
    const resolved = getComputedStyle(probe).color
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return fallback
    context.fillStyle = 'rgba(0, 0, 0, 0)'
    context.fillStyle = resolved
    context.fillRect(0, 0, 1, 1)
    const data = context.getImageData(0, 0, 1, 1).data
    const red = data[0]!
    const green = data[1]!
    const blue = data[2]!
    const alpha = data[3]!
    const channels = [red, green, blue].map((channel) => channel.toString(16).padStart(2, '0'))
    return `#${channels.join('')}${alpha === 255 ? '' : alpha.toString(16).padStart(2, '0')}`
  } catch {
    return fallback
  } finally {
    probe.remove()
  }
}

export function appearanceColorsAreReadable(colors: AppearanceColors): boolean {
  const text = bestReadableText([colors.background, colors.surface])
  return [colors.background, colors.surface].every((background) => (
    contrastRatio(text, background) >= 4.5 && contrastRatio(colors.accent, background) >= 3
  ))
}

export function bestReadableText(backgrounds: readonly string[]): '#111111' | '#ffffff' {
  const darkScore = Math.min(...backgrounds.map((value) => contrastRatio('#111111', value)))
  const lightScore = Math.min(...backgrounds.map((value) => contrastRatio('#ffffff', value)))
  return darkScore >= lightScore ? '#111111' : '#ffffff'
}

export function applyAppearancePreferences(
  preferencesInput: unknown,
  systemPrefersDark = readSystemDarkPreference(),
  documentElement: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
  persisted = false,
): AppearancePreferences {
  const preferences = hydrateAppearancePreferences(preferencesInput)
  if (!documentElement) return preferences
  const resolvedTheme = resolveAppearanceTheme(preferences.theme, systemPrefersDark)
  documentElement.dataset.lsTheme = resolvedTheme
  documentElement.dataset.lsThemeMode = preferences.theme
  documentElement.dataset.lsPalette = preferences.palette
  documentElement.style.setProperty('--ui-font-scale', String(preferences.interfaceFontSize / 14))
  documentElement.style.setProperty('--chat-message-font-size', `${preferences.chatFontSize}px`)
  documentElement.style.setProperty('--workspace-code-font-size', `${preferences.codeFontSize}px`)
  documentElement.style.setProperty('--terminal-font-size', `${preferences.terminalFontSize}px`)
  if (preferences.palette === 'custom' && appearanceColorsAreReadable(preferences.colors)) {
    const text = bestReadableText([preferences.colors.background, preferences.colors.surface])
    documentElement.style.setProperty('--ls-custom-accent', preferences.colors.accent)
    documentElement.style.setProperty('--ls-custom-background', preferences.colors.background)
    documentElement.style.setProperty('--ls-custom-surface', preferences.colors.surface)
    documentElement.style.setProperty('--ls-custom-text', text)
    documentElement.style.setProperty('--ls-custom-muted', text === '#111111' ? '#555555' : '#bdbdbd')
    documentElement.dataset.lsPaletteUsable = 'true'
  } else {
    for (const property of ['--ls-custom-accent', '--ls-custom-background', '--ls-custom-surface', '--ls-custom-text', '--ls-custom-muted']) {
      documentElement.style.removeProperty(property)
    }
    documentElement.dataset.lsPaletteUsable = preferences.palette === 'custom' ? 'false' : 'true'
  }
  documentElement.dispatchEvent(new CustomEvent<AppearancePreferencesEventDetail>(APPEARANCE_PREFERENCES_EVENT, {
    detail: { preferences, persisted },
  }))
  if (typeof window !== 'undefined') window.littlesheep?.setWindowAppearance?.(isAppearanceDark())
  return preferences
}

export function readAppearancePreferences(): AppearancePreferences {
  if (typeof window === 'undefined') return { ...APPEARANCE_DEFAULTS, colors: { ...APPEARANCE_DEFAULTS.colors } }
  try {
    const raw = window.localStorage.getItem(APPEARANCE_PREFERENCES_KEY)
    if (raw) return hydrateAppearancePreferences(JSON.parse(raw) as unknown)
    // Users who already have a UI profile retain its established dark appearance.
    // A genuinely fresh profile follows the OS on its first launch.
    const hasExistingUiProfile = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? '')
      .some((key) => key.startsWith('littlesheep.ui.') && key !== APPEARANCE_PREFERENCES_KEY)
    return { ...APPEARANCE_DEFAULTS, theme: hasExistingUiProfile ? 'dark' : 'system', colors: { ...APPEARANCE_DEFAULTS.colors } }
  } catch {
    return { ...APPEARANCE_DEFAULTS, colors: { ...APPEARANCE_DEFAULTS.colors } }
  }
}

export function writeAppearancePreferences(input: unknown): AppearancePreferencesWriteResult {
  const preferences = hydrateAppearancePreferences(input)
  let persisted = false
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(APPEARANCE_PREFERENCES_KEY, JSON.stringify(preferences))
      persisted = true
    } catch { /* The caller reports that the current value could not be saved. */ }
  }
  applyAppearancePreferences(preferences, readSystemDarkPreference(), undefined, persisted)
  return { preferences, persisted }
}

export function bootstrapAppearancePreferences(): () => void {
  const preferences = readAppearancePreferences()
  applyAppearancePreferences(preferences)
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
  const updateSystem = () => {
    const current = readAppearancePreferences()
    if (current.theme === 'system') applyAppearancePreferences(current, media?.matches ?? false)
  }
  const updateStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_PREFERENCES_KEY) applyAppearancePreferences(readAppearancePreferences(), media?.matches ?? false, undefined, true)
  }
  media?.addEventListener?.('change', updateSystem)
  window.addEventListener('storage', updateStorage)
  return () => {
    media?.removeEventListener?.('change', updateSystem)
    window.removeEventListener('storage', updateStorage)
  }
}

export function readSystemDarkPreference(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
}

export function appearanceFontScale(size: number): number {
  return boundedNumber(size, 14, 12, 22) / 14
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(min, Math.min(max, value)))
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground)
  const l2 = relativeLuminance(background)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/gu)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [0, 0, 0]
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}
