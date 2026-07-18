import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ICON_FILES = ['littlesheep.ico', 'littlesheep-icon.png'] as const

export interface AppIconPathOptions {
  appPath?: string
  moduleDir?: string
  resourcesPath?: string
  exists?: (path: string) => boolean
}

/**
 * Resolve the icon from both the repository layout and a packaged Electron
 * resources directory. The PNG fallback keeps development startup usable if
 * a packaging step only carries raster assets.
 */
export function appIconCandidates(options: AppIconPathOptions): string[] {
  const roots = [
    options.appPath ? join(options.appPath, 'resources') : undefined,
    options.moduleDir ? join(options.moduleDir, '../../resources') : undefined,
    options.resourcesPath,
  ].filter((root): root is string => Boolean(root))

  return [...new Set(roots.flatMap((root) => ICON_FILES.map((file) => join(root, file))))]
}

export function resolveAppIconPath(options: AppIconPathOptions): string | undefined {
  const exists = options.exists ?? existsSync
  return appIconCandidates(options).find((path) => exists(path))
}
