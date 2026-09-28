// Real native-window geometry and desktop-composited backdrop acceptance.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, CdpClient, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000 })
await harness.assertBuildFresh()
// A window whose Runtime reached `ready`. The previous fixture left `model` empty,
// which fails the config parse ("invalid model ref"), and a failed start keeps the
// window-wide `.runtime-readiness-notice` strip across the top of the content column —
// a real surface that legitimately covers the workspace panel's corner toggle and made
// this script fail on its own fixture rather than on the layout it measures.
const provider = await startElectronAcceptanceProvider()
const root = await mkdtemp(join(tmpdir(), 'littlesheep-window-layout-'))
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
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, mainDebuggingPort, logPath: join(root, 'electron.log') })
let client, main, locator
const results = []
async function state() {
  return client.evaluate(`(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      return { x:r.x, y:r.y, width:r.width, height:r.height, background:s.backgroundColor, radius:s.borderTopLeftRadius };
    };
    return { layout:document.documentElement.dataset.windowLayout, backdrop:document.documentElement.dataset.nativeBackdrop,
      title:rect('.window-titlebar'), sidebar:rect('.sidebar-surface'), core:rect('.core-workspace'),
      settings:rect('.settings-sidebar'), settingsBody:rect('.settings-workspace-body'),
      collapsed:document.querySelector('.window-shell').classList.contains('sidebar-collapsed'),
      settingsOpen:document.querySelector('.window-shell').classList.contains('settings-open'),
      titleBrand:document.querySelector('.window-titlebar-brand, .window-titlebar-icon') !== null,
      width:innerWidth, height:innerHeight };
  })()`)
}
/**
 * The pinned window-chrome controls, the sidebar geometry they must be independent of,
 * and the window's top-edge drag tiling.
 *
 * `gaps` samples every x across the top edge and asks whether any drag surface's box
 * covers it; `misrouted` samples the same edge and asks which element actually receives
 * the pointer there. Two hit regions are deliberate and counted rather than reported as
 * holes: the pinned controls (three buttons were already a no-drag island before they
 * were pinned) and the sidebar's resize seam, whose box is 8px wide and straddles the
 * grid boundary — its inner half sits under the band, its outer half above the top bar
 * (z-index 20 against the bar's `auto`), so 4px of the top edge resizes the sidebar. That
 * geometry predates the pinned controls and is bounded here so it cannot grow unnoticed.
 */
