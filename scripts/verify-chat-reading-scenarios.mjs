// Real-window acceptance for the reading-position scenarios (taskbook UX-19, closed out by UX-38).
//
// `verify:electron-ui-state-continuity` covers viewport height and width changes and
// `verify:chat-streaming-rendering` covers text arriving while the reader is away. The scenarios
// left were the ones a reader triggers themselves, where the risk is that the app "helps" by
// moving them:
//
//   A. the composer grows to several lines while the reader is above the bottom;
//   B. the reader expands a tool detail at their reading position (the disclosure guard);
//   C. the reader switches to another conversation and comes back;
//   D. the same displacements from the top, the middle and the bottom of the transcript;
//   E. the floating way back to the newest message is reachable wherever the reader left the bottom.
//
// A and B must not move the message being read. C is no longer recorded: UX-38 settled the product
// question ("returning to a conversation starts at its newest message") and the gate asserts that
// decision — after switching away and back the reader is at the bottom (`gap <= 1`) and no
// `.chat-jump-to-latest` is offered. A fixture that cannot produce a second conversation fails the
// check instead of skipping it.
//
// D separates the two invariants the reader's position decides: above the bottom the keyed message
// is the anchor and must not move, at the bottom the bottom edge is the anchor, so the pin is the
// invariant. E measures the floating way back in normal and compact display mode at the gate's
// window and at the minimum window UX-22 uses.
//
// The acceptance runs in a window parked outside the desktop
// (`packages/app/src/main/desktop-visual-acceptance.ts`), and Chromium reports that page as hidden:
// it runs no rendering steps, so animation frames and ResizeObserver callbacks are not delivered on
// their own, and timers are throttled to roughly a quarter second. Two rules follow and both are
// measured, not assumed:
//   - no expression below waits inside the renderer (no `await` of a frame or a timer), because a
//     starved page then hangs the gate until the evaluate timeout; waiting is `harness.waitFor` on
//     the Node side, which does not depend on the renderer's scheduler;
//   - every measurement that depends on something the app corrects through an observer or a frame
//     forces a paint first (`forcePaint`), which is what delivers those callbacks.
//
// Usage:
//   node scripts/verify-chat-reading-scenarios.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  LONG_MARKDOWN_END,
  LONG_MARKDOWN_MARKER,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-reading-scenarios')))
const screenshotDir = join(outRoot, 'screenshots')
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1024, height: 640 }
/** The minimum window `verify-chat-output-readability.mjs` measures the transcript at. */
const MINIMUM_WINDOW = { width: 800, height: 660 }
const EVALUATE_TIMEOUT_MS = 30_000
/** A viewport or anchor may settle sub-pixel; anything larger is a real jump. */
const ANCHOR_TOLERANCE_PX = 1
/** The height the window loses in the three-position matrix, so the displacement is a real one. */
const VIEWPORT_PROBE_DELTA_PX = 80
/**
 * The transcript height the deterministic viewport probe pins before changing it. The element's own
 * `flex-grow` is 1, so the height has to be pinned (`flex: 0 0 <px>`) rather than merely biased.
 */
const VIEWPORT_PINNED_HEIGHT_PX = 480
/** The reader has to be this far above the bottom for "was away" to mean anything. */
const AWAY_FROM_BOTTOM_PX = 300
/** Scroll-away distance used by the reachability cases, identical to the streaming gate's. */
const AWAY_OFFSET_PX = 400

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

/** Names the evaluation that timed out: a bare "Runtime.evaluate timed out" is undiagnosable. */
const evaluate = (client, expression) => withTimeout(
  client.evaluate(expression),
  EVALUATE_TIMEOUT_MS,
  `Runtime.evaluate ${expression.replace(/\s+/gu, ' ').trim().slice(0, 120)}`,
)

/** The last phase that was entered, reported with a failure so a red run says where it died. */
let currentStep = 'startup'
const markStep = (name) => { currentStep = name }

async function writePng(client, name) {
  await client.send('Page.bringToFront').catch(() => undefined)
  const shot = await withTimeout(
    client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    10_000,
    'Page.captureScreenshot',
  )
  const path = join(screenshotDir, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Electron Acceptance', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 10, models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/slow-a',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 32,
      },
    },
  }
}

/**
 * Every expression below is synchronous on purpose. The acceptance window is parked outside the
 * desktop, and a busy machine can starve it of animation frames *and* timers; a promise awaited
 * inside the renderer then hangs the gate until the evaluate timeout (measured: a six-frame settle
 * loop that should take ~360 ms timed out after 15 s). Waiting is the Node side's job — the
 * `harness.waitFor` loops below do not depend on the renderer's scheduler at all.
 */

/**
 * Force one paint.
 *
 * The acceptance window is parked outside the desktop, and Chromium reports that page as hidden
 * (`document.visibilityState === 'hidden'`), so it runs no rendering steps: measured, two style
 * writes produced zero ResizeObserver callbacks and zero animation frames, and the app's own
 * composer overlay measurement stayed at its old value. One `Page.captureScreenshot` delivered the
 * coalesced callback and the new measurement. Everything the app corrects through a ResizeObserver
 * or a frame — the scroll repair, the overlay clearance, the composer height — therefore needs a
 * forced paint before it can be measured at all.
 */
async function forcePaint(client) {
  await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined)
}

/**
 * Report the frames delivered so far, asking for one more. Only a delivered frame moves the
 * counter, so this is the honest check that the renderer can paint at all.
 */
const FRAME_TICK_EXPRESSION = `(() => {
  window.__lsFrames = window.__lsFrames ?? 0
  requestAnimationFrame(() => { window.__lsFrames += 1 })
  return window.__lsFrames
})()`

/**
 * The reading position: bottom gap, scrollTop, the first keyed message still on screen, whether the
 * way back is offered, and the distance between the last message and the composer's top edge.
 */
