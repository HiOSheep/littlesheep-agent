// Owns the visible Electron window, tray, and close-to-background behavior.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeImage, screen } from 'electron'
import type { DesktopClosePolicy } from '@littlesheep/config'
import {
  APPLICATION_STATE_FLUSH_ACK_CHANNEL,
  APPLICATION_STATE_FLUSH_CHANNEL,
} from '../shared/application-state-contracts.js'
import { resolveAppIconPath, resolveAppPngIconPath } from './app-icon.js'
import { APPLICATION_ZOOM_FACTOR, isApplicationZoomShortcut } from './application-zoom.js'
import { decideLastWindowClose } from './close-policy.js'
import {
  createDesktopWindowState,
  loadDesktopWindowState,
  saveDesktopWindowState,
  type DesktopWindowState,
} from './desktop-window-state.js'
import {
  createDesktopStartupPageUrl,
  DESKTOP_STARTUP_SURFACE,
  DESKTOP_TITLEBAR_HEIGHT,
} from './desktop-startup-page.js'
import {
  desktopVisualContract,
  type DesktopVisualContract,
} from './desktop-visual-acceptance.js'
import { configureEmbeddedBrowserWindow } from './embedded-browser.js'
import { recordBootstrapTiming } from './bootstrap-timing.js'
import type { RunActivityMonitor } from './run-activity-monitor.js'
import { LittleSheepTrayController } from './tray-controller.js'
import {
  isWindowDragPoint,
  WINDOW_DRAG_END_CHANNEL,
  WINDOW_DRAG_MOVE_CHANNEL,
  WINDOW_DRAG_START_CHANNEL,
  type WindowDragPoint,
} from '../shared/window-drag-contracts.js'

// Keep the renderer titlebar row and Electron's native caption buttons on the
// same CSS-pixel height. The native overlay is outside the DOM, so this
// explicit contract prevents the two rows from drifting independently. The
// value is owned by `desktop-startup-page.ts` because the startup document
// reserves exactly this row for the drag region.
export const WINDOW_TITLEBAR_HEIGHT = DESKTOP_TITLEBAR_HEIGHT

export interface LittleSheepDesktopShellOptions {
  activity: RunActivityMonitor
  getClosePolicy: () => DesktopClosePolicy
  canCreateWindow: () => boolean
  isQuitting: () => boolean
  getWindowStateFilePath: () => string | undefined
  onQuit: () => void
  onWarning?: (message: string) => void
}

export interface DesktopShellSnapshot {
  windowExists: boolean
  windowVisible: boolean
  windowMinimized: boolean
  trayAvailable: boolean
  closePolicy: DesktopClosePolicy
  activeRunCount: number
}

export interface DesktopAcceptanceSnapshot extends DesktopShellSnapshot {
  sampledAt: string
  /** Native window surface facts the DOM cannot report (CS-02 seam check). */
  visual: DesktopVisualContract
  process: {
    rssBytes: number
    heapUsedBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    activeHandleCount: number
    activeRequestCount: number
    activeHandleTypes: DesktopAcceptanceResourceType[]
    activeRequestTypes: DesktopAcceptanceResourceType[]
  }
  electron: {
    processCount: number
    workingSetBytes: number
    peakWorkingSetBytes: number
    privateBytes: number
  }
  runtime: {
    currentRunnerActiveRunCount: number
    aggregatedActiveRunCount: number
    retiredRunnerCount: number
    activitySourceCount: number
    activityListenerCount: number
  }
}

export interface DesktopAcceptanceResourceType {
  type: string
  count: number
}

export class LittleSheepDesktopShell {
  private readonly options: LittleSheepDesktopShellOptions
  private mainWindow: BrowserWindow | null = null
  private tray: LittleSheepTrayController | null = null
  private pendingWindowState: DesktopWindowState | null = null
  private windowStateSaveTimer: ReturnType<typeof setTimeout> | undefined
  private windowStateWriteTail: Promise<void> = Promise.resolve()
  private rendererAvailable = false
  private readonly rendererLoadedWindows = new Set<BrowserWindow>()
  private readonly restoredWindowStateWindows = new Set<BrowserWindow>()
  private windowDragSession: { senderId: number; startPoint: WindowDragPoint; startBounds: Electron.Rectangle } | null = null
  private windowDragHandlersInstalled = false

