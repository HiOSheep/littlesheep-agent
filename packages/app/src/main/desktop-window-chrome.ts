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
  const publish = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const layout = window.isMaximized() || window.isFullScreen() ? 'beta' : 'chali'
    const renderer = isRenderer()
    const surface = isDark ? DESKTOP_STARTUP_SURFACE : '#f4f4f2'
    window.setBackgroundColor(renderer && backdrop !== 'solid' ? '#00000000' : surface)
    if (process.platform === 'win32') {
      // In Beta the native caption buttons expose the same native acrylic as the
      // titlebar. Chali and the standalone startup page have an opaque titlebar.
      // A transparent overlay lets the renderer paint to the right edge while
      // keeping the native buttons above it in the non-client area.
      window.setTitleBarOverlay({ color: renderer && backdrop !== 'solid' ? '#00000000' : surface, symbolColor: isDark ? '#e8e8e8' : '#202020' })
    }
    window.webContents.send(WINDOW_CHROME_CHANNEL, { layout, backdrop } satisfies WindowChromeState)
  }
  const query = (event: IpcMainEvent) => {
    if (!window.isDestroyed() && event.sender === window.webContents) publish()
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
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  // On Windows these events precede the isFullScreen() update (observed in a
  // real window). Read the native fact after the current transition settles.
  window.on('enter-full-screen', () => { setImmediate(publish) })
  window.on('leave-full-screen', () => { setImmediate(publish) })
  window.webContents.on('did-finish-load', publish)
  window.once('closed', () => {
    ipcMain.removeListener(WINDOW_CHROME_QUERY_CHANNEL, query)
    ipcMain.removeListener(WINDOW_APPEARANCE_CHANNEL, appearance)
    nativeTheme.removeListener('updated', systemThemeChanged)
  })
}
