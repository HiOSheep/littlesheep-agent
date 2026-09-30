export const WINDOW_APPEARANCE_CHANNEL = 'littlesheep:window-appearance'

export interface WindowAppearance {
  isDark: boolean
}

export function isWindowAppearance(value: unknown): value is WindowAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && typeof record.isDark === 'boolean'
}
