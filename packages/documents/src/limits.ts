export const DEFAULT_MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
export const DEFAULT_MAX_EXTRACTED_CHARS = 100_000
export const DEFAULT_MAX_SECTIONS = 100
export const DEFAULT_MAX_ROWS_PER_SHEET = 500
export const MAX_CREATE_BLOCKS = 2_000
export const MAX_CREATE_SHEETS = 100
export const MAX_CREATE_ROWS = 50_000
export const MAX_CREATE_COLUMNS = 256
export const MAX_CELL_CHARS = 32_000

export function positiveLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), ceiling)
}

export function clipText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: `${value.slice(0, maxChars)}\n[内容已按读取上限截断]`, truncated: true }
}
