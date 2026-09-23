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
