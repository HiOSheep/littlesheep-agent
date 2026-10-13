// Native backdrop and maximize/fullscreen projection. Renderer appearance input is
// accepted only through a narrow boolean contract for caption contrast.
import { release } from 'node:os'
import { ipcMain, nativeTheme, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  WINDOW_CHROME_CHANNEL,
  WINDOW_CHROME_QUERY_CHANNEL,
  windowChromeNativeTitlebarMismatch,
  type WindowChromeState,
} from '../shared/window-chrome-contracts.js'
import { DESKTOP_STARTUP_SURFACE, DESKTOP_TITLEBAR_HEIGHT } from './desktop-startup-page.js'
import { isWindowAppearance, WINDOW_APPEARANCE_CHANNEL } from '../shared/window-appearance-contracts.js'

export function nativeWindowBackdrop(platform = process.platform, version = release()): WindowChromeState['backdrop'] {
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32' && Number(version.split('.')[2]) >= 22621) return 'acrylic'
  return 'solid'
}

/**
 * The native caption row and the renderer's top bar are the same 32px row, and this
 * module is where main paints over it (`setTitleBarOverlay` in Beta). The shared
 * window-chrome contract declares that row once; this compares main's own constant
 * against it, before the window is configured, so the two cannot drift apart into a
 * caption overlay that lines up with nothing.
 */
export function nativeWindowChromeRowMismatch(): string | null {
  return windowChromeNativeTitlebarMismatch(DESKTOP_TITLEBAR_HEIGHT)
}

export function installDesktopWindowChrome(window: BrowserWindow, isRenderer: () => boolean): void {
  const rowMismatch = nativeWindowChromeRowMismatch()
  if (rowMismatch) throw new Error(`window chrome contract: ${rowMismatch}`)
  const backdrop = nativeWindowBackdrop()
  let isDark = nativeTheme.shouldUseDarkColors
  if (backdrop === 'acrylic') window.setBackgroundMaterial('acrylic')
  if (backdrop === 'vibrancy') window.setVibrancy('under-window')
  let maximized = window.isMaximized()
  let fullscreen = window.isFullScreen()
  let revision = 0
  let lastState: WindowChromeState | undefined
  let background: string | undefined
  let overlayKey: string | undefined
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined
  const publish = (force = false) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const layout = maximized || fullscreen ? 'beta' : 'chali'
    const renderer = isRenderer()
    const surface = isDark ? DESKTOP_STARTUP_SURFACE : '#f4f4f2'
    const nextBackground = renderer && backdrop !== 'solid' ? '#00000000' : surface
    if (background !== nextBackground) {
      window.setBackgroundColor(nextBackground)
      background = nextBackground
    }
    if (process.platform === 'win32') {
      const symbolColor = isDark ? '#e8e8e8' : '#202020'
      const nextOverlayKey = `${nextBackground}:${symbolColor}`
      if (overlayKey !== nextOverlayKey) {
        window.setTitleBarOverlay({ color: nextBackground, symbolColor })
        overlayKey = nextOverlayKey
      }
    }
    if (!lastState || lastState.layout !== layout || lastState.backdrop !== backdrop) {
      lastState = { layout, backdrop, revision: ++revision }
      window.webContents.send(WINDOW_CHROME_CHANNEL, lastState)
    } else if (force) window.webContents.send(WINDOW_CHROME_CHANNEL, lastState)
  }
  const reconcile = () => {
    reconcileTimer = undefined
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    maximized = window.isMaximized()
    fullscreen = window.isFullScreen()
    publish()
  }
  const scheduleReconcile = () => {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(reconcile, 16)
  }
  const onMaximize = () => { maximized = true; publish(); scheduleReconcile() }
  const onUnmaximize = () => { maximized = false; publish(); scheduleReconcile() }
  const onEnterFullscreen = () => { fullscreen = true; publish(); scheduleReconcile() }
  const onLeaveFullscreen = () => { fullscreen = false; publish(); scheduleReconcile() }
  const onLoaded = () => {
    maximized = window.isMaximized(); fullscreen = window.isFullScreen()
    publish(true)
  }
  const query = (event: IpcMainEvent) => {
    if (!window.isDestroyed() && event.sender === window.webContents) {
      publish(true)
    }
  }
  const appearance = (event: IpcMainEvent, payload: unknown) => {
    if (window.isDestroyed() || event.sender !== window.webContents || !isWindowAppearance(payload)) return
    isDark = payload.isDark
    publish()
  }
  const systemThemeChanged = () => {
    if (window.isDestroyed() || isRenderer()) return
    isDark = nativeTheme.shouldUseDarkColors
    publish()
  }
  ipcMain.on(WINDOW_CHROME_QUERY_CHANNEL, query)
  ipcMain.on(WINDOW_APPEARANCE_CHANNEL, appearance)
  nativeTheme.on('updated', systemThemeChanged)
  window.on('maximize', onMaximize)
  window.on('unmaximize', onUnmaximize)
  // Event identities are authoritative while Electron's query flags catch up.
  window.on('enter-full-screen', onEnterFullscreen)
  window.on('leave-full-screen', onLeaveFullscreen)
  window.on('resize', scheduleReconcile)
  window.on('restore', scheduleReconcile)
  window.webContents.on('did-finish-load', onLoaded)
  window.once('closed', () => {
    if (reconcileTimer) clearTimeout(reconcileTimer)
    window.removeListener('resize', scheduleReconcile)
    window.removeListener('restore', scheduleReconcile)
    window.removeListener('maximize', onMaximize)
    window.removeListener('unmaximize', onUnmaximize)
    window.removeListener('enter-full-screen', onEnterFullscreen)
    window.removeListener('leave-full-screen', onLeaveFullscreen)
    window.webContents.removeListener('did-finish-load', onLoaded)
    ipcMain.removeListener(WINDOW_CHROME_QUERY_CHANNEL, query)
    ipcMain.removeListener(WINDOW_APPEARANCE_CHANNEL, appearance)
    nativeTheme.removeListener('updated', systemThemeChanged)
  })
}
