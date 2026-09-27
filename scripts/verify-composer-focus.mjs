// Real-window acceptance for composer focus ownership (P1).
//
// Measured defect: on a fresh window `document.activeElement` was BODY both at
// first paint and once execution was ready, so real key events inserted nothing
// until the textarea had been clicked. ChatGPT, Claude, Cursor and VS Code all
// put the caret in the input on launch and when a new conversation starts.
//
// The same fix must not take the keyboard away from a surface that owns it, so
// the four negative cases below are as much the contract as the two positive ones:
//   A. launch: a fresh window focuses the composer with no click, and real CDP
//      key events arrive there;
//   B. a new conversation (a real click on 新对话, which leaves the button
//      focused) puts the caret back in the composer;
//   C. an open dialog (the full-access warning) keeps focus;
//   D. a user typing in another text surface (the sidebar search box) keeps it;
//   E. a live approval prompt of a running turn keeps focus.
//
// C, D and E inject the one-shot window event `newSession()` itself dispatches
// (`COMPOSER_FOCUS_REQUEST_EVENT`, read from its source below), so they exercise
// the real command without the side effects that would close the surface under
// test (a new conversation closes the search panel, and the modal blocks clicks).
//
// Usage:
//   node scripts/verify-composer-focus.mjs [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const PROVIDER_ID = 'acceptance-gw'
const MODEL_ID = 'slow-a'
const API_KEY = 'acceptance-key-not-a-credential'
/** The fixture's approval path: a write tool the research mode must ask about. */
const APPROVAL_MARKER = 'UX07-APPROVAL-ESCAPE'

const FOCUS_EXPRESSION = `(() => {
  const active = document.activeElement;
  const textarea = document.querySelector('.composer textarea');
  const describe = (node) => node ? {
    tag: node.tagName ? node.tagName.toLowerCase() : null,
    className: typeof node.className === 'string' ? node.className : null,
    ariaLabel: node.getAttribute ? node.getAttribute('aria-label') : null,
  } : null;
  const within = (selector) => Boolean(active && active.closest && active.closest(selector));
  return {
    active: describe(active),
    composerFocused: Boolean(textarea) && active === textarea,
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    fullAccessWarningOpen: Boolean(document.querySelector('.full-access-warning')),
    approvalOpen: Boolean(document.querySelector('.approval-prompt')),
    modePickerOpen: Boolean(document.querySelector('.mode-picker.open')),
    focusInsideFullAccess: within('.full-access-warning'),
    focusInsideApproval: within('.approval-prompt'),
    focusInsideSearch: within('.sidebar-search-box'),
  };
})()`

function createRecorder() {
  const observations = []
  const failures = []
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      if (!condition) failures.push({ check, detail })
      return Boolean(condition)
    },
    failures,
    observations,
  }
}

async function readFocus(client) {
  return client.evaluate(FOCUS_EXPRESSION)
}

async function waitForFocus(client, predicate, timeoutMs, label) {
  return harness.waitFor(async () => {
    const state = await readFocus(client).catch(() => undefined)
    return state && predicate(state) ? state : undefined
  }, timeoutMs, label)
}

/** A real mouse click at the element's center, so focus lands where a user's would. */
async function clickElement(client, selector) {
  const point = await client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (!point) return false
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  })
  await delay(120)
  return true
}

/** Real CDP key events: what the renderer receives from a keyboard. */
async function typeText(client, text) {
  for (const character of text) {
    const code = `Key${character.toUpperCase()}`
    const keyCode = character.toUpperCase().charCodeAt(0)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: character, unmodifiedText: character, key: character, code,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: character, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    })
  }
}

async function pressKey(client, key, keyCode, code) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  })
}

/** Ctrl+A then Backspace, so the next case starts from an empty draft. */
async function clearDraft(client) {
  await client.evaluate(`document.querySelector('.composer textarea')?.focus()`)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    })
  }
  await pressKey(client, 'Backspace', 8, 'Backspace')
  await delay(120)
}

