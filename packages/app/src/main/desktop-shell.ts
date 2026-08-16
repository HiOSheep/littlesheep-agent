// Owns the visible Electron window, tray, and close-to-background behavior.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { DesktopClosePolicy } from '@littlesheep/config'
import {
  APPLICATION_STATE_FLUSH_ACK_CHANNEL,
  APPLICATION_STATE_FLUSH_CHANNEL,
} from '../shared/application-state-contracts.js'
import { resolveAppIconPath } from './app-icon.js'
import { APPLICATION_ZOOM_FACTOR, isApplicationZoomShortcut } from './application-zoom.js'
import { decideLastWindowClose } from './close-policy.js'
import {
  createDesktopWindowState,
  loadDesktopWindowState,
  saveDesktopWindowState,
  type DesktopWindowState,
} from './desktop-window-state.js'
import { configureEmbeddedBrowserWindow } from './embedded-browser.js'
import type { RunActivityMonitor } from './run-activity-monitor.js'
import { LittleSheepTrayController } from './tray-controller.js'

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

  constructor(options: LittleSheepDesktopShellOptions) {
    this.options = options
  }

  initialize(): void {
    this.initializeTray()
    this.mainWindow = this.createWindow()
  }

  show(): void {
    const window = this.resolveWindow()
    if (window) {
      this.mainWindow = window
      showWindow(window)
      return
    }
    if (this.options.canCreateWindow()) this.mainWindow = this.createWindow()
  }

  close(): boolean {
    const window = this.resolveWindow()
    if (!window) return false
    window.close()
    return true
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
    const restoredState = loadDesktopWindowState(
      this.options.getWindowStateFilePath(),
      screen.getAllDisplays().map((display) => display.workArea),
    )
    const win = new BrowserWindow({
      ...(restoredState?.bounds ?? { width: 1280, height: 820 }),
      minWidth: 800,
      minHeight: 600,
      title: 'LittleSheep',
      icon: resolveDesktopIcon(),
      titleBarStyle: 'hidden',
      transparent: false,
      backgroundMaterial: 'acrylic',
      roundedCorners: true,
      thickFrame: true,
      hasShadow: true,
      titleBarOverlay: {
        color: '#141414',
        symbolColor: '#e8e8e8',
        height: 32,
      },
      backgroundColor: process.platform === 'win32' ? '#00000000' : '#141414',
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

    configureEmbeddedBrowserWindow(win)
    this.mainWindow = win
    let allowInitialShow = true
    let showFallbackTimer: ReturnType<typeof setTimeout> | undefined
    const showInitialWindow = () => {
      if (allowInitialShow && !win.isDestroyed() && !win.isVisible()) showWindow(win)
    }
    const cancelInitialShow = () => {
      allowInitialShow = false
      if (showFallbackTimer) clearTimeout(showFallbackTimer)
      showFallbackTimer = undefined
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
        cancelInitialShow()
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
    win.once('ready-to-show', showInitialWindow)
    win.webContents.once('did-finish-load', () => {
      win.webContents.setZoomFactor(APPLICATION_ZOOM_FACTOR)
      showInitialWindow()
    })
    showFallbackTimer = setTimeout(showInitialWindow, 4000)
    win.once('closed', () => {
      cancelInitialShow()
      if (this.mainWindow === win) this.mainWindow = null
    })

    if (restoredState?.maximized) win.maximize()

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(devUrl)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
    return win
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
