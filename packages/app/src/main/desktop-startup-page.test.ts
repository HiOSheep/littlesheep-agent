import { describe, expect, it } from 'vitest'
import {
  createDesktopStartupPageHtml,
  createDesktopStartupPageUrl,
  DESKTOP_STARTUP_SURFACE,
  DESKTOP_STARTUP_WINDOW_BACKGROUND,
  DESKTOP_TITLEBAR_HEIGHT,
} from './desktop-startup-page.js'

describe('desktop startup page', () => {
  it('renders only the centered LS icon on the unified opaque surface', () => {
    const iconDataUrl = 'data:image/png;base64,AA=='
    const html = createDesktopStartupPageHtml(iconDataUrl)

    expect(DESKTOP_STARTUP_SURFACE).toBe('#101010')
    expect(DESKTOP_STARTUP_WINDOW_BACKGROUND).toBe(DESKTOP_STARTUP_SURFACE)
    expect(DESKTOP_TITLEBAR_HEIGHT).toBe(32)
    expect(html).toContain(`background: ${DESKTOP_STARTUP_SURFACE}`)
    // A translucent material over the native caption buttons is the seam this
    // page must not reintroduce.
    expect(html).not.toContain('backdrop-filter')
    expect(html).not.toMatch(/rgba\(16, 16, 16/u)
    expect(html).toContain('<div class="startup-drag-region" aria-hidden="true"></div>')
    expect(html).toContain('right: 150px')
    expect(html).toContain('height: 32px')
    expect(html).toContain('-webkit-app-region: drag')
    expect(html).toContain('-webkit-app-region: no-drag')
    expect(html).toContain("bridge.startWindowDrag({ screenX: event.screenX, screenY: event.screenY })")
    expect(html).toContain(`<img class="startup-icon" src="${iconDataUrl}" alt="LittleSheep" />`)
    expect(html).not.toMatch(/(?:loading|加载|progress|状态)/iu)
  })

  it('encodes the standalone page as a data URL and omits an invalid icon source', () => {
    const url = createDesktopStartupPageUrl('https://example.com/littlesheep.png')
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))

    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(html).not.toContain('<img class="startup-icon"')
  })

  it('escapes bootstrap diagnostics before putting them in the startup page', () => {
    const html = createDesktopStartupPageHtml(undefined, { errorMessage: '<path> & failed' })

    expect(html).toContain('LittleSheep 无法启动')
    expect(html).toContain('&lt;path&gt; &amp; failed')
    expect(html).not.toContain('<path> & failed')
  })
})
