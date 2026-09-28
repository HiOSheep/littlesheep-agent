// Real-window acceptance for Escape in the model-provider editor and its discard question (P1).
//
// Measured defect: with unsaved edits, Escape left the editor open and the caret in the field, and
// after the close entry had asked its discard question (继续编辑 / 丢弃修改), Escape did nothing
// there either. Every other dialog in the app answers Escape - the approval prompt, the danger
// confirm, the full-access warning, the embedded channel and skills pages, and every popover - so
// this was the one gap left.
//
// The gate drives the real editor with real key events and asserts, per case, what the keyboard
// user gets:
//   A. a clean editor closes on Escape, and Escape closes only that layer (settings stays open);
//   B. an editor with unsaved edits does not close silently: Escape asks the same question the
//      close entry asks, keeps the draft, and leaves the caret in the field;
//   C. Escape while the question is up keeps editing: the question closes, the editor and the
//      draft stay, the caret never leaves the field;
//   D. the question's other answer still works: 丢弃修改 closes the editor and drops the draft
//      (this case is a control - it must behave the same before and after the fix);
//   E. Escape while a save is in flight closes nothing: the editor, its 保存中… state and its
//      draft stay until the save really lands, and the save still lands;
//   F. the template picker on the same page is measured by the same code and recorded, because
//      "every other dialog honours Escape" is the claim this gate exists to check.
//
// Usage:
//   node scripts/verify-settings-escape-scopes.mjs [--keep] [--stale-build-diagnostic]
//
// `--stale-build-diagnostic` measures whatever is in `packages/app/out` even when the sources have
// moved on, which is how the pre-fix reading of this gate is taken from the build that predates the
// fix; a normal run asserts freshness first.

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { inspectAppBuildFreshness } from './lib/app-build-fingerprint.mjs'
import { runArtifact, runArtifactsRoot } from './lib/run-artifacts.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const OUT_ROOT = 'settings-escape-scopes'
const WINDOW_SIZE = { width: 1180, height: 780 }
const EVALUATE_TIMEOUT_MS = 20_000
const PROVIDER_ID = 'escape-acceptance'
const PROVIDER_NAME = 'Escape Acceptance Provider'
const DRAFT_NAME = 'ESCAPE-DRAFT-MARKER'
const SAVE_NAME = 'ESCAPE-SAVE-MARKER'

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

/** Everything each case decides on, read in one round trip. */
const EDITOR_EXPRESSION = `(() => {
  const editor = document.querySelector('.provider-editor');
  const confirm = editor ? editor.querySelector('.provider-editor-discard') : null;
  const nameInput = editor ? [...editor.querySelectorAll('.settings-inline-field input')][1] ?? null : null;
  const active = document.activeElement;
  return {
    editorOpen: Boolean(editor),
    editorLabel: editor instanceof HTMLElement ? editor.getAttribute('aria-label') : null,
    discardConfirm: confirm instanceof HTMLElement ? {
      text: confirm.textContent?.trim() ?? '',
      actions: [...confirm.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
    } : null,
    name: nameInput instanceof HTMLInputElement ? nameInput.value : null,
    status: editor ? editor.querySelector('.provider-editor-status')?.textContent?.trim() ?? null : null,
    saveLabel: editor ? editor.querySelector('.save-btn')?.textContent?.trim() ?? null : null,
    saveDisabled: editor ? editor.querySelector('.save-btn')?.disabled ?? null : null,
    closeDisabled: editor ? editor.querySelector('.dialog-close')?.disabled ?? null : null,
    caretInName: Boolean(nameInput) && active === nameInput,
    settingsOpen: Boolean(document.querySelector('.settings-workspace')),
    listVisible: Boolean(document.querySelector('.provider-card') || document.querySelector('.provider-empty') || document.querySelector('.provider-add')),
    templatePickerOpen: Boolean(document.querySelector('.provider-template-picker')),
    active: active instanceof HTMLElement ? {
      tag: active.tagName.toLowerCase(),
      className: typeof active.className === 'string' ? active.className : null,
      ariaLabel: active.getAttribute('aria-label'),
    } : null,
  };
})()`

