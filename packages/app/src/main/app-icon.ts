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
 *
 * The packaged layout needs both forms of the resources root: electron-builder
 * copies the app's `resources/` directory into `<resourcesPath>/resources`, while
 * a package that spreads extra files directly into `resources/` is also valid.
 * Missing the nested form is what made the packaged startup page ship without its
 * brand mark while the development build showed it (found by running the visual
 * acceptance against `release/win-unpacked`).
 */
export function appIconCandidates(options: AppIconPathOptions): string[] {
  const roots = [
    options.appPath ? join(options.appPath, 'resources') : undefined,
    options.moduleDir ? join(options.moduleDir, '../../resources') : undefined,
    options.resourcesPath,
    options.resourcesPath ? join(options.resourcesPath, 'resources') : undefined,
  ].filter((root): root is string => Boolean(root))

  return [...new Set(roots.flatMap((root) => ICON_FILES.map((file) => join(root, file))))]
}

export function resolveAppIconPath(options: AppIconPathOptions): string | undefined {
  const exists = options.exists ?? existsSync
  return appIconCandidates(options).find((path) => exists(path))
}

/**
 * Resolve the PNG specifically for renderer surfaces such as the startup page.
 * The native window continues to prefer the ICO through resolveAppIconPath.
 */
export function resolveAppPngIconPath(options: AppIconPathOptions): string | undefined {
  const exists = options.exists ?? existsSync
  return appIconCandidates(options).find((path) => path.endsWith('.png') && exists(path))
}