function buildConfig(workspaceDir, provider) {
  return {
    version: 1,
    providers: [{
      id: PROVIDER_ID,
      name: '验收网关',
      baseURL: provider.baseURL,
      apiKey: API_KEY,
      models: [{ id: MODEL_ID, name: MODEL_ID }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `${PROVIDER_ID}/${MODEL_ID}`,
        reasoning: 'auto',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

async function readFocusEventName() {
  const source = await readFile(join(repoRoot, 'packages/app/src/renderer/composer/focus-routing.ts'), 'utf8')
  return /COMPOSER_FOCUS_REQUEST_EVENT = '([^']+)'/u.exec(source)?.[1] ?? null
}

async function startWindow({ root, provider, focusEventName }) {
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider), null, 2)}\n`, 'utf8')
  const electron = await harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath,
    extraEnv: { OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GLM_API_KEY: undefined },
  })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  // The window is fully interactive here: the composer exists and execution is ready.
  await harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    const readiness = response?.body?.readiness ?? response?.body
    return readiness?.state === 'ready' ? true : undefined
  }, 60_000, 'readiness ready')
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
    30_000,
    'the composer textarea',
  )
  // A hidden window is backgrounded: Chromium stops rendering frames, so the
  // surfaces mounted from measured layout (two `requestAnimationFrame`s, see
  // `sidebar/feature-panel.tsx`) never appear. Parking the window off every
  // display renders it without landing on the user's desktop and without taking
  // focus (`showInactive`), which is what lets the "typing somewhere else" case
  // below use a real, app-focused text surface.
  await harness.desktopAction(locator, 'park-offscreen')
  await delay(400)
  // Nothing above clicks or focuses anything: case A reads the caret the window
  // chose for itself.
  return { electron, locator, client }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const focusEventName = await readFocusEventName()
  recorder.check(
    typeof focusEventName === 'string' && focusEventName.length > 0,
    'the one-shot composer focus event is read from its source',
    focusEventName,
  )
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-composer-focus-'))
  let handle
  try {
    handle = await startWindow({ root, provider, focusEventName })

    // --- A. launch: the caret is already in the composer, with no click --------
    const launch = await waitForFocus(handle.client, (state) => (state.composerFocused ? state : undefined), 20_000, 'the launch caret')
    await typeText(handle.client, 'focus')
    const typed = await readFocus(handle.client)
    recorder.note({
      step: 'launch',
      active: launch.active,
      composerFocused: launch.composerFocused,
      draftAfterKeyEvents: typed.draft,
      activeAfterKeyEvents: typed.active,
    })
    recorder.check(launch.composerFocused === true, 'a fresh window puts the caret in the composer without a click', launch)
    recorder.check(typed.draft === 'focus', 'real key events reach the composer without a click', { draft: typed.draft })
    recorder.check(typed.composerFocused === true, 'the caret stays in the composer while typing', typed.active)

    // --- B. a new conversation claims the caret -------------------------------
    const clickedNew = await clickElement(handle.client, '.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
    const afterNew = await waitForFocus(handle.client, (state) => (state.composerFocused ? state : undefined), 10_000, 'the new-conversation caret')
    recorder.note({ step: 'new-conversation', clickedNew, active: afterNew.active })
    recorder.check(clickedNew === true, 'the sidebar 新对话 control was clicked', { clickedNew })
    recorder.check(afterNew.composerFocused === true, 'a new conversation puts the caret in the composer', afterNew)

    // --- C. an open dialog keeps focus ----------------------------------------
    await clickElement(handle.client, '.mode-picker-trigger')
    await clickElement(handle.client, '.mode-picker-panel .mode-option[aria-label^="完全访问"]')
    const warning = await waitForFocus(
      handle.client,
      (state) => (state.fullAccessWarningOpen ? state : undefined),
      15_000,
      'the full-access warning',
    ).catch(() => undefined)
    await handle.client.evaluate(`window.dispatchEvent(new CustomEvent(${JSON.stringify(focusEventName)}))`)
    await delay(200)
    const duringWarning = await readFocus(handle.client)
    recorder.note({
      step: 'dialog-open',
      warningOpen: Boolean(warning),
      beforeRequest: warning?.active ?? null,
      afterRequest: duringWarning.active,
      focusInsideFullAccess: duringWarning.focusInsideFullAccess,
    })
    recorder.check(Boolean(warning), 'the full-access warning opened', warning ?? null)
    recorder.check(
      duringWarning.fullAccessWarningOpen === true && duringWarning.composerFocused === false,
      'an open dialog keeps the keyboard: the composer does not take the caret',
      duringWarning,
    )
    await clickElement(handle.client, '.full-access-warning .approval-action')
    await delay(400)

    // --- D. a user typing elsewhere keeps focus -------------------------------
    await clickElement(handle.client, '.sidebar-quick-nav .sidebar-nav-button[aria-label="搜索"]')
    // The panel mounts from two animation frames and stays `inert` until they
    // arrive, so this waits for a focusable input and then does what the user
    // does: puts the caret in it. Forcing a frame per poll is the same trick the
    // cold-start gates use, and it is what keeps this case honest on a machine
    // where the window is not otherwise compositing.
    const searchFocused = await harness.waitFor(async () => {
      await handle.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).catch(() => undefined)
      const state = await readFocus(handle.client).catch(() => undefined)
      if (!state) return undefined
      if (state.focusInsideSearch) return state
      await handle.client.evaluate(`(() => {
        const input = document.querySelector('.sidebar-search-box input');
        if (!(input instanceof HTMLInputElement)) return false;
        if (input.closest('[inert]')) return false;
        input.focus();
        return true;
      })()`).catch(() => undefined)
      const focused = await readFocus(handle.client).catch(() => undefined)
      return focused?.focusInsideSearch ? focused : undefined
    }, 45_000, 'the search box to take focus')
    await handle.client.evaluate(`window.dispatchEvent(new CustomEvent(${JSON.stringify(focusEventName)}))`)
    await delay(200)
    const duringSearch = await readFocus(handle.client)
    recorder.note({
      step: 'elsewhere',
      beforeRequest: searchFocused.active,
      afterRequest: duringSearch.active,
      focusInsideSearch: duringSearch.focusInsideSearch,
    })
    recorder.check(
      duringSearch.focusInsideSearch === true && duringSearch.composerFocused === false,
      'a user typing in another text surface keeps the caret',
      duringSearch,
    )
    await clickElement(handle.client, '.sidebar-feature-close')
    await delay(300)

    // --- E. a live approval prompt keeps focus --------------------------------
    await clearDraft(handle.client)
    await typeText(handle.client, APPROVAL_MARKER)
    await pressKey(handle.client, 'Enter', 13, 'Enter')
    const approval = await waitForFocus(
      handle.client,
      (state) => (state.approvalOpen ? state : undefined),
      45_000,
      'the run approval prompt',
    ).catch(() => undefined)
    await handle.client.evaluate(`window.dispatchEvent(new CustomEvent(${JSON.stringify(focusEventName)}))`)
    await delay(200)
    const duringApproval = await readFocus(handle.client)
    recorder.note({
      step: 'approval-open',
      approvalOpen: Boolean(approval),
      beforeRequest: approval?.active ?? null,
      afterRequest: duringApproval.active,
      focusInsideApproval: duringApproval.focusInsideApproval,
    })
    recorder.check(Boolean(approval), 'a running turn asked for approval', approval ?? null)
    recorder.check(
      duringApproval.approvalOpen === true && duringApproval.focusInsideApproval === true,
      'an approval prompt keeps focus when a new conversation asks for the caret',
      duringApproval,
    )
    recorder.check(duringApproval.composerFocused === false, 'the composer did not take the caret from the approval', duringApproval)
    // Escape denies it, so the turn settles instead of holding the run open.
    await pressKey(handle.client, 'Escape', 27, 'Escape')
    await harness.waitFor(async () => {
      const state = await readFocus(handle.client).catch(() => undefined)
      return state && !state.approvalOpen ? true : undefined
    }, 30_000, 'the approval prompt to settle').catch(() => undefined)
  } catch (error) {
    recorder.check(false, 'the focus walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await stopWindow(handle)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root).catch(() => undefined)
  }

  const evidence = {
    check: 'composer-focus',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'Cases C, D and E inject the same window event that starting a new conversation dispatches, because the real command closes the search panel (case D) and the modal blocks clicks (cases C and E); the composer re-checks its guards on that event exactly as it does on the command.',
      'The window is parked off every display so Chromium renders frames; it never lands on the user\'s desktop and `showInactive` keeps it from taking focus, so this proves DOM focus ownership and key delivery, not what a user sees painted.',
      'Case D polls with a forced frame because the search panel mounts from two animation frames and is `inert` until they arrive; the caret is then placed the way the user places it, and the assertion is about the composer not taking it away.',
      'The full-access warning opens without taking focus itself (its `useModalSurface` initial-focus effect runs before `FadePresence` mounts the dialog), so case C asserts what is true there: the composer does not take the keyboard while that dialog is open. Case E carries the literal "the open surface keeps its focus" evidence.',
      'Case E needs the Provider stub\'s deterministic write-tool branch; the approval prompt it opens is the same surface a real run uses.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