const POSITION_EXPRESSION = `(() => {
  const round = (value) => Math.round(value * 100) / 100
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const viewportTop = messages.getBoundingClientRect().top
  const keyed = [...messages.querySelectorAll('[data-message-key]')]
  const visible = keyed.find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight
  })
  const composer = document.querySelector('.composer')
  const last = keyed.at(-1) ?? null
  return {
    scrollTop: round(messages.scrollTop),
    gap: round(messages.scrollHeight - messages.scrollTop - messages.clientHeight),
    anchorKey: visible?.getAttribute('data-message-key') ?? null,
    anchorTop: visible ? round(visible.getBoundingClientRect().top - viewportTop) : null,
    jumpButton: document.querySelector('.chat-jump-to-latest')?.getAttribute('data-new-content') ?? null,
    clearance: composer instanceof HTMLElement && last
      ? round(composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom)
      : null,
  }
})()`

/** Put the reader at the top, the middle or the bottom of the transcript. */
const scrollToPositionExpression = (where) => `(() => {
  const round = (value) => Math.round(value * 100) / 100
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const maximum = Math.max(0, messages.scrollHeight - messages.clientHeight)
  const target = ${where === 'top' ? '0' : where === 'middle' ? 'maximum / 2' : 'maximum'}
  messages.scrollTop = target
  messages.dispatchEvent(new Event('scroll', { bubbles: true }))
  return { requested: round(target), applied: round(messages.scrollTop), maximum: round(maximum) }
})()`

/** Put the reader 400 px above the bottom and report where they ended up. */
const SCROLL_AWAY_EXPRESSION = `(() => {
  const round = (value) => Math.round(value * 100) / 100
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - ${AWAY_OFFSET_PX})
  messages.dispatchEvent(new Event('scroll', { bubbles: true }))
  return {
    scrollTop: round(messages.scrollTop),
    gap: round(messages.scrollHeight - messages.scrollTop - messages.clientHeight),
  }
})()`

/**
 * Type six lines into the composer. The taller overlay is the displacement the reader has to
 * survive; the overlay height itself is waited for on the Node side.
 */
const COMPOSER_GROWTH_EXPRESSION = `(() => {
  const textarea = document.querySelector('.composer textarea')
  const overlay = document.querySelector('.chat')
  if (!(textarea instanceof HTMLTextAreaElement) || !(overlay instanceof HTMLElement)) return null
  const overlayBefore = Number.parseFloat(getComputedStyle(overlay).getPropertyValue('--composer-overlay-height'))
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, ['第一行', '第二行', '第三行', '第四行', '第五行', '第六行'].join('\\n'))
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return { overlayBefore }
})()`

/** Scroll the last tool row into the middle of the viewport, the way a reader would. */
const DISCLOSURE_ENTRY_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const rows = [...messages.querySelectorAll('.agent-tool-row')]
  if (rows.length === 0) return null
  rows[rows.length - 1].scrollIntoView({ block: 'center' })
  messages.dispatchEvent(new Event('scroll', { bubbles: true }))
  return true
})()`

const CLEAR_COMPOSER_EXPRESSION = `(() => {
  const textarea = document.querySelector('.composer textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, '')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

/** Start a new conversation from the sidebar, the way the reader does. */
const NEW_CONVERSATION_EXPRESSION = `(() => {
  const button = document.querySelector('.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
  if (button instanceof HTMLElement) button.click()
  return true
})()`

/** The display-mode contract the settings UI writes (see `chat/conversation-display.ts`). */
const displayModeExpression = (mode) => `(() => {
  localStorage.setItem('littlesheep.ui.conversationDisplayMode', ${JSON.stringify(mode)})
  window.dispatchEvent(new CustomEvent('littlesheep:conversation-display-mode', { detail: ${JSON.stringify(mode)} }))
  return localStorage.getItem('littlesheep.ui.conversationDisplayMode')
})()`

/**
 * Everything the way back has to satisfy while the reader is away, in one evaluation: it is hit by
 * its own centre (`reachable()` from verify-narrow-high-dpi-forms.mjs), it does not intersect the
 * composer, it sits above the composer's top edge, and it floats above the measured
 * `--composer-overlay-height`.
 */
const JUMP_REACHABILITY_EXPRESSION = `(() => {
  const button = document.querySelector('.chat-jump-to-latest')
  if (!(button instanceof HTMLElement)) return null
  const round = (value) => Math.round(value * 100) / 100
  const box = (element) => {
    const bounds = element.getBoundingClientRect()
    return {
      left: round(bounds.left), top: round(bounds.top), right: round(bounds.right), bottom: round(bounds.bottom),
      width: round(bounds.width), height: round(bounds.height),
    }
  }
  const describe = (element) => {
    if (!(element instanceof HTMLElement)) return null
    const name = typeof element.className === 'string' ? element.className.trim() : ''
    return name ? name.split(/\\s+/u)[0] : element.tagName.toLowerCase()
  }
  const reachable = (node) => {
    if (!(node instanceof HTMLElement)) return null
    const bounds = node.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return false
    if (bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false
    const x = Math.min(window.innerWidth - 1, Math.max(0, bounds.left + bounds.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, bounds.top + bounds.height / 2))
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit) && (hit === node || node.contains(hit) || hit.contains(node))
  }
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const composer = document.querySelector('.composer')
  const chat = document.querySelector('.chat')
  const buttonBox = box(button)
  const composerBox = composer instanceof HTMLElement ? box(composer) : null
  const centre = { x: round(buttonBox.left + buttonBox.width / 2), y: round(buttonBox.top + buttonBox.height / 2) }
  const hit = document.elementFromPoint(centre.x, centre.y)
  const overlay = chat instanceof HTMLElement
    ? Number.parseFloat(getComputedStyle(chat).getPropertyValue('--composer-overlay-height'))
    : Number.NaN
  return {
    label: button.textContent?.trim() ?? null,
    newContent: button.getAttribute('data-new-content'),
    rect: buttonBox,
    centre,
    hit: describe(hit),
    hitIsButton: hit === button,
    reachable: reachable(button),
    composer: composerBox,
    intersectsComposer: composerBox ? intersects(buttonBox, composerBox) : null,
    composerTop: composerBox ? composerBox.top : null,
    bottomAboveComposerTop: composerBox ? round(composerBox.top - buttonBox.bottom) : null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    overlayHeight: Number.isFinite(overlay) ? round(overlay) : null,
    overlayClearance: Number.isFinite(overlay) ? round(window.innerHeight - overlay - buttonBox.bottom) : null,
    displayMode: localStorage.getItem('littlesheep.ui.conversationDisplayMode') ?? 'normal',
    // What compact mode is allowed to fold away: evidence that the mode reached the transcript,
    // recorded rather than asserted because this fixture's turns may legitimately have none.
    foldableRows: document.querySelectorAll(
      '.assistant-turn [data-transcript-entry], .assistant-turn .context-projection-row',
    ).length,
  }
})()`

/** A tool row that is actually on screen, so clicking it is a reading action. */
const VISIBLE_TOOL_ROW_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const viewportTop = messages.getBoundingClientRect().top
  const row = [...messages.querySelectorAll('.agent-tool-row')].find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.top - viewportTop > 8 && bounds.bottom - viewportTop < messages.clientHeight - 8
  })
  if (!(row instanceof HTMLElement)) return null
  return { label: row.getAttribute('aria-label') ?? row.textContent?.trim().slice(0, 30) ?? '', expanded: row.getAttribute('aria-expanded') }
})()`

/** The width, height, scroll position, overlay height and delivered-frame count of one instant. */
const VIEWPORT_SIGNATURE_EXPRESSION = `(() => {
  window.__lsFrames = window.__lsFrames ?? 0
  requestAnimationFrame(() => { window.__lsFrames += 1 })
  const messages = document.querySelector('.messages')
  const chat = document.querySelector('.chat')
  if (!(messages instanceof HTMLElement) || !(chat instanceof HTMLElement)) return null
  return {
    frames: window.__lsFrames,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollTop: Math.round(messages.scrollTop * 100) / 100,
    scrollHeight: messages.scrollHeight,
    clientHeight: messages.clientHeight,
    overlay: getComputedStyle(chat).getPropertyValue('--composer-overlay-height'),
  }
})()`

/** Everything but the frame counter: the frame counter moves even when nothing else does. */
const layoutSignature = (sample) => {
  const { frames: _frames, ...layout } = sample
  return JSON.stringify(layout)
}
async function submitPrompt(client, prompt) {
  const submitted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, ${JSON.stringify(prompt)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('could not submit the composer')
}

async function waitForSettledTurn(client, timeoutMs) {
  // `error` is a page global (window.error), so the local must not shadow it here.
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    const failureNotice = turn?.querySelector('.run-status-error')
    if (response?.getAttribute('data-stream-state') === 'settled') return 'settled'
    if (failureNotice?.textContent?.trim()) return 'failed'
    return null
  })()`), timeoutMs, 'settled turn')
}

