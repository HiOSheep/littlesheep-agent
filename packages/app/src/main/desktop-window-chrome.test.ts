import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { WINDOW_CHROME_CHANNEL, WINDOW_CHROME_QUERY_CHANNEL } from '../shared/window-chrome-contracts.js'
import { isWindowChromeState } from '../shared/window-chrome-contracts.js'
import { WINDOW_APPEARANCE_CHANNEL } from '../shared/window-appearance-contracts.js'

const { ipc, theme } = vi.hoisted(() => ({
  ipc: { on: vi.fn(), removeListener: vi.fn() },
  theme: { shouldUseDarkColors: true, on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock('electron', () => ({ ipcMain: ipc, nativeTheme: theme }))
vi.mock('node:os', () => ({ release: () => '10.0.26200' }))
import { installDesktopWindowChrome, nativeWindowBackdrop } from './desktop-window-chrome.js'

function fixture() {
  const win = Object.assign(new EventEmitter(), {
    maximized: false, fullscreen: false, destroyed: false,
    isDestroyed() { return this.destroyed },
    isMaximized() { return this.maximized },
    isFullScreen() { return this.fullscreen },
    setBackgroundMaterial: vi.fn(), setVibrancy: vi.fn(),
    setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }),
  })
  let renderer = true
  installDesktopWindowChrome(win as unknown as BrowserWindow, () => renderer)
  return {
    win,
    startup: () => { renderer = false },
    query: ipc.on.mock.calls.find(([channel]) => channel === WINDOW_CHROME_QUERY_CHANNEL)![1] as (event: unknown) => void,
    appearance: ipc.on.mock.calls.find(([channel]) => channel === WINDOW_APPEARANCE_CHANNEL)![1] as (event: unknown, payload: unknown) => void,
  }
}

describe('native window chrome', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses a supported native backdrop or an explicit opaque fallback', () => {
    expect(nativeWindowBackdrop('win32', '10.0.22621')).toBe('acrylic')
    expect(nativeWindowBackdrop('win32', '10.0.22000')).toBe('solid')
    expect(nativeWindowBackdrop('win32', '10.0.19045')).toBe('solid')
    expect(nativeWindowBackdrop('darwin', '25.0.0')).toBe('vibrancy')
    expect(nativeWindowBackdrop('linux', '6.8.0')).toBe('solid')
  })

  it('follows maximize, restore, fullscreen and reload without renderer guesses', async () => {
    const { win, query } = fixture()
    const layout = () => win.webContents.send.mock.lastCall?.[1].layout
    query({ sender: win.webContents })
    expect(layout()).toBe('chali')
    win.maximized = true; win.emit('maximize')
    expect(layout()).toBe('beta')
    win.webContents.emit('did-finish-load')
    expect(layout()).toBe('beta')
    win.maximized = false; win.emit('unmaximize')
    expect(layout()).toBe('chali')
    win.emit('enter-full-screen'); win.fullscreen = true
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(layout()).toBe('beta')
    win.emit('leave-full-screen'); win.fullscreen = false
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(layout()).toBe('chali')
    expect(win.webContents.send.mock.lastCall?.[0]).toBe(WINDOW_CHROME_CHANNEL)
  })

  it('releases every listener after Electron destroys the window getter', () => {
    const { win, query, appearance } = fixture()
    const contents = win.webContents
    win.emit('resize')
    Object.defineProperty(win, 'webContents', { get: () => {
      if (win.destroyed) throw new TypeError('Object has been destroyed')
      return contents
    } })
    win.destroyed = true
    expect(() => win.emit('closed')).not.toThrow()
    expect(contents.listenerCount('did-finish-load')).toBe(0)
    expect(win.listenerCount('resize')).toBe(0)
    expect(ipc.removeListener).toHaveBeenCalledWith(WINDOW_CHROME_QUERY_CHANNEL, query)
    expect(ipc.removeListener).toHaveBeenCalledWith(WINDOW_APPEARANCE_CHANNEL, appearance)
    expect(theme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function))
    expect(() => query({ sender: contents })).not.toThrow()
    expect(() => appearance({ sender: contents }, { isDark: false })).not.toThrow()
  })

  it('rejects other senders and unregisters the query on close', () => {
    const { win, query } = fixture()
    query({ sender: {} })
    expect(win.webContents.send).not.toHaveBeenCalled()
    win.emit('closed')
    expect(ipc.removeListener).toHaveBeenCalledWith(WINDOW_CHROME_QUERY_CHANNEL, query)
    expect(ipc.removeListener).toHaveBeenCalledWith(WINDOW_APPEARANCE_CHANNEL, expect.any(Function))
    expect(theme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function))
    win.destroyed = true
    query({ sender: win.webContents })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('keeps startup and error documents opaque even when maximized', () => {
    const { win, startup } = fixture()
    win.maximized = true
    win.emit('maximize')
    if (process.platform === 'win32') {
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
      expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#00000000', symbolColor: '#e8e8e8' })
    }
    startup(); win.webContents.emit('did-finish-load')
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#101010')
    if (process.platform === 'win32') expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#101010', symbolColor: '#e8e8e8' })
  })

  it('accepts only the owning renderer theme fact and updates native caption contrast', () => {
    const { win, appearance } = fixture()
    appearance({ sender: {} }, { isDark: false })
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
    appearance({ sender: win.webContents }, { isDark: 'light' })
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled()
    appearance({ sender: win.webContents }, { isDark: false })
    if (process.platform === 'win32') {
      expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#00000000', symbolColor: '#202020' })
    }
  })

  it('publishes event facts immediately while native query flags lag', async () => {
    const { win, query } = fixture()
    query({ sender: win.webContents })
    win.emit('maximize')
    expect(win.webContents.send.mock.lastCall?.[1].layout).toBe('beta')
    win.maximized = true
    win.emit('unmaximize')
    expect(win.webContents.send.mock.lastCall?.[1].layout).toBe('chali')
    win.maximized = false
    win.emit('enter-full-screen')
    expect(win.webContents.send.mock.lastCall?.[1].layout).toBe('beta')
    win.fullscreen = true
    win.emit('leave-full-screen')
    expect(win.webContents.send.mock.lastCall?.[1].layout).toBe('chali')
    win.fullscreen = false
    win.emit('closed')
  })

  it('coalesces resize reconciliation and corrects a missed native restore event', async () => {
    vi.useFakeTimers()
    try {
      const { win, query } = fixture()
      win.maximized = true; win.emit('maximize')
      const firstRevision = win.webContents.send.mock.lastCall?.[1].revision
      win.maximized = false
      for (let i = 0; i < 40; i++) win.emit('resize')
      await vi.advanceTimersByTimeAsync(16)
      expect(win.webContents.send.mock.lastCall?.[1].layout).toBe('chali')
      expect(win.webContents.send).toHaveBeenCalledTimes(2)
      expect(win.webContents.send.mock.lastCall?.[1].revision).toBeGreaterThan(firstRevision)
      query({ sender: win.webContents })
      expect(win.webContents.send).toHaveBeenCalledTimes(3)
      win.emit('closed')
      await vi.advanceTimersByTimeAsync(50)
      expect(win.webContents.send).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  it('avoids native material and IPC work for repeated identical appearance changes', () => {
    const { win, query, appearance } = fixture()
    query({ sender: win.webContents })
    for (let i = 0; i < 100; i++) appearance({ sender: win.webContents }, { isDark: true })
    expect(win.setBackgroundColor).toHaveBeenCalledTimes(1)
    if (process.platform === 'win32') expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    win.emit('closed')
  })

  it('only accepts the narrow state contract in preload', () => {
    expect(isWindowChromeState({ layout: 'beta', backdrop: 'acrylic' })).toBe(true)
    expect(isWindowChromeState({ layout: 'chali', backdrop: 'solid' })).toBe(true)
    expect(isWindowChromeState({ layout: 'expanded', backdrop: 'acrylic' })).toBe(false)
    expect(isWindowChromeState({ layout: 'beta', backdrop: 'unknown' })).toBe(false)
    expect(isWindowChromeState(null)).toBe(false)
  })
})
