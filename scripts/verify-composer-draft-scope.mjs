// Real-window acceptance for composer draft scope (P1).
//
// Measured defect: the unsent draft — and its attachment chips — followed the user into whatever
// conversation they opened next. Typing a draft in a brand-new conversation and then clicking
// another conversation in the sidebar switched the transcript (that row became `.active`) while the
// composer still held the first conversation's draft with send enabled, so Enter delivered it to the
// wrong thread; the chips carried workspace paths belonging to the conversation just left. The
// product already modelled a draft as belonging to one conversation (`persistent-state.ts`
// `restoreComposerDraft` compares `composerSessionId`), but the runtime never enforced it.
//
// The walkthrough, on one fresh isolated data root with the deterministic acceptance provider:
//   1. a new conversation holds a distinctive draft (typed with real CDP key events) plus one
//      attachment chip, and the send control accepts it;
//   2. switching to the conversation created earlier shows an EMPTY composer there — no text, no
//      chips — and the send control refuses it, while the transcript really did switch;
//   3. switching back restores the draft and the chip verbatim;
//   4. the reverse direction holds too (the older conversation keeps its own draft),
//   5. and sending in one conversation clears only that conversation's draft: the other
//      conversation's draft is still there afterwards, and the sent conversation stays cleared.
// The Provider request log is asserted as well: the unsent draft never reaches the model.
//
// Usage:
//   node scripts/verify-composer-draft-scope.mjs [--keep] [--stale-build-diagnostic]
//
// `--stale-build-diagnostic` measures whatever is in `packages/app/out` even when it does not match
// the sources. It exists for one purpose: recording the pre-fix bundle for the before/after pair.
// Freshness is asserted by default, and the evidence always records which of the two ran.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { inspectAppBuildFreshness } from './lib/app-build-fingerprint.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { runArtifact, runArtifactsRoot } from './lib/run-artifacts.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const PROVIDER_ID = 'acceptance-gw'
const MODEL_ID = 'slow-a'
const API_KEY = 'acceptance-key-not-a-credential'
/** The draft typed in the not-yet-saved conversation. Distinctive, and never meant to be sent. */
const DRAFT_NEW = '这段草稿只属于新对话：draft-scope-9c41-A'
/** The draft typed in the conversation created by the seed turn. */
const DRAFT_SEED = '这段草稿只属于这个已有对话：draft-scope-9c41-B'
/** The turn that creates the conversation the walkthrough switches to. */
const SEED_TEXT = '先建立一个可以切回来的对话。'
const CHIP_NAME = 'draft-scope-chip.txt'
const CHIP_CONTENT = 'draft scope chip\n'

/**
 * Composer, transcript, sidebar and gate state in one read.
 *
 * `.session-item.active` is the row the transcript is showing; the send control's own `disabled`
 * and accessible name are read together with the draft, because "the composer is empty" only counts
 * if the control reflects it (an empty draft disables send; a model/execution gate would instead
 * replace the label with its reason).
 */
const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const textarea = document.querySelector('.composer textarea');
  const send = document.querySelector('.composer-run-actions .send-round:not(.stop)');
  const trigger = document.querySelector('.runtime-picker-trigger');
  const chips = [...document.querySelectorAll('.attachment-preview-grid .attachment-preview-card')]
    .map((card) => {
      const open = card.querySelector('.attachment-preview-open');
      return {
        name: (card.querySelector('.attachment-preview-meta span')?.textContent || '').trim() || null,
        label: open ? open.getAttribute('aria-label') : null,
      };
    });
  return {
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    focused: textarea instanceof HTMLTextAreaElement && document.activeElement === textarea,
    sendPresent: Boolean(send),
    sendDisabled: send ? send.disabled === true : null,
    sendLabel: send ? send.getAttribute('aria-label') : null,
    blockNotice: text('.composer-send-block'),
    pickerAria: trigger ? trigger.getAttribute('aria-label') : null,
    chips,
    sessionRows: [...document.querySelectorAll('.session-list .session-item')].map((row) => ({
      title: (row.querySelector('.session-title')?.textContent || '').trim(),
      active: row.classList.contains('active'),
    })),
    userMessages: [...document.querySelectorAll('.message.user')].map((node) => (node.textContent || '').trim()),
    assistantMessages: document.querySelectorAll('.message.assistant').length,
    running: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
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

async function readSurface(client) {
  return client.evaluate(SURFACE_EXPRESSION)
}

async function waitForSurface(client, predicate, timeoutMs, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client).catch(() => undefined)
    return surface && predicate(surface) ? surface : undefined
  }, timeoutMs, label)
}