const readEditor = (client) => evaluate(client, EDITOR_EXPRESSION)

/** A real Escape key press: the same event a keyboard user produces. */
async function pressEscape(client) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    })
  }
  await delay(220)
}

/** Real key events, so the draft is typed the way a user types it and the caret stays in the field. */
async function typeText(client, text) {
  // Ctrl+A first: the name field arrives holding the provider's current name, and a user replacing it
  // would not end up with the old value prefixed to what they typed.
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
    })
  }
  await delay(80)
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
  await delay(200)
}

async function clickDom(client, selector, text = null) {
  return evaluate(client, `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = ${text === null ? 'nodes[0]' : `nodes.find((item) => (item.textContent || '').includes(${JSON.stringify(text)}))`};
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function focusNameField(client) {
  return evaluate(client, `(() => {
    const input = [...document.querySelectorAll('.provider-editor .settings-inline-field input')][1];
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    return document.activeElement === input;
  })()`)
}

async function waitForEditorState(client, predicate, label, timeoutMs = 20_000) {
  return harness.waitFor(async () => {
    const state = await readEditor(client).catch(() => undefined)
    return state && predicate(state) ? state : undefined
  }, timeoutMs, label).catch(async () => readEditor(client))
}

/** Fail or hold the next provider save, and count every one the renderer issues. */
const INSTALL_SAVE_PROBE = `(() => {
  if (window.__lsSaveProbe) return true;
  const probe = { saves: 0, delayNextMs: 0 };
  window.__lsSaveProbe = probe;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/config/providers')) {
      probe.saves += 1;
      if (probe.delayNextMs > 0) {
        const waitMs = probe.delayNextMs;
        probe.delayNextMs = 0;
        await new Promise((done) => setTimeout(done, waitMs));
      }
    }
    return originalFetch(input, init);
  };
  return true;
})()`

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key-not-a-credential',
      timeoutSeconds: 10,
      models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `acceptance/slow-a`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
  }
}

async function startWindow({ root, provider }) {
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')
  const electron = await harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath,
    extraEnv: { OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GLM_API_KEY: undefined },
  })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  await harness.desktopAction(locator, 'park-offscreen')
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  return { electron, locator, client, logPath }
}

async function openSettingsPage(client, label) {
  await evaluate(client, `(() => {
    if (!document.querySelector('.settings-workspace')) document.querySelector('.settings-entry-btn')?.click();
    return true;
  })()`)
  await harness.waitFor(
    () => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`),
    harness.startTimeoutMs,
    'the settings navigation',
  )
  const opened = await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.settings-nav-item')];
    const target = items.find((item) => (item.textContent || '').includes(${JSON.stringify(label)}));
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  })()`)
  if (!opened) throw new Error(`the ${label} navigation item is missing`)
  await delay(400)
}

/** Open the editor through the list's own edit entry, unless a restored draft already opened it. */
async function openEditor(client) {
  const opened = await evaluate(client, `(() => {
    if (document.querySelector('.provider-editor')) return 'already-open';
    const button = [...document.querySelectorAll('.provider-card .save-btn')][0];
    if (!(button instanceof HTMLElement)) return 'missing';
    button.click();
    return 'clicked';
  })()`)
  if (opened === 'missing') throw new Error('no provider edit entry was found')
  return waitForEditorState(client, (state) => (state.editorOpen ? state : undefined), 'the provider editor')
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

/**
 * Which bundle the walkthrough ran against, and whether that bundle registers the editor's Escape
 * scopes at all. The pre-fix reading is taken from the same build with those two registrations
 * removed, so the evidence has to say which of the two it measured.
 */
async function readBundleIdentity(recorder) {
  const assetsDir = join(repoRoot, 'packages/app/out/renderer/assets')
  const identity = { assets: [], escapeScopes: [] }
  const names = (await readdir(assetsDir).catch(() => [])).filter((name) => name.endsWith('.js')).sort()
  for (const name of names) {
    const bytes = await readFile(join(assetsDir, name))
    const text = bytes.toString('utf8')
    if (!text.includes('provider-editor-discard')) continue
    identity.assets.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) })
    identity.escapeScopes.push({
      asset: name,
      closeOnEscape: /useEscapeScope\(onCancel,\s*!saving && !discardConfirm\)/u.test(text),
      keepEditingOnEscape: /useEscapeScope\(onKeepEditing,\s*discardConfirm\)/u.test(text),
      anyEscapeScopeCall: (text.match(/useEscapeScope\(/gu) ?? []).length,
    })
  }
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/app/out/.littlesheep-build-fingerprint.json'), 'utf8'))
    identity.manifest = { createdAt: manifest.createdAt, mode: manifest.mode, inputDigest: manifest.input?.digest ?? null, outputDigest: manifest.output?.digest ?? null }
  } catch (error) {
    identity.manifest = { error: error instanceof Error ? error.message : String(error) }
  }
  recorder.note({ step: 'bundle', ...identity })
  return identity
}

/**
 * A build in progress removes the fingerprint sidecar for its duration, and the window cannot be
 * launched without it. Waiting is bounded and recorded; it never turns a missing manifest into a
 * passing measurement.
 */
async function waitForBuildManifest(recorder, timeoutMs = 300_000) {
  const startedAt = Date.now()
  let waitedMs = 0
  for (;;) {
    try {
      await readFile(join(repoRoot, 'packages/app/out/.littlesheep-build-fingerprint.json'))
      break
    } catch {
      // Not written yet (or being rewritten): a concurrent build owns it right now.
    }
    if (Date.now() - startedAt > timeoutMs) break
    await delay(2_000)
    waitedMs = Date.now() - startedAt
  }
  recorder.note({ step: 'build-manifest-wait', waitedMs })
}

async function main() {
  const keep = process.argv.includes('--keep')
  const staleBuildDiagnostic = process.argv.includes('--stale-build-diagnostic')
  const recorder = createRecorder()

  await waitForBuildManifest(recorder)
  const bundle = await readBundleIdentity(recorder)
  const freshness = await inspectAppBuildFreshness(repoRoot).catch((error) => ({
    fresh: false,
    reason: 'inspection-failed',
    detail: error instanceof Error ? error.message : String(error),
  }))
  if (!staleBuildDiagnostic) await harness.assertBuildFresh()
  recorder.note({
    step: 'build-freshness',
    assertedFresh: !staleBuildDiagnostic,
    fresh: freshness.fresh,
    reason: freshness.reason,
    inputDigest: freshness.manifest?.input?.digest ?? null,
  })

  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-settings-escape-'))
  let handle
  const cases = {}
  try {
    handle = await startWindow({ root, provider })
    const { client, locator } = handle
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer',
    )
    if (!await evaluate(client, INSTALL_SAVE_PROBE)) throw new Error('the save probe could not be installed')
    await openSettingsPage(client, '模型供应商')
    const providersBefore = await harness.fetchJson(locator, '/config/providers').then((response) => response.body?.providers ?? null)
    recorder.check(
      providersBefore !== null && providersBefore.some((entry) => entry.id === PROVIDER_ID),
      'the fixture provider is configured, so the editor has something real to edit',
      { providers: providersBefore?.map((entry) => entry.id) ?? null },
    )

    // --- A. a clean editor closes on Escape, and only that layer closes -------------------------
    await openEditor(client)
    const clean = await readEditor(client)
    recorder.check(clean.editorOpen === true && clean.status === null, 'the editor opened with nothing to ask about', clean)
    await pressEscape(client)
    const afterCleanEscape = await readEditor(client)
    cases.cleanEscape = afterCleanEscape
    recorder.note({ step: 'clean-escape', ...afterCleanEscape })
    recorder.check(afterCleanEscape.editorOpen === false, 'Escape closes an editor with no unsaved edits', afterCleanEscape)
    recorder.check(afterCleanEscape.discardConfirm === null, 'a clean editor never asks about discarding', afterCleanEscape.discardConfirm)
    recorder.check(afterCleanEscape.settingsOpen === true, 'Escape closed the editor, not the settings surface behind it', afterCleanEscape)

    // --- B. unsaved edits: Escape asks instead of dropping them ---------------------------------
    await openEditor(client)
    const focusedName = await focusNameField(client)
    recorder.check(focusedName === true, 'the caret could be placed in the name field', focusedName)
    await typeText(client, DRAFT_NAME)
    const dirty = await readEditor(client)
    recorder.check(dirty.name === DRAFT_NAME && dirty.status === '已修改，尚未保存。', 'the editor reports unsaved edits', dirty)
    recorder.check(dirty.caretInName === true, 'the caret is in the field that was typed into', dirty.active)
    await pressEscape(client)
    const afterDirtyEscape = await readEditor(client)
    cases.dirtyEscape = afterDirtyEscape
    recorder.note({ step: 'dirty-escape', ...afterDirtyEscape })
    recorder.check(
      afterDirtyEscape.discardConfirm !== null,
      'Escape with unsaved edits asks before dropping them instead of doing nothing',
      { discardConfirm: afterDirtyEscape.discardConfirm, editorOpen: afterDirtyEscape.editorOpen },
    )
    recorder.check(afterDirtyEscape.editorOpen === true, 'the editor stays open while the question is unanswered', afterDirtyEscape)
    recorder.check(afterDirtyEscape.name === DRAFT_NAME, 'the question does not drop the draft', afterDirtyEscape.name)
    recorder.check(afterDirtyEscape.caretInName === true, 'the caret stays in the field the question is about', afterDirtyEscape.active)
    recorder.check(
      afterDirtyEscape.discardConfirm?.actions.some((label) => label.includes('继续编辑')) === true
      && afterDirtyEscape.discardConfirm?.actions.some((label) => label.includes('丢弃修改')) === true,
      'the question offers both answers',
      afterDirtyEscape.discardConfirm?.actions ?? null,
    )
    recorder.check(afterDirtyEscape.settingsOpen === true, 'the question is the only layer Escape opened', afterDirtyEscape.settingsOpen)

    // --- C. Escape in the question keeps editing ------------------------------------------------
    if (afterDirtyEscape.discardConfirm !== null) {
      await pressEscape(client)
      const afterQuestionEscape = await readEditor(client)
      cases.discardQuestionEscape = afterQuestionEscape
      recorder.note({ step: 'discard-question-escape', ...afterQuestionEscape })
      recorder.check(afterQuestionEscape.discardConfirm === null, 'Escape answers the question by keeping the editor', afterQuestionEscape.discardConfirm)
      recorder.check(afterQuestionEscape.editorOpen === true, 'the editor is still open after that answer', afterQuestionEscape)
      recorder.check(afterQuestionEscape.name === DRAFT_NAME && afterQuestionEscape.status === '已修改，尚未保存。', 'the draft survived the question', afterQuestionEscape)
      recorder.check(afterQuestionEscape.caretInName === true, 'the caret never left the field', afterQuestionEscape.active)
    } else {
      recorder.check(false, 'the discard question was never shown, so Escape in it could not be checked', cases.dirtyEscape?.discardConfirm ?? null)
    }

    // --- D. the question's other answer still works (control case) ------------------------------
    // Reached through the close entry, which is the path this question already had: whatever
    // Escape does, the × and both answers keep behaving.
    const closeClicked = await clickDom(client, '.provider-editor .dialog-close')
    const askedByClose = await waitForEditorState(client, (state) => (state.discardConfirm ? state : undefined), 'the close entry to ask')
    recorder.check(closeClicked === true && askedByClose.discardConfirm !== null, 'the close entry asks the same question', askedByClose.discardConfirm)
    const discardClicked = await clickDom(client, '.provider-editor-discard button', '丢弃修改')
    const afterDiscard = await waitForEditorState(client, (state) => (!state.editorOpen ? state : undefined), 'the editor to close after 丢弃修改')
    cases.discard = { discardClicked, ...afterDiscard }
    recorder.note({ step: 'discard-answer', ...cases.discard })
    recorder.check(discardClicked === true && afterDiscard.editorOpen === false, '丢弃修改 still closes the editor', afterDiscard)
    const reopened = await openEditor(client)
    cases.reopenAfterDiscard = reopened
    recorder.check(reopened.name === PROVIDER_NAME, '丢弃修改 still drops the draft', reopened)
    recorder.check(reopened.status === null, 'the reopened editor is clean again', reopened.status)

    // --- E. Escape while a save is in flight closes nothing, and the save lands ------------------
    const focusedForSave = await focusNameField(client)
    await typeText(client, SAVE_NAME)
    await evaluate(client, `(() => { window.__lsSaveProbe.delayNextMs = 1600; return true })()`)
    const saveClicked = await clickDom(client, '.provider-editor .save-btn')
    const saving = await waitForEditorState(client, (state) => (state.saveLabel === '保存中…' ? state : undefined), 'the save to report progress')
    recorder.check(saveClicked === true && saving.saveLabel === '保存中…', 'the save is in flight', saving)
    await pressEscape(client)
    const afterSavingEscape = await readEditor(client)
    cases.savingEscape = afterSavingEscape
    recorder.note({ step: 'saving-escape', ...afterSavingEscape })
    recorder.check(afterSavingEscape.editorOpen === true, 'Escape does not close the editor while a save is in flight', afterSavingEscape)
    recorder.check(afterSavingEscape.saveLabel === '保存中…', 'the save is still the editor\'s state after Escape', afterSavingEscape.saveLabel)
    recorder.check(afterSavingEscape.discardConfirm === null, 'Escape while saving does not open the discard question', afterSavingEscape.discardConfirm)
    recorder.check(afterSavingEscape.name === SAVE_NAME, 'Escape while saving does not touch the draft', afterSavingEscape.name)
    const saved = await waitForEditorState(client, (state) => (!state.editorOpen ? state : undefined), 'the editor to close when the save lands', 30_000)
    const probe = await evaluate(client, `window.__lsSaveProbe`)
    const listText = await evaluate(client, `document.querySelector('.provider-cards')?.textContent ?? ''`)
    recorder.check(saved.editorOpen === false, 'the editor closes when the save really lands', saved)
    recorder.check(probe.saves === 1, 'exactly one save request was issued', probe)
    recorder.check(listText.includes(SAVE_NAME), 'the saved name is what the list now shows', listText.slice(0, 160))

    // --- F. the template picker on the same page (recorded, not fixed by this package) ----------
    const pickerClicked = await clickDom(client, '.provider-add')
    const picker = await waitForEditorState(client, (state) => (state.templatePickerOpen ? state : undefined), 'the template picker')
    await pressEscape(client)
    const afterPickerEscape = await readEditor(client)
    cases.templatePicker = { pickerClicked, opened: picker.templatePickerOpen, afterEscape: afterPickerEscape.templatePickerOpen }
    recorder.note({ step: 'template-picker-escape', ...cases.templatePicker })

    const desktop = await harness.desktopSnapshot(locator)
    recorder.check(desktop?.activeRunCount === 0, 'no run is left active at the end', desktop?.activeRunCount ?? null)
  } catch (error) {
    recorder.check(false, 'the escape walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : null,
    })
  } finally {
    await stopWindow(handle)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root).catch(() => undefined)
  }

  const evidence = {
    check: 'settings-escape-scopes',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    artifactsRoot: runArtifactsRoot,
    buildFreshness: { asserted: !staleBuildDiagnostic, fresh: freshness.fresh, reason: freshness.reason },
    bundle,
    cases,
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The window is parked off every display and shown inactively, so this proves DOM state, focus and key delivery - not what a user sees painted (the pixel side of the same surface is a different gate).',
      'Case D is a control: it reaches the discard question through the close entry, the path that already worked, so a pre-fix run shows the question, its two answers and the draft drop behaving while the Escape cases fail.',
      'Case E holds the save open with the same page-level fetch probe `verify:provider-editor-draft` uses: the request really is in flight when Escape is pressed, and the case then waits for the real save to land.',
      'Case F records the template picker on the same settings page. It is not fixed by this package (the audited gap was the editor and its discard question); the measurement is here so the next reader sees whether that dialog answers Escape without having to re-run anything.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  await mkdir(runArtifact(OUT_ROOT), { recursive: true })
  await writeFile(runArtifact(OUT_ROOT, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  if (!evidence.ok) process.exitCode = 1
}

await main()
