// Native backdrop and maximize/fullscreen projection. No renderer-supplied state is trusted.
import { release } from 'node:os'
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  WINDOW_CHROME_CHANNEL,
  WINDOW_CHROME_QUERY_CHANNEL,
  windowChromeNativeTitlebarMismatch,
  type WindowChromeState,
} from '../shared/window-chrome-contracts.js'
import { DESKTOP_STARTUP_SURFACE, DESKTOP_TITLEBAR_HEIGHT } from './desktop-startup-page.js'

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
  if (backdrop === 'acrylic') window.setBackgroundMaterial('acrylic')
  if (backdrop === 'vibrancy') window.setVibrancy('under-window')
  const publish = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const layout = window.isMaximized() || window.isFullScreen() ? 'beta' : 'chali'
    const renderer = isRenderer()
    window.setBackgroundColor(renderer && backdrop !== 'solid' ? '#00000000' : DESKTOP_STARTUP_SURFACE)
    if (process.platform === 'win32') {
      // In Beta the native caption buttons expose the same native acrylic as the
      // titlebar. Chali and the standalone startup page have an opaque titlebar.
      // The user asked for the caption buttons to sit on a transparent strip and stay on top. Only a fully
// transparent overlay does that: the strip then shows whatever the renderer paints underneath (the app's own
// top bar, all the way to the right edge), while Windows still draws its three buttons above it in the
// non-client area. Cost, accepted by the user: with a transparent overlay Windows derives the caption hover
// background as solid black, so a hover darkens the button itself rather than tinting a strip.
  window.setTitleBarOverlay({ color: renderer ? '#00000000' : DESKTOP_STARTUP_SURFACE })
    }
    window.webContents.send(WINDOW_CHROME_CHANNEL, { layout, backdrop } satisfies WindowChromeState)
  }
  const query = (event: IpcMainEvent) => {
    if (!window.isDestroyed() && event.sender === window.webContents) publish()
  }
  ipcMain.on(WINDOW_CHROME_QUERY_CHANNEL, query)
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  // On Windows these events precede the isFullScreen() update (observed in a
  // real window). Read the native fact after the current transition settles.
  window.on('enter-full-screen', () => { setImmediate(publish) })
  window.on('leave-full-screen', () => { setImmediate(publish) })
  window.webContents.on('did-finish-load', publish)
  window.once('closed', () => ipcMain.removeListener(WINDOW_CHROME_QUERY_CHANNEL, query))
}
