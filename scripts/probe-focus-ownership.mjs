// Diagnostic probe: what actually holds focus in the two surfaces A2 touches.
//
// This is a *probe*, not a gate: it asserts nothing and always exits 0. It exists
// so the two open questions about this area can be answered from a real window
// instead of from a reading of the stylesheet:
//
//   1. the 完全访问 warning - who owns the caret on the commit it opens, a frame
//      later, and after a bounded retry; and where an Enter right after opening
//      is delivered.
//   2. the permission picker's option list - does a focused option match
//      `:focus-visible`, what outline does it resolve to, how much of that ring
//      survives the list's `overflow: hidden`, and which element really eats the
//      clipped pixels (`elementsFromPoint`).
//
// Usage:
//   node scripts/probe-focus-ownership.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-focus-probe')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1280, height: 840 }
const EVALUATE_TIMEOUT_MS = 20_000

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

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Focus Probe Provider', baseURL: providerBaseURL,
      apiKey: 'acceptance-key-not-a-credential', timeoutSeconds: 10, models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir, model: 'acceptance/slow-a', reasoning: 'auto',
        profile: 'general', timeoutSeconds: 60, maxRecoveryAttempts: 1,
      },
    },
  }
}

/** Describe whatever owns the caret, in the terms the two defects are stated in. */
const ACTIVE_EXPRESSION = `(() => {
  const active = document.activeElement;
  const describe = (node) => (node instanceof HTMLElement) ? {
    tag: node.tagName.toLowerCase(),
    className: typeof node.className === 'string' ? node.className : null,
    ariaLabel: node.getAttribute('aria-label'),
    text: (node.textContent ?? '').trim().slice(0, 28),
    focusVisible: node.matches(':focus-visible'),
  } : { tag: 'NONE' };
  return {
    active: describe(active),
    isBody: active === document.body || active === document.documentElement,
    inWarning: Boolean(active && active.closest && active.closest('.full-access-warning')),
    inPickerPanel: Boolean(active && active.closest && active.closest('.mode-picker-panel')),
    inComposer: Boolean(active && active.closest && active.closest('.composer')),
    warningOpen: Boolean(document.querySelector('.full-access-warning')),
    pickerOpen: Boolean(document.querySelector('.mode-picker.open')),
    modeLabel: document.querySelector('.mode-picker-trigger')?.getAttribute('aria-label') ?? null,
    sidebarActive: document.querySelector('.sidebar-nav-button.active, .session-item.active')?.textContent?.trim().slice(0, 24) ?? null,
  };
})()`

