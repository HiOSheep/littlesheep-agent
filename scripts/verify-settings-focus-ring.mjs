// Real-window pixel gate for the settings search field's visible focus (audit finding #19).
//
// The defect: `.settings-sidebar-search input:focus { outline: 0 }` turned the app-wide
// `:focus-visible` ring off and put nothing in its place, so a keyboard user tabbing into the
// settings search field had no visible position at all. The audit measured 0 ring pixels and 0 fill
// pixels for that field against 2538 ring pixels for a settings rail row, sampled per Tab stop as
// "focused frame against the same pixels blurred". This gate measures the same way, in the same
// window size, so the numbers stay comparable with that record.
//
// Why pixels and not the computed outline: a resolved `outline` says what the cascade decided, not
// what the user can see. A declaration can resolve to a non-zero outline that is clipped, covered or
// drawn off the element, and an indication can also be a fill. The pixels decide; the computed
// outline is recorded next to them only as a cross-check that the cascade changed the way the source
// says it did.
//
// Keyboard focus is always reached with real key presses (`Input.dispatchKeyEvent`), never by
// calling `element.focus()`: `:focus-visible` is the browser's judgement about how focus arrived,
// and programmatic focus would not exercise it.
//
// The gate has to be able to come out red, so it does not only measure the fixed page. In the same
// window and the same session it runs three measurements of the same field, changing exactly one
// thing between them:
//
//   A  the shipped bundle                                        -> the ring must be there;
//   B  the fix rule deleted from the live CSS object model       -> nothing may be drawn;
//   C  the same rule text re-inserted at the same index          -> the ring must come back.
//
// B is the pre-fix reading. Deleting the rule from the loaded stylesheet leaves exactly the cascade
// the pre-fix build had: the fix commit's only change to this element was adding that one rule (the
// pre-fix file carried `.settings-sidebar-search input:focus { outline: 0 }` and no `:focus-visible`
// rule), and nothing else in the sheet moves. Doing it in one window rather than two removes every
// other variable - build, display, DPI, theme, fixture state - so the delta can only be the rule.
// The rule text is recorded and checked against the source before it is removed, and C proves the
// measurement did not simply drift.
//
// Usage:
//   node scripts/verify-settings-focus-ring.mjs [--out=<dir>] [--keep] [--skip-falsification]
//
// What the mouse half of this gate establishes, and what it does not: the fix is a `:focus-visible`
// rule, so pointer focus draws the field's indication whenever Chromium matches that pseudo-class.
// For a text input Chromium matches it for a pointer click as well, so the ring does appear on
// click; the gate measures a text input that already had a `:focus-visible` rule before the fix
// (`.settings-inline-field input`) and requires the search field to answer the same way, which is
// the claim that can be defended - "this is the app-wide rule, reaching one more field" - rather
// than "nothing changed for the mouse", which the browser's own heuristic does not allow.

import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { inspectAppBuildFreshness } from './lib/app-build-fingerprint.mjs'
import { decodePng, pixelAt } from './lib/png-pixels.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-settings-focus-ring')))
const keepRoot = process.argv.includes('--keep')
const skipFalsification = process.argv.includes('--skip-falsification')
/** Same window as the V3 evidence run, so the ring-pixel counts are directly comparable. */
const WINDOW = { width: 1280, height: 840 }
const EVALUATE_TIMEOUT_MS = 20_000
/** A channel difference at or below this is compression/precision noise, not an indication. */
const PIXEL_THRESHOLD = 6
/** The rail row is the positive control: the audit measured 2538 ring pixels for it. */
const RAIL_CONTROL_MINIMUM_RING_PIXELS = 1_000
/** How far a real Tab walk may travel before a control counts as unreachable. */
const MAX_TAB_STEPS = 80
const SEARCH_SELECTOR = '.settings-sidebar-search input'
const RAIL_SELECTOR = '.settings-nav-item'
/**
 * A text input that already carried a `:focus-visible` rule before this fix, used as the control
 * for "what does a pointer click do to a text input in this app". The second field is 显示名称; the
 * first is the provider id, which is disabled while editing an existing provider and so cannot take
 * focus at all.
 */
const CONTROL_SELECTOR = '.provider-editor-body > .settings-inline-field:nth-child(2) input'
const FIX_RULE_SELECTOR = '.settings-sidebar-search input:focus-visible'
/**
 * Repeats per measurement. A focused text field blinks a caret, which lands inside the element's own
 * box and would otherwise be read as a focus fill; the ring is unaffected by it. Taking the extreme
 * over repeats keeps both numbers honest instead of depending on the blink phase at capture time.
 */
const REPEATS = 3

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

const evaluate = (client, expression) => withTimeout(client.evaluate(expression), EVALUATE_TIMEOUT_MS, 'Runtime.evaluate')

