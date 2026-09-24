// Real-window acceptance for keyboard-only layers and focus (taskbook UX-07).
//
// UX-07 asks for the interaction that a mouse hides: opening a layer with the keyboard alone,
// Tab staying inside the dialog, Escape removing exactly one layer, and focus landing back on
// the control that opened it. Two layers is the interesting case — the archive page lives inside
// the settings overlay, and a delete confirmation opens on top of it, so one Escape must close
// the dialog and leave the page behind it.
//
// The keys are dispatched through CDP, so the renderer receives real `keydown` events and native
// button activation; the fixture never calls the click handlers directly.
//
// Usage:
//   node scripts/verify-keyboard-modal-focus.mjs [--out=<dir>] [--keep]

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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-keyboard-modal')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1180, height: 760 }
const EVALUATE_TIMEOUT_MS = 15_000
const SESSION_TITLE = '键盘验收归档对话'

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

async function writePng(client, name) {
  await client.send('Page.bringToFront').catch(() => undefined)
  const shot = await withTimeout(
    client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    10_000,
    'Page.captureScreenshot',
  )
  await mkdir(join(outRoot, 'screenshots'), { recursive: true })
  const path = join(outRoot, 'screenshots', `${name}.png`)
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
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
  }
}

async function seedArchive(dataDir) {
  const now = Date.now()
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  await mkdir(join(dataDir, 'archive'), { recursive: true })
  const session = {
    id: 'keyboard-archived-session',
    title: SESSION_TITLE,
    createdAt: now - 60_000,
    lastMessageAt: now - 30_000,
    mode: 'research',
    scope: 'standalone',
    archivedAt: now,
  }
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: [] }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'archive', 'index.json'), `${JSON.stringify({ projects: [], sessions: [session] }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'sessions', `${session.id}.jsonl`), `${JSON.stringify({
    type: 'metadata',
    metadata: {
      title: session.title,
      model: '',
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.lastMessageAt).toISOString(),
      messageCount: 2,
    },
  })}\n`, 'utf8')
}

/** A real key press: the renderer sees the same event a keyboard user produces. */
async function pressKey(client, key, { shift = false } = {}) {
  const keyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0
  const code = key === 'Tab' ? 'Tab' : key === 'Enter' ? 'Enter' : 'Escape'
  const modifiers = shift ? 8 : 0
  await client.send('Input.dispatchKeyEvent', {
    // `keyDown` (not `rawKeyDown`) is what lets Chromium run the default action: Enter activates
    // a focused button, which is exactly the keyboard path this fixture is testing.
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  })
  await delay(150)
}

/** Focus a selector without clicking it, then report what is focused. */
async function focusSelector(client, selector) {
  return evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLElement)) return null
    element.focus({ preventScroll: true })
    return document.activeElement === element
  })()`)
}