async function chrome() {
  return client.evaluate(`(() => {
    const box = (selector) => {
      const node = document.querySelector(selector); if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2) };
    };
    const controls = document.querySelector('.app-nav-controls');
    const surfaces = ['.window-titlebar', '.window-drag-band'].flatMap((selector) => {
      const node = document.querySelector(selector); if (!node) return [];
      const style = getComputedStyle(node); if (style.display === 'none') return [];
      const r = node.getBoundingClientRect();
      return [{ selector, x:+r.x.toFixed(2), width:+r.width.toFixed(2), height:+r.height.toFixed(2),
        appRegion: style.getPropertyValue('-webkit-app-region') }];
    });
    const gaps = [];
    for (let x = 0; x < innerWidth; x += 1) {
      if (!surfaces.some((surface) => x >= surface.x - 0.5 && x < surface.x + surface.width + 0.5)) gaps.push(x);
    }
    const misrouted = [];
    const seamHits = [];
    let controlHits = 0;
    for (let x = 0.5; x < Math.floor(document.documentElement.clientWidth) - 1; x += 4) {
      const hit = document.elementFromPoint(x, 16);
      if (!(hit instanceof Element)) { misrouted.push({ x, hit: null }); continue; }
      if (hit.closest('.app-nav-controls')) { controlHits += 1; continue; }
      if (hit.closest('.sidebar-resizer')) { seamHits.push(x); continue; }
      if (!hit.closest('.window-titlebar, .window-drag-band')) misrouted.push({ x, hit: hit.className || hit.tagName });
    }
    const toggle = document.querySelector('.app-nav-controls .sidebar-toggle-btn');
    return {
      layout: document.documentElement.dataset.windowLayout,
      collapsed: document.querySelector('.window-shell').classList.contains('sidebar-collapsed'),
      controls: box('.app-nav-controls'), toggle: box('.app-nav-controls .sidebar-toggle-btn'),
      back: box('.app-nav-btn.nav-back'), forward: box('.app-nav-btn.nav-forward'),
      position: controls ? getComputedStyle(controls).position : null,
      zIndex: controls ? getComputedStyle(controls).zIndex : null,
      toggleLabel: toggle?.getAttribute('aria-label') ?? null,
      toggleExpanded: toggle?.getAttribute('aria-expanded') ?? null,
      backDisabled: document.querySelector('.app-nav-btn.nav-back')?.disabled ?? null,
      forwardDisabled: document.querySelector('.app-nav-btn.nav-forward')?.disabled ?? null,
      sidebarTrack: box('.sidebar'), sidebarSurface: box('.sidebar-surface'),
      controlTops: ['.app-nav-controls .sidebar-toggle-btn', '.app-nav-btn.nav-back', '.app-nav-btn.nav-forward'].map((selector) => {
        const node = document.querySelector(selector);
        if (!node) return { selector, top: null, isControl: false };
        const r = node.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { selector, top: top ? (top.getAttribute('class') || top.tagName) : null, isControl: Boolean(top && node.contains(top)) };
      }),
      surfaces, gaps, misrouted, seamHits, controlHits, width: innerWidth,
    };
  })()`)
}
function assertDragTiling(current, label) {
  assert.deepEqual(current.gaps, [], `${label}: the drag surfaces leave a gap in the window's top edge`)
  assert.deepEqual(current.misrouted, [], `${label}: part of the top edge is owned by something that is not a drag surface`)
  for (const surface of current.surfaces) {
    assert.equal(surface.appRegion, 'drag', `${label}: ${surface.selector} is not a drag surface`)
  }
  // Not vacuous: the top edge, and the controls' own island, were really sampled.
  assert(current.width > 0 && current.controlHits > 1, `${label}: the top edge was not sampled`)
  // The bounded resize-seam exception: 4px on either side of the boundary, one sample per 4px.
  assert(current.seamHits.length <= 2, `${label}: the sidebar resize seam grew into the top edge (${current.seamHits.length} samples)`)
  // The DOM half of the controls' own contract: at each control's centre the element under
  // the point is that control — not the band or the top bar that tile the same row, which
  // paint below it but are the surfaces a real press would otherwise land on.
  for (const control of current.controlTops ?? []) {
    assert(control.isControl, `${label}: ${control.selector} is not the element under its own centre (${control.top})`)
  }
}
/** One pinned position for all three controls, in every sidebar state. */
function assertPinned(current, reference, label) {
  assert.equal(current.position, 'fixed', `${label}: the controls are not pinned to the window`)
  assert.deepEqual(current.controls, reference.controls, `${label}: the pinned controls moved`)
  assert.deepEqual(current.toggle, reference.toggle, `${label}: the sidebar toggle moved`)
  assert.deepEqual(current.back, reference.back, `${label}: the back control moved`)
  assert.deepEqual(current.forward, reference.forward, `${label}: the forward control moved`)
}
/**
 * What the *window* does with a real mouse press at these points.
 *
 * `elementFromPoint` and `Input.dispatchMouseEvent` both answer a layer above this one: a
 * real press is filtered first by the window's draggable region, which the renderer
 * publishes from `-webkit-app-region` and Windows consults through the window's own
 * WM_NCHITTEST. HTCAPTION (2) there means the press becomes a caption interaction and the
 * page never sees it; HTCLIENT (1) means it is delivered. That filter is why the pinned
 * controls could look reachable to the DOM checks in this script — and to a CDP click —
 * while a real click on them did nothing, so the three sidebar states are asserted here
 * through the OS instead.
 *
 * The points are given in viewport coordinates and converted with the window's own
 * geometry: `getContentBounds()` is in DIP, and the scale factor of the display it sits on
 * takes that to the physical screen space WM_NCHITTEST speaks. The window is deliberately
 * *not* moved onto a display for this: moving it re-applies its bounds through a
 * DIP/physical round trip that ratchets its size about a pixel per call, which would break
 * the exact geometry asserted below. A parked window answers correctly from where it is.
 */
