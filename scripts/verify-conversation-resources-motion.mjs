// Real Renderer acceptance for the chat resources popover: the panel must be
// borderless and must slide out from / retract to the right edge. Isolated data
// root and the local deterministic provider; no user session is read.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness()
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 20, streamChunkCharacters: 60 })
const root = await mkdtemp(join(tmpdir(), 'littlesheep-resources-motion-'))
const dataDir = join(root, 'data')
const workspace = join(dataDir, 'projects', 'resources-motion-workspace')
const report = { checks: [], measurements: {}, screenshots: [] }
let child, client
const record = (name) => { report.checks.push(name); console.log(`PASS ${name}`) }
const evaluate = (source) => client.evaluate(source)
async function wait(source, label) {
  return harness.waitFor(() => evaluate(source), 60_000, label)
}
async function screenshot(name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  const path = join(root, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(path)
  return path
}

// Everything the panel contract needs, sampled in one round trip. `translateX(0)`
// computes as `matrix(1, 0, 0, 1, 0, 0)`, never `none`, so the resting state is
// read as the matrix tx component rather than a keyword.
const panelProbe = `(() => {
  const panel = document.querySelector('.conversation-resources-panel');
  const layer = document.querySelector('.conversation-resources-presence');
  const host = document.querySelector('.conversation-resources');
  const chat = document.querySelector('.chat');
  const messages = document.querySelector('.messages');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } };
  const panelStyle = panel ? getComputedStyle(panel) : null;
  const overflowChain = [];
  for (let el = panel ?? host; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    overflowChain.push({ cls: el.className || el.tagName, x: s.overflowX, y: s.overflowY, display: s.display, position: s.position });
  }
  return {
    exists: !!panel,
    layerExists: !!layer,
    layerClass: layer ? layer.className : null,
    layerAriaHidden: layer ? layer.getAttribute('aria-hidden') : null,
    layerInert: layer ? layer.hasAttribute('inert') : null,
    layerDisplay: layer ? getComputedStyle(layer).display : null,
    layerBox: box(layer),
    panelBox: box(panel),
    hostBox: box(host),
    chatBox: box(chat),
    expandable: document.querySelector('.conversation-resources-toggle')?.getAttribute('aria-expanded') ?? null,
    opacity: panelStyle?.opacity ?? null,
    background: panelStyle?.backgroundColor ?? null,
    backdrop: panelStyle?.backdropFilter ?? null,
    panelTransform: panelStyle?.transform ?? null,
    panelTx: (() => { const v = panelStyle?.transform; if (!v || v === 'none') return 0;
      const m = v.match(/matrix\(([^)]+)\)/u); return m ? Number(m[1].split(',')[4]) : 0 })(),
    transition: panelStyle?.transitionDuration ?? null,
    borderTop: panelStyle?.borderTopWidth ?? null,
    borderRight: panelStyle?.borderRightWidth ?? null,
    borderBottom: panelStyle?.borderBottomWidth ?? null,
    borderLeft: panelStyle?.borderLeftWidth ?? null,
    boxShadow: panelStyle?.boxShadow ?? null,
    overflowX: panelStyle?.overflowX ?? null,
    overflowY: panelStyle?.overflowY ?? null,
    panelScroll: panel ? { sw: panel.scrollWidth, cw: panel.clientWidth, sh: panel.scrollHeight, ch: panel.clientHeight } : null,
    messagesOverflow: messages ? messages.scrollWidth - messages.clientWidth : null,
    documentOverflow: document.documentElement.scrollWidth - innerWidth,
    changesMounted: !!document.querySelector('.conversation-resources-changes'),
    overflowChain,
    // Presence in the DOM is not visibility: an ancestor with overflow: clip
    // can hide the whole panel while every rectangle still looks correct. Hit
    // testing is the honest check — a clipped point resolves to whatever sits
    // behind the panel instead of the panel itself.
    hitTest: (() => {
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const probe = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return { x: Math.round(x), y: Math.round(y), inside: !!el && panel.contains(el),
          hit: el ? (el.className || el.tagName) : null };
      };
      return {
        centre: probe(r.left + r.width / 2, r.top + r.height / 2),
        // The left edge is where a clip on the narrow positioning root truncates
        // first, so sample just inside it as well as a little further in.
        nearLeft: probe(r.left + 4, r.top + r.height / 2),
        innerLeft: probe(r.left + 40, r.top + r.height / 2),
        nearTop: probe(r.left + r.width / 2, r.top + 4),
      };
    })(),
    // Report how much of the panel the viewport actually shows, so a shrunken
    // or fully clipped panel cannot pass as "rendered".
    visibleArea: (() => {
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
      const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
      return { width: Math.max(0, right - left), height: Math.max(0, bottom - top),
        ratio: r.width > 0 && r.height > 0 ? Math.max(0, right - left) * Math.max(0, bottom - top) / (r.width * r.height) : 0 };
    })(),
  };
})()`

const clickToggle = "document.querySelector('.conversation-resources-toggle').click()"
// Sample the transition without letting a single frame go by unseen.
const sampleFrames = (frames) => `(async () => {
  const out = [];
  for (let i = 0; i < ${frames}; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const panel = document.querySelector('.conversation-resources-panel');
    const style = panel ? getComputedStyle(panel) : null;
    const r = panel?.getBoundingClientRect();
    out.push({ i, exists: !!panel, opacity: style ? Number(style.opacity) : null,
      transform: style?.transform ?? null, right: r ? r.right : null, left: r ? r.left : null });
  }
  return out;
})()`

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'fixture.txt'), 'resources motion acceptance')
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'acceptance-key',
      timeoutSeconds: 15, models: ['slow-a'] }],
    agents: { defaults: { workspace, model: 'acceptance/slow-a', harness: 'core-flow' } },
  }))
  const port = await harness.reservePort()
  child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, child.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'resize', { width: 1280, height: 760 })
  await harness.desktopAction(locator, 'show')
  client = await harness.connectRenderer(port)
  await client.send('Page.bringToFront')
  await wait("document.querySelector('.composer textarea') ? true : null", 'composer')
  await harness.waitFor(async () => {
    const readiness = await harness.fetchJson(locator, '/runtime/readiness')
    return readiness?.body?.state === 'ready' ? true : null
  }, 60_000, 'runtime ready')
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  await delay(200)

  // --- closed state -------------------------------------------------------
  const closed = await evaluate(panelProbe)
  assert.equal(closed.exists, false, 'the panel subtree must stay unmounted while closed')
  assert.equal(closed.expandable, 'false')
  assert.equal(closed.changesMounted, false, 'change snapshot must not load while closed')
  report.measurements.closed = closed
  record('closed resources popover keeps its panel subtree unmounted')

  // --- opening ------------------------------------------------------------
  await evaluate(clickToggle)
  const enterFrames = await evaluate(sampleFrames(90))
  const open = await evaluate(panelProbe)
  report.measurements.enterFrames = enterFrames
  report.measurements.open = open
  assert.equal(open.exists, true, 'the panel must exist after opening')
  assert.equal(open.expandable, 'true')
  assert.equal(await evaluate(`document.querySelectorAll('.conversation-resources-heading button').length`),0,'section headings must not show inactive add controls')
  assert.equal(await evaluate(`!!document.querySelector('.conversation-resources-history')`),false,'verbose footer must be removed')
  assert.equal(open.transition,'0.32s','panel should use the slower 320ms slide')
  assert(open.changesMounted, 'the change snapshot mounts with the panel')

  // Borderless and shadowless: no CSS border box, no 1px shadow ring and no drop
  // shadow. The wide dark shadow read as a halo around the panel against the dark
  // transcript, so the translucent glass fill alone marks the float (2026-10-15).
  for (const side of ['borderTop', 'borderRight', 'borderBottom', 'borderLeft']) {
    assert.equal(open[side], '0px', `${side} must be 0px, received ${open[side]}`)
  }
  assert.equal(open.boxShadow, 'none', `the panel must not paint a drop shadow, received ${open.boxShadow}`)
  assert.match(open.backdrop, /blur\(18px\)/u, 'panel must use the shared glass blur')
  assert.match(open.background, /rgba\([^)]*,\s*0\./u, 'glass fill must remain translucent')
  record('panel uses translucent glass with 18px blur and paints no border or shadow')

  // Slide origin: the panel rests flush with its host's right edge. The enter
  // motion is still running when the frames above are sampled, so the resting
  // state is measured only after the transition has had time to settle.
  await delay(600)
  const settledOpen = await evaluate(panelProbe)
  report.measurements.settledOpen = settledOpen
  assert.equal(settledOpen.exists, true, 'the panel must stay mounted after the enter motion settles')
  assert(Math.abs(settledOpen.panelBox.right - settledOpen.hostBox.right) <= 1,
    `open panel must sit flush with the right edge (panel ${settledOpen.panelBox.right} vs host ${settledOpen.hostBox.right})`)
  assert.equal(settledOpen.panelTx, 0, `the open panel must rest at translateX(0), received ${settledOpen.panelTransform}`)
  assert.equal(settledOpen.opacity, '1', `the open panel must be fully opaque, received ${settledOpen.opacity}`)
  record('open panel rests flush with the right edge at translateX(0)')

  // The panel must actually be painted on screen, not merely mounted: an ancestor
  // `overflow: clip` would hide it while every rectangle above still looked right.
  assert(settledOpen.visibleArea.ratio >= 0.99,
    `the open panel must be fully within the viewport, received ${JSON.stringify(settledOpen.visibleArea)}`)
  for (const [where, hit] of Object.entries(settledOpen.hitTest)) {
    assert(hit.inside, `the open panel must be hit-testable at its ${where}, received ${JSON.stringify(hit)}`)
  }
  record('open panel is hit-testable across its surface, so nothing clips it away')

  // The enter motion must be observed, and must travel toward the right edge.
  const entering = enterFrames.filter((frame) => frame.exists)
  assert(entering.length > 2, 'the enter transition must be sampled over multiple frames')
  const firstEnter = entering[0]
  const offsetOf = (frame) => frame.transform && frame.transform !== 'none'
    ? Number(frame.transform.match(/matrix\(([^)]+)\)/u)?.[1].split(',')[4] ?? '0') : 0
  assert(offsetOf(firstEnter) > 1, `the first enter frame must start displaced to the right, received ${firstEnter.transform}`)
  assert(entering.some((frame, i) => i > 0 && Math.abs(offsetOf(frame)) < Math.abs(offsetOf(entering[i - 1]))),
    'the enter motion must converge leftwards to the resting position')
  assert(entering.every(frame => Number(frame.opacity) === 1), 'opening must move the solid panel without fading')
  assert(offsetOf(firstEnter) >= settledOpen.panelBox.width, 'opening must move the entire panel in from outside')
  assert.equal(offsetOf(entering.at(-1)), 0, 'the enter motion must settle at translateX(0)')
  record('opening slides the panel leftwards out of the right edge into its resting position')
  const hoverBox = await evaluate(`(() => {const r=document.querySelector('.conversation-resources-changes > button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await client.send('Input.dispatchMouseEvent', {type:'mouseMoved',...hoverBox})
  const compact = await evaluate(`(() => {const e=document.querySelector('.conversation-resources-changes > button');const s=getComputedStyle(e);return {hover:e.matches(':hover'),radius:parseFloat(s.borderRadius),height:e.getBoundingClientRect().height,padding:getComputedStyle(document.querySelector('.conversation-resources-panel')).paddingTop}})()`)
  assert.equal(compact.hover,true)
  assert(compact.radius>=12,'hover row needs generous rounded corners')
  assert(compact.height<=36,'resource rows should remain compact')
  assert.equal(compact.padding,'12px')
  report.measurements.compact=compact
  record('hover rows have 12px corners and compact height, with reduced panel padding')
  report.measurements.openScreenshot = await screenshot('resources-open')

  // No transient horizontal overflow while the panel is at the right edge.
  assert(open.documentOverflow <= 1, `document must not overflow horizontally, received ${open.documentOverflow}`)
  assert(open.messagesOverflow <= 1, `the transcript must not gain a horizontal scrollbar, received ${open.messagesOverflow}`)
  assert(open.panelScroll.sw <= open.panelScroll.cw + 1, `panel content must not overflow horizontally: ${JSON.stringify(open.panelScroll)}`)
  record('opening creates no horizontal scrollbar in the document, transcript or panel')

  // --- closing ------------------------------------------------------------
  await evaluate("document.querySelector('.conversation-resources-toggle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  const exitFrames = await evaluate(sampleFrames(90))
  // The exit motion is unmount-deferred; wait past the 380ms deadline before
  // asserting removal so the check cannot race the retract.
  await delay(700)
  const afterExit = await evaluate(panelProbe)
  report.measurements.exitFrames = exitFrames
  report.measurements.afterExit = afterExit
  const exiting = exitFrames.filter((frame) => frame.exists)
  assert(exiting.length > 1, 'the exit transition must paint before the subtree unmounts')
  assert(exiting.every(frame => Number(frame.opacity) === 1), 'closing must move the solid panel without fading')
  assert(offsetOf(exiting.at(-1)) >= settledOpen.panelBox.width, 'closing must move the entire panel outside before unmount')
  assert.equal(afterExit.exists, false, 'the panel must be removed after the exit motion settles')
  assert.equal(afterExit.expandable, 'false')
  assert.equal(afterExit.changesMounted, false, 'the change snapshot must unmount after closing')
  assert.equal(await evaluate('document.activeElement.className'), 'conversation-resources-toggle',
    'Escape must return focus to the trigger')
  record('closing retracts the panel to the right edge, then unmounts it and returns focus')
  await screenshot('resources-closed')

  // --- reopen during the exit motion --------------------------------------
  await evaluate(clickToggle)
  await delay(80)
  await evaluate("document.querySelector('.conversation-resources-toggle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await delay(60)
  await evaluate(clickToggle)
  await delay(500)
  const reopened = await evaluate(panelProbe)
  assert.equal(reopened.exists, true, 'reopening during the exit motion must leave exactly one panel')
  assert.equal(reopened.expandable, 'true')
  assert.equal(await evaluate("document.querySelectorAll('.conversation-resources-panel').length"), 1)
  assert.equal(reopened.panelTx, 0, 'the reopened panel must settle at its resting position')
  assert.equal(reopened.opacity, '1')
  record('reopening during the exit motion settles on one open panel')

  // --- narrow chat pane ----------------------------------------------------
  await evaluate("Object.assign(document.querySelector('.chat').style, { width: '320px', maxWidth: '320px', minWidth: '0' })")
  await delay(300)
  const narrow = await evaluate(panelProbe)
  report.measurements.narrow = narrow
  assert(narrow.exists, 'the panel must stay mounted in a narrow pane')
  assert(narrow.panelScroll.sw <= narrow.panelScroll.cw + 1,
    `narrow panel must not overflow horizontally: ${JSON.stringify(narrow.panelScroll)}`)
  assert(narrow.panelBox.left >= narrow.chatBox.left - 1,
    `narrow panel must stay inside the chat pane (panel ${narrow.panelBox.left} vs chat ${narrow.chatBox.left})`)
  assert(Math.abs(narrow.panelBox.right - narrow.hostBox.right) <= 1, 'narrow panel must stay flush with the right edge')
  record('narrow chat pane keeps the panel inside the pane without a horizontal scrollbar')
  await screenshot('resources-narrow')
  await evaluate("document.querySelector('.chat').removeAttribute('style')")
  await delay(250)

  // --- reduced motion (appearance preference, attribute path) --------------
  // The narrow-pane step above leaves the panel open; close it first so the
  // toggle below is a real open transition under the reduced-motion preference.
  const wasOpen = await evaluate("!!document.querySelector('.conversation-resources-panel')")
  if (wasOpen) { await evaluate(clickToggle); await delay(500) }
  await evaluate("document.documentElement.setAttribute('data-ls-reduced-motion', 'true')")
  await delay(100)
  await evaluate(clickToggle)
  const reducedOpenFrames = await evaluate(sampleFrames(3))
  const reduced = await evaluate(panelProbe)
  report.measurements.reducedMotion = { reduced, reducedOpenFrames }
  assert.equal(reduced.exists, true, 'reduced motion must still open the panel')
  assert.equal(reduced.panelTx, 0, 'reduced motion must not leave a residual transform')
  assert.equal(reduced.opacity, '1', `reduced motion must open at full opacity, received ${reduced.opacity}`)
  // Under reduced motion the transition collapses to the theme's 0.01ms, which
  // Chromium reports in seconds as `1e-05s`; compare numerically rather than by text.
  const reducedSeconds = String(reduced.transition).split(',').map((part) => Number.parseFloat(part.trim()))
  assert(reducedSeconds.every((seconds) => Number.isFinite(seconds) && seconds <= 0.001),
    `reduced motion must not tween the panel, received ${reduced.transition}`)
  record('appearance reduced-motion opens the panel at rest with no slide')
  await evaluate("document.documentElement.setAttribute('data-ls-reduced-motion', 'false')")
  const restored = await evaluate(panelProbe)
  assert.equal(restored.panelTx, 0, 'the resting panel stays at translateX(0) when motion returns')
  record('turning motion back on keeps the open panel at its resting position')

  // --- collapsed workspace: the two top-right controls share one row --------
  // Collapsed, the panel's stationary toggle sits on the close line and this control uses the
  // tab row's own gap. It used to keep the 12px the panel's popover reserves below the toggle,
  // so the pair read as two unrelated controls (asked for 2026-10-15).
  if (!await evaluate("document.querySelector('.conversation-resources').dataset.workspaceCollapsed === 'true'")) {
    await evaluate("document.querySelector('.workspace-panel-corner-toggle').click()")
    await wait("document.querySelector('.conversation-resources').dataset.workspaceCollapsed === 'true' ? true : null", 'collapsed resources control')
  }
  await delay(400)
  const collapsedRow = await evaluate(`(() => {
    const resources = document.querySelector('.conversation-resources-toggle').getBoundingClientRect();
    const fold = document.querySelector('.workspace-panel-corner-toggle').getBoundingClientRect();
    return {
      gap: Math.round((fold.left - resources.right) * 100) / 100,
      resourcesRight: Math.round(resources.right),
      foldLeft: Math.round(fold.left),
      collapsed: document.querySelector('.conversation-resources').dataset.workspaceCollapsed,
    };
  })()`)
  report.measurements.collapsedRow = collapsedRow
  assert.equal(collapsedRow.collapsed, 'true')
  assert.equal(collapsedRow.gap, 4,
    `collapsed workspace must space the two controls by 4px, received ${JSON.stringify(collapsedRow)}`)
  record('collapsed workspace spaces the chat and panel controls by the tab row gap')
  await screenshot('resources-collapsed-workspace')

  // The chip that reopens the workspace is the tab row's own plate: translucent frosted glass
  // with no stroke and the tab's corner (asked for 2026-10-15). It used to be an opaque
  // `--control-hover` box inside a `--border-strong` outline. Offered through focus, so the
  // reading does not depend on where the pointer happens to be; a focus-visible wash is fine.
  await evaluate("document.querySelector('.workspace-panel-reopen-target').focus()")
  await wait("document.querySelector('.workspace-panel-reopen-target').classList.contains('reopen-visible') ? true : null", 'the reopen chip to be offered')
  await delay(200)
  const reopenChip = await evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.workspace-panel-reopen-icon'));
    return {
      background: style.backgroundColor,
      border: style.borderTopWidth,
      radius: style.borderRadius,
      blur: style.backdropFilter,
    };
  })()`)
  report.measurements.reopenChip = reopenChip
  assert.equal(reopenChip.border, '0px', `the reopen chip must carry no stroke, received ${JSON.stringify(reopenChip)}`)
  assert.equal(reopenChip.radius, '10px', `the reopen chip must take the tab's corner, received ${reopenChip.radius}`)
  assert.match(reopenChip.blur, /blur\(12px\)/, 'the reopen chip must be frosted glass')
  assert.match(reopenChip.background, /0\.(?:14|22)\)/, `the reopen chip fill must stay translucent, received ${reopenChip.background}`)
  record('reopen workspace chip is borderless translucent glass at the tab row corner')

  report.ok = true
  console.log(JSON.stringify({ ok: true, checks: report.checks, measurements: report.measurements, screenshots: report.screenshots }, null, 2))
} catch (error) {
  console.error('FAIL', error?.stack ?? error)
  console.error(JSON.stringify({ ok: false, checks: report.checks, measurements: report.measurements }, null, 2))
  process.exitCode = 1
} finally {
  try { await client?.close?.() } catch {}
  try { await child?.kill?.() } catch {}
  try { await provider?.close?.() } catch {}
  try { await harness.cleanup?.() } catch {}
}