const FOCUS_STATE_EXPRESSION = `(() => {
  const active = document.activeElement
  const dialog = document.querySelector('.danger-confirm-dialog')
  return {
    activeLabel: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 30) ?? null,
    activeClass: typeof active?.className === 'string' ? active.className : null,
    insideDialog: Boolean(dialog && active && dialog.contains(active)),
    dialogOpen: Boolean(dialog),
    archiveOpen: Boolean(document.querySelector('.archive-page')),
    settingsOpen: Boolean(document.querySelector('.settings-workspace')),
    chatVisible: Boolean(document.querySelector('.messages')),
  }
})()`

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-keyboard-modal-'))
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
    await seedArchive(dataDir)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.settings-entry-btn') instanceof HTMLElement || null`),
      harness.startTimeoutMs,
      'the settings entry',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // --- 1. open the settings layer and the archive page with the keyboard alone ---------------
    const entryFocused = await focusSelector(client, '.settings-entry-btn')
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`), harness.startTimeoutMs, 'settings navigation')
    // The nav item that says 归档 is not the first one; focus it explicitly by index.
    const archiveNavIndex = await evaluate(client, `(() => {
      const items = [...document.querySelectorAll('.settings-nav-item')]
      return items.findIndex((item) => item.textContent?.includes('归档'))
    })()`)
    if (archiveNavIndex < 0) throw new Error('the archive navigation item is missing')
    const navFocused = await evaluate(client, `(() => {
      const items = [...document.querySelectorAll('.settings-nav-item')]
      const target = items[${archiveNavIndex}]
      if (!(target instanceof HTMLElement)) return false
      target.focus({ preventScroll: true })
      return document.activeElement === target
    })()`)
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.archive-session-row') ? true : null`), harness.startTimeoutMs, 'the archived conversation row')
    const openedByKeyboard = await evaluate(client, `(() => ({
      archiveOpen: Boolean(document.querySelector('.archive-page')),
      settingsOpen: Boolean(document.querySelector('.settings-workspace')),
      focused: document.activeElement?.textContent?.trim().slice(0, 30) ?? null,
    }))()`)

    // --- 2. open the confirmation with the keyboard --------------------------------------------
    const deleteFocused = await focusSelector(client, '.archive-session-row .archive-action.danger')
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog') ? true : null`), harness.startTimeoutMs, 'the confirmation dialog')
    await delay(200)
    const opened = await evaluate(client, FOCUS_STATE_EXPRESSION)
    const dialogScreenshot = await writePng(client, 'dialog-open')

    // --- 3. Tab stays inside the dialog ---------------------------------------------------------
    const tabTrace = []
    for (let index = 0; index < 5; index += 1) {
      await pressKey(client, 'Tab')
      tabTrace.push(await evaluate(client, FOCUS_STATE_EXPRESSION))
    }
    for (let index = 0; index < 2; index += 1) {
      await pressKey(client, 'Tab', { shift: true })
      tabTrace.push(await evaluate(client, FOCUS_STATE_EXPRESSION))
    }
    const tabScreenshot = await writePng(client, 'dialog-tab-cycle')

    // --- 4. one Escape removes one layer, and focus goes back to the trigger --------------------
    await pressKey(client, 'Escape')
    await delay(250)
    const afterFirstEscape = await evaluate(client, FOCUS_STATE_EXPRESSION)
    // A second Escape is *recorded*, not asserted: the settings layer is a persistent page-level
    // surface, and closing it is the 退出设置 control's job (no Escape scope is registered for
    // it). What UX-07 requires is that the first Escape removed exactly one layer.
    await pressKey(client, 'Escape')
    await delay(400)
    const afterSecondEscape = await evaluate(client, FOCUS_STATE_EXPRESSION)
    const secondEscapeClosedSettings = afterSecondEscape.settingsOpen === false
    const escapeScreenshot = await writePng(client, 'after-escape')

    const results = {
      entryFocused,
      navFocused,
      openedByKeyboard,
      deleteFocused,
      opened,
      tabTrace,
      afterFirstEscape,
      afterSecondEscape,
      secondEscapeClosedSettings,
      screenshots: { dialogScreenshot, tabScreenshot, escapeScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. the whole path was opened with keys, not clicks.
    expect(entryFocused === true, 'the settings entry could not be focused')
    expect(navFocused === true, 'the archive navigation item could not be focused')
    expect(openedByKeyboard.archiveOpen, 'the archive page did not open from the keyboard')
    expect(deleteFocused === true, 'the delete action could not be focused')
    // 2. initial focus is the deliberate target.
    expect(opened.dialogOpen, 'the dialog did not open from the keyboard')
    expect(opened.activeClass?.includes('close-btn') === true,
      `initial focus was not the cancel button: ${JSON.stringify(opened.activeLabel)}`)
    // 3. Tab never leaves the dialog.
    expect(tabTrace.every((state) => state.insideDialog),
      `Tab left the dialog: ${JSON.stringify(tabTrace.map((state) => state.activeClass))}`)
    expect(new Set(tabTrace.map((state) => state.activeClass)).size >= 2, 'Tab never reached the second action')
    // 4. one Escape per layer, focus returned to the trigger.
    expect(afterFirstEscape.dialogOpen === false, 'the first Escape did not close the dialog')
    expect(afterFirstEscape.archiveOpen, 'the first Escape also closed the page behind the dialog')
    expect(afterFirstEscape.settingsOpen, 'the first Escape closed the settings layer as well')
    expect(afterFirstEscape.activeClass?.includes('archive-action') === true,
      `focus did not return to the delete action: ${JSON.stringify(afterFirstEscape.activeClass)}`)

    if (failures.length > 0) {
      throw new Error(`keyboard modal focus acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'keyboard-modal-focus', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'keyboard-modal-focus',
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
