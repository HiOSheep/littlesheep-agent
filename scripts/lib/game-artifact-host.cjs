// Electron host for the game-artifact probe: one window, navigated by the driver
// through CDP, so a generated `file://` game runs in the engine the desktop app
// ships rather than in a stubbed DOM.
//
// The window is shown but positioned off the visible desktop: Chromium does not
// composite a hidden window, and `Page.captureScreenshot` then never returns —
// measured as a ten-minute hang on the probe's first version.
//
// It also has to keep animating while it sits off-screen: Chromium pauses
// `requestAnimationFrame` for a window it believes is occluded (native window
// occlusion detection on Windows), which made three `requestAnimationFrame` games
// look like they never drew a frame while the `setInterval` ones kept going.
const { app, BrowserWindow, screen } = require('electron')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    x: display.width + 200,
    y: display.height + 200,
    show: true,
    skipTaskbar: true,
    webPreferences: { offscreen: false, contextIsolation: false, nodeIntegration: false },
  })
  window.webContents.setBackgroundThrottling(false)
  window.loadURL('about:blank')
  app.on('window-all-closed', () => app.quit())
})