  constructor(options: LittleSheepDesktopShellOptions) {
    this.options = options
  }

  initialize(): void {
    this.initializeTray()
    this.rendererAvailable = true
    const window = this.resolveWindow() ?? this.createWindow()
    this.mainWindow = window
    this.restoreWindowState()
    this.loadRenderer(window)
  }

  /**
   * The live application window, or undefined when none exists.
   *
   * Callers that push state into the visible window (readiness transitions)
   * must resolve it per publish: close-to-background and `show()` can replace
   * or hide the window while the Runtime is still starting.
   */
  currentWindow(): BrowserWindow | undefined {
    return this.resolveWindow()
  }

  /** Show a lightweight branding surface while the Runtime is still starting. */
  showStartup(): void {
    const window = this.resolveWindow()
    if (window) {
      this.mainWindow = window
      showWindow(window)
      return
    }
    this.mainWindow = this.createWindow()
  }

  show(): void {
    const window = this.resolveWindow()
    if (window) {
      this.mainWindow = window
      showWindow(window)
      return
    }
    if (!this.options.canCreateWindow()) return
    const created = this.createWindow()
    this.mainWindow = created
    if (this.rendererAvailable) this.loadRenderer(created)
  }

  /** Apply the durable geometry once the data-root location is known. */
  restoreWindowState(): void {
    const window = this.resolveWindow()
    const restoredState = window ? this.restoreWindowStateFor(window) : undefined
    if (restoredState?.maximized === true) window?.maximize()
  }

  close(): boolean {
    const window = this.resolveWindow()
    if (!window) return false
    window.close()
    return true
  }

  /** Native window facts the visual acceptance cannot read from the DOM. */
  visualContract(): DesktopVisualContract {
    return desktopVisualContract()
  }

  async prepareToQuit(): Promise<void> {
    const window = this.resolveWindow()
    if (window) this.captureWindowState(window)
    await Promise.all([
      this.requestRendererStateFlush(window),
      this.flushWindowState(),
    ])
  }

  async shutdown(): Promise<void> {
    try {
      await this.prepareToQuit()
    } finally {
      this.removeWindowDragHandlers()
      this.dispose()
    }
  }

  snapshot(): DesktopShellSnapshot {
    const window = this.resolveWindow()
    return {
      windowExists: Boolean(window),
      windowVisible: window?.isVisible() ?? false,
      windowMinimized: window?.isMinimized() ?? false,
      trayAvailable: this.tray?.available === true,
      closePolicy: this.options.getClosePolicy(),
      activeRunCount: this.options.activity.snapshot().length,
    }
  }

  dispose(): void {
    if (this.windowStateSaveTimer) clearTimeout(this.windowStateSaveTimer)
    this.windowStateSaveTimer = undefined
    this.tray?.dispose()
    this.tray = null
  }

  private resolveWindow(): BrowserWindow | undefined {
    const window = this.mainWindow && !this.mainWindow.isDestroyed()
      ? this.mainWindow
      : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (window) this.mainWindow = window
    return window
  }

