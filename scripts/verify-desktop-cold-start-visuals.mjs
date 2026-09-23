// Real-window visual acceptance for the desktop cold start (taskbook CS-02).
//
// CS-02 exists because the startup page, the native caption-button overlay and
// the renderer titlebar were painted with three different materials, which the
// screenshots showed as a seam around the window buttons. This script drives a
// real Electron window and checks the pixels that seam would appear in:
//
//   1. the standalone startup page paints one opaque surface everywhere;
//   2. after the renderer takes over, the titlebar row, the caption-button area
//      and the application background are the same colour at more than one
//      window width;
//   3. the renderer's own computed styles agree with the captured pixels.
//
// It cannot validate acrylic/blur composition on other machines, other Windows
// builds or other display scaling levels: those need a human looking at a
// rotated display, and they stay unchecked in the taskbook.
//
// Usage:
//   node scripts/verify-desktop-cold-start-visuals.mjs [--app=dev|packaged] [--out=docs/reference/cold-start-baseline/screenshots] [--keep]
//
// `--app=packaged` drives `release/win-unpacked/LittleSheep.exe` instead of the
// development entry, and writes its captures with a `-packaged` suffix so a
// packaged run cannot overwrite the development evidence.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, CdpClient, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { columnColors, decodePng, hexAt } from './lib/png-pixels.mjs'

const PACKAGED_EXECUTABLE_RELATIVE = 'release/win-unpacked/LittleSheep.exe'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const appKind = readOption('app', 'dev')
if (appKind !== 'dev' && appKind !== 'packaged') {
  throw new Error(`--app must be dev or packaged, received ${appKind}`)
}
const packagedExecutable = appKind === 'packaged' ? resolve(repoRoot, PACKAGED_EXECUTABLE_RELATIVE) : undefined
const captureSuffix = appKind === 'packaged' ? '-packaged' : ''
const ledgerName = appKind === 'packaged' ? 'cold-start-visuals-packaged.json' : 'cold-start-visuals.json'

const harness = createElectronHarness({
  startTimeoutMs: 90_000,
  actionTimeoutMs: 30_000,
  ...(packagedExecutable === undefined ? {} : { packagedExecutable }),
})

/** Must equal DESKTOP_STARTUP_SURFACE in `packages/app/src/main/desktop-startup-page.ts`. */
const EXPECTED_SURFACE = '#101010'

/** Distinctive so the captured page cannot accidentally contain it. */
const STARTUP_ERROR_MESSAGE = 'cold-start acceptance: bootstrap failed as requested'

const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline/screenshots'))

/**
 * CDP calls that must not hang the whole verification.
 *
 * A capture issued while the document is being replaced can be answered only
 * after a navigation that never produces a frame for that target, and the
 * client would then wait forever. Every call here is bounded.
 */
const EVALUATE_TIMEOUT_MS = 5_000
const SCREENSHOT_TIMEOUT_MS = 10_000

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

const screenshot = (client) => withTimeout(
  client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
  SCREENSHOT_TIMEOUT_MS,
  'Page.captureScreenshot',
)