async function rawShot(client) {
  await client.send('Page.bringToFront').catch(() => undefined)
  return withTimeout(
    client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    15_000,
    'Page.captureScreenshot',
  )
}

async function capture(client) {
  return decodePng(Buffer.from((await rawShot(client)).data, 'base64'))
}

async function saveShot(client, name) {
  await mkdir(join(outRoot, 'screenshots'), { recursive: true })
  const shot = await rawShot(client)
  const path = join(outRoot, 'screenshots', `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
}

/** Force compositor frames: an off-screen acceptance window only advances transitions while it paints. */
async function settlePaint(client, frames = 3) {
  for (let frame = 0; frame < frames; frame += 1) {
    await capture(client).catch(() => undefined)
    await delay(180)
  }
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Focus Ring Acceptance Provider', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 10, models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/slow-a',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
  }
}

/** Which bundle is on disk, read from the stylesheet rather than inferred from the manifest. */
async function inspectBuiltStylesheet() {
  const assetsDir = join(repoRoot, 'packages', 'app', 'out', 'renderer', 'assets')
  const entries = await readdir(assetsDir)
  const stylesheets = entries.filter((name) => name.endsWith('.css'))
  const carrying = []
  for (const name of stylesheets) {
    const contents = await readFile(join(assetsDir, name), 'utf8')
    if (!contents.includes('.settings-sidebar-search')) continue
    carrying.push({
      name,
      hasFixRule: contents.includes(FIX_RULE_SELECTOR),
      hasPreFixFocusReset: contents.includes('.settings-sidebar-search input:focus'),
    })
  }
  return {
    stylesheetCount: stylesheets.length,
    carrying,
    hasFixRule: carrying.some((entry) => entry.hasFixRule),
  }
}

/** Real key press through CDP, so the renderer runs its own default action and focus heuristic. */
async function pressTab(client) {
  const base = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 0 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await delay(120)
}

async function pressEnter(client) {
  const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r', unmodifiedText: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await delay(200)
}

const FOCUS_STATE = `(() => {
  const node = document.activeElement;
  if (!(node instanceof HTMLElement)) return { isBody: true };
  return {
    isBody: node === document.body || node === document.documentElement,
    tag: node.tagName,
    className: typeof node.className === 'string' ? node.className : '',
    matchesSearch: node.matches(${JSON.stringify(SEARCH_SELECTOR)}),
    matchesRail: node.matches(${JSON.stringify(RAIL_SELECTOR)}),
    matchesSettingsEntry: node.matches('.settings-entry-btn'),
    focusVisible: node.matches(':focus-visible'),
  };
})()`

const OUTLINE_STATE = `(() => {
  const node = document.querySelector(${JSON.stringify(SEARCH_SELECTOR)});
  if (!(node instanceof HTMLElement)) return null;
  const style = getComputedStyle(node);
  return {
    focused: document.activeElement === node,
    focusVisible: node.matches(':focus-visible'),
    outlineWidth: style.outlineWidth,
    outlineStyle: style.outlineStyle,
    outlineColor: style.outlineColor,
    outlineOffset: style.outlineOffset,
  };
})()`

/**
 * Delete exactly the fix rule from the live CSS object model. This is the pre-fix cascade with no
 * equivalence argument: the pre-fix stylesheet is this stylesheet without that one rule.
 */
const DELETE_FIX_RULE = `(() => {
  const selector = ${JSON.stringify(FIX_RULE_SELECTOR)};
  const walk = (rules, sheet) => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      if (rule.selectorText === selector) return { sheet, index, text: rule.cssText };
      const nested = rule.cssRules;
      if (nested && nested.length > 0) {
        const found = walk(nested, sheet);
        if (found) return found;
      }
    }
    return null;
  };
  let scanned = 0;
  let unreadable = 0;
  for (const sheet of document.styleSheets) {
    let rules = null;
    try { rules = sheet.cssRules; } catch { unreadable += 1; continue; }
    if (!rules) continue;
    scanned += rules.length;
    const found = walk(rules, sheet);
    if (found) {
      window.__lsFocusRingRule = { sheet: found.sheet, index: found.index, text: found.text };
      found.sheet.deleteRule(found.index);
      return { deleted: true, text: found.text, index: found.index, href: found.sheet.href ?? null, scanned, unreadable };
    }
  }
  return { deleted: false, text: null, index: null, href: null, scanned, unreadable };
})()`

const RESTORE_FIX_RULE = `(() => {
  const saved = window.__lsFocusRingRule;
  if (!saved) return { restored: false, reason: 'nothing was deleted' };
  saved.sheet.insertRule(saved.text, saved.index);
  const check = [...saved.sheet.cssRules].filter((rule) => rule.selectorText === ${JSON.stringify(FIX_RULE_SELECTOR)});
  return { restored: check.length === 1, text: saved.text, index: saved.index, matches: check.length };
})()`

/** Real pointer click at the centre of a selector, the way a mouse user focuses a field. */
async function clickSelector(client, selector) {
  const point = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (!point) return null
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await delay(250)
  return point
}

function pixelBox(rect, scale, image, pad) {
  return {
    x0: Math.max(0, Math.floor((rect.x - pad) * scale)),
    y0: Math.max(0, Math.floor((rect.y - pad) * scale)),
    x1: Math.min(image.width, Math.ceil((rect.x + rect.w + pad) * scale)),
    y1: Math.min(image.height, Math.ceil((rect.y + rect.h + pad) * scale)),
  }
}

function diffRegion(before, after, box) {
  const changed = []
  let maxDiff = 0
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const a = pixelAt(before, x, y)
      const b = pixelAt(after, x, y)
      const difference = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
      if (difference > maxDiff) maxDiff = difference
      if (difference >= PIXEL_THRESHOLD) changed.push({ x, y, difference, color: b })
    }
  }
  return { changed, maxDiff }
}

function colourSummary(changed) {
  const counts = new Map()
  for (const entry of changed) {
    const key = `#${[entry.color[0], entry.color[1], entry.color[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4)
    .map(([color, count]) => ({ color, count }))
}

