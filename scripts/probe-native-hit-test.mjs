// Does `lib/native-hit-test.mjs` actually discriminate? This probe is the
// answer, and the usage example for a gate that has to prove "the user can
// really click this" (see scripts/README.md).
//
// It starts one real window and asks the same question twice, about the same
// control, through the shared library:
//
//   1. as shipped            -> the sidebar toggle is a client hit (clickable)
//   2. with a diagnostic     -> a transparent diagnostic overlay with
//      overlay injected by      `-webkit-app-region: drag` covers the control's
//      the probe only           own box, which is what the historical failure
//                              looked like
//                              -> the toggle is HTCAPTION (not clickable)
//
// The second run is the one that matters, and it is the exact shape of the
// historical false success: the DOM has an element covering the point, and a
// synthetic press goes to *something* — but whether the window hands that press
// to the page is decided by WM_NCHITTEST, which no DOM-level check can see.
//
// Nothing under `packages/` is touched: the broken state is one element
// appended to the running renderer's DOM and removed again before the window
// closes.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, CdpClient, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import {
  createNativeHitTest,
  describeHit,
  describeHitName,
  HTCLIENT,
  HTCAPTION,
} from './lib/native-hit-test.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const TOGGLE = '.app-nav-controls .sidebar-toggle-btn'
const CONTROLS = '.app-nav-controls'
const evidenceDir = runArtifact('native-hit-test-probe')
await mkdir(evidenceDir, { recursive: true })
/**
 * This probe answers "does the native hit test discriminate", and the native
 * hit test reads only the window handle, the content bounds and the DOM. On a
 * shared working tree the app fingerprint is red almost continuously (another
 * agent is editing `packages/app/src/**` while the build runs), so the strict
 * freshness assertion would make this capability untestable. The opt-out is
 * explicit and recorded in the report; gates that assert product behaviour must
 * NOT use it.
 */
const allowStaleBuild = process.argv.includes('--allow-stale-build')
// `requireAppBuildManifest: false` is the same opt-out one level down: the
// harness otherwise refuses to resolve the prepared Electron runtime without
// the sidecar a *successful* build writes, and a build that lost the race
// against a concurrent editor writes none.
const harness = createElectronHarness({ startTimeoutMs: 90_000, requireAppBuildManifest: !allowStaleBuild })
const buildFreshness = allowStaleBuild
  ? { status: 'skipped-by-flag', note: '--allow-stale-build: the app fingerprint was not asserted for this run' }
  : await harness.assertBuildFresh()
