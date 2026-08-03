// Owns the visible Electron window, tray, and close-to-background behavior.

import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { DesktopClosePolicy } from '@littlesheep/config'
import { resolveAppIconPath } from './app-icon.js'
import { decideLastWindowClose } from './close-policy.js'
import { configureEmbeddedBrowserWindow } from './embedded-browser.js'
import type { RunActivityMonitor } from './run-activity-monitor.js'
import { LittleSheepTrayController } from './tray-controller.js'

export interface LittleSheepDesktopShellOptions {
  activity: RunActivityMonitor
  getClosePolicy: () => DesktopClosePolicy
  canCreateWindow: () => boolean
  isQuitting: () => boolean
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
  }
  runtime: {
    currentRunnerActiveRunCount: number
    aggregatedActiveRunCount: number
    retiredRunnerCount: number
    activitySourceCount: number
    activityListenerCount: number
  }
}

export class LittleSheepDesktopShell {
  private readonly options: LittleSheepDesktopShellOptions
  private mainWindow: BrowserWindow | null = null
  private tray: LittleSheepTrayController | null = null

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
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 800,
      minHeight: 600,
      title: 'LittleSheep',
      icon: resolveDesktopIcon(),
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#181818',
        symbolColor: '#e8e8e8',
        height: 32,
      },
      backgroundColor: '#181818',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: true,
        webviewTag: true,
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
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
    win.once('ready-to-show', showInitialWindow)
    win.webContents.once('did-finish-load', showInitialWindow)
    showFallbackTimer = setTimeout(showInitialWindow, 4000)
    win.once('closed', () => {
      cancelInitialShow()
      if (this.mainWindow === win) this.mainWindow = null
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(devUrl)
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
    return win
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
