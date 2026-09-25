import { describe, expect, it } from 'vitest'
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browser-control-contracts'
import { hardenGuestAttach, isAllowedGuestSource } from './embedded-browser-hardening'

const httpSource = { src: 'http://127.0.0.1:41800/token/game.html' }

describe('guest webview hardening', () => {
  it('strips node integration, preloads and foreign partitions', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      experimentalFeatures: true,
      webviewTag: true,
      plugins: true,
      partition: 'persist:something-else',
      preload: 'C:\\evil\\preload.js',
      additionalArguments: ['--token=secret'],
    }

    const decision = hardenGuestAttach({ webPreferences, params: httpSource })

    expect(decision.allowed).toBe(true)
    expect(webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      plugins: false,
      partition: EMBEDDED_BROWSER_PARTITION,
    })
    expect('preload' in webPreferences).toBe(false)
    expect('additionalArguments' in webPreferences).toBe(false)
    expect(decision.corrections).toEqual(expect.arrayContaining(['nodeIntegration', 'sandbox', 'partition', 'preload', 'additionalArguments']))
  })

  it('leaves correct preferences alone and keeps window routing possible', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      plugins: false,
      partition: EMBEDDED_BROWSER_PARTITION,
      // `window.open` must still reach Main's routing handler, which is what turns a
      // `target="_blank"` link into an LS browser tab (and denies an OS window).
      nativeWindowOpen: true,
    }

    const decision = hardenGuestAttach({ webPreferences, params: httpSource })

    expect(decision.allowed).toBe(true)
    expect(decision.corrections).toEqual([])
    expect(webPreferences['nativeWindowOpen']).toBe(true)
  })

  it('refuses a guest that is not pointed at http(s)', () => {
    for (const src of ['file:///C:/Windows/System32/drivers/etc/hosts', 'javascript:alert(1)', 'chrome://settings']) {
      const decision = hardenGuestAttach({ webPreferences: {}, params: { src } })
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain('not http(s)')
    }
    for (const src of [undefined, '', 'about:blank', 'https://example.com/x', 'HTTP://EXAMPLE.COM']) {
      expect(isAllowedGuestSource(src)).toBe(true)
    }
  })
})