  private createWindow(): BrowserWindow {
    this.installWindowDragHandlers()
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 800,
      minHeight: 600,
      title: 'LittleSheep',
      icon: resolveDesktopIcon(),
      titleBarStyle: 'hidden',
      // One opaque surface for the startup page, the renderer titlebar and the
      // native caption buttons. Acrylic composites the native overlay against a
      // differently-lit backdrop than the page paints, which is the seam the
      // cold-start screenshots showed; the unified solid surface is the
      // verified scheme.
      transparent: false,
      roundedCorners: true,
      // Keep the native thick frame so Windows resizing, shadow, and window
      // animations remain available. The active frame highlight is disabled
      // immediately below; it is the bright outer ring seen in the UI.
      thickFrame: true,
      hasShadow: true,
      titleBarOverlay: {
        color: DESKTOP_STARTUP_SURFACE,
        symbolColor: '#e8e8e8',
        height: WINDOW_TITLEBAR_HEIGHT,
      },
      backgroundColor: startupWindowBackgroundColor(),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: true,
        webviewTag: true,
        zoomFactor: APPLICATION_ZOOM_FACTOR,
      },
    })

    if (process.platform === 'win32') {
      // Preserve the native frame behavior without painting the system accent
      // outline around the entire hidden-titlebar window.
      win.setAccentColor(false)
    }

    // BrowserWindow.webContents is already destroyed by the `closed` event.
    const windowWebContentsId = win.webContents.id
    configureEmbeddedBrowserWindow(win)
    this.mainWindow = win
    const restoredState = this.restoreWindowStateFor(win)
    const shouldRestoreMaximized = restoredState?.maximized === true
    let rendererReadyForInitialShow = false
    let restoredWindowStateReady = !shouldRestoreMaximized
    const showWhenInitialStateIsReady = () => {
      if (rendererReadyForInitialShow && restoredWindowStateReady) showWindow(win)
    }
    const markRendererReadyForInitialShow = () => {
      rendererReadyForInitialShow = true
      showWhenInitialStateIsReady()
    }
    const finishMaximizeRestore = () => {
      restoredWindowStateReady = true
      showWhenInitialStateIsReady()
    }

    if (shouldRestoreMaximized) {
      win.once('maximize', finishMaximizeRestore)
      win.maximize()
    }

    win.on('close', (event) => {
      this.captureWindowState(win)
      if (this.options.isQuitting()) return
      const closeAction = decideLastWindowClose({
        policy: this.options.getClosePolicy(),
        activeRunCount: this.options.activity.snapshot().length,
        trayAvailable: this.tray?.available === true,
      })
      if (closeAction === 'hide') {
        event.preventDefault()
        win.hide()
      }
    })
    const scheduleWindowStateSave = () => this.captureWindowState(win)
    win.on('move', scheduleWindowStateSave)
    win.on('resize', scheduleWindowStateSave)
    win.on('maximize', scheduleWindowStateSave)
    win.on('unmaximize', scheduleWindowStateSave)
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (isApplicationZoomShortcut(input)) {
        win.webContents.setZoomFactor(APPLICATION_ZOOM_FACTOR)
        event.preventDefault()
        return
      }
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
    win.webContents.on('zoom-changed', (event) => {
      event.preventDefault()
      win.webContents.setZoomFactor(APPLICATION_ZOOM_FACTOR)
    })
    win.once('ready-to-show', markRendererReadyForInitialShow)
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      recordBootstrapTiming('renderer-did-finish-load')
      markRendererReadyForInitialShow()
      win.webContents.setZoomFactor(APPLICATION_ZOOM_FACTOR)
      win.setBackgroundColor(applicationWindowBackgroundColor())
    })
    win.once('closed', () => {
      if (this.windowDragSession?.senderId === windowWebContentsId) this.windowDragSession = null
      this.rendererLoadedWindows.delete(win)
      this.restoredWindowStateWindows.delete(win)
      if (this.mainWindow === win) this.mainWindow = null
    })
    void this.loadStartupPage(win)
    return win
  }

  /** Leave an actionable diagnostic instead of keeping a failed bootstrap hidden. */
  showStartupError(error: unknown): void {
    const win = this.resolveWindow()
    if (!win || win.isDestroyed()) return
    this.rendererLoadedWindows.delete(win)
    win.setBackgroundColor(startupWindowBackgroundColor())
    const message = error instanceof Error ? error.message : String(error)
    const loading = win.loadURL(createDesktopStartupPageUrl(
      resolveDesktopStartupIconDataUrl(),
      { errorMessage: message },
    ))
    void loading
      .catch((loadError) => {
        if (!isNavigationAbortedError(loadError)) {
          this.options.onWarning?.(`startup error page failed to load: ${(loadError as Error).message}`)
        }
      })
      .finally(() => showWindow(win))
  }

  private restoreWindowStateFor(win: BrowserWindow): DesktopWindowState | undefined {
    if (win.isDestroyed() || this.restoredWindowStateWindows.has(win)) return
    const restoredState = loadDesktopWindowState(
      this.options.getWindowStateFilePath(),
      screen.getAllDisplays().map((display) => display.workArea),
    )
    if (!restoredState) return
    this.restoredWindowStateWindows.add(win)
    win.setBounds(restoredState.bounds)
    return restoredState
  }

  private installWindowDragHandlers(): void {
    if (this.windowDragHandlersInstalled) return
    this.windowDragHandlersInstalled = true
    ipcMain.on(WINDOW_DRAG_START_CHANNEL, this.handleWindowDragStart)
    ipcMain.on(WINDOW_DRAG_MOVE_CHANNEL, this.handleWindowDragMove)
    ipcMain.on(WINDOW_DRAG_END_CHANNEL, this.handleWindowDragEnd)
  }

  private removeWindowDragHandlers(): void {
    if (!this.windowDragHandlersInstalled) return
    this.windowDragHandlersInstalled = false
    this.windowDragSession = null
    ipcMain.removeListener(WINDOW_DRAG_START_CHANNEL, this.handleWindowDragStart)
    ipcMain.removeListener(WINDOW_DRAG_MOVE_CHANNEL, this.handleWindowDragMove)
    ipcMain.removeListener(WINDOW_DRAG_END_CHANNEL, this.handleWindowDragEnd)
  }

  private readonly handleWindowDragStart = (event: Electron.IpcMainEvent, point: unknown): void => {
    const win = this.windowForDragSender(event.sender)
    if (!win || !isWindowDragPoint(point)) return
    this.windowDragSession = {
      senderId: event.sender.id,
      startPoint: point,
      startBounds: win.getBounds(),
    }
  }

  private readonly handleWindowDragMove = (event: Electron.IpcMainEvent, point: unknown): void => {
    const session = this.windowDragSession
    const win = this.windowForDragSender(event.sender)
    if (!session || !win || session.senderId !== event.sender.id || !isWindowDragPoint(point)) return
    const deltaX = Math.round(point.screenX - session.startPoint.screenX)
    const deltaY = Math.round(point.screenY - session.startPoint.screenY)
    if (Math.abs(deltaX) > 20_000 || Math.abs(deltaY) > 20_000) return
    win.setPosition(session.startBounds.x + deltaX, session.startBounds.y + deltaY)
  }

  private readonly handleWindowDragEnd = (event: Electron.IpcMainEvent): void => {
    if (this.windowDragSession?.senderId === event.sender.id) this.windowDragSession = null
  }

  private windowForDragSender(sender: Electron.WebContents): BrowserWindow | undefined {
    const win = this.resolveWindow()
    return win && !win.isDestroyed() && win.webContents === sender ? win : undefined
  }

  private loadStartupPage(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return Promise.resolve()
    win.setBackgroundColor(startupWindowBackgroundColor())
    const loading = win.loadURL(createDesktopStartupPageUrl(resolveDesktopStartupIconDataUrl())).catch((error) => {
      if (!isNavigationAbortedError(error) && !this.rendererLoadedWindows.has(win)) {
        this.options.onWarning?.(`startup page failed to load: ${(error as Error).message}`)
      }
    })
    return loading
  }

  private loadRenderer(win: BrowserWindow): void {
    if (win.isDestroyed() || this.rendererLoadedWindows.has(win)) return
    this.rendererLoadedWindows.add(win)
    recordBootstrapTiming('renderer-load-started')
    // The standalone startup page can remain loading on some Electron/Windows
    // combinations. End that navigation before handing the same WebContents
    // to the application renderer, otherwise loadFile can be reported as an
    // aborted navigation without ever producing a second load event.
    if (win.webContents.isLoading()) win.webContents.stop()
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const loading = devUrl
      ? win.loadURL(devUrl)
      : win.loadFile(join(__dirname, '../renderer/index.html'))
    void loading.catch((error) => {
      if (win.isDestroyed()) return
      this.rendererLoadedWindows.delete(win)
      if (!isNavigationAbortedError(error)) {
        this.options.onWarning?.(`renderer failed to load: ${(error as Error).message}`)
      }
      if (isNavigationAbortedError(error)) {
        // A stop/load race can still reject the first attempt. Retry on the
        // next turn after Chromium has finished dispatching that cancellation.
        setTimeout(() => this.loadRenderer(win), 0)
      } else {
        void this.loadStartupPage(win)
      }
    })
  }

  private captureWindowState(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    this.pendingWindowState = createDesktopWindowState(win.getNormalBounds(), win.isMaximized())
    if (this.windowStateSaveTimer) clearTimeout(this.windowStateSaveTimer)
    this.windowStateSaveTimer = setTimeout(() => {
      this.windowStateSaveTimer = undefined
      void this.flushWindowState()
    }, 240)
  }

  private async flushWindowState(): Promise<void> {
    if (this.windowStateSaveTimer) clearTimeout(this.windowStateSaveTimer)
    this.windowStateSaveTimer = undefined
    const state = this.pendingWindowState
    this.pendingWindowState = null
    if (state) {
      const filePath = this.options.getWindowStateFilePath()
      this.windowStateWriteTail = this.windowStateWriteTail
        .catch(() => undefined)
        .then(() => saveDesktopWindowState(filePath, state))
        .catch((error) => {
          this.options.onWarning?.(`window state could not be saved: ${(error as Error).message}`)
        })
    }
    await this.windowStateWriteTail
    if (this.pendingWindowState) await this.flushWindowState()
  }

  private async requestRendererStateFlush(win: BrowserWindow | undefined): Promise<void> {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    const requestId = randomUUID()
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ipcMain.removeListener(APPLICATION_STATE_FLUSH_ACK_CHANNEL, onAck)
        resolve()
      }
      const onAck = (event: Electron.IpcMainEvent, receivedId: unknown) => {
        if (event.sender !== win.webContents || receivedId !== requestId) return
        finish()
      }
      const timer = setTimeout(finish, 500)
      ipcMain.on(APPLICATION_STATE_FLUSH_ACK_CHANNEL, onAck)
      try {
        win.webContents.send(APPLICATION_STATE_FLUSH_CHANNEL, requestId)
      } catch {
        finish()
      }
    })
  }

  private initializeTray(): void {
    this.dispose()
    const iconPath = resolveDesktopIcon()
    if (!iconPath) {
      this.options.onWarning?.('application icon is unavailable; close-to-background is disabled')
      return
    }
    try {
      this.tray = new LittleSheepTrayController({
        iconPath,
        activity: this.options.activity,
        onShow: () => this.show(),
        onQuit: this.options.onQuit,
        onWarning: this.options.onWarning,
      })
    } catch (error) {
      this.options.onWarning?.(`tray unavailable: ${(error as Error).message}`)
      this.tray = null
    }
  }
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function resolveDesktopIcon(): string | undefined {
  return resolveAppIconPath({
    appPath: app.getAppPath(),
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath,
  })
}

function resolveDesktopStartupIconDataUrl(): string | undefined {
  const iconPath = resolveAppPngIconPath({
    appPath: app.getAppPath(),
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath,
  })
  if (!iconPath) return undefined
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) return undefined
  return icon.resize({ width: 112, height: 112, quality: 'best' }).toDataURL()
}

function applicationWindowBackgroundColor(): string {
  return DESKTOP_STARTUP_SURFACE
}

function startupWindowBackgroundColor(): string {
  return DESKTOP_STARTUP_SURFACE
}

function isNavigationAbortedError(error: unknown): boolean {
  return /ERR_ABORTED|\(-3\)/u.test(error instanceof Error ? error.message : String(error))
}