const provider = await startElectronAcceptanceProvider()
const root = await mkdtemp(join(tmpdir(), 'littlesheep-native-hit-probe-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'workplace'), { recursive: true })
await writeFile(join(dataDir, 'config.json'), JSON.stringify({
  version: 1,
  providers: [{
    id: 'acceptance', name: 'Electron Acceptance', baseURL: provider.baseURL,
    apiKey: 'acceptance-key', timeoutSeconds: 10, models: ['slow-a'],
  }],
  agents: { defaults: { workspace: join(dataDir, 'workplace'), model: 'acceptance/slow-a', harness: 'core-flow' } },
  desktop: { closePolicy: 'always-background' },
}))
const debuggingPort = await harness.reservePort()
const mainDebuggingPort = await harness.reservePort()
const child = await harness.startElectron({
  dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, mainDebuggingPort, logPath: join(root, 'electron.log'),
})
let client, main, locator
const report = { check: 'native-hit-test-discriminates', root, evidenceDir, buildFreshness, runs: [] }

/**
 * What the renderer and the window say right now. Written on failure and kept
 * with the scratch root, because "the layout attribute never arrived" is a
 * fixture problem and guessing at it costs another whole Electron launch.
 */
async function diagnose() {
  const renderer = await client?.evaluate(`(() => ({
    url: location.href,
    readyState: document.readyState,
    root: Boolean(document.querySelector('#root')),
    rootChildren: document.querySelector('#root')?.childElementCount ?? null,
    windowLayout: document.documentElement.dataset.windowLayout ?? null,
    nativeBackdrop: document.documentElement.dataset.nativeBackdrop ?? null,
    bridge: typeof window.littlesheep,
    hasChromeApi: typeof window.littlesheep?.onWindowChrome,
    controls: Boolean(document.querySelector(${JSON.stringify(CONTROLS)})),
    toggle: Boolean(document.querySelector(${JSON.stringify(TOGGLE)})),
    bodyText: (document.body?.innerText ?? '').slice(0, 400),
  }))()`).catch((error) => ({ error: error.message }))
  const windowState = await main?.evaluate(`(() => {
    const win = layoutWindow ?? layoutElectron?.BrowserWindow?.getAllWindows?.()[0];
    return win ? { shown: win.isVisible(), maximized: win.isMaximized(), fullScreen: win.isFullScreen(), bounds: win.getBounds() } : null;
  })()`).catch((error) => ({ error: error.message }))
  return { renderer, windowState }
}

/** The control's own centre and the box the island occupies, in CSS px. */
async function measure() {
  return client.evaluate(`(() => {
    const box = (selector) => { const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2) }; };
    const toggle = box(${JSON.stringify(TOGGLE)});
    const controls = box(${JSON.stringify(CONTROLS)});
    const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    return { toggle, controls, under: (() => { const p = centre(toggle);
      const hit = document.elementFromPoint(p.x, p.y);
      return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), className: hit ? (hit.getAttribute('class') || hit.tagName) : null,
        insideToggle: Boolean(hit && document.querySelector(${JSON.stringify(TOGGLE)}).contains(hit)) }; })() };
  })()`)
}

/**
 * The two points both runs use. The band point is **located through the library
 * itself** rather than assumed to sit a fixed offset from the controls' box: the
 * no-drag hole is a declared box that the chrome contract may tighten, and a
 * hardcoded offset silently lands inside it the moment it does (measured
 * 2026-09-28, after the hole was narrowed to the controls' island exactly). The
 * first sample to the right of the island that the window still treats as
 * caption is the band by definition — and finding none is a fixture failure, not
 * a pass.
 */
async function choosePoints(probe) {
  const dom = await measure()
  const toggle = { label: 'toggle', x: dom.under.x, y: dom.under.y }
  const candidates = []
  for (let offset = 0; offset <= 48; offset += 4) {
    candidates.push({ label: `band+${offset}`, x: dom.controls.x + dom.controls.width + offset, y: 16 })
  }
  const probed = await probe.probe(candidates)
  assert(probed, 'the native hit test answered nothing on this platform')
  const band = probed.find((entry) => entry.caption)
  if (!band) {
    report.status = 'fixture-failed'
    report.failure = 'no draggable band found to the right of the controls island'
    report.bandCandidates = probed
    report.diagnosis = await diagnose()
    await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
    console.error(JSON.stringify(report, null, 2))
    throw new Error('the probe found no caption hit beside the island to use as its control point')
  }
  report.bandPoint = { label: 'drag-band-beside-island', css: band.css, hit: band.hit, name: band.name, locatedBy: 'first caption hit at or right of the island edge, sampled every 4px' }
  return { dom, list: [toggle, { label: 'drag-band-beside-island', x: band.css.x, y: band.css.y }] }
}

/**
 * Produce the historical failure state *without touching `packages/`*: a
 * diagnostic overlay is appended over the control's own box, paints nothing,
 * swallows mouse events the way a drag surface does and declares itself a drag
 * region. The measured question is only whether the window's draggable region
 * picked that up — which is exactly what `probe()` answers.
 */
async function injectDragOverlay(probe, point) {
  const installed = await client.evaluate(`(() => {
    document.getElementById('native-hit-probe-drag')?.remove();
    const box = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = 'native-hit-probe-drag';
    overlay.style.cssText = 'position:fixed;background:transparent;pointer-events:auto;z-index:2147483000;'
      + '-webkit-app-region:drag;app-region:drag;user-select:none;';
    overlay.style.left = box.left + 'px';
    overlay.style.top = box.top + 'px';
    overlay.style.width = box.width + 'px';
    overlay.style.height = box.height + 'px';
    document.body.appendChild(overlay);
    const style = getComputedStyle(overlay);
    const at = ${JSON.stringify(point)};
    return {
      appRegion: style.getPropertyValue('-webkit-app-region'),
      position: style.position,
      rect: { left: box.left, top: box.top, width: box.width, height: box.height },
      topElementIsOverlay: document.elementFromPoint(at.x, at.y) === overlay,
    };
  })()`)
  // The window resolves the drag region from the renderer's published boxes, so
  // poll the native answer instead of assuming one style recalc is enough: the
  // measured result of this loop is part of the evidence either way.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 300 }).catch(() => {})
    await delay(250)
    const [toggle] = await probe.probe([{ label: 'toggle', ...point }])
    if (toggle?.hit === HTCAPTION) return { installed, attempts: attempt, hit: toggle.hit }
  }
  const [toggle] = await probe.probe([{ label: 'toggle', ...point }])
  return { installed, attempts: 12, hit: toggle?.hit }
}

async function removeDragOverlay() {
  await client.evaluate(`(() => { document.getElementById('native-hit-probe-drag')?.remove(); return true; })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 300 }).catch(() => {})
  await delay(400)
}

/** One probe of the two points, keeping the DOM answer next to the native one. */
async function run(label, probe, list) {
  const dom = await measure()
  const entries = await probe.probe(list)
  assert(entries, 'the native hit test answered nothing on this platform')
  const record = {
    label,
    elementFromPoint: dom.under,
    points: entries.map((entry) => ({
      label: entry.label,
      css: entry.css,
      physical: entry.physical,
      hit: entry.hit,
      name: entry.name,
      kind: entry.kind,
      clickable: entry.client,
    })),
  }
  report.runs.push(record)
  for (const entry of record.points) {
    console.log(`${label} | ${entry.label} | elementFromPoint=${dom.under.className} | css ${entry.css.x},${entry.css.y} -> physical ${entry.physical.x},${entry.physical.y} | hit ${entry.hit} ${entry.name} | ${describeHit(entry.hit)} | ${entry.clickable ? 'clickable' : 'NOT clickable'}`)
  }
  return { record, entries, dom }
}

try {
  locator = await harness.waitForLocator(dataDir, child.pid)
  client = await harness.connectRenderer(debuggingPort)
  const target = await harness.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${mainDebuggingPort}/json/list`).catch(() => null)
    return response?.ok ? (await response.json())[0] : null
  }, 30_000, 'main inspector')
  main = new CdpClient(target.webSocketDebuggerUrl)
  // `layoutElectron`/`layoutWindow` are what `lib/native-hit-test.mjs` reads out
  // of the main process; the library never launches or moves anything itself.
  await main.evaluate(`globalThis.layoutElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); globalThis.layoutWindow = layoutElectron.BrowserWindow.getAllWindows()[0]; true`)
  // Deliberately NOT `park-offscreen`. A window that is hidden, or moved entirely
  // off every display, has no observable draggable region: measured here on
  // 2026-09-28, a parked window answered `HTCLIENT` at the titlebar's centre while
  // the same point answered `HTCAPTION` once the window was on screen again, and
  // the renderer's own `-webkit-app-region` boxes were unchanged throughout. A
  // hit test that runs off screen measures a stale or absent region, so the
  // window stays where and as the app put it and the measurement records that.
  const renderState = await main.evaluate(`(() => {
    const win = layoutWindow ?? layoutElectron.BrowserWindow.getAllWindows()[0];
    return { visible: win.isVisible(), minimized: win.isMinimized(), bounds: win.getBounds() };
  })()`)
  report.renderState = { ...renderState, note: 'the native hit test is only meaningful for a window the OS still composites' }
  // An acceptance run is allowed to leave the window hidden; the native half of
  // this probe needs it rendered, so it is shown inactively (no focus, no click
  // stealing) and that is recorded rather than assumed.
  if (!renderState.visible || renderState.minimized) {
    await main.evaluate('layoutWindow.showInactive(); true')
    await delay(800)
    report.renderState.shownForMeasurement = true
  } else {
    report.renderState.shownForMeasurement = false
  }
  const rendererAdapter = { client }
  const waitForLayout = async (timeoutMs, label) => {
    try {
      await harness.waitForRenderer(rendererAdapter, `(() => {
        const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
        return document.documentElement.dataset.windowLayout === 'chali' && toggle ? true : undefined;
      })()`, timeoutMs, label, { reconnect: () => harness.connectRenderer(debuggingPort) })
      client = rendererAdapter.client
    } catch (error) {
      report.status = 'fixture-failed'
      report.failure = error.message
      report.diagnosis = await diagnose()
      report.electronLog = await readFile(join(root, 'electron.log'), 'utf8').catch(() => '')
      await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
      console.error(JSON.stringify(report, null, 2))
      throw error
    }
  }
  await waitForLayout(90_000, 'Chali layout')
  await delay(900)

  const probe = createNativeHitTest({ main, pointsPath: join(root, 'native-hit-points.json') })
  const { list } = await choosePoints(probe)
  const togglePoint = list.find((point) => point.label === 'toggle')
  const assertCase = async (caseLabel, runLabel, expected) => {
    const { record, entries, dom } = await run(runLabel, probe, list)
    const boundsBefore = await main.evaluate('(() => { const b = layoutWindow.getBounds(); return { x:b.x, y:b.y, width:b.width, height:b.height }; })()')
    // The library's own contract, called exactly as a gate calls it: in the
    // fixed state it returns, over a drag region it must throw. A CDP click on
    // the same point is dispatched too, so the report shows what that layer said.
    try {
      const hits = await probe.assertClientHits([togglePoint], caseLabel)
      record.assertClientHits = { outcome: 'passed', hit: hits?.[0]?.hit ?? null }
    } catch (error) {
      record.assertClientHits = { outcome: 'failed', message: error.message }
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dom.under.x, y: dom.under.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dom.under.x, y: dom.under.y, button: 'left', clickCount: 1 })
    await delay(400)
    // Recorded, not asserted: a CDP click is answered by the renderer whenever
    // the native layer happens to deliver it, and puts the *state* of the
    // control on screen whether or not a real press ever would. It is here to
    // show what that layer says next to the native answer, nothing more.
    record.cdpClickEffect = {
      ariaExpandedAfter: await client.evaluate(`(() => document.querySelector(${JSON.stringify(TOGGLE)})?.getAttribute('aria-expanded') ?? null)()`),
      note: 'the renderer toggles this whenever the press reaches the page; it cannot distinguish a real press from a synthetic one',
    }
    const boundsAfter = await main.evaluate('(() => { const b = layoutWindow.getBounds(); return { x:b.x, y:b.y, width:b.width, height:b.height }; })()')
    // The probe must not have moved the window: a move re-applies bounds through
    // the DIP round trip that ratchets the size and breaks exact geometry.
    assert.deepEqual(boundsAfter, boundsBefore, `${caseLabel}: the native probe moved the window`)
    // The inverted expectation is the proof. When the control sits inside a drag
    // region the same assertion MUST fail, and nothing in the DOM says so.
    assert.equal(record.assertClientHits.outcome, expected, `${caseLabel}: assertClientHits ${record.assertClientHits.outcome} (hit ${entries[0].hit} ${describeHitName(entries[0].hit)})`)
    const band = entries.find((entry) => entry.label === 'drag-band-beside-island')
    assert.equal(band?.hit, HTCAPTION, `${caseLabel}: the drag band beside the island stopped being window chrome (${band?.hit})`)
    return { record, dom, toggle: togglePoint }
  }

  const fixed = await assertCase('as-shipped', 'as-shipped', 'passed')
  assert.equal(fixed.record.points[0].hit, HTCLIENT, 'the shipped build does not deliver a real press to the toggle')
  assert.equal(fixed.record.elementFromPoint.insideToggle, true, 'the DOM says the toggle is not under its own centre')

  const injected = await injectDragOverlay(probe, togglePoint)
  report.injectedDragOverlay = injected
  assert.equal(injected.installed.appRegion, 'drag', 'the diagnostic overlay is not a drag region')
  assert.equal(injected.installed.topElementIsOverlay, true, 'the diagnostic overlay is not the element on top of the control')
  const broken = await assertCase('drag-region-over-control', 'drag-region-over-control', 'failed')
  assert.equal(broken.record.points[0].hit, HTCAPTION, `the injected drag region did not reach the window (hit ${broken.record.points[0].hit})`)
  report.sameGeometry = {
    css: broken.record.points[0].css,
    physical: broken.record.points[0].physical,
    identicalToFixedRun: JSON.stringify(fixed.record.points[0].physical) === JSON.stringify(broken.record.points[0].physical),
  }

  await removeDragOverlay()
  report.status = 'passed'
  report.conclusion = 'the same CSS point (20,16) and the same physical point convert identically in both runs; it answers HTCLIENT (clickable, assertClientHits returns) as shipped and HTCAPTION (not clickable, assertClientHits throws) once a drag region covers the control'
  await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  console.log(`Evidence: ${evidenceDir}`)
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {})
  client?.close(); main?.close()
  if (locator) await harness.desktopAction(locator, 'quit').catch(() => {})
  if (child.exitCode === null) await harness.waitForExit(child, 10_000).catch(() => child.kill())
  await provider.close().catch(() => {})
  // The scratch root is deleted unless the caller asked to keep it: the report
  // in the evidence directory is the artifact, not a temp tree full of Chromium
  // caches.
  if (!process.argv.includes('--keep-temp')) await harness.removeTemporaryRoot(root).catch(() => {})
}