/** Wait for a condition, then read the surface once more: the observation is what was asserted on. */
async function surfaceAfter(client, predicate, timeoutMs, label) {
  await waitForSurface(client, predicate, timeoutMs, label).catch(() => undefined)
  return readSurface(client)
}

async function waitForReadiness(locator, state, timeoutMs = 60_000) {
  return harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    const readiness = response?.body?.readiness ?? response?.body
    return readiness?.state === state ? readiness : undefined
  }, timeoutMs, `readiness ${state}`)
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

async function pressEnter(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
}

async function focusComposer(client) {
  return client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.focus();
    return document.activeElement === textarea;
  })()`)
}

/**
 * Paste a file into the composer.
 *
 * This is the clipboard path the composer already implements (`handleComposerPaste`); the File is
 * synthetic, so it has no filesystem path and `importAttachment` asks the Local App API for a
 * managed copy — which is exactly how a pasted/copied file becomes a chip with a real path.
 */
async function pasteFile(client, name, content) {
  return client.evaluate(`(async () => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/plain' }));
    textarea.focus();
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    return true;
  })()`)
}

/**
 * Press the "new conversation" button.
 *
 * `.sidebar-section-action.sidebar-new-action` is shared with the project section's "new project"
 * button, so the selector is scoped to the conversation section and the accessible name is
 * verified before the click — a careless selector opens the New Project dialog instead.
 */
async function clickNewConversation(client) {
  return client.evaluate(`(() => {
    const button = document.querySelector('.conversation-section .sidebar-section-action.sidebar-new-action');
    if (!(button instanceof HTMLElement)) return { clicked: false, ariaLabel: null };
    const ariaLabel = button.getAttribute('aria-label');
    button.click();
    return { clicked: true, ariaLabel };
  })()`)
}

async function clickSessionRow(client) {
  return client.evaluate(`(() => {
    const row = document.querySelector('.session-list .session-item');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`)
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

async function startWindow({ root, provider }) {
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
    // Ambient provider keys would make this root "configured" for a provider this fixture does not
    // serve; the fixture decides what counts as configured.
    extraEnv: { OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GLM_API_KEY: undefined },
  })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  await waitForReadiness(locator, 'ready')
  // A hidden window is backgrounded, so Chromium stops rendering frames and the surfaces mounted
  // from measured layout never appear. Parking the window off every display renders it without
  // landing on the user's desktop and without taking focus.
  await harness.desktopAction(locator, 'park-offscreen')
  await delay(300)
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
    30_000,
    'the composer textarea',
  )
  // The model gate must be satisfied, otherwise the send control would refuse for a reason that has
  // nothing to do with this contract.
  await waitForSurface(
    client,
    (surface) => (surface.pickerAria?.includes(MODEL_ID) ? surface : undefined),
    60_000,
    'the configured model in the runtime picker',
  )
  return { electron, locator, client, dataDir, logPath }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

async function capture(client, name, recorder) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).catch(() => undefined)
  if (!shot?.data) {
    recorder.note({ step: 'screenshot', name, captured: false })
    return null
  }
  const path = runArtifact('composer-draft-scope', name)
  mkdirSync(join(runArtifactsRoot, 'composer-draft-scope'), { recursive: true })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  recorder.note({ step: 'screenshot', name, captured: true, path })
  return path
}

/** One settled turn: `running` seen, then the transcript holding a user message and an answer. */
async function runTurn(client, surface, waitMs = 90_000) {
  const started = await surfaceAfter(client, (state) => (state.running ? state : undefined), 30_000, 'the turn to start')
  const settled = await surfaceAfter(
    client,
    (state) => (!state.running && state.assistantMessages > 0 ? state : undefined),
    waitMs,
    'the turn to settle',
  )
  return { started, settled }
}

async function main() {
  const keep = process.argv.includes('--keep')
  const staleBuildDiagnostic = process.argv.includes('--stale-build-diagnostic')
  const recorder = createRecorder()

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
  })

  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-draft-scope-'))
  let handle
  const screenshots = []
  try {
    handle = await startWindow({ root, provider })
    const { client, locator } = handle

    // --- 0. the fixture itself: one fresh root, one empty new conversation ---------------
    const first = await readSurface(client)
    recorder.check(provider.baseURL.startsWith('http://127.0.0.1:'), 'the deterministic Provider is the only configured model', provider.baseURL)
    recorder.check(first.draft === '', 'a fresh window opens with an empty composer', first)
    recorder.check(first.sessionRows.length === 0, 'a fresh root has no conversation yet', first.sessionRows)
    recorder.check(
      first.sendDisabled === true && first.sendLabel === '发送' && first.blockNotice === null,
      'the empty composer refuses the send, and not for a model or execution reason',
      { sendDisabled: first.sendDisabled, sendLabel: first.sendLabel, blockNotice: first.blockNotice },
    )

    // --- 1. a conversation to switch to ------------------------------------------------
    await focusComposer(client)
    await typeText(client, SEED_TEXT)
    await pressEnter(client)
    await runTurn(client, await readSurface(client))
    const seeded = await surfaceAfter(
      client,
      (state) => (state.sessionRows.length === 1 && state.draft === '' ? state : undefined),
      30_000,
      'the seed conversation to appear in the sidebar',
    )
    recorder.check(
      seeded.sessionRows.length === 1 && seeded.sessionRows[0].active === true,
      'the seed turn created one conversation and the window is in it',
      seeded.sessionRows,
    )
    recorder.check(seeded.draft === '' && seeded.userMessages.length === 1, 'the seed turn left an empty composer and one user message', {
      draft: seeded.draft,
      userMessages: seeded.userMessages,
    })

    // --- 2. a new conversation holds a draft that belongs to it only -------------------
    const clickedNew = await clickNewConversation(client)
    recorder.check(
      clickedNew.clicked === true && clickedNew.ariaLabel === '新建对话',
      'the new-conversation control was pressed (not the project section\'s shared-class button)',
      clickedNew,
    )
    const emptyNew = await surfaceAfter(
      client,
      (state) => (!state.sessionRows.some((row) => row.active) && state.draft === '' ? state : undefined),
      20_000,
      'the new conversation to open',
    )
    recorder.check(
      !emptyNew.sessionRows.some((row) => row.active) && emptyNew.draft === '',
      'the new conversation opened empty, with the transcript off the seeded session',
      emptyNew,
    )
    await focusComposer(client)
    await typeText(client, DRAFT_NEW)
    await pasteFile(client, CHIP_NAME, CHIP_CONTENT)
    const typed = await surfaceAfter(
      client,
      (state) => (state.draft === DRAFT_NEW && state.chips.length === 1 ? state : undefined),
      20_000,
      'the typed draft and its attachment chip',
    )
    recorder.check(typed.draft === DRAFT_NEW, 'the draft was typed with real key events', { draft: typed.draft })
    recorder.check(typed.focused === true, 'the caret stayed in the composer while typing', typed)
    recorder.check(
      typed.chips.length === 1 && (typed.chips[0].label ?? '').includes(CHIP_NAME),
      'the draft carries the attachment chip, with the path the Local App API returned',
      typed.chips,
    )
    recorder.check(
      typed.sendDisabled === false && typed.sendLabel === '发送',
      'the new conversation accepts sending its own draft',
      { sendDisabled: typed.sendDisabled, sendLabel: typed.sendLabel },
    )
    screenshots.push(await capture(client, 'draft-in-new-conversation.png', recorder))

    // --- 3. switching away shows THAT conversation's draft (the measured defect) -------
    await clickSessionRow(client)
    const switched = await surfaceAfter(
      client,
      (state) => (state.sessionRows.some((row) => row.active) && state.draft === '' ? state : undefined),
      40_000,
      'the seeded conversation to become active with an empty composer',
    )
    recorder.note({ step: 'switched-to-seeded', surface: switched })
    recorder.check(
      switched.sessionRows.some((row) => row.active === true),
      'the transcript really switched: a sidebar row is active',
      switched.sessionRows,
    )
    recorder.check(
      switched.draft === '',
      'the opened conversation shows an empty composer, not the draft typed in the other one',
      { draft: switched.draft },
    )
    recorder.check(
      switched.chips.length === 0,
      'and none of the other conversation\'s attachment chips are there',
      switched.chips,
    )
    recorder.check(
      switched.sendDisabled === true && switched.sendLabel === '发送' && switched.blockNotice === null,
      'the send control there reflects the empty draft instead of offering to send the other one',
      { sendDisabled: switched.sendDisabled, sendLabel: switched.sendLabel, blockNotice: switched.blockNotice },
    )
    recorder.check(
      !switched.userMessages.some((message) => message.includes(DRAFT_NEW)),
      'the draft is not in this conversation\'s transcript either',
      switched.userMessages,
    )
    screenshots.push(await capture(client, 'empty-composer-after-switch.png', recorder))

    // --- 4. switching back restores the draft verbatim ---------------------------------
    const backClicked = await clickNewConversation(client)
    const restored = await surfaceAfter(
      client,
      (state) => (state.draft === DRAFT_NEW && state.chips.length === 1 ? state : undefined),
      20_000,
      'the draft of the unsent conversation to come back',
    )
    recorder.note({ step: 'restored', surface: restored, clicked: backClicked })
    recorder.check(restored.draft === DRAFT_NEW, 'switching back restores the draft verbatim', { draft: restored.draft, expected: DRAFT_NEW })
    recorder.check(
      restored.chips.length === 1 && restored.chips[0].label === typed.chips[0].label,
      'and restores the same attachment chip, path included',
      { restored: restored.chips, typed: typed.chips },
    )
    recorder.check(restored.sendDisabled === false, 'the restored draft is sendable again', restored)

    // --- 5. the older conversation keeps its own draft, in both directions -------------
    await clickSessionRow(client)
    const seedEmpty = await surfaceAfter(
      client,
      (state) => (state.sessionRows.some((row) => row.active) && state.draft === '' && state.chips.length === 0
        ? state
        : undefined),
      40_000,
      'the seeded conversation again, still empty',
    )
    recorder.check(
      seedEmpty.draft === '' && seedEmpty.chips.length === 0,
      'coming back to the older conversation from the restored one is still empty there',
      { draft: seedEmpty.draft, chips: seedEmpty.chips.length },
    )
    await focusComposer(client)
    await typeText(client, DRAFT_SEED)
    const seedTyped = await surfaceAfter(client, (state) => (state.draft === DRAFT_SEED ? state : undefined), 20_000, 'the second draft')
    recorder.check(seedTyped.draft === DRAFT_SEED, 'the older conversation took its own draft', { draft: seedTyped.draft })
    await clickNewConversation(client)
    const otherDirection = await surfaceAfter(client, (state) => (state.draft === DRAFT_NEW ? state : undefined), 20_000, 'the new conversation draft')
    recorder.check(
      otherDirection.draft === DRAFT_NEW && !otherDirection.draft.includes(DRAFT_SEED),
      'each conversation shows its own draft, in both directions',
      { draft: otherDirection.draft, otherDraft: DRAFT_SEED },
    )
    await clickSessionRow(client)
    const seedRestored = await surfaceAfter(client, (state) => (state.draft === DRAFT_SEED ? state : undefined), 40_000, 'the older draft to come back')
    recorder.check(seedRestored.draft === DRAFT_SEED, 'the older conversation restores its draft verbatim too', { draft: seedRestored.draft })

    // --- 6. sending clears only the conversation it was sent in ------------------------
    await focusComposer(client)
    await pressEnter(client)
    const sent = await runTurn(client, await readSurface(client))
    const sentSettled = await surfaceAfter(
      client,
      (state) => (!state.running && state.assistantMessages >= 2 ? state : undefined),
      90_000,
      'the sent turn to settle',
    )
    recorder.note({ step: 'sent-in-seeded', started: sent.started.running, settled: sentSettled })
    recorder.check(
      sent.started.running === true,
      'Enter dispatched the draft of the conversation it was typed in',
      { running: sent.started.running },
    )
    recorder.check(
      sentSettled.userMessages.some((message) => message.includes(DRAFT_SEED)),
      'the sent turn carries that conversation\'s draft',
      sentSettled.userMessages,
    )
    recorder.check(
      sentSettled.draft === '' && sentSettled.chips.length === 0,
      'sending cleared the draft of the conversation it was sent in',
      { draft: sentSettled.draft, chips: sentSettled.chips.length },
    )
    await clickNewConversation(client)
    const afterSendNew = await surfaceAfter(client, (state) => (state.draft === DRAFT_NEW ? state : undefined), 20_000, 'the untouched draft')
    recorder.check(
      afterSendNew.draft === DRAFT_NEW && afterSendNew.chips.length === 1,
      'sending in one conversation did not clear another conversation\'s draft',
      { draft: afterSendNew.draft, chips: afterSendNew.chips.length },
    )
    await clickSessionRow(client)
    const afterSendBack = await surfaceAfter(
      client,
      (state) => (state.sessionRows.some((row) => row.active) && state.draft === '' ? state : undefined),
      40_000,
      'the sent conversation again',
    )
    recorder.check(
      afterSendBack.draft === '' && afterSendBack.chips.length === 0,
      'the conversation that sent stays cleared when it is reopened',
      { draft: afterSendBack.draft, chips: afterSendBack.chips.length },
    )

    // --- 7. the unsent draft never reached the model -----------------------------------
    const providerRequests = await (await fetch(provider.requestsURL)).json()
    const promptTexts = providerRequests.requests.flatMap((entry) => (entry.messages ?? []).map((message) => message.content ?? ''))
    recorder.note({
      step: 'provider-requests',
      count: providerRequests.requests.length,
      models: providerRequests.requests.map((entry) => entry.model),
    })
    recorder.check(
      promptTexts.some((text) => text.includes(DRAFT_SEED)),
      'the Provider received the draft that was actually sent',
      { requests: providerRequests.requests.length },
    )
    recorder.check(
      !promptTexts.some((text) => text.includes(DRAFT_NEW)),
      'and never received the unsent draft of the other conversation',
      { requests: providerRequests.requests.length },
    )
    const desktop = await harness.desktopSnapshot(locator)
    recorder.note({ step: 'desktop', activeRunCount: desktop?.activeRunCount ?? null })
    recorder.check(desktop?.activeRunCount === 0, 'no run is left active at the end', desktop?.activeRunCount ?? null)
  } catch (error) {
    recorder.check(false, 'the draft-scope walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await stopWindow(handle)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root).catch(() => undefined)
  }

  const evidence = {
    check: 'composer-draft-scope',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    artifactsRoot: runArtifactsRoot,
    screenshots: screenshots.filter(Boolean),
    buildFreshness: { asserted: !staleBuildDiagnostic, fresh: freshness.fresh, reason: freshness.reason },
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The window is parked off every display so Chromium renders frames (and screenshots work); it never lands on the user\'s desktop, so this proves DOM state and key delivery, not what a user sees painted.',
      'The attachment chip comes from the composer\'s own paste path with a synthetic File, so the chip carries the managed copy the Local App API returned for it; the native file picker (`addAttachments`) cannot be driven over CDP.',
      'The "switch back" step uses the sidebar\'s new-conversation control, because a conversation that was never sent has no sidebar row to click; it is the same unsent-conversation slot the draft was typed in, and the seeded conversation is used for the row-to-row direction.',
      'Drafts are runtime state keyed by `currentSession ?? \'draft\'`; `persistent-state.ts` still persists the single entry it always did, so restart-time recovery across several conversations is not asserted here.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  mkdirSync(join(runArtifactsRoot, 'composer-draft-scope'), { recursive: true })
  writeFileSync(runArtifact('composer-draft-scope', 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  if (!evidence.ok) process.exitCode = 1
}

await main()