const readPosition = (client) => evaluate(client, POSITION_EXPRESSION)

/** Wait until a forced paint has delivered at least `frames` animation frames. */
async function waitForFrames(client, frames, label) {
  return harness.waitFor(async () => {
    await forcePaint(client)
    const delivered = await evaluate(client, FRAME_TICK_EXPRESSION)
    return typeof delivered === 'number' && delivered >= frames ? delivered : undefined
  }, harness.actionTimeoutMs, label)
}

/** The composer overlay grew past what it was before the six lines were typed. */
async function waitForOverlayGrowth(client, overlayBefore, label) {
  return harness.waitFor(async () => {
    await forcePaint(client)
    return evaluate(client, `(() => {
      const chat = document.querySelector('.chat')
      if (!(chat instanceof HTMLElement)) return null
      const value = Number.parseFloat(getComputedStyle(chat).getPropertyValue('--composer-overlay-height'))
      return Number.isFinite(value) && value > ${Number(overlayBefore ?? 0)} ? value : null
    })()`)
  }, harness.actionTimeoutMs, label)
}

/** Type six lines, wait for the taller overlay, and wait for the layout it displaces to settle. */
async function growComposer(client, label) {
  const growth = await evaluate(client, COMPOSER_GROWTH_EXPRESSION)
  const overlayAfter = await waitForOverlayGrowth(client, growth?.overlayBefore, `the composer overlay to grow ${label}`)
    .catch(() => null)
  await waitForStableViewport(client, `the viewport after the composer grew ${label}`)
  return {
    overlayBefore: growth?.overlayBefore ?? null,
    overlayAfter,
    grown: growth !== null && overlayAfter !== null && overlayAfter > (growth?.overlayBefore ?? 0),
  }
}

/** Clear the composer again and let the transcript settle back. */
async function clearComposer(client, label) {
  await evaluate(client, CLEAR_COMPOSER_EXPRESSION)
  await waitForStableViewport(client, `the viewport after the composer shrank ${label}`)
}

/**
 * The instant after the layout stopped changing. Each sample is preceded by a forced paint, which is
 * what lets the app's ResizeObserver callbacks and its frame-driven scroll correction run at all for
 * a hidden page; two identical samples with a paint in between is therefore "the app has seen this
 * layout and stopped moving".
 */
async function waitForStableViewport(client, label) {
  return harness.waitFor(async () => {
    await forcePaint(client)
    const first = await evaluate(client, VIEWPORT_SIGNATURE_EXPRESSION)
    if (!first) return undefined
    await delay(120)
    await forcePaint(client)
    const second = await evaluate(client, VIEWPORT_SIGNATURE_EXPRESSION)
    if (!second) return undefined
    return layoutSignature(first) === layoutSignature(second) ? second : undefined
  }, harness.actionTimeoutMs, label)
}

/** The viewport as the renderer sees it, plus what the native window reports for diagnostics. */
const VIEWPORT_EXPRESSION = `(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  availableHeight: window.screen?.availHeight ?? null,
}))()`

/** How long one resize request gets to reach the renderer before it is asked again. */
const RESIZE_OBSERVE_MS = 8_000

/**
 * Resize the real window and wait until the renderer's viewport and the layout have settled.
 *
 * Two things are measured here that a plain `setSize` call does not give you:
 *   - a resize message can be dropped for a window parked outside the desktop (measured: the native
 *     window reported the new size while the renderer kept the old one), so the request is retried
 *     once and a failure says exactly what arrived;
 *   - the layout controller marks the burst with `body.is-window-resizing` and ends it
 *     `WINDOW_RESIZE_SETTLE_DELAY_MS` after the last resize event, and the scroll controller applies
 *     its one correction then. A viewport that merely stopped changing is not a finished resize.
 *
 * `expectChange` is false when the window is asked for the size it already has. `tolerant` keeps a
 * prop that only carries secondary evidence from failing the gate; the callers that measure against
 * the window size stay strict.
 */