/** Everything about one option's ring: what it resolved to, and what survives. */
const OPTION_GEOMETRY_EXPRESSION = `(() => {
  const option = document.activeElement;
  if (!(option instanceof HTMLElement)) return { error: 'nothing is focused' };
  const list = option.closest('.option-picker-list');
  const panel = option.closest('.option-picker-panel');
  const style = getComputedStyle(option);
  const box = option.getBoundingClientRect();
  const listBox = list instanceof HTMLElement ? list.getBoundingClientRect() : null;
  const panelBox = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
  const offset = Number.parseFloat(style.outlineOffset) || 0;
  const width = Number.parseFloat(style.outlineWidth) || 0;
  // The outermost pixel the ring would occupy, on each side.
  const ringOuter = {
    left: box.left - offset - width,
    right: box.right + offset + width,
    top: box.top - offset - width,
    bottom: box.bottom + offset + width,
  };
  // A clipping container cuts at its padding box; anything outside is unreachable.
  const clipOf = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const s = getComputedStyle(node);
    const clipsX = s.overflowX !== 'visible';
    const clipsY = s.overflowY !== 'visible';
    if (!clipsX && !clipsY) return null;
    const r = node.getBoundingClientRect();
    const pad = {
      left: Number.parseFloat(s.paddingLeft) || 0,
      right: Number.parseFloat(s.paddingRight) || 0,
      top: Number.parseFloat(s.paddingTop) || 0,
      bottom: Number.parseFloat(s.paddingBottom) || 0,
    };
    return {
      className: typeof node.className === 'string' ? node.className : null,
      clipsX, clipsY, pad, box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      paddingBox: { left: r.left + pad.left, top: r.top + pad.top, right: r.right - pad.right, bottom: r.bottom - pad.bottom },
    };
  };
  const clippers = [];
  for (let node = option.parentElement; node && node !== document.body; node = node.parentElement) {
    const clip = clipOf(node);
    if (clip) clippers.push(clip);
  }
  // Does each ring edge land inside every clipping padding box?
  const edgeCoverage = {};
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const coordinate = ringOuter[side];
    let visible = true;
    for (const clip of clippers) {
      if (side === 'left' && clip.clipsX && coordinate < clip.paddingBox.left) visible = false;
      if (side === 'right' && clip.clipsX && coordinate > clip.paddingBox.right) visible = false;
      if (side === 'top' && clip.clipsY && coordinate < clip.paddingBox.top) visible = false;
      if (side === 'bottom' && clip.clipsY && coordinate > clip.paddingBox.bottom) visible = false;
    }
    edgeCoverage[side] = { coordinate: Math.round(coordinate * 100) / 100, visible };
  }
  // What the compositor says is at the ring's midpoints - the audit attributed the
  // zero coverage with elementsFromPoint, so the probe asks the same question.
  const probePoints = {
    left: { x: box.left - offset - width / 2, y: box.top + box.height / 2 },
    right: { x: box.right + offset + width / 2, y: box.top + box.height / 2 },
    top: { x: box.left + box.width / 2, y: box.top - offset - width / 2 },
    bottom: { x: box.left + box.width / 2, y: box.bottom + offset + width / 2 },
  };
  const topmostAt = (point) => {
    const found = document.elementsFromPoint(point.x, point.y);
    return found.slice(0, 3).map((node) => ({
      className: typeof node.className === 'string' ? node.className : node.tagName,
      isOption: node === option,
      inList: Boolean(list && node === list),
    }));
  };
  return {
    option: {
      className: typeof option.className === 'string' ? option.className : null,
      ariaLabel: option.getAttribute('aria-label'),
      focusVisible: option.matches(':focus-visible'),
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
    },
    outline: { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset },
    ringOuter,
    edgeCoverage,
    list: listBox && {
      box: { left: listBox.left, top: listBox.top, right: listBox.right, bottom: listBox.bottom, width: listBox.width, height: listBox.height },
      padding: getComputedStyle(list).padding,
      overflowX: getComputedStyle(list).overflowX,
      overflowY: getComputedStyle(list).overflowY,
      radius: getComputedStyle(list).borderRadius,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    },
    panel: panelBox && { width: panelBox.width, height: panelBox.height, padding: panel instanceof HTMLElement ? getComputedStyle(panel).padding : null },
    clippers,
    probePoints,
    points: Object.fromEntries(Object.entries(probePoints).map(([side, point]) => [side, { point, elements: topmostAt(point) }])),
    optionCount: document.querySelectorAll('.mode-picker-panel .mode-option').length,
    optionWidths: [...document.querySelectorAll('.mode-picker-panel .mode-option')].map((node) => Math.round(node.getBoundingClientRect().width * 100) / 100),
  };
})()`

/** Real pointer click at a selector's centre. */
async function clickSelector(client, selector) {
  const point = await evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (!point) return null
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  await delay(260)
  return point
}

