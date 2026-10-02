import { readFileSync } from 'node:fs'
import { resolveAppStartupMotionPath, type AppIconPathOptions } from './app-icon.js'

let cached: { path: string; data: string } | undefined

/** Independent first-frame resource; failures retain the existing PNG fallback. */
export function loadAppStartupMotionDataUrl(options: AppIconPathOptions): string | undefined {
  const path = resolveAppStartupMotionPath(options)
  if (!path) return undefined
  if (cached?.path === path) return cached.data
  try {
    const bytes = readFileSync(path)
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined
    cached = { path, data: `data:image/webp;base64,${bytes.toString('base64')}` }
    return cached.data
  } catch {
    return undefined
  }
}