async function resizeWindow(client, locator, size, label, { expectChange = true, tolerant = false } = {}) {
  const before = await evaluate(client, VIEWPORT_EXPRESSION)
  let after = before
  for (let attempt = 1; attempt <= 2 && expectChange; attempt += 1) {
    await harness.desktopAction(locator, 'resize', size)
    const observed = await harness.waitFor(async () => {
      const value = await evaluate(client, VIEWPORT_EXPRESSION)
      if (!value) return undefined
      return value.innerWidth === before.innerWidth && value.innerHeight === before.innerHeight
        ? undefined
        : value
    }, RESIZE_OBSERVE_MS, `${label} (attempt ${attempt})`).catch(() => null)
    if (observed) {
      after = observed
      break
    }
    after = await evaluate(client, VIEWPORT_EXPRESSION)
  }
  if (!expectChange) {
    await harness.desktopAction(locator, 'resize', size)
    await delay(120)
  }
  const observed = after.innerWidth !== before.innerWidth || after.innerHeight !== before.innerHeight
  if (expectChange && !observed && !tolerant) {
    throw new Error(
      `the window resize never reached the renderer: asked for ${size.width}x${size.height}, `
      + `viewport stayed ${after.innerWidth}x${after.innerHeight} (native window ${after.outerWidth}x${after.outerHeight}, `
      + `screen height ${after.availableHeight})`,
    )
  }
  await harness.waitFor(
    () => evaluate(client, `document.body.classList.contains('is-window-resizing') ? null : true`),
    harness.actionTimeoutMs,
    `${label} to finish resizing`,
  ).catch(() => undefined)
  await waitForStableViewport(client, `${label} to settle`)
  const settled = await evaluate(client, VIEWPORT_EXPRESSION)
  // `observed` is "the renderer saw a resize at some point"; `changed` is where it ended up, which
  // is what a case that measures against the window size has to be judged on.
  const changed = settled.innerWidth !== before.innerWidth || settled.innerHeight !== before.innerHeight
  return { before, after: settled, changed, observed }
}

/**
 * A synthetic viewport-height change on the transcript itself. `flex: 0 0 <px>` is what pins the
 * height: the element's own `flex-grow` is 1, so a bare `flex-basis` would be grown straight back
 * into the free space. This is the mechanism `verify-electron-ui-state-continuity.mjs` states the
 * pin rule with; the real window resize measured alongside it goes through the app's resize-event
 * path and ends somewhere else (see the limits entry).
 */
const PIN_VIEWPORT_EXPRESSION = (heightPx) => `(() => {
  const round = (value) => Math.round(value * 100) / 100
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  messages.style.flex = ${JSON.stringify(`0 0 ${heightPx}px`)}
  return { clientHeight: messages.clientHeight, scrollTop: round(messages.scrollTop) }
})()`

const RESTORE_VIEWPORT_EXPRESSION = `(() => {
  const round = (value) => Math.round(value * 100) / 100
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  messages.style.flex = ''
  return { clientHeight: messages.clientHeight, scrollTop: round(messages.scrollTop) }
})()`

/** Leave the window on the gate size, reporting what the renderer ended up with. */
async function restoreGateWindow(client, locator, label) {
  const current = await evaluate(client, VIEWPORT_EXPRESSION)
  if (current.innerWidth === WINDOW.width && current.innerHeight === WINDOW.height) {
    return { before: current, after: current, changed: false, observed: false }
  }
  return resizeWindow(client, locator, WINDOW, label, { tolerant: true })
}

/**
 * The same flow from three starting positions, with two displacements per position: a deterministic
 * viewport-height change on the transcript (the displacement the documented pin rule is written
 * for) and the composer growing to six lines (the flow steps A and B already use).
 *
 * The real window is not resized here. A parked window's resize is not reliably delivered to the
 * renderer (measured: the native window reached the requested size while the renderer kept the old
 * viewport for over 30 s), which would make a per-position probe both slow and flaky; the
 * reachability cases below resize the real window and assert the size they were measured in.
 */
async function measurePositionMatrix(client) {
  const cases = []
  for (const where of ['top', 'middle', 'bottom']) {
    // A pinned transcript height makes the probe below a known-size viewport change regardless of
    // what the window happens to be.
    const pinnedViewport = await evaluate(client, PIN_VIEWPORT_EXPRESSION(VIEWPORT_PINNED_HEIGHT_PX))
    await waitForStableViewport(client, `the pinned transcript at the ${where}`)
    const start = await evaluate(client, scrollToPositionExpression(where))
    await waitForStableViewport(client, `the ${where} reading position`)
    const before = await readPosition(client)

    // The viewport change: the bottom edge an anchored reader is pinned to moves by exactly this.
    const shrunkViewport = await evaluate(
      client,
      PIN_VIEWPORT_EXPRESSION(VIEWPORT_PINNED_HEIGHT_PX - VIEWPORT_PROBE_DELTA_PX),
    )
    await waitForStableViewport(client, `the viewport after the change at the ${where}`)
    const afterViewportProbe = await readPosition(client)
    const restoredViewport = await evaluate(client, RESTORE_VIEWPORT_EXPRESSION)
    await waitForStableViewport(client, `the transcript after the viewport probe at the ${where}`)
    const afterViewportRestore = await readPosition(client)

    // The composer grows to six lines underneath the reader.
    const overlay = await growComposer(client, `at the ${where}`)
    const afterGrowth = await readPosition(client)
    await clearComposer(client, `at the ${where}`)
    const afterShrink = await readPosition(client)
    const screenshot = await writePng(client, `position-${where}`)
    cases.push({
      where, pinnedViewport, start, before,
      shrunkViewport, afterViewportProbe, restoredViewport, afterViewportRestore,
      overlay, afterGrowth, afterShrink, screenshot,
    })
  }
  return cases
}

/**
 * The way back to the newest message is a floating control: it must be clickable at its own centre
 * and it must stay clear of the composer at the gate's window and at the minimum window, in normal
 * and in compact display mode.
 */