async function pressKey(client, key) {
  const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Space' ? 32 : 0
  const base = { key, code: key === 'Space' ? 'Space' : key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await delay(200)
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-focus-probe-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  let electron
  let client
  const report = { probe: 'focus-ownership', capturedAt: new Date().toISOString() }
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
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')
    await delay(500)

    // --- 1. the 完全访问 warning, opened by a real pointer path --------------------------------
    const modeBefore = await evaluate(client, ACTIVE_EXPRESSION)
    const pickerClick = await clickSelector(client, '.mode-picker-trigger')
    const pickerOpen = await evaluate(client, ACTIVE_EXPRESSION)
    // What the picker itself does about focus when a pointer opens it.
    report.pickerFocus = {
      modeBefore,
      pickerClick,
      onOpen: pickerOpen,
      optionFocusedOnOpen: await evaluate(client, `Boolean(document.activeElement?.closest?.('.mode-picker-panel'))`),
    }
    const optionPoint = await clickSelector(client, '.mode-picker-panel .mode-option[aria-label^="完全访问"]')
    report.warning = {
      optionPoint,
      // Immediately after the click resolves, before any retry frame can run.
      onOpenCommit: await evaluate(client, ACTIVE_EXPRESSION),
    }
    await delay(60)
    // First animation frame after the open commit.
    report.warning.afterOneFrame = await evaluate(client, ACTIVE_EXPRESSION)
    await delay(400)
    // After any bounded retry would have exhausted.
    report.warning.afterRetryWindow = await evaluate(client, ACTIVE_EXPRESSION)
    report.warning.warningPresent = await evaluate(client, `Boolean(document.querySelector('.full-access-warning'))`)

    // Where would an Enter/Space go? Record what the browser would activate.
    report.warning.beforeEnter = await evaluate(client, `(() => {
      const active = document.activeElement;
      return {
        active: active instanceof HTMLElement ? (typeof active.className === 'string' ? active.className : active.tagName) : 'NONE',
        isBody: active === document.body,
        inWarning: Boolean(active?.closest?.('.full-access-warning')),
        modeLabel: document.querySelector('.mode-picker-trigger')?.getAttribute('aria-label') ?? null,
      };
    })()`)
    await pressKey(client, 'Enter')
    report.warning.afterEnter = await evaluate(client, ACTIVE_EXPRESSION)

    // Close whatever is left, then reopen for the picker measurement.
    await evaluate(client, `(() => {
      const cancel = document.querySelector('.full-access-warning .approval-action:not(.primary)');
      if (cancel instanceof HTMLElement) cancel.click();
      return true;
    })()`)
    await delay(400)
    report.warning.afterCancel = await evaluate(client, ACTIVE_EXPRESSION)

    // --- 2. the permission picker's focused option --------------------------------------------
    const reopen = await clickSelector(client, '.mode-picker-trigger')
    const pickerOpenAgain = await evaluate(client, ACTIVE_EXPRESSION)
    // Focus the first option the way a keyboard user arrives at it.
    const focusedFirst = await evaluate(client, `(() => {
      const option = document.querySelector('.mode-picker-panel .mode-option');
      if (!(option instanceof HTMLElement)) return false;
      option.focus({ preventScroll: true });
      return document.activeElement === option;
    })()`)
    await delay(200)
    report.option = {
      reopen,
      pickerOpenAgain,
      focusedFirst,
      geometry: await evaluate(client, OPTION_GEOMETRY_EXPRESSION),
    }
    // The same question for the last option, whose bottom ring edge is the other
    // edge the audit named.
    const focusedLast = await evaluate(client, `(() => {
      const options = [...document.querySelectorAll('.mode-picker-panel .mode-option')];
      const option = options.at(-1);
      if (!(option instanceof HTMLElement)) return false;
      option.focus({ preventScroll: true });
      return document.activeElement === option;
    })()`)
    await delay(200)
    report.optionLast = { focusedLast, geometry: await evaluate(client, OPTION_GEOMETRY_EXPRESSION) }
    report.computedAt = new Date().toISOString()
  } catch (error) {
    report.error = error instanceof Error ? `${error.message}\n${error.stack?.split('\n').slice(0, 5).join('\n')}` : String(error)
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    await mkdir(outRoot, { recursive: true })
    await writeFile(join(outRoot, 'probe-focus-ownership.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    if (!keepRoot) await harness.removeTemporaryRoot(root).catch(() => undefined)
  }
  console.log(JSON.stringify(report, null, 2))
}

await main()
