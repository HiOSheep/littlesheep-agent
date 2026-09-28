// The native hit-test module's own contract: how each Win32 answer is named and
// classified, and the one platform boundary that must not silently pass. The
// live half — that a drag region really does produce HTCAPTION — is
// `scripts/probe-native-hit-test.mjs`, which needs a real window.

import { describe, expect, it, vi } from 'vitest'
import {
  createNativeHitTest,
  describeHit,
  describeHitName,
  HTCLIENT,
  HTCAPTION,
  HTCLOSE,
  HTLEFT,
  HTMAXBUTTON,
  HTMINBUTTON,
  HTSYSMENU,
  isCaptionButton,
  isCaptionHit,
  isClientHit,
  nativeHitScript,
} from './native-hit-test.mjs'

describe('native hit-test classification', () => {
  it('separates the three answers a chrome gate asks about', () => {
    expect(describeHit(HTCLIENT)).toBe('client')
    expect(describeHit(HTCAPTION)).toBe('caption')
    for (const button of [HTSYSMENU, HTMINBUTTON, HTMAXBUTTON, HTCLOSE]) {
      expect(describeHit(button)).toBe('caption-button')
      expect(isCaptionButton(button)).toBe(true)
    }
    expect(describeHit(HTLEFT)).toBe('other')
    expect(describeHit(undefined)).toBe('unavailable')
  })

  it('names the values a failure message quotes', () => {
    expect(describeHitName(HTCLIENT)).toBe('HTCLIENT')
    expect(describeHitName(HTCAPTION)).toBe('HTCAPTION')
    expect(describeHitName(13)).toBe('HTTOPLEFT')
    expect(describeHitName(4242)).toBe('unknown(4242)')
    expect(describeHitName(null)).toBe('unavailable')
  })

  it('is a client hit only for HTCLIENT', () => {
    expect(isClientHit(HTCLIENT)).toBe(true)
    for (const other of [HTCAPTION, HTSYSMENU, HTMINBUTTON, 0, undefined, null]) {
      expect(isClientHit(other)).toBe(false)
    }
    expect(isCaptionHit(HTCAPTION)).toBe(true)
    // A drag answer is never also a client answer: the two are what makes the
    // assertion in a gate discriminate.
    for (const other of [HTCLIENT, HTSYSMENU, HTMINBUTTON, HTCLOSE, 0, undefined, null]) {
      expect(isCaptionHit(other)).toBe(false)
    }
  })
})

describe('native hit-test platform boundary', () => {
  it('answers nothing off Windows instead of passing an assertion vacuously', async () => {
    const main = { evaluate: vi.fn() }
    const probe = createNativeHitTest({ main, platform: 'darwin' })
    expect(await probe.probe([{ label: 'toggle', x: 1, y: 2 }])).toBeUndefined()
    expect(await probe.assertClientHits([{ label: 'toggle', x: 1, y: 2 }], 'darwin')).toBeUndefined()
    expect(await probe.assertCaptionHits([{ label: 'titlebar', x: 1, y: 2 }], 'darwin')).toBeUndefined()
    // The window was never asked anything: no CDP call, so no coordinate could
    // be converted and no probe could be reported as "fine".
    expect(main.evaluate).not.toHaveBeenCalled()
  })

  it('refuses to run without a main-process client', () => {
    expect(() => createNativeHitTest({})).toThrow(/main-process CDP client/u)
  })

  it('refuses an empty point list on every platform, including ones that cannot answer', async () => {
    const probe = createNativeHitTest({ main: { evaluate: vi.fn() }, platform: 'darwin' })
    await expect(probe.probe([])).rejects.toThrow(/at least one point/u)
  })
})

describe('native hit-test script', () => {
  it('packs the point, is DPI aware and embeds a Windows handle as a literal', () => {
    const script = nativeHitScript('281474976710655', 'C:\\Temp\\it\\points.json')
    expect(script).toContain('SetProcessDpiAwarenessContext')
    expect(script).toContain('0x0084')
    expect(script).toContain('[IntPtr][int64]281474976710655')
    expect(script).toContain("'C:\\Temp\\it\\points.json'")
  })

  it('escapes a quote in the scratch path instead of breaking the command', () => {
    expect(nativeHitScript('1', "C:\\it's\\points.json")).toContain("'C:\\it''s\\points.json'")
  })
})
