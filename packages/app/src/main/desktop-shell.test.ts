import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('desktop shell window cleanup', () => {
  it('keeps native frame behavior while disabling the active outer highlight', async () => {
    const source = await readFile(new URL('./desktop-shell.ts', import.meta.url), 'utf8')

    expect(source).toContain('thickFrame: true')
    expect(source).toContain('win.setAccentColor(false)')
  })

  it('does not access destroyed WebContents from the closed callback', async () => {
    const source = await readFile(new URL('./desktop-shell.ts', import.meta.url), 'utf8')
    const closedHandler = source.match(/win\.once\('closed', \(\) => \{(?<body>[\s\S]*?)\n    \}\)/u)

    expect(source).toContain('const windowWebContentsId = win.webContents.id')
    expect(closedHandler?.groups?.body).toContain('this.windowDragSession?.senderId === windowWebContentsId')
    expect(closedHandler?.groups?.body).not.toContain('win.webContents')
  })

  it('does not let the standalone startup page block the renderer', async () => {
    const source = await readFile(new URL('./desktop-shell.ts', import.meta.url), 'utf8')

    expect(source).toContain('let rendererReadyForInitialShow = false')
    expect(source).toContain('if (rendererReadyForInitialShow && restoredWindowStateReady) showWindow(win)')
    expect(source).toContain("win.once('ready-to-show', markRendererReadyForInitialShow)")
    expect(source).toContain('void this.loadStartupPage(win)')
    expect(source).toContain('if (win.webContents.isLoading()) win.webContents.stop()')
    expect(source).toContain('setTimeout(() => this.loadRenderer(win), 0)')
    expect(source).not.toContain('const startupLoaded = this.startupPageLoads.get(win)')
  })

  it('surfaces bootstrap failures on the visible startup page', async () => {
    const [shell, entry] = await Promise.all([
      readFile(new URL('./desktop-shell.ts', import.meta.url), 'utf8'),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ])

    expect(shell).toContain('showStartupError(error: unknown)')
    expect(shell).toContain('{ errorMessage: message }')
    expect(entry).toContain("void bootstrap().catch((error: unknown) => {")
    expect(entry).toContain('desktopShell.showStartupError(error)')
    expect(entry).toContain('readiness.fail(')
  })

  it('localizes one #101010 surface instead of a translucent startup overlay', async () => {
    const [startup, shell] = await Promise.all([
      readFile(new URL('./desktop-startup-page.ts', import.meta.url), 'utf8'),
      readFile(new URL('./desktop-shell.ts', import.meta.url), 'utf8'),
    ])

    // The startup page must not paint a translucent material over the native
    // caption buttons: that is the visible seam CS-02 removes.
    expect(startup).toContain("export const DESKTOP_STARTUP_SURFACE = '#101010'")
    expect(startup).toContain('background: ${DESKTOP_STARTUP_SURFACE}')
    expect(startup).not.toContain('backdrop-filter')
    expect(startup).toContain('export const DESKTOP_TITLEBAR_HEIGHT = 32')
    // The native titlebar overlay byte-identically matches the renderer's
    // --workspace-code-surface through that shared constant.
    expect(shell).toContain('color: DESKTOP_STARTUP_SURFACE')
    expect(shell).toContain('height: WINDOW_TITLEBAR_HEIGHT')
    expect(shell).toContain('export const WINDOW_TITLEBAR_HEIGHT = DESKTOP_TITLEBAR_HEIGHT')
  })

  it('shows the shell before the Runner is published so the window is usable early', async () => {
    const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
    const shellInitialized = entry.indexOf('desktopShell.initialize()')
    const executionStarted = entry.indexOf('await startExecution(')

    expect(shellInitialized).toBeGreaterThanOrEqual(0)
    expect(executionStarted).toBeGreaterThan(shellInitialized)
    // Execution readiness is published only after the Runner and its run router
    // exist, so no request observes a half-built runtime.
    expect(entry).toContain('await server?.setRunner(created)')
  })
})