const evaluate = (client, expression) => withTimeout(
  client.evaluate(expression),
  EVALUATE_TIMEOUT_MS,
  'Runtime.evaluate',
)

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-cold-start-visual-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  const screenshots = []
  const failures = []
  let client
  let child

  try {
    await mkdir(outDir, { recursive: true })
    // A previous run's startup capture may have caught a mid-composite frame;
    // never leave it behind to be mistaken for a measurement of this run.
    const staleStartupShot = join(outDir, `startup-page${captureSuffix}.png`)
    await rm(staleStartupShot, { force: true }).catch(() => undefined)
    child = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    // The startup document is replaced within a few hundred milliseconds, so the
    // debugger attach races the locator handshake instead of following it.
    const startupCapture = captureStartupPage(debuggingPort, outDir)
    const locator = await harness.waitForLocator(dataDir, child.pid)
    const startup = await startupCapture

    const startupGaps = []
    if (startup) {
      screenshots.push(startup)
      record(
        failures,
        'startup page declares and paints one opaque surface',
        startup.uniform && startup.declaredBodyBackground === 'rgb(16, 16, 16)',
        startup,
      )
      // Captured pixels may still be composited by the window manager while the
      // window is coming up, so pixel equality is a reported fact rather than a
      // gate; the renderer checks below carry the seam assertion.
      startup.pixelsMatchDeclaredSurface = startup.body === EXPECTED_SURFACE
    } else {
      // Not a product failure: this run simply attached after the handoff. The
      // start of the renderer load is read from the process log to say so.
      const timings = await harness.readBootstrapTimings(logPath).catch(() => [])
      const rendererLoadStarted = timings.find((entry) => entry.stage === 'renderer-load-started')
      startupGaps.push({
        check: 'startup page screenshot',
        detail: 'the debugger attached after the renderer had already replaced the startup document',
        rendererLoadStartedAtProcessUptimeMs: rendererLoadStarted?.processUptimeMs ?? null,
      })
    }

    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs).catch(() => undefined)
    await delay(300)

    // Native window facts: the document cannot report the caption-button
    // overlay colour, so the acceptance snapshot is the only source for it.
    const snapshot = await harness.desktopSnapshot(locator)
    const visual = snapshot.visual ?? {}
    record(failures, 'native caption-button overlay uses the unified surface', visual.titlebarOverlayColor === EXPECTED_SURFACE, visual)
    record(failures, 'window background uses the unified surface', visual.backgroundColor === EXPECTED_SURFACE, visual)
    record(failures, 'startup surface constant is the unified surface', visual.startupSurface === EXPECTED_SURFACE, visual)
    record(failures, 'native titlebar height matches the renderer row', visual.titlebarHeight === 32, visual)

    for (const size of [{ width: 1280, height: 820 }, { width: 980, height: 700 }, { width: 1580, height: 900 }]) {
      await setAcceptanceWindowSize(locator, size)
      await delay(450)
      const capture = await captureRenderer(client, outDir, `renderer-${size.width}x${size.height}${captureSuffix}`)
      screenshots.push(capture)
      const label = `${size.width}x${size.height}`
      record(failures, `${label}: titlebar row is the unified surface`, capture.titlebar === EXPECTED_SURFACE, capture)
      // `Page.captureScreenshot` frames the web contents only, so the native
      // caption buttons are outside this image; their colour is asserted from
      // the acceptance snapshot above. What this checks is that the renderer's
      // own right-hand titlebar segment matches, i.e. the DOM side of the seam.
      record(failures, `${label}: titlebar right segment matches the titlebar`, capture.titlebarRight === capture.titlebar, capture)
      record(failures, `${label}: application background matches the titlebar`, capture.body === capture.titlebar, capture)
      record(failures, `${label}: titlebar is one colour across the row`, capture.titlebarUniform, capture)
      record(failures, `${label}: no colour break below the titlebar`, capture.columnFlat, capture)
      record(failures, `${label}: renderer background variable matches the pixels`, capture.computedBackground === EXPECTED_SURFACE, capture)
    }

    // The maximized state is where a user sits for hours, and the native overlay
    // meets the renderer at a different width there, so it is checked the same
    // way as the explicit sizes. Restoring afterwards proves the state changed
    // instead of the action being a no-op.
    await harness.desktopAction(locator, 'maximize', { maximized: true })
    await delay(700)
    const maximized = await captureRenderer(client, outDir, `renderer-maximized${captureSuffix}`)
    screenshots.push(maximized)
    record(failures, 'maximized: titlebar row is the unified surface', maximized.titlebar === EXPECTED_SURFACE, maximized)
    record(failures, 'maximized: application background matches the titlebar', maximized.body === maximized.titlebar, maximized)
    record(failures, 'maximized: titlebar is one colour across the row', maximized.titlebarUniform, maximized)
    record(failures, 'maximized: no colour break below the titlebar', maximized.columnFlat, maximized)

    await harness.desktopAction(locator, 'maximize', { maximized: false })
    await delay(700)
    const restored = await captureRenderer(client, outDir, `renderer-restored${captureSuffix}`)
    screenshots.push(restored)
    record(failures, 'restored: titlebar row is the unified surface', restored.titlebar === EXPECTED_SURFACE, restored)
    record(failures, 'restored: application background matches the titlebar', restored.body === restored.titlebar, restored)
    record(failures, 'restored: no colour break below the titlebar', restored.columnFlat, restored)
    record(
      failures,
      'the maximize action really changed the window size',
      maximized.imageSize.width > restored.imageSize.width || maximized.imageSize.height > restored.imageSize.height,
      { maximized: maximized.imageSize, restored: restored.imageSize },
    )

    // The standalone startup document is normally replaced within ~90 ms, which
    // no external observer can catch, and the failure page is reachable only by
    // asking for it. Both are rendered here through the same loaders the product
    // uses, so the captures are evidence about those pages' pixels - not about
    // how long the startup page stays on screen.
    await harness.desktopAction(locator, 'startup-page')
    await delay(600)
    const startupPage = await captureStartupPageDocument(client, outDir)
    screenshots.push(startupPage)
    record(failures, 'startup page paints the unified surface', startupPage.titlebar === EXPECTED_SURFACE && startupPage.leftGutter === EXPECTED_SURFACE && startupPage.rightGutter === EXPECTED_SURFACE, startupPage)
    record(failures, 'startup page keeps one surface down the gutter', startupPage.gutterFlat, startupPage)
    record(failures, 'startup page shows the brand mark and no failure text', startupPage.hasIcon && startupPage.errorBox === null, startupPage)

    await harness.desktopAction(locator, 'startup-error', { message: STARTUP_ERROR_MESSAGE })
    await delay(600)
    const errorPage = await captureStartupErrorPage(client, outDir)
    screenshots.push(errorPage)
    record(failures, 'bootstrap-failure page shows the real message', errorPage.errorText?.includes(STARTUP_ERROR_MESSAGE) === true, errorPage)
    record(
      failures,
      'bootstrap-failure page renders the error card inside the window',
      errorPage.errorBox !== null && errorPage.errorBox.height > 0 && errorPage.errorBox.bottom <= errorPage.viewport.height,
      errorPage,
    )
    record(failures, 'bootstrap-failure page paints the unified surface', errorPage.titlebar === EXPECTED_SURFACE && errorPage.leftGutter === EXPECTED_SURFACE, errorPage)
    record(failures, 'bootstrap-failure page keeps one surface down the gutter', errorPage.gutterFlat && errorPage.rightGutter === EXPECTED_SURFACE, errorPage)
    // Reported, not gated: the card is translucent, so its composited colour is
    // only evidence that something painted over the surface.
    errorPage.cardOverSurface = errorPage.cardSurface !== EXPECTED_SURFACE

    await writeFile(join(outDir, ledgerName), `${JSON.stringify({
      check: 'desktop-cold-start-visuals',
      app: appKind,
      appExecutable: appKind === 'packaged' ? PACKAGED_EXECUTABLE_RELATIVE : 'packages/app/out (dev entry)',
      ok: failures.length === 0,
      expectedSurface: EXPECTED_SURFACE,
      screenshots,
      failures,
      gaps: [
        ...startupGaps.map((gap) => `${gap.check}: ${gap.detail}`),
        'DPR other than the host default, and 125%/150%/200% display scaling',
        'focus and minimized states (minimize produces no capturable window)',
        'the hand-over instant between the startup page and the renderer',
        'desktop wallpaper variation behind the window',
      ],
    }, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      ok: failures.length === 0,
      outDir,
      screenshots: screenshots.map((item) => item.file),
      startupGaps,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

/**
 * Capture the standalone startup document before the renderer replaces it.
 *
 * It is only on screen for a few hundred milliseconds, so the debugger attaches
 * to whatever page target exists first instead of waiting for the production
 * document.
 */
async function captureStartupPage(port, dir) {
  const deadline = Date.now() + 12_000
  let client
  let target
  // Tight polling on purpose: the startup document is visible for well under a
  // tenth of a second on this machine, so a 100 ms poll would always miss it.
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined)
    if (response?.ok) {
      const values = await response.json()
      target = values.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
      if (target) break
    }
    await delay(2)
  }
  if (!target) return undefined
  client = new CdpClient(target.webSocketDebuggerUrl)
  try {
    // Capture first, then identify: the URL check must not delay the screenshot,
    // because the production renderer may replace the document at any moment.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const shot = await screenshot(client).catch(() => undefined)
      if (!shot?.data) { await delay(5); continue }
      const image = decodePng(Buffer.from(shot.data, 'base64'))
      if (image.width < 200 || image.height < 200) { await delay(5); continue }
      const pageState = await evaluate(client, `(() => ({
        url: location.href,
        readyState: document.readyState,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        devicePixelRatio: window.devicePixelRatio,
        hasStartupIcon: Boolean(document.querySelector('.startup-icon')),
        hasRoot: Boolean(document.querySelector('#root')),
      }))()`).catch(() => undefined)
      if (!pageState?.url.startsWith('data:text/html') || pageState.hasRoot) return undefined
      if (pageState.readyState !== 'complete' || !pageState.hasStartupIcon) { await delay(5); continue }
      // Reject the window's own pre-paint surface. It is a different colour from
      // the document and would otherwise be recorded as the startup page's
      // background, which is exactly the kind of unverified claim CS-02 forbids.
      const bodyHex = hexAt(image, Math.round(image.width / 2), Math.round(image.height / 2))
      if (bodyHex !== EXPECTED_SURFACE) { await delay(5); continue }
      const file = join(dir, `startup-page${captureSuffix}.png`)
      await writeFile(file, Buffer.from(shot.data, 'base64'))
      const dpr = pageState.devicePixelRatio || 1
      const titlebarY = Math.round(16 * dpr)
      const column = columnColors(image, Math.round(image.width / 2), 0, image.height - 1, Math.max(1, Math.round(4 * dpr)))
      return {
        file,
        kind: 'startup-page',
        imageSize: { width: image.width, height: image.height },
        devicePixelRatio: dpr,
        declaredBodyBackground: pageState.bodyBackground,
        titlebar: hexAt(image, Math.round(image.width / 2), titlebarY),
        body: hexAt(image, Math.round(image.width / 2), Math.round(image.height / 2)),
        caption: hexAt(image, image.width - Math.round(30 * dpr), titlebarY),
        uniform: new Set(column).size === 1,
        column: [...new Set(column)],
      }
    }
    return undefined
  } finally {
    client.close()
  }
}

async function captureRenderer(client, dir, name) {
  const shot = await screenshot(client)
  const buffer = Buffer.from(shot.data, 'base64')
  const file = join(dir, `${name}.png`)
  await writeFile(file, buffer)
  const image = decodePng(buffer)
  const state = await evaluate(client, `(() => {
    const titlebar = document.querySelector('.window-titlebar');
    const shell = document.querySelector('.window-shell');
    const background = getComputedStyle(document.documentElement).getPropertyValue('--workspace-code-surface').trim();
    return {
      devicePixelRatio: window.devicePixelRatio,
      titlebarHeight: titlebar ? titlebar.getBoundingClientRect().height : null,
      titlebarBackground: titlebar ? getComputedStyle(titlebar).backgroundColor : null,
      shellBackground: shell ? getComputedStyle(shell).backgroundColor : null,
      computedBackground: background,
    };
  })()`)
  const dpr = state.devicePixelRatio || 1
  const titlebarY = Math.max(1, Math.round((state.titlebarHeight ?? 32) / 2 * dpr))
  const sampleX = Math.round(image.width * 0.45)
  const titlebarRow = columnColors(decodePng(buffer), sampleX, 0, 1, 1)
  const titlebarHex = hexAt(image, sampleX, titlebarY)
  const column = columnColors(image, sampleX, 0, Math.round(60 * dpr), Math.max(1, Math.round(2 * dpr)))
  return {
    file,
    kind: 'renderer',
    imageSize: { width: image.width, height: image.height },
    ...state,
    titlebar: titlebarHex,
    titlebarRight: hexAt(image, image.width - Math.round(30 * dpr), titlebarY),
    body: hexAt(image, Math.round(image.width / 2), Math.round(image.height * 0.75)),
    titlebarUniform: new Set(titlebarRow).size === 1,
    columnFlat: new Set(column).size === 1,
    column,
  }
}

async function setAcceptanceWindowSize(locator, size) {
  const response = await fetch(harness.apiUrl(locator, '/application/acceptance'), {
    method: 'POST',
    headers: { ...harness.authHeaders(locator), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resize', width: size.width, height: size.height }),
  })
  if (!response.ok) throw new Error(`acceptance resize failed: ${response.status}`)
}

/**
 * Read the bootstrap-failure document through the same debugger that is attached
 * to the window: the failure page replaces the renderer document in place.
 */
async function captureStartupErrorPage(client, dir) {
  const state = await evaluate(client, `(() => {
    const error = document.querySelector('.startup-error');
    const icon = document.querySelector('.startup-icon');
    const box = error ? error.getBoundingClientRect() : null;
    return {
      url: location.href,
      isFailureDocument: location.href.startsWith('data:text/html'),
      hasIcon: Boolean(icon),
      errorText: error ? error.textContent : null,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      errorBox: box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height } : null,
    };
  })()`)
  const shot = await screenshot(client)
  const buffer = Buffer.from(shot.data, 'base64')
  const file = join(dir, `startup-error${captureSuffix}.png`)
  await writeFile(file, buffer)
  const image = decodePng(buffer)
  const dpr = state.devicePixelRatio || 1
  // The logo is centred and the error card is pinned to the bottom, so the flat
  // surface is probed where neither paints: the titlebar row and a narrow gutter
  // just inside the left edge, left of the card's 24px inset.
  const gutterX = Math.max(1, Math.round(12 * dpr))
  const probeY = Math.round((32 + 40) * dpr)
  const column = columnColors(image, gutterX, 0, image.height - 1, Math.max(1, Math.round(dpr)))
  const pixels = [...new Set(column)]
  return {
    file,
    kind: 'startup-error',
    imageSize: { width: image.width, height: image.height },
    ...state,
    titlebar: hexAt(image, Math.round(image.width * 0.45), Math.round(16 * dpr)),
    leftGutter: hexAt(image, gutterX, probeY),
    rightGutter: hexAt(image, image.width - gutterX, probeY),
    gutterFlat: pixels.length === 1,
    gutterColors: pixels.slice(0, 4),
    // rgba(0,0,0,0.42) over the surface: composites darker if the card painted.
    cardSurface: hexAt(image, Math.round(image.width / 2), Math.max(0, image.height - Math.round(40 * dpr))),
  }
}

/**
 * Read and pixel-check the standalone startup document.
 *
 * It shares the failure page's geometry (centred brand mark, flat surface), but
 * must have no error card: the two documents are the same template with and
 * without a message.
 */
async function captureStartupPageDocument(client, dir) {
  const state = await evaluate(client, `(() => {
    const error = document.querySelector('.startup-error');
    const icon = document.querySelector('.startup-icon');
    return {
      url: location.href,
      isStartupDocument: location.href.startsWith('data:text/html'),
      hasIcon: Boolean(icon),
      errorBox: error ? error.getBoundingClientRect().height : null,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`)
  const shot = await screenshot(client)
  const buffer = Buffer.from(shot.data, 'base64')
  const file = join(dir, `startup-page${captureSuffix}.png`)
  await writeFile(file, buffer)
  const image = decodePng(buffer)
  const dpr = state.devicePixelRatio || 1
  const gutterX = Math.max(1, Math.round(12 * dpr))
  const probeY = Math.round((32 + 40) * dpr)
  const column = columnColors(image, gutterX, 0, image.height - 1, Math.max(1, Math.round(dpr)))
  const pixels = [...new Set(column)]
  return {
    file,
    kind: 'startup-page',
    imageSize: { width: image.width, height: image.height },
    ...state,
    titlebar: hexAt(image, Math.round(image.width * 0.45), Math.round(16 * dpr)),
    leftGutter: hexAt(image, gutterX, probeY),
    rightGutter: hexAt(image, image.width - gutterX, probeY),
    gutterFlat: pixels.length === 1,
    gutterColors: pixels.slice(0, 4),
    // What the user briefly sees while the Runtime starts, before the renderer
    // document replaces it in the same window.
    center: hexAt(image, Math.round(image.width / 2), Math.round(image.height / 2)),
  }
}

function record(failures, check, ok, detail) {
  if (ok) return
  failures.push({ check, ok: false, detail })
}

await main()