async function measureJumpReachability(client, locator) {
  const cases = []
  // The matrix always ends by restoring the gate window, so the first case starts from it.
  let lastRequested = WINDOW
  for (const entry of [
    { name: 'normal-gate-window', mode: 'normal', window: WINDOW },
    { name: 'compact-gate-window', mode: 'compact', window: WINDOW },
    { name: 'normal-minimum-window', mode: 'normal', window: MINIMUM_WINDOW },
    { name: 'compact-minimum-window', mode: 'compact', window: MINIMUM_WINDOW },
  ]) {
    const expectChange = lastRequested.width !== entry.window.width || lastRequested.height !== entry.window.height
    const stored = await evaluate(client, displayModeExpression(entry.mode))
    const resize = await resizeWindow(client, locator, entry.window, `the ${entry.name} window`, { expectChange })
    lastRequested = entry.window
    // Compact mode folds finished rows away, so the transcript has to settle before measuring.
    await waitForStableViewport(client, `the ${entry.name} layout`)
    await evaluate(client, SCROLL_AWAY_EXPRESSION)
    const appeared = await harness.waitFor(
      () => evaluate(client, `document.querySelector('.chat-jump-to-latest') instanceof HTMLElement ? true : null`),
      harness.actionTimeoutMs,
      `the way back at ${entry.name}`,
    ).catch(() => null)
    await waitForStableViewport(client, `the ${entry.name} reading position`)
    const measurement = await evaluate(client, JUMP_REACHABILITY_EXPRESSION)
    const screenshot = await writePng(client, `jump-to-latest-${entry.name}`)
    cases.push({
      name: entry.name, mode: entry.mode, requestedWindow: entry.window,
      expectChange, resize, stored, appeared, measurement, screenshot,
    })
  }
  // Leave the renderer in the documented normal state so the recorded end state is not compact.
  const restoredMode = await evaluate(client, displayModeExpression('normal'))
  const restored = await resizeWindow(client, locator, WINDOW, 'the gate window restored', {
    expectChange: lastRequested.width !== WINDOW.width || lastRequested.height !== WINDOW.height,
  })
  return { cases, restoredMode, restored }
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-reading-scenarios-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 10, streamChunkCharacters: 80 })
  let electron
  let client
  let preserve = false

  try {
    await mkdir(screenshotDir, { recursive: true })
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // A window that is never shown is not composited, so animation frames — and with them every
    // settle loop this gate measures through — never run. Parking it outside the desktop renders
    // without ever putting a window in front of the person using the machine.
    await harness.desktopAction(locator, 'park-offscreen')
    await harness.desktopAction(locator, 'resize', WINDOW)
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(() => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer',
    )
    // A hidden page runs no rendering steps on its own, so both the app's layout observers and this
    // gate depend on forced paints. Fail here, with one clear message, rather than reading stale
    // geometry for the rest of the run.
    await waitForFrames(client, 3, 'a forced paint to deliver animation frames')
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // A tall transcript with at least one tool row: two long answers and one tool run.
    markStep('fixture')
    await submitPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await submitPrompt(client, '请使用 glob 工具列出当前工作区顶层条目')
    await waitForSettledTurn(client, 60_000)
    await submitPrompt(client, `请再输出一次这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await waitForStableViewport(client, 'the fixture transcript')
    const fixtureScreenshot = await writePng(client, 'fixture-ready')

    // --- A. the composer grows while the reader is above the bottom ---------------------------
    markStep('A: composer growth')
    await evaluate(client, SCROLL_AWAY_EXPRESSION)
    await waitForStableViewport(client, 'the reading position above the bottom')
    const beforeComposer = await readPosition(client)
    const composerGrowth = await growComposer(client, 'while reading above the bottom')
    const afterComposer = await readPosition(client)
    const composerScreenshot = await writePng(client, 'composer-grown')
    await clearComposer(client, 'while reading above the bottom')

    // --- B. expanding a tool detail at the reading position ------------------------------------
    markStep('B: tool disclosure')
    await evaluate(client, SCROLL_AWAY_EXPRESSION)
    await waitForStableViewport(client, 'the reading position before the disclosure')
    const beforeDisclosure = await readPosition(client)
    // Move the reading position so a tool row sits inside the viewport, then click it.
    const disclosure = await evaluate(client, DISCLOSURE_ENTRY_EXPRESSION)
    await waitForStableViewport(client, 'the reading position at the tool row')
    const beforeRow = await readPosition(client)
    const rowInfo = await evaluate(client, VISIBLE_TOOL_ROW_EXPRESSION)
    const expanded = await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      const viewportTop = messages.getBoundingClientRect().top
      const row = [...messages.querySelectorAll('.agent-tool-row')].find((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.top - viewportTop > 0 && bounds.bottom - viewportTop < messages.clientHeight
      })
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return row.getAttribute('aria-expanded') !== null
    })()`)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.agent-tool-row[aria-expanded="true"]') ? true : null`),
      harness.actionTimeoutMs,
      'the expanded tool detail',
    ).catch(() => undefined)
    await waitForStableViewport(client, 'the viewport after the disclosure expanded')
    const afterRow = await readPosition(client)
    const disclosureScreenshot = await writePng(client, 'tool-expanded')

    // --- C. switching away and coming back goes to the newest message ---------------------------
    // UX-38 decided this: coming back starts at the newest message. The gate asserts the decision,
    // and a fixture that cannot produce a second conversation fails the check instead of skipping
    // it — the skipped version used to pass with `sessionReturn: null`.
    markStep('C: conversation switch')
    const beforeSecond = await evaluate(client, `(() => ({
      id: localStorage.getItem('littlesheep.ui.activeSession'),
      rows: document.querySelectorAll('.session-item').length,
    }))()`)
    await evaluate(client, NEW_CONVERSATION_EXPRESSION)
    await harness.waitFor(() => evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      return textarea instanceof HTMLTextAreaElement && textarea.value === '' ? true : null
    })()`), harness.actionTimeoutMs, 'an empty composer in the new conversation')
    await submitPrompt(client, '请简短确认收到这条第二会话的消息。')
    await waitForSettledTurn(client, 45_000)
    const sessionRows = await harness.waitFor(() => evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.session-item')].map((element) => ({
        title: element.querySelector('.session-title')?.textContent?.trim() ?? '',
        active: element.classList.contains('active'),
      })).filter((entry) => entry.title)
      return rows.length >= 2 ? rows : null
    })()`), harness.actionTimeoutMs, 'a second conversation in the sidebar').catch(() => null)
    const secondId = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)

    let sessionReturn = null
    if (
      Array.isArray(sessionRows)
      && sessionRows.length >= 2
      && typeof beforeSecond?.id === 'string' && beforeSecond.id.length > 0
    ) {
      const clickOtherConversation = () => evaluate(client, `(() => {
        const rows = [...document.querySelectorAll('.session-item')]
        const target = rows.find((element) => !element.classList.contains('active'))
        if (!(target instanceof HTMLElement)) return false
        target.click()
        return true
      })()`)
      const waitForActiveSession = (id, label) => harness.waitFor(
        () => evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession') === ${JSON.stringify(id)} ? true : null`),
        harness.actionTimeoutMs,
        label,
      )
      const waitForLongTranscript = (label) => harness.waitFor(() => evaluate(client, `(() => {
        const messages = document.querySelector('.messages')
        if (!(messages instanceof HTMLElement)) return null
        return messages.textContent.includes(${JSON.stringify(LONG_MARKDOWN_END)}) ? true : null
      })()`), harness.actionTimeoutMs, label)

      // Back to the long conversation, leave the bottom, then switch away and back again.
      const toFirst = await clickOtherConversation()
      await waitForActiveSession(beforeSecond.id, 'the long conversation to be reopened')
      const longTranscript = await waitForLongTranscript('the long transcript after reopening')
      await evaluate(client, SCROLL_AWAY_EXPRESSION)
      await waitForStableViewport(client, 'the reading position before switching away')
      const beforeSwitch = await readPosition(client)
      const switched = await clickOtherConversation()
      await waitForActiveSession(secondId, 'the second conversation to be opened')
      await waitForStableViewport(client, 'the second conversation')
      const otherSession = await readPosition(client)
      const returned = await clickOtherConversation()
      await waitForActiveSession(beforeSecond.id, 'the long conversation after returning')
      await waitForLongTranscript('the returned transcript')
      await waitForStableViewport(client, 'the returned conversation')
      const back = await readPosition(client)
      const sessionReturnScreenshot = await writePng(client, 'session-return')
      sessionReturn = {
        sessionRows, beforeSecond, secondId, toFirst, longTranscript,
        beforeSwitch, switched, otherSession, returned, back, screenshot: sessionReturnScreenshot,
      }
    }

    // --- D. the same displacements from the top, the middle and the bottom ---------------------
    markStep('D: three-position matrix')
    const matrix = await measurePositionMatrix(client)
    // The matrix leaves the transcript on its natural height; the reachability cases measure in that
    // state, so make sure the pinned height is really gone, and that the window is on the gate size.
    const matrixTranscriptRestore = await evaluate(client, RESTORE_VIEWPORT_EXPRESSION)
    await waitForStableViewport(client, 'the transcript after the matrix')
    const matrixWindowRestore = await restoreGateWindow(client, locator, 'the gate window after the matrix')

    // --- E. the way back to the newest message stays reachable ---------------------------------
    markStep('E: jump-to-latest reachability')
    const reachability = await measureJumpReachability(client, locator)

    markStep('assertions')
    const results = {
      composerGrowth: { before: beforeComposer, after: afterComposer, overlay: composerGrowth },
      disclosure: { before: beforeRow, after: afterRow, rowInfo, expanded, entry: disclosure, beforeScrollAway: beforeDisclosure },
      sessionReturn,
      positionMatrix: matrix,
      matrixTranscriptRestore,
      matrixWindowRestore,
      jumpReachability: reachability,
      screenshots: { fixtureScreenshot, composerScreenshot, disclosureScreenshot },
      limits: [
        'No video recording exists anywhere in scripts/ (no Page.startScreencast, no MediaRecorder and no ffmpeg frame capture), so the taskbook\'s "截图/视频" requirement is met by the documented substitution: before/after DOM sampling (scrollTop plus the keyed anchor) and a PNG per case. Per-frame evidence is available through `window.__lsStyleRecorder`, the frame-level style recorder installed by verify-chat-streaming-rendering.mjs, when a change is too fast to poll.',
        'Step C asserts the decided product behaviour (a conversation switch returns to the newest message) from the renderer\'s own state: the conversation snapshot keeps no scroll position at all, so "restore the old position" is not a behaviour this gate could accidentally measure. A future restore-position feature would have to persist {messageKey, offset} and this gate would fail until it is updated.',
        'The three-position matrix names the displacement each invariant belongs to. The deterministic viewport change (`flex: 0 0 <px>` on .messages, the mechanism verify-electron-ui-state-continuity.mjs states the pin rule with) is what `gap <= 1` is asserted on for a pinned reader, and it is what keeps a reader above the bottom still. A composer that grows is not a viewport change: it adds the overlay delta to the transcript\'s own bottom padding, so the pinned reader\'s scrollTop does not move at all and the raw gap grows by exactly that delta — the taller composer extends over the last message\'s reserved clearance (recorded in positionMatrix[].afterGrowth.clearance) until the reader scrolls again. This gate asserts the no-jump fact and records the overlap; whether the transcript should re-pin instead needs the composer-overlay path to stop being gated on a viewport resize in use-chat-scroll-controller.ts.',
        'Measured while building this gate, on the real window (640 -> 720 -> 640 at a pinned reader): the reader is kept at the bottom when the window grows (the browser itself clamps scrollTop to the new maximum, so gap stays ~0) but is left one viewport delta above the bottom when the window shrinks back (~80px, `afterRestore.gap`) — the app\'s resize path captures its geometry after the layout has already changed, so didChatViewportResize() sees no change at that point and applies no correction. The gate does not assert the pin on a real window resize: a parked window\'s resize is not reliably delivered to the renderer at all (a probe of 640 -> 720 left the renderer on the old viewport for over 30 s), which would be an environment failure rather than a product one. The deterministic change above is the asserted displacement, and the reachability cases resize the real window and assert the size they measured in. Closing the real-resize gap is a product change in use-chat-scroll-controller.ts, not a gate change.',
        'Compact display mode is applied through the same localStorage + CustomEvent contract the settings UI writes. The gate asserts the stored value and measures the resulting geometry; this fixture\'s turns reported no foldable rows (`foldableRows`), so the compact cases differ from the normal ones by the stored mode and by whatever the mode changed internally, not by a measurable row count.',
        'The reachability cases measure the floating button while the reader is parked 400 px above the bottom. A reader who is away because a tool detail was expanded, or because older history was prepended, is covered by step B and by verify-chat-history-paging instead.',
      ],
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    const drift = (before, after) => Math.abs(Number(after.anchorTop) - Number(before.anchorTop))

    expect(composerGrowth !== null, 'the composer overlay height could not be measured')
    expect(composerGrowth?.grown === true, `the composer did not actually grow: ${JSON.stringify(composerGrowth)}`)
    expect(beforeComposer.gap > AWAY_FROM_BOTTOM_PX, `the reading position was not away from the bottom: ${beforeComposer.gap}`)
    expect(afterComposer.anchorKey === beforeComposer.anchorKey, 'the composer growth changed which message is being read')
    expect(drift(beforeComposer, afterComposer) <= ANCHOR_TOLERANCE_PX,
      `the composer growth moved the message being read by ${drift(beforeComposer, afterComposer)}px`)
    expect(afterComposer.gap > AWAY_FROM_BOTTOM_PX, `the composer growth pulled the reader toward the bottom: ${afterComposer.gap}`)

    expect(expanded, 'no visible tool row could be expanded')
    expect(beforeRow.anchorKey === afterRow.anchorKey, 'expanding a tool detail changed which message is being read')
    expect(drift(beforeRow, afterRow) <= ANCHOR_TOLERANCE_PX,
      `expanding a tool detail moved the message being read by ${drift(beforeRow, afterRow)}px`)

    // C. the fixture must produce a second conversation, and the return must go to the newest one.
    expect(Array.isArray(sessionRows) && sessionRows.length >= 2,
      `the fixture could not create a second conversation, so "switch away and come back" cannot be asserted: ${JSON.stringify(sessionRows)}`)
    expect(sessionReturn !== null, 'the switch-away-and-come-back flow did not run')
    expect(typeof beforeSecond?.id === 'string' && beforeSecond.id.length > 0,
      `the first conversation never got a persistent id: ${JSON.stringify(beforeSecond)}`)
    expect(sessionReturn?.secondId !== beforeSecond?.id,
      `the second conversation was not a separate session: ${JSON.stringify({ secondId: sessionReturn?.secondId, firstId: beforeSecond?.id })}`)
    expect(sessionReturn?.toFirst === true && sessionReturn?.switched === true && sessionReturn?.returned === true,
      `the conversation switch could not be driven: ${JSON.stringify({ toFirst: sessionReturn?.toFirst, switched: sessionReturn?.switched, returned: sessionReturn?.returned })}`)
    expect((sessionReturn?.beforeSwitch?.gap ?? 0) > AWAY_FROM_BOTTOM_PX,
      `the reader was not away from the bottom before switching conversations: ${sessionReturn?.beforeSwitch?.gap}`)
    expect((sessionReturn?.back?.gap ?? Number.POSITIVE_INFINITY) <= ANCHOR_TOLERANCE_PX,
      `coming back to a conversation did not go to its newest message: gap=${sessionReturn?.back?.gap}`)
    expect(sessionReturn?.back?.jumpButton === null,
      `the way back to the newest message was still offered after coming back: ${JSON.stringify(sessionReturn?.back)}`)

    // D. the position decides the invariant.
    for (const entry of matrix) {
      const label = entry.where
      const pinnedDelta = Number(entry.pinnedViewport?.clientHeight) - Number(entry.shrunkViewport?.clientHeight)
      expect(entry.start !== null && entry.before !== null, `the ${label} reading position could not be set`)
      expect(pinnedDelta >= VIEWPORT_PROBE_DELTA_PX / 2,
        `the viewport probe only moved the transcript by ${pinnedDelta}px at the ${label} position: ${JSON.stringify({ pinned: entry.pinnedViewport, shrunk: entry.shrunkViewport })}`)
      expect(Number(entry.restoredViewport?.clientHeight) > VIEWPORT_PINNED_HEIGHT_PX,
        `the transcript height was not restored after the ${label} probe: ${JSON.stringify(entry.restoredViewport)}`)
      expect(entry.overlay?.grown === true,
        `the composer did not actually grow at the ${label} reading position: ${JSON.stringify(entry.overlay)}`)
      if (label === 'bottom') {
        // The bottom edge is the anchor here: the viewport change has to leave the pin at ~0.
        expect((entry.before?.gap ?? Number.POSITIVE_INFINITY) <= ANCHOR_TOLERANCE_PX,
          `the bottom reading position was not pinned to begin with: gap=${entry.before?.gap}`)
        expect((entry.afterViewportProbe?.gap ?? Number.POSITIVE_INFINITY) <= ANCHOR_TOLERANCE_PX,
          `a pinned reader left the bottom on a viewport-height change: gap=${entry.afterViewportProbe?.gap} for a ${pinnedDelta}px change`)
        expect((entry.afterViewportRestore?.gap ?? Number.POSITIVE_INFINITY) <= ANCHOR_TOLERANCE_PX,
          `a pinned reader left the bottom when the transcript height was restored: gap=${entry.afterViewportRestore?.gap}`)
        // The composer growth is not a viewport change: it grows the transcript's own bottom
        // padding, so the reader's position is what must not move. It runs at the restored height,
        // which is why the comparison baseline is the post-restore sample, not the pinned one.
        expect(drift(entry.afterViewportRestore, entry.afterGrowth) <= ANCHOR_TOLERANCE_PX,
          `the composer growth moved the message being read by ${drift(entry.afterViewportRestore, entry.afterGrowth)}px at the bottom position`)
        expect(Number(entry.afterGrowth?.scrollTop) === Number(entry.afterViewportRestore?.scrollTop),
          `the composer growth moved the pinned reader: scrollTop ${entry.afterViewportRestore?.scrollTop} -> ${entry.afterGrowth?.scrollTop}`)
        expect((entry.afterShrink?.gap ?? Number.POSITIVE_INFINITY) <= ANCHOR_TOLERANCE_PX,
          `the reader did not return to the bottom after the composer shrank: gap=${entry.afterShrink?.gap}`)
      } else {
        expect(entry.afterViewportProbe?.anchorKey === entry.before?.anchorKey,
          `the viewport change changed which message is being read at the ${label} position: ${entry.before?.anchorKey} -> ${entry.afterViewportProbe?.anchorKey}`)
        expect(drift(entry.before, entry.afterViewportProbe) <= ANCHOR_TOLERANCE_PX,
          `the viewport change moved the message being read by ${drift(entry.before, entry.afterViewportProbe)}px at the ${label} position`)
        expect(Math.abs(Number(entry.afterViewportProbe?.gap) - Number(entry.before?.gap) - pinnedDelta) <= ANCHOR_TOLERANCE_PX,
          `the viewport change was not absorbed by the reader's gap at the ${label} position: gap ${entry.before?.gap} -> ${entry.afterViewportProbe?.gap} for a ${pinnedDelta}px change`)
        expect(entry.afterViewportRestore?.anchorKey === entry.before?.anchorKey,
          `restoring the transcript height changed which message is being read at the ${label} position: ${entry.before?.anchorKey} -> ${entry.afterViewportRestore?.anchorKey}`)
        expect(drift(entry.before, entry.afterViewportRestore) <= ANCHOR_TOLERANCE_PX,
          `restoring the transcript height moved the message being read by ${drift(entry.before, entry.afterViewportRestore)}px at the ${label} position`)
        expect(entry.afterGrowth?.anchorKey === entry.afterViewportRestore?.anchorKey,
          `the composer growth changed which message is being read at the ${label} position: ${entry.afterViewportRestore?.anchorKey} -> ${entry.afterGrowth?.anchorKey}`)
        expect(drift(entry.afterViewportRestore, entry.afterGrowth) <= ANCHOR_TOLERANCE_PX,
          `the composer growth moved the message being read by ${drift(entry.afterViewportRestore, entry.afterGrowth)}px at the ${label} position`)
        expect(Math.abs(Number(entry.afterShrink?.gap) - Number(entry.afterViewportRestore?.gap)) <= ANCHOR_TOLERANCE_PX,
          `the composer growth and its removal left the gap changed at the ${label} position: ${entry.afterViewportRestore?.gap} -> ${entry.afterShrink?.gap}`)
      }
    }

    // E. the way back is clickable and clear of the composer in every case.
    // The cases chain the measured viewport: the matrix above leaves the window at the gate size,
    // and every later case has to be measured in the window it claims.
    let previousCaseViewport = null
    for (const entry of reachability.cases) {
      const measurement = entry.measurement
      const viewport = measurement?.viewport ?? null
      expect(entry.resize?.changed === entry.expectChange,
        `${entry.name}: the window resize did not do what the case needs: expected a change=${entry.expectChange}, viewport ${JSON.stringify(entry.resize?.before)} -> ${JSON.stringify(entry.resize?.after)}`)
      if (previousCaseViewport === null) {
        expect(viewport?.width === WINDOW.width && viewport?.height === WINDOW.height,
          `${entry.name}: the gate window is not ${WINDOW.width}x${WINDOW.height}: ${JSON.stringify(viewport)}`)
      } else {
        const sameWindow = viewport?.width === previousCaseViewport.width && viewport?.height === previousCaseViewport.height
        expect(entry.expectChange ? !sameWindow : sameWindow,
          `${entry.name}: the window is not the one this case needs: ${JSON.stringify(viewport)} against the previous case's ${JSON.stringify(previousCaseViewport)}`)
      }
      previousCaseViewport = viewport
      expect(entry.stored === entry.mode, `${entry.name}: the conversation display mode was not stored: ${entry.stored}`)
      expect(entry.appeared === true, `the way back to the newest message never appeared at ${entry.name}`)
      expect(measurement !== null, `the way back to the newest message could not be measured at ${entry.name}`)
      expect(measurement?.hitIsButton === true,
        `${entry.name}: the centre of the way back hits ${measurement?.hit ?? 'nothing'} instead of the button itself`)
      expect(measurement?.reachable === true,
        `${entry.name}: the way back is not hittable at its own centre (elementFromPoint landed on ${measurement?.hit ?? 'nothing'})`)
      expect(measurement?.intersectsComposer === false,
        `${entry.name}: the way back overlaps the composer: ${JSON.stringify({ button: measurement?.rect, composer: measurement?.composer })}`)
      expect(measurement?.composerTop !== null && (measurement?.rect?.bottom ?? Number.POSITIVE_INFINITY) <= measurement.composerTop,
        `${entry.name}: the way back is not above the composer: bottom=${measurement?.rect?.bottom} composerTop=${measurement?.composerTop}`)
      expect(measurement?.overlayHeight !== null && (measurement?.overlayHeight ?? 0) > 0,
        `${entry.name}: the composer overlay height is not readable from .chat: ${measurement?.overlayHeight}`)
      expect(measurement?.overlayClearance !== null && (measurement?.overlayClearance ?? -1) >= 0,
        `${entry.name}: the way back floats into the composer overlay: bottom=${measurement?.rect?.bottom} viewportHeight=${measurement?.viewport?.height} overlayHeight=${measurement?.overlayHeight}`)
      expect(measurement?.displayMode === entry.mode,
        `${entry.name}: the conversation display mode was not applied: ${measurement?.displayMode}`)
    }
    expect(reachability.restoredMode === 'normal',
      `the conversation display mode was not returned to normal: ${reachability.restoredMode}`)
    expect(reachability.restored?.changed === true,
      `the gate window was not restored after the minimum-window cases: ${JSON.stringify(reachability.restored)}`)

    if (failures.length > 0) {
      throw new Error(`chat reading-position scenarios failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'chat-reading-scenarios', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'chat-reading-scenarios',
      ok: false,
      step: currentStep,
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