/** One focused-frame / blurred-frame pair, classified into ring (outside the box) and fill. */
async function measureOnce(client, selector) {
  const viewport = await evaluate(client, `(() => ({ width: window.innerWidth, height: window.innerHeight }))()`)
  const rect = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  })()`)
  if (!rect) throw new Error(`${selector} is not on screen`)
  await delay(120)
  const focused = await capture(client)
  const focusVisible = await evaluate(client, `Boolean(document.activeElement?.matches?.(':focus-visible'))`)
  // Blurring the focused element (rather than focusing another one) keeps the layout identical and
  // leaves no other focus indication in the frame, so every changed pixel belongs to this element.
  await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
  await delay(220)
  const blurred = await capture(client)
  const scale = focused.width / viewport.width
  const box = pixelBox(rect, scale, focused, 8)
  const diff = diffRegion(blurred, focused, box)
  const inner = {
    x0: Math.round(rect.x * scale),
    y0: Math.round(rect.y * scale),
    x1: Math.round((rect.x + rect.w) * scale),
    y1: Math.round((rect.y + rect.h) * scale),
  }
  const isOutside = (pixel) => pixel.x < inner.x0 || pixel.x >= inner.x1 || pixel.y < inner.y0 || pixel.y >= inner.y1
  const outside = diff.changed.filter(isOutside)
  const inside = diff.changed.filter((pixel) => !isOutside(pixel))
  return {
    focusVisible,
    ringPixels: outside.length,
    fillPixels: inside.length,
    maxDiff: diff.maxDiff,
    sides: {
      left: outside.filter((pixel) => pixel.x < inner.x0).length,
      right: outside.filter((pixel) => pixel.x >= inner.x1).length,
      top: outside.filter((pixel) => pixel.y < inner.y0).length,
      bottom: outside.filter((pixel) => pixel.y >= inner.y1).length,
    },
    ringColors: colourSummary(outside),
    frames: { focused, blurred },
    rect,
    scale: Math.round(scale * 1000) / 1000,
  }
}

/**
 * Tab from a cleared focus until the target matches. Returns the whole stop trace so "it was reached
 * with real keys" is checkable, not just asserted.
 */
async function tabTo(client, matcher, { steps = MAX_TAB_STEPS } = {}) {
  await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
  await delay(150)
  const trace = []
  for (let step = 1; step <= steps; step += 1) {
    await pressTab(client)
    const state = await evaluate(client, FOCUS_STATE)
    trace.push({ step, ...state })
    if (state[matcher] === true) return { reached: true, steps: step, trace, focusVisible: state.focusVisible === true }
  }
  return { reached: false, steps, trace, focusVisible: false }
}

/** Tab to the control, then measure it over `repeats` pairs so a blinking caret cannot decide a result. */
async function measureByKeyboard(client, selector, matcher, { shotName = null, outline = false, repeats = REPEATS } = {}) {
  const walk = await tabTo(client, matcher)
  if (!walk.reached) return { walk, measured: null }
  const outlineBefore = outline ? await evaluate(client, OUTLINE_STATE) : null
  const runs = []
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    runs.push(await measureOnce(client, selector))
    // measureOnce blurs the element; walking again re-enters it with a real Tab press.
    if (attempt < repeats - 1) {
      const again = await tabTo(client, matcher)
      if (!again.reached) return { walk, measured: null, runs, reentryFailedAt: attempt + 1 }
    }
  }
  const shots = {}
  if (shotName) {
    await tabTo(client, matcher)
    shots.focused = await saveShot(client, `${shotName}-focused`)
    await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
    await delay(220)
    shots.blurred = await saveShot(client, `${shotName}-blurred`)
  }
  return {
    walk,
    outlineBefore,
    runs: runs.map(({ frames, ...rest }) => rest),
    ringPixels: { min: Math.min(...runs.map((run) => run.ringPixels)), max: Math.max(...runs.map((run) => run.ringPixels)) },
    fillPixels: { min: Math.min(...runs.map((run) => run.fillPixels)), max: Math.max(...runs.map((run) => run.fillPixels)) },
    focusVisible: runs.every((run) => run.focusVisible),
    sides: runs.map((run) => run.sides),
    ringColors: runs.map((run) => run.ringColors),
    shots,
    measured: runs[0],
  }
}

/** Focus the control with a real pointer click, then measure it the same way. */
async function measureByClick(client, selector, { shotName = null } = {}) {
  const clickPoint = await clickSelector(client, selector)
  if (!clickPoint) return { clickPoint: null, measured: null }
  const runs = []
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    if (attempt > 0) {
      await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
      await delay(150)
      await clickSelector(client, selector)
    }
    runs.push(await measureOnce(client, selector))
  }
  const shots = {}
  if (shotName) {
    await clickSelector(client, selector)
    shots.focused = await saveShot(client, `${shotName}-focused`)
    await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
    await delay(220)
    shots.blurred = await saveShot(client, `${shotName}-blurred`)
  }
  return {
    clickPoint,
    // Read from the runs: `measureOnce` blurs the element when it finishes, so asking the page
    // afterwards would always answer false.
    focusVisible: runs.every((run) => run.focusVisible),
    focusVisiblePerRun: runs.map((run) => run.focusVisible),
    runs: runs.map(({ frames, ...rest }) => rest),
    ringPixels: { min: Math.min(...runs.map((run) => run.ringPixels)), max: Math.max(...runs.map((run) => run.ringPixels)) },
    fillPixels: { min: Math.min(...runs.map((run) => run.fillPixels)), max: Math.max(...runs.map((run) => run.fillPixels)) },
    shots,
    measured: runs[0],
  }
}

/**
 * Targeted freshness for a stylesheet question.
 *
 * The whole-app input digest moves whenever any workspace source is touched, and this checkout is
 * edited by more than one agent at a time, so requiring it can fail a correct measurement because
 * an unrelated file was saved a second earlier. What this gate actually needs is narrower: the
 * built stylesheet must be newer than the source stylesheets that can change this control's focus
 * appearance. That set is derived from content rather than listed by hand - a file that names the
 * search field, or that declares the app-wide `input:focus-visible` ring the fix reuses, is in it -
 * so adding a rule elsewhere keeps the check honest without keeping it fragile. A structurally
 * stale bundle cannot slip through either: the Tab walk still has to reach both controls, and the
 * built CSS still has to carry the fix rule.
 */
async function inspectStylesheetFreshness(carryingNames) {
  const stylesDir = join(repoRoot, 'packages', 'app', 'src', 'renderer', 'styles')
  const assetsDir = join(repoRoot, 'packages', 'app', 'out', 'renderer', 'assets')
  const sourceNames = (await readdir(stylesDir)).filter((name) => name.endsWith('.css'))
  const relevant = []
  for (const name of sourceNames) {
    const contents = await readFile(join(stylesDir, name), 'utf8')
    if (contents.includes('.settings-sidebar-search') || contents.includes('input:focus-visible')) {
      relevant.push({ name, mtimeMs: (await stat(join(stylesDir, name))).mtimeMs })
    }
  }
  const built = await Promise.all(carryingNames.map(async (name) => ({
    name, mtimeMs: (await stat(join(assetsDir, name))).mtimeMs,
  })))
  const newestSource = relevant.reduce((left, right) => (left.mtimeMs >= right.mtimeMs ? left : right))
  const oldestBuilt = built.reduce((left, right) => (left.mtimeMs <= right.mtimeMs ? left : right))
  return {
    relevantSources: relevant.map((entry) => ({ name: entry.name, at: new Date(entry.mtimeMs).toISOString() })),
    newestSource: { name: newestSource.name, at: new Date(newestSource.mtimeMs).toISOString() },
    oldestBuilt: { name: oldestBuilt.name, at: new Date(oldestBuilt.mtimeMs).toISOString() },
    stylesheetIsNewerThanSources: oldestBuilt.mtimeMs >= newestSource.mtimeMs,
  }
}

async function main() {
  const freshness = await inspectAppBuildFreshness(repoRoot).catch((error) => ({
    fresh: false, reason: 'inspection-failed', detail: error instanceof Error ? error.message : String(error),
  }))
  const bundle = await inspectBuiltStylesheet()
  if (!bundle.hasFixRule) {
    throw new Error(`the built stylesheet does not carry ${FIX_RULE_SELECTOR}: ${JSON.stringify(bundle.carrying)}`)
  }
  const styleFreshness = await inspectStylesheetFreshness(bundle.carrying.map((entry) => entry.name))
  if (!freshness.fresh && !styleFreshness.stylesheetIsNewerThanSources) {
    throw new Error(`App build artifacts are stale (${freshness.reason}) and the built stylesheet is older than its sources: ${JSON.stringify(styleFreshness)}`)
  }

  const root = await mkdtemp(join(tmpdir(), 'littlesheep-settings-focus-ring-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
    await harness.desktopAction(locator, 'park-offscreen')
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // --- open settings, keyboard first -----------------------------------------------------
    // The app focuses the composer when the shell becomes ready, so a plain `focus()` on the
    // settings entry can be undone before the Enter arrives. Walk to the entry with real Tab
    // presses instead, and only fall back to a programmatic focus (which is still followed by a
    // real Enter) or a pointer click if that walk does not find it. Which path opened the panel is
    // recorded: the measurement that matters is that the *field* is entered with real keys.
    const entryReachable = await tabTo(client, 'matchesSettingsEntry', { steps: 60 })
    let openedBy = null
    if (entryReachable.reached) {
      await pressEnter(client)
      openedBy = 'tab-then-enter'
    } else {
      const refocused = await evaluate(client, `(() => {
        const node = document.querySelector('.settings-entry-btn');
        if (!(node instanceof HTMLElement)) return false;
        node.focus();
        return document.activeElement === node;
      })()`)
      if (refocused) {
        await pressEnter(client)
        openedBy = 'focus-then-enter'
      }
    }
    const fieldAppeared = await harness.waitFor(
      () => evaluate(client, `document.querySelector(${JSON.stringify(SEARCH_SELECTOR)}) instanceof HTMLInputElement || null`),
      8_000,
      'the settings search field',
    ).then(() => true, () => false)
    if (!fieldAppeared) {
      // Last resort, and recorded: a real pointer press on the entry. The keyboard requirement
      // under test is how the field itself is entered, and that stays a real Tab walk.
      await clickSelector(client, '.settings-entry-btn')
      await harness.waitFor(
        () => evaluate(client, `document.querySelector(${JSON.stringify(SEARCH_SELECTOR)}) instanceof HTMLInputElement || null`),
        harness.startTimeoutMs,
        `the settings search field (opened by ${openedBy ?? 'nothing'})`,
      )
      openedBy = 'pointer-fallback'
    }
    await settlePaint(client, 3)
    const openedDiagnostics = await evaluate(client, `(() => ({
      navItems: document.querySelectorAll('.settings-nav-item').length,
      presenceClass: document.querySelector('.settings-presence')?.className ?? null,
    }))()`)

    // --- positive control: a settings rail row, measured by the same code -----------------------
    // One run only: the rail is a scrolling container, and repeatedly Tab-walking into it can move
    // its scroll position between the focused and blurred frames, which shows up as a large diff
    // that has nothing to do with the focus ring. The control's single job is to prove the method
    // can see an indication at all, and one run reproduces the audit's own 2538 exactly.
    const rail = await measureByKeyboard(client, RAIL_SELECTOR, 'matchesRail', { shotName: 'rail-keyboard', repeats: 1 })

    // --- A. the shipped bundle -----------------------------------------------------------------
    const fixedKeyboard = await measureByKeyboard(client, SEARCH_SELECTOR, 'matchesSearch', {
      shotName: 'search-keyboard', outline: true,
    })

    // --- mouse appearance of the shipped bundle ------------------------------------------------
    const fixedMouse = await measureByClick(client, SEARCH_SELECTOR, { shotName: 'search-mouse' })
    const fixedMouseOutline = await evaluate(client, OUTLINE_STATE)

    // --- B. the same page with the fix rule deleted from the live stylesheet --------------------
    let deletion = null
    let falsifiedKeyboard = null
    let falsifiedMouse = null
    let restoration = null
    let restoredKeyboard = null
    let restoredOutline = null
    if (!skipFalsification) {
      deletion = await evaluate(client, DELETE_FIX_RULE)
      if (deletion.deleted) {
        await delay(200)
        // Take focus away before measuring, so the first Tab into the field is a real keyboard entry.
        await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
        falsifiedKeyboard = await measureByKeyboard(client, SEARCH_SELECTOR, 'matchesSearch', {
          shotName: 'search-keyboard-rule-deleted', outline: true,
        })
        falsifiedMouse = await measureByClick(client, SEARCH_SELECTOR, { shotName: 'search-mouse-rule-deleted' })
        restoration = await evaluate(client, RESTORE_FIX_RULE)
        await delay(200)
        await evaluate(client, `(() => { document.activeElement?.blur?.(); return true })()`)
        restoredKeyboard = await measureByKeyboard(client, SEARCH_SELECTOR, 'matchesSearch', { outline: true })
        restoredOutline = await evaluate(client, OUTLINE_STATE)
      }
    }

    // --- control: a text input that already drew a focus ring before this fix -------------------
    // `.settings-inline-field input:focus-visible` predates the fix and is untouched by it, so it
    // answers what a pointer click already did to a text input in this app. Without that control,
    // "a click rings the settings search field" could be read as something this fix introduced
    // rather than as the app-wide rule reaching one more field. Measured last, because it leaves
    // the settings sidebar behind.
    let controlMouse = null
    let controlOutline = null
    let controlDiagnostics = null
    const controlOpened = await harness.waitFor(() => evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.settings-nav-item')]
        .find((node) => node.textContent?.includes('模型供应商'));
      if (!(item instanceof HTMLElement)) return null;
      item.click();
      return true;
    })()`), 20_000, 'the 模型供应商 settings page').then(() => true, () => false)
    if (controlOpened) {
      const editorOpened = await harness.waitFor(() => evaluate(client, `(() => {
        if (document.querySelector('.provider-editor')) return true;
        const entry = document.querySelector('.provider-card .save-btn');
        if (!(entry instanceof HTMLElement)) return null;
        entry.click();
        return true;
      })()`), 25_000, 'the provider editor').then(() => true, () => false)
      if (editorOpened) {
        await delay(300)
        controlOutline = await evaluate(client, `(() => {
          const node = document.querySelector(${JSON.stringify(CONTROL_SELECTOR)});
          if (!(node instanceof HTMLElement)) return null;
          node.focus();
          const style = getComputedStyle(node);
          const focused = {
            outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor,
            focusVisible: node.matches(':focus-visible'),
          };
          node.blur();
          return focused;
        })()`)
        controlMouse = await measureByClick(client, CONTROL_SELECTOR, { shotName: 'control-input-mouse' })
      } else {
        controlDiagnostics = await evaluate(client, `(() => ({
          editor: Boolean(document.querySelector('.provider-editor')),
          cards: document.querySelectorAll('.provider-card').length,
          editEntries: document.querySelectorAll('.provider-card .save-btn').length,
        }))()`)
      }
    }

    const results = {
      freshness: { fresh: freshness.fresh, reason: freshness.reason },
      styleFreshness,
      bundle,
      window: WINDOW,
      pixelThreshold: PIXEL_THRESHOLD,
      repeats: REPEATS,
      openedBy,
      openedDiagnostics,
      railControl: { ringPixels: rail.ringPixels, fillPixels: rail.fillPixels, walk: { reached: rail.walk.reached, steps: rail.walk.steps }, runs: rail.runs, shots: rail.shots },
      fixedKeyboard: {
        ringPixels: fixedKeyboard.ringPixels, fillPixels: fixedKeyboard.fillPixels,
        focusVisible: fixedKeyboard.focusVisible, outline: fixedKeyboard.outlineBefore,
        walk: { reached: fixedKeyboard.walk.reached, steps: fixedKeyboard.walk.steps, trace: fixedKeyboard.walk.trace },
        runs: fixedKeyboard.runs, sides: fixedKeyboard.sides, ringColors: fixedKeyboard.ringColors, shots: fixedKeyboard.shots,
      },
      fixedMouse: {
        ringPixels: fixedMouse.ringPixels, fillPixels: fixedMouse.fillPixels,
        focusVisible: fixedMouse.focusVisible, focusVisiblePerRun: fixedMouse.focusVisiblePerRun,
        outlineAfterClick: fixedMouseOutline, runs: fixedMouse.runs, shots: fixedMouse.shots,
      },
      control: {
        selector: CONTROL_SELECTOR,
        opened: controlOpened,
        diagnostics: controlDiagnostics,
        focusedOutline: controlOutline,
        mouse: controlMouse && {
          ringPixels: controlMouse.ringPixels, fillPixels: controlMouse.fillPixels,
          focusVisible: controlMouse.focusVisible, focusVisiblePerRun: controlMouse.focusVisiblePerRun,
          runs: controlMouse.runs, shots: controlMouse.shots,
        },
      },
      falsification: skipFalsification ? { skipped: true } : {
        deletion,
        keyboard: falsifiedKeyboard && {
          ringPixels: falsifiedKeyboard.ringPixels, fillPixels: falsifiedKeyboard.fillPixels,
          focusVisible: falsifiedKeyboard.focusVisible, outline: falsifiedKeyboard.outlineBefore,
          walk: { reached: falsifiedKeyboard.walk.reached, steps: falsifiedKeyboard.walk.steps },
          runs: falsifiedKeyboard.runs, sides: falsifiedKeyboard.sides, ringColors: falsifiedKeyboard.ringColors,
          shots: falsifiedKeyboard.shots,
        },
        mouse: falsifiedMouse && {
          ringPixels: falsifiedMouse.ringPixels, fillPixels: falsifiedMouse.fillPixels,
          focusVisible: falsifiedMouse.focusVisible, runs: falsifiedMouse.runs, shots: falsifiedMouse.shots,
        },
        restoration,
        restoredKeyboard: restoredKeyboard && {
          ringPixels: restoredKeyboard.ringPixels, fillPixels: restoredKeyboard.fillPixels,
          focusVisible: restoredKeyboard.focusVisible, runs: restoredKeyboard.runs,
        },
        restoredOutline,
      },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    expect(styleFreshness.stylesheetIsNewerThanSources === true,
      `the built stylesheet predates a source stylesheet: ${JSON.stringify(styleFreshness)}`)
    expect(openedBy !== null, `the settings panel could not be opened: ${JSON.stringify(openedDiagnostics)}`)
    // The measurement has to be able to see a focus indication in this window at all.
    expect(rail.walk.reached === true, `a settings rail row was not reachable with ${MAX_TAB_STEPS} real Tab presses`)
    expect((rail.ringPixels?.max ?? 0) >= RAIL_CONTROL_MINIMUM_RING_PIXELS,
      `the rail-row positive control drew ${rail.ringPixels?.max ?? 'no'} ring pixels, so a zero elsewhere would prove nothing`)
    // A. the fix: keyboard focus shows the app-wide ring, drawn outside the field's own box.
    expect(fixedKeyboard.walk.reached === true,
      `the settings search field was not reachable with ${MAX_TAB_STEPS} real Tab presses: ${JSON.stringify(fixedKeyboard.walk.trace.map((stop) => stop.className || stop.tag))}`)
    expect(fixedKeyboard.focusVisible === true, 'the search field was entered by a real Tab press but reported :focus-visible false')
    expect((fixedKeyboard.ringPixels?.min ?? 0) > 0,
      `the fixed build drew ${fixedKeyboard.ringPixels?.min ?? 'no'} ring pixels for keyboard focus`)
    expect(fixedKeyboard.outlineBefore?.outlineStyle === 'solid' && fixedKeyboard.outlineBefore?.outlineWidth === '2px',
      `the focused field resolved to ${JSON.stringify(fixedKeyboard.outlineBefore)}`)
    // Whatever Chromium decides for a pointer click on a text field, the drawn indication has to
    // follow `:focus-visible` exactly: it appears when the pseudo-class matches and not otherwise.
    // That is stated as the rule the stylesheet uses, not as a guess about the browser's answer.
    expect(fixedMouse.focusVisible === ((fixedMouse.measured?.ringPixels ?? 0) > 0 || (fixedMouse.measured?.fillPixels ?? 0) > 0),
      `the click indication ${JSON.stringify({ ring: fixedMouse.ringPixels, fill: fixedMouse.fillPixels })} does not follow :focus-visible (${fixedMouse.focusVisible})`)
    // And it has to be the app-wide answer, not a new one: a text input that already had a
    // `:focus-visible` rule before this fix must behave the same way under the same click.
    expect(controlOpened === true && controlMouse !== null,
      `the control text input could not be measured: ${JSON.stringify({ controlOpened, controlDiagnostics })}`)
    expect(controlMouse !== null && controlMouse.focusVisible === (fixedMouse.focusVisible === true),
      `the control input reported :focus-visible ${controlMouse?.focusVisible} while the search field reported ${fixedMouse.focusVisible}`)
    expect(controlMouse !== null && ((controlMouse.ringPixels?.max ?? 0) > 0) === ((fixedMouse.ringPixels?.max ?? 0) > 0),
      `a click rings the control input ${JSON.stringify(controlMouse?.ringPixels)} but the search field ${JSON.stringify(fixedMouse.ringPixels)}`)
    if (!skipFalsification) {
      // B. the pre-fix reading: with the rule gone, keyboard focus draws nothing at all.
      expect(deletion?.deleted === true, `the fix rule could not be removed from the live stylesheet: ${JSON.stringify(deletion)}`)
      expect((deletion?.text ?? '').includes('rgba(226, 226, 226, 0.32)') && (deletion?.text ?? '').includes('outline-offset: 2px'),
        `the deleted rule is not the committed fix rule: ${JSON.stringify(deletion?.text)}`)
      expect(falsifiedKeyboard !== null && falsifiedKeyboard.walk.reached === true,
        'the search field was not reachable with real Tab presses after the rule was deleted')
      expect((falsifiedKeyboard?.ringPixels?.max ?? -1) === 0,
        `with the fix rule deleted the field still drew ${falsifiedKeyboard?.ringPixels?.max} ring pixels`)
      expect((falsifiedKeyboard?.ringPixels?.max ?? -1) === 0,
        `with the fix rule deleted the field still drew ${falsifiedKeyboard?.ringPixels?.max} ring pixels`)
      // Fill pixels are not a focus indication here: a focused text field paints a caret *inside*
      // its own box, so the two states have to show the same caret and differ only outside the box.
      // (The audit recorded 0 fill pixels for this field; in this window the caret is painted
      // steadily at a small, constant size, so the honest claim is equality, not zero.)
      expect(falsifiedKeyboard?.fillPixels?.max === fixedKeyboard.fillPixels?.max,
        `deleting the fix rule changed fill pixels from ${fixedKeyboard.fillPixels?.max} to ${falsifiedKeyboard?.fillPixels?.max}, so the fill is not just the caret`)
      expect((falsifiedKeyboard?.fillPixels?.max ?? 1e9) <= 128,
        `the residual fill is ${falsifiedKeyboard?.fillPixels?.max} pixels, too large to be a caret`)
      expect(falsifiedKeyboard?.outlineBefore?.outlineStyle === 'none' && falsifiedKeyboard?.outlineBefore?.outlineWidth === '0px',
        `with the fix rule deleted the focused field resolved to ${JSON.stringify(falsifiedKeyboard?.outlineBefore)}`)
      // C. putting the same rule back has to bring the same ring back.
      expect(restoration?.restored === true, `the fix rule was not restored: ${JSON.stringify(restoration)}`)
      expect(restoredKeyboard?.ringPixels?.min === fixedKeyboard.ringPixels?.min && restoredKeyboard?.ringPixels?.max === fixedKeyboard.ringPixels?.max,
        `restoring the rule gave ${JSON.stringify(restoredKeyboard?.ringPixels)} against ${JSON.stringify(fixedKeyboard.ringPixels)} before it was removed`)
      // The mouse reading is recorded before and after the rule is removed. It is deliberately
      // reported rather than asserted to be unchanged: `:focus-visible` is Chromium's judgement,
      // and a text input is one of the cases it can match for a pointer click too.
      results.mouseAppearanceUnchangedByFix =
        JSON.stringify(fixedMouse.ringPixels) === JSON.stringify(falsifiedMouse?.ringPixels)
        && JSON.stringify(fixedMouse.fillPixels) === JSON.stringify(falsifiedMouse?.fillPixels)
    }

    await mkdir(outRoot, { recursive: true })
    await writeFile(join(outRoot, 'settings-focus-ring.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')

    if (failures.length > 0) {
      throw new Error(`settings focus ring acceptance failed: ${JSON.stringify({ failures })}`)
    }
    console.log(JSON.stringify({
      check: 'settings-focus-ring',
      ok: true,
      summary: {
        openedBy,
        appBuildFresh: freshness.fresh,
        stylesheetFresh: styleFreshness.stylesheetIsNewerThanSources,
        railRingPixels: rail.ringPixels,
        fixedKeyboardRingPixels: fixedKeyboard.ringPixels,
        fixedKeyboardFillPixels: fixedKeyboard.fillPixels,
        fixedKeyboardOutline: fixedKeyboard.outlineBefore,
        falsifiedKeyboardRingPixels: results.falsification.keyboard?.ringPixels ?? null,
        falsifiedKeyboardFillPixels: results.falsification.keyboard?.fillPixels ?? null,
        falsifiedKeyboardOutline: results.falsification.keyboard?.outline ?? null,
        restoredKeyboardRingPixels: results.falsification.restoredKeyboard?.ringPixels ?? null,
        mouseFocused: { ring: fixedMouse.ringPixels, fill: fixedMouse.fillPixels, focusVisible: fixedMouse.focusVisible },
        mouseRuleDeleted: results.falsification.mouse ? { ring: results.falsification.mouse.ringPixels, fill: results.falsification.mouse.fillPixels, focusVisible: results.falsification.mouse.focusVisible } : null,
        mouseAppearanceUnchangedByFix: results.mouseAppearanceUnchangedByFix ?? null,
        controlInput: {
          selector: CONTROL_SELECTOR,
          focusedOutline: controlOutline,
          mouse: controlMouse && { ring: controlMouse.ringPixels, fill: controlMouse.fillPixels, focusVisible: controlMouse.focusVisible },
        },
        deletedRule: deletion?.text ?? null,
      },
    }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'settings-focus-ring',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    if (!preserve && !keepRoot) await harness.removeTemporaryRoot(root)
  }
}

await main()
