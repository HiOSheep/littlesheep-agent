// Visual acceptance helpers for the desktop window (taskbook CS-02).
//
// The cold-start seam lives between three surfaces that no single process can
// observe: the startup document, the renderer's titlebar and Electron's native
// caption-button overlay. This module is the one place that states the native
// side of that contract, so the visual verification script can compare measured
// pixels against declared facts instead of trusting the DOM alone.
//
// Boundary: facts and a bounded resize only. It owns no window lifecycle, and
// `LittleSheepDesktopShell` remains the only owner of the BrowserWindow.

import type { BrowserWindow } from 'electron'
import { DESKTOP_STARTUP_SURFACE, DESKTOP_TITLEBAR_HEIGHT } from './desktop-startup-page.js'

export interface DesktopVisualContract {
  titlebarHeight: number
  /** Colour Electron paints behind the native caption buttons. */
  titlebarOverlayColor: string
  /** Colour the standalone startup document paints. */
  startupSurface: string
  /** Colour the window itself paints before any document is loaded. */
  backgroundColor: string
}

export function desktopVisualContract(): DesktopVisualContract {
  return {
    titlebarHeight: DESKTOP_TITLEBAR_HEIGHT,
    titlebarOverlayColor: DESKTOP_STARTUP_SURFACE,
    startupSurface: DESKTOP_STARTUP_SURFACE,
    backgroundColor: DESKTOP_STARTUP_SURFACE,
  }
}

/**
 * Resize a live window to an explicit size.
 *
 * Only the isolated acceptance run uses this: the seam check needs the native
 * caption buttons rendered at more than one width, which the renderer cannot
 * drive. Bounds are clamped so a bad argument cannot produce a degenerate window.
 */
export function resizeWindowForAcceptance(
  window: BrowserWindow | undefined,
  size: { width: number; height: number },
): boolean {
  if (!window || window.isDestroyed()) return false
  window.setSize(
    Math.max(320, Math.round(size.width)),
    Math.max(240, Math.round(size.height)),
  )
  return true
}

/**
 * Render the bootstrap-failure page on a live window.
 *
 * The failure page is the one startup surface that cannot be reached by waiting
 * for a real failure, so the isolated acceptance run asks for it explicitly. It
 * renders through the same `showStartupError` the failure path uses; nothing
 * about the failure path is bypassed. Gated on the acceptance environment, so a
 * production run can never be driven into it by an HTTP action.
 */
export function showStartupErrorPageForAcceptance(
  window: BrowserWindow | undefined,
  message: string,
  showStartupError: (error: unknown) => void,
): boolean {
  if (process.env['LITTLESHEEP_ELECTRON_ACCEPTANCE'] !== '1') return false
  if (!window || window.isDestroyed()) return false
  showStartupError(new Error(message))
  return true
}

/**
 * Render the standalone startup document on a live window.
 *
 * Same reasoning as the failure page: the real startup path replaces this
 * document within roughly 90 ms, so the only way to check the pixels the user
 * briefly sees is to render that exact document on purpose. What this proves is
 * the page's appearance, not how long it stays on screen - the transition window
 * itself still needs a human with a camera. Gated on the acceptance environment.
 */
export function showStartupPageForAcceptance(
  window: BrowserWindow | undefined,
  showStartupPage: () => void,
): boolean {
  if (process.env['LITTLESHEEP_ELECTRON_ACCEPTANCE'] !== '1') return false
  if (!window || window.isDestroyed()) return false
  showStartupPage()
  return true
}

/**
 * Maximize or restore a live window.
 *
 * The CS-02 seam is a property of the window at every size and state, and the
 * maximized state is the one a user sits in for hours. Only the isolated
 * acceptance run uses this; the window keeps its own lifecycle.
 */
export function setWindowMaximizedForAcceptance(
  window: BrowserWindow | undefined,
  maximized: boolean,
): boolean {
  if (!window || window.isDestroyed()) return false
  if (maximized === window.isMaximized()) return true
  if (maximized) window.maximize()
  else window.unmaximize()
  return true
}

/**
 * Minimize or restore a live window.
 *
 * A minimized window produces no capturable frame, so this exists for the
 * interaction contract instead: the window must come back without reloading the
 * renderer or losing what the user typed. Only the isolated acceptance run uses it.
 */
export function setWindowMinimizedForAcceptance(
  window: BrowserWindow | undefined,
  minimized: boolean,
): boolean {
  if (!window || window.isDestroyed()) return false
  if (minimized === window.isMinimized()) return true
  if (minimized) window.minimize()
  else window.restore()
  return true
}
