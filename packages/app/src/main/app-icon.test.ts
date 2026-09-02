import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { appIconCandidates, resolveAppIconPath, resolveAppPngIconPath } from './app-icon.js'

describe('app icon resolution', () => {
  it('orders repository resources before packaged resources', () => {
    const candidates = appIconCandidates({
      appPath: '/app',
      moduleDir: '/app/out/main',
      resourcesPath: '/packaged/resources',
    })

    expect(candidates.slice(0, 2)).toEqual([
      join('/app', 'resources', 'littlesheep.ico'),
      join('/app', 'resources', 'littlesheep-icon.png'),
    ])
    expect(candidates.slice(-2)).toEqual([
      join('/packaged/resources', 'littlesheep.ico'),
      join('/packaged/resources', 'littlesheep-icon.png'),
    ])
  })

  it('falls back to the PNG when the ICO is unavailable', () => {
    const resolved = resolveAppIconPath({
      appPath: '/app',
      resourcesPath: '/packaged/resources',
      exists: (path) => path.endsWith('littlesheep-icon.png'),
    })

    expect(resolved).toBe(join('/app', 'resources', 'littlesheep-icon.png'))
  })

  it('resolves the PNG when a renderer surface needs a raster icon', () => {
    const resolved = resolveAppPngIconPath({
      appPath: '/app',
      resourcesPath: '/packaged/resources',
      exists: (path) => path.endsWith('littlesheep-icon.png'),
    })

    expect(resolved).toBe(join('/app', 'resources', 'littlesheep-icon.png'))
  })

  it('resolves the checked-in application icon', () => {
    const appPath = resolve(process.cwd(), 'packages/app')
    expect(resolveAppIconPath({ appPath })).toBe(join(appPath, 'resources', 'littlesheep.ico'))
  })
})
