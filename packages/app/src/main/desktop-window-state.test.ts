import { describe, expect, it } from 'vitest'
import { hydrateDesktopWindowState } from './desktop-window-state'

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }

describe('desktop window state', () => {
  it('restores a valid normal bound and maximized flag without changing it', () => {
    expect(hydrateDesktopWindowState({
      version: 1,
      bounds: { x: 120, y: 80, width: 1280, height: 820 },
      maximized: true,
    }, [PRIMARY])).toEqual({
      version: 1,
      bounds: { x: 120, y: 80, width: 1280, height: 820 },
      maximized: true,
    })
  })

  it('moves an off-screen window onto the nearest current display', () => {
    expect(hydrateDesktopWindowState({
      version: 1,
      bounds: { x: 5400, y: 1800, width: 1400, height: 900 },
      maximized: false,
    }, [PRIMARY]))?.toEqual({
      version: 1,
      bounds: { x: 520, y: 140, width: 1400, height: 900 },
      maximized: false,
    })
  })

  it('selects the display containing most of the saved window', () => {
    expect(hydrateDesktopWindowState({
      version: 1,
      bounds: { x: -1500, y: 100, width: 1200, height: 800 },
      maximized: false,
    }, [PRIMARY, { x: -1920, y: 0, width: 1920, height: 1040 }])?.bounds).toEqual({
      x: -1500,
      y: 100,
      width: 1200,
      height: 800,
    })
  })

  it('rejects malformed and unsupported snapshots', () => {
    expect(hydrateDesktopWindowState({ version: 2, bounds: PRIMARY }, [PRIMARY])).toBeNull()
    expect(hydrateDesktopWindowState({ version: 1, bounds: { ...PRIMARY, x: '0' } }, [PRIMARY])).toBeNull()
    expect(hydrateDesktopWindowState({ version: 1, bounds: PRIMARY }, [])).toBeNull()
  })
})