function nativeHitScript(hwnd, pointsPath) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace LsWindowLayout -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
'@
[void][LsWindowLayout.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
$points = Get-Content -Raw -LiteralPath '${pointsPath.replaceAll("'", "''")}' | ConvertFrom-Json
$out = foreach ($point in $points) {
  $packed = ((([int64]$point.y -band 0xFFFF) -shl 16) -bor ([int64]$point.x -band 0xFFFF))
  if ($packed -ge 0x80000000) { $packed -= 0x100000000 }
  [pscustomobject]@{ label = [string]$point.label; hit = [int64][LsWindowLayout.Native]::SendMessage([IntPtr][int64]${hwnd}, 0x0084, [IntPtr]::Zero, [IntPtr][int64]$packed) }
}
ConvertTo-Json -InputObject @($out) -Compress
`
}
async function nativeHitTest(points) {
  if (process.platform !== 'win32') return undefined
  const geometry = await main.evaluate(`(() => {
    const content = layoutWindow.getContentBounds();
    const scale = layoutElectron.screen.getDisplayMatching(layoutWindow.getBounds()).scaleFactor;
    const handle = layoutWindow.getNativeWindowHandle();
    return { hwnd: handle.readBigUInt64LE(0).toString(), content, scale };
  })()`)
  const pointsPath = join(root, 'native-hit-points.json')
  await writeFile(pointsPath, JSON.stringify(points.map((point) => ({
    label: point.label,
    x: Math.round((geometry.content.x + point.x) * geometry.scale),
    y: Math.round((geometry.content.y + point.y) * geometry.scale),
  }))))
  const stdout = execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', nativeHitScript(geometry.hwnd, pointsPath)], { encoding: 'utf8' })
  return Object.fromEntries(JSON.parse(stdout).map((entry) => [entry.label, entry.hit]))
}
const HT_CLIENT = 1
const HT_CAPTION = 2
/** The island is the three buttons themselves; every neighbour of it stays grabbable. */
function nativeChromePoints(dom) {
  const centre = (box) => ({ x: box.x + (box.width / 2), y: box.y + (box.height / 2) })
  const titlebar = dom.surfaces.find((surface) => surface.selector === '.window-titlebar')
  return [
    { label: 'toggle', ...centre(dom.toggle) },
    { label: 'back', ...centre(dom.back) },
    { label: 'forward', ...centre(dom.forward) },
    { label: 'island-left', x: dom.controls.x - 4, y: 16 },
    { label: 'island-right', x: dom.controls.x + dom.controls.width + 8, y: 16 },
    { label: 'island-below', x: dom.controls.x + (dom.controls.width / 2), y: dom.controls.y + dom.controls.height + 3 },
    { label: 'titlebar', x: titlebar.x + (titlebar.width / 2), y: 16 },
    { label: 'chat-client', x: 600, y: 300 },
  ]
}
function assertNativeHitTest(hits, label) {
  if (!hits) return
  for (const name of ['toggle', 'back', 'forward']) {
    assert.equal(hits[name], HT_CLIENT, `${label}: a real mouse press on the ${name} control is not delivered to the page (win32 hit test ${hits[name]})`)
  }
  for (const name of ['island-left', 'island-right', 'island-below', 'titlebar']) {
    assert.equal(hits[name], HT_CAPTION, `${label}: ${name} is no longer part of the window's draggable top edge (win32 hit test ${hits[name]})`)
  }
  assert.equal(hits['chat-client'], HT_CLIENT, `${label}: the win32 hit test did not answer for this window`)
}
async function assertNativeChrome(dom, label) {
  const hits = await nativeHitTest(nativeChromePoints(dom))
  assertNativeHitTest(hits, label)
  return hits
}
async function windowBounds() {
  return main.evaluate(`(() => { const b = layoutWindow.getBounds(); return { x:b.x, y:b.y, width:b.width, height:b.height }; })()`)
}
/** A real pointer drag along the window's top edge, through the pointer bridge to Main. */
async function dragTopEdge(x, dx, dy) {
  const before = await windowBounds()
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 16, button: 'left', clickCount: 1 })
  await delay(80)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: 16 + dy, button: 'left', buttons: 1 })
  await delay(200)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: 16 + dy, button: 'left', clickCount: 1 })
  await delay(400)
  const after = await windowBounds()
  return { before, after, delta: { x: after.x - before.x, y: after.y - before.y }, requested: { x: dx, y: dy } }
}
async function click(selector) {
  const point = await client.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,reachable:el.contains(document.elementFromPoint(x,y))};})()`)
  assert(point.reachable, `${selector} is covered`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await delay(700)
}
async function shot(name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(root, `${name}.png`), Buffer.from(data, 'base64'))
}
/** The window's top-left corner, which is where the pinned controls live. */
async function shotCorner(name) {
  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 360, height: 64, scale: 1 },
  })
  await writeFile(join(root, `${name}.png`), Buffer.from(data, 'base64'))
}
try {
  locator = await harness.waitForLocator(dataDir, child.pid)
  client = await harness.connectRenderer(debuggingPort)
  const target = await harness.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${mainDebuggingPort}/json/list`).catch(() => null)
    return response?.ok ? (await response.json())[0] : null
  }, 30_000, 'main inspector')
  main = new CdpClient(target.webSocketDebuggerUrl)
  await main.evaluate(`globalThis.layoutElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); globalThis.layoutWindow = layoutElectron.BrowserWindow.getAllWindows()[0]; true`)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.waitFor(async () => (await state()).layout === 'chali', 30_000, 'initial Chali')
  await delay(700)
  await click('.workspace-panel-corner-toggle')
  for (const [name, maximized] of [['chali', false], ['beta', true], ['restored', false]]) {
    await harness.desktopAction(locator, 'maximize', { maximized })
    await harness.waitFor(async () => (await state()).layout === (maximized ? 'beta' : 'chali'), 10_000, name)
    await delay(600)
    const s = await state()
    assert.equal(s.titleBrand, false)
    assert.equal(s.sidebar.y, maximized ? 32 : 0)
    assert.equal(s.core.y, 32)
    assert.equal(s.title.x, maximized ? 0 : s.core.x)
    assert.equal(s.sidebar.x, 0)
    assert.equal(s.sidebar.y + s.sidebar.height, s.height)
    assert.equal(s.core.radius, maximized ? '12px' : '0px')
    const expandedChrome = await chrome()
    assertDragTiling(expandedChrome, `${name} expanded`)
    assert.equal(expandedChrome.controls.x, 8)
    assert.equal(expandedChrome.controls.y, 4)
    const expandedNative = await assertNativeChrome(expandedChrome, `${name} expanded`)
    await shot(name)
    await click('.sidebar-toggle-btn')
    const collapsedState = await state()
    assert.equal(collapsedState.collapsed, true)
    assert.equal(collapsedState.title.x, 0)
    const collapsedChrome = await chrome()
    assertDragTiling(collapsedChrome, `${name} collapsed`)
    assertPinned(collapsedChrome, expandedChrome, `${name} collapsed`)
    assert.equal(collapsedChrome.sidebarTrack.width, 0)
    const collapsedNative = await assertNativeChrome(collapsedChrome, `${name} collapsed`)
    await click('.sidebar-toggle-btn')
    await click('.settings-entry-btn')
    const settings = await state()
    assert(settings.settingsOpen)
    assert.equal(settings.settings.y, maximized ? 32 : 0)
    // The settings rail renders its own drag band over the same 32px row, so the controls
    // keep their island while that surface owns the left rail.
    const settingsNative = await assertNativeChrome(await chrome(), `${name} settings open`)
    await click('.settings-entry-btn')
    await client.send('Page.reload')
    await harness.waitFor(async () => (await state()).layout === (maximized ? 'beta' : 'chali'), 20_000, 'reload layout')
    await delay(700)
    results.push({ name, ...s, settings, controls: 'passed', reload: 'passed', pinned: expandedChrome.controls, dragTiling: 'passed', native: { expanded: expandedNative, collapsed: collapsedNative, settings: settingsNative } })
  }

  // The pinned window-chrome controls: one position across every sidebar state, with
  // the sidebar geometry — and only the sidebar geometry — changing around them.
  await harness.desktopAction(locator, 'maximize', { maximized: false })
  await harness.waitFor(async () => (await state()).layout === 'chali', 10_000, 'chali for pinned controls')
  await delay(600)
  const expanded = await chrome()
  assertDragTiling(expanded, 'pinned expanded')
  assert.equal(expanded.position, 'fixed')
  assert.equal(expanded.toggleLabel, '收起侧边栏')
  assert.equal(expanded.toggleExpanded, 'true')
  assert.equal(expanded.controls.x, 8)
  assert.equal(expanded.controls.y, 4)
  assert.equal(expanded.controls.height, 24)
  const expandedWidth = expanded.sidebarTrack.width
  assert(expandedWidth > 0, 'the expanded sidebar has no width to shrink from')
  // ...and the whole top edge is only draggable if the three controls are *not*: a real
  // press on the island is delivered to the page, a real press on its neighbours is window
  // chrome. This is the half of the contract the DOM-level checks above cannot see.
  const expandedNative = await assertNativeChrome(expanded, 'pinned expanded')
  await shotCorner('corner-expanded')

  // Collapsed: the sidebar track is gone, the controls are where they were — and the top
  // bar, which now starts at x = 0 and covers the island, must still let the clicks through.
  await click('.app-nav-controls .sidebar-toggle-btn')
  const collapsed = await chrome()
  assert.equal(collapsed.collapsed, true)
  assert.equal(collapsed.sidebarTrack.width, 0)
  assert.equal(collapsed.toggleLabel, '展开侧边栏')
  assert.equal(collapsed.toggleExpanded, 'false')
  assertPinned(collapsed, expanded, 'collapsed')
  assertDragTiling(collapsed, 'pinned collapsed')
  const collapsedNative = await assertNativeChrome(collapsed, 'pinned collapsed')
  await shotCorner('corner-collapsed')

  // ...and a real pointer click on the pinned toggle brings the sidebar back: the
  // pinned corner is the only way out of a collapsed sidebar, so it has to work there.
  await click('.app-nav-controls .sidebar-toggle-btn')
  const reopened = await chrome()
  assert.equal(reopened.collapsed, false)
  assert.equal(reopened.toggleLabel, '收起侧边栏')
  assert(Math.abs(reopened.sidebarTrack.width - expandedWidth) < 2, `the reopened sidebar lost its width (${reopened.sidebarTrack.width})`)
  assertPinned(reopened, expanded, 'reopened')

  // Mid-resize: a real pointer drag on the sidebar's seam, measured while the pointer
  // is still down. The sidebar width changes frame by frame here; the controls do not.
  const seam = await client.evaluate(`(() => { const r = document.querySelector('.sidebar-resizer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seam.x, y: seam.y, button: 'left', clickCount: 1 })
  await delay(80)
  const midResize = []
  for (const dx of [40, 90, 130]) {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seam.x + dx, y: seam.y, button: 'left', buttons: 1 })
    await delay(160)
    const sample = await chrome()
    assertPinned(sample, expanded, `mid-resize +${dx}`)
    assertDragTiling(sample, `mid-resize +${dx}`)
    assert(Math.abs(sample.sidebarTrack.width - (expandedWidth + dx)) < 2, `mid-resize +${dx}: the sidebar track did not follow the pointer (${sample.sidebarTrack.width})`)
    assert(Math.abs(sample.sidebarSurface.width - (expandedWidth + dx)) < 2, `mid-resize +${dx}: the sidebar surface did not follow the pointer (${sample.sidebarSurface.width})`)
    midResize.push({ dx, sidebarTrack: sample.sidebarTrack.width, controls: sample.controls })
  }
  await shotCorner('corner-mid-resize')
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: seam.x + 130, y: seam.y, button: 'left', clickCount: 1 })
  await delay(700)
  const widened = await chrome()
  assert(Math.abs(widened.sidebarTrack.width - (expandedWidth + 130)) < 2, `the resized sidebar did not commit (${widened.sidebarTrack.width})`)
  assertPinned(widened, expanded, 'resized')
  // A sidebar that is wider than the pinned controls but not at its default width is the
  // third state the controls have to survive: the drag band is under them and the top bar
  // starts past their right edge.
  const resizedNative = await assertNativeChrome(widened, 'resized')

  // The top edge is still grabbable where the controls are not: a real drag on the
  // band over the sidebar moves the native window by exactly the requested amount.
  const bandDrag = await dragTopEdge(Math.round(expandedWidth - 40), 24, 12)
  assert.deepEqual(bandDrag.delta, bandDrag.requested, 'the drag surface over the sidebar no longer moves the window')
  await shotCorner('corner-dragged')

  // Restore the sidebar the drag widened, through the same real interaction.
  const settledSeam = await client.evaluate(`(() => { const r = document.querySelector('.sidebar-resizer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: settledSeam.x, y: settledSeam.y, button: 'left', clickCount: 1 })
  await delay(80)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: settledSeam.x - 130, y: settledSeam.y, button: 'left', buttons: 1 })
  await delay(160)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: settledSeam.x - 130, y: settledSeam.y, button: 'left', clickCount: 1 })
  await delay(700)
  const restoredSidebar = await chrome()
  assert(Math.abs(restoredSidebar.sidebarTrack.width - expandedWidth) < 2, `the sidebar width was not restored (${restoredSidebar.sidebarTrack.width})`)
  assertPinned(restoredSidebar, expanded, 'sidebar width restored')
  results.push({
    name: 'pinned-window-chrome',
    status: 'passed',
    controls: expanded.controls,
    toggle: expanded.toggle,
    back: expanded.back,
    forward: expanded.forward,
    collapsedControls: collapsed.controls,
    midResize,
    sidebarTrack: { expanded: expandedWidth, collapsed: collapsed.sidebarTrack.width, widened: widened.sidebarTrack.width },
    dragTiling: { expanded: expanded.surfaces, collapsed: collapsed.surfaces },
    controlTops: { expanded: expanded.controlTops, collapsed: collapsed.controlTops, resized: widened.controlTops },
    seamHits: { expanded: expanded.seamHits, collapsed: collapsed.seamHits },
    nativeHitTest: { expanded: expandedNative, collapsed: collapsedNative, resized: resizedNative },
    bandDrag,
  })

  // Native fullscreen uses the same layout facts as maximize.
  await main.evaluate('layoutWindow.setFullScreen(true); true')
  await harness.waitFor(async () => (await state()).layout === 'beta', 10_000, 'fullscreen Beta')
  await main.evaluate('layoutWindow.setFullScreen(false); true')
  await harness.waitFor(async () => (await state()).layout === 'chali', 10_000, 'fullscreen restore')
  results.push({ name: 'fullscreen-and-restore', status: 'passed' })

  if (process.argv.includes('--desktop-backdrop')) {
    // A known test window behind LS proves cross-window compositing. Capture only
    // the LS rectangle; no other desktop contents are saved in the artifacts.
    await main.evaluate(`(() => {
      const {BrowserWindow,screen}=layoutElectron; const area=screen.getPrimaryDisplay().workArea;
      globalThis.layoutBackdrop=new BrowserWindow({ ...area, frame:false, show:false, backgroundColor:'#ff2020', skipTaskbar:true });
      layoutBackdrop.showInactive(); layoutWindow.setBounds({x:area.x+50,y:area.y+50,width:1100,height:720});
      layoutWindow.show(); layoutWindow.focus(); return true;
    })()`)
    for (const maximized of [false, true]) {
      await harness.desktopAction(locator, 'maximize', { maximized })
      await delay(800)
      const frames = []
      for (const [label, color] of [['red', '#ff2020'], ['blue', '#2020ff']]) {
        await main.evaluate(`layoutBackdrop.setBackgroundColor('${color}'); layoutWindow.focus(); true`)
        await delay(1000)
        const capture = await main.evaluate(`(async () => {
          const display=layoutElectron.screen.getDisplayMatching(layoutWindow.getBounds());
          const scale=display.scaleFactor;
          const sources=await layoutElectron.desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*scale),height:Math.round(display.size.height*scale)}});
          const source=sources.find(s=>s.display_id===String(display.id));
          const b=layoutWindow.getContentBounds();
          const crop={x:Math.round((b.x-display.bounds.x)*scale),y:Math.round((b.y-display.bounds.y)*scale),width:Math.round(b.width*scale),height:Math.round(b.height*scale)};
          const image=source.thumbnail.crop(crop);
          const mean=(x,y)=>{ const bitmap=image.crop({x:Math.round(x*scale),y:Math.round(y*scale),width:12,height:12}).toBitmap(); const rgb=[0,0,0]; for(let i=0;i<bitmap.length;i+=4){rgb[0]+=bitmap[i+2];rgb[1]+=bitmap[i+1];rgb[2]+=bitmap[i];}return rgb.map(v=>v/(bitmap.length/4));};
          return {png:image.toPNG().toString('base64'), sidebar:mean(18,380), title:mean(650,16), chat:mean(500,380), joinAbove:mean(180,22), joinBelow:mean(180,34), focused:layoutWindow.isFocused()};
        })()`)
        await writeFile(join(root, `${maximized ? 'beta' : 'chali'}-desktop-${label}.png`), Buffer.from(capture.png, 'base64'))
        delete capture.png
        frames.push(capture)
      }
      const delta = key => Math.max(...frames[0][key].map((v,i)=>Math.abs(v-frames[1][key][i])))
      const proof = { name: maximized ? 'beta-backdrop' : 'chali-backdrop', frames, sidebarDelta:delta('sidebar'), titleDelta:delta('title'), chatDelta:delta('chat') }
      results.push(proof)
      assert(proof.sidebarDelta > 8, 'sidebar must respond to the window behind LS')
      assert(proof.chatDelta < 3, 'chat must remain opaque')
      assert(maximized ? proof.titleDelta > 8 : proof.titleDelta < 3, 'only Beta titlebar exposes the desktop backdrop')
      if (maximized) for (const frame of frames) {
        assert(Math.max(...frame.joinAbove.map((v, i) => Math.abs(v - frame.joinBelow[i]))) < 8, 'Beta titlebar/sidebar material must have no seam')
      }
    }
  }
  console.log(JSON.stringify({ root, results, status:'passed' }, null, 2))
} finally {
  await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2))
  await main?.evaluate('if(globalThis.layoutBackdrop) layoutBackdrop.destroy(); true').catch(() => {})
  client?.close(); main?.close()
  if (locator) await harness.desktopAction(locator, 'quit').catch(() => {})
  if (child.exitCode === null) {
    await harness.waitForExit(child, 10_000).catch(() => child.kill())
  }
  await provider.close().catch(() => {})
  console.log(`Evidence: ${root}`)
}
