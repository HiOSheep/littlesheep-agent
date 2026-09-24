// Real-window interaction acceptance for the early-available shell (CS-03/CS-06).
//
// The window is deliberately usable before the Runtime is ready, so the things
// that can silently break are interactions, not timings:
//
//   1. the composer accepts typing and window operations while execution is
//      still unavailable;
//   2. a send attempt in that window is refused in place and never reported as
//      accepted, and the window states the Runtime's own phase while the send
//      entry stays disabled;
//   3. when readiness arrives, the draft, the focused element and the current
//      conversation are exactly what the user left — enabling capability must be
//      an in-place transition, not a reload;
//   4. no page navigation happens across the handoff.
//
// The not-ready window is about 300 ms on a normal start, which is too short to
// type into and read a notice, so this script asks the app to hold back the
// readiness *publish* (`LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS`, acceptance-only;
// the Runner is still built normally). The measured window is asserted to have
// been open, so these steps cannot pass by accident against a ready runtime. Every
// step still records what it actually observed.
//
// Usage:
//   node scripts/verify-desktop-cold-start-interaction.mjs [--out=docs/reference/cold-start-baseline/screenshots] [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline/screenshots'))

/** Acceptance-only readiness delay; also the window this script needs. */
const NOT_READY_WINDOW_MS = 6_000

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-cold-start-interaction-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  const observations = []
  const failures = []
  let client
  let child
  let spawnRequestedAt = 0

  try {
    await mkdir(outDir, { recursive: true })
    await seedSessions(dataDir)
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: {
        LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
        // The real not-ready window is about 300 ms, which is too short to type
        // into, refuse a send and read the notice before it closes. The Runner is
        // still built normally; only the readiness publish is held back, so this
        // widens the window instead of faking a slow or failed start.
        LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS: String(NOT_READY_WINDOW_MS),
      },
      onSpawn: ({ spawnRequestedAt: at }) => { spawnRequestedAt = at },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)

    const markupBefore = await readComposerIdentity(client)
    const readinessAtAttach = await readReadiness(locator)
    // The window must not greet the user with a failure for work it simply cannot
    // do yet (history comes from the Runner), so the error surfaces are read
    // before any interaction.
    const noticesAtAttach = await readNoticeSurfaces(client)
    observations.push({ step: 'attached', readiness: readinessAtAttach, notices: noticesAtAttach })
    if (noticesAtAttach.errorText !== null) {
      failures.push({ check: 'the not-ready window opens without an error banner', detail: noticesAtAttach })
    }

    // 1. Type while execution may still be unavailable. `beforeinput` is
    //    dispatched so the assertion exercises the same handler a real keypress
    //    would, instead of only assigning `value` from the outside.
    const typed = await typeComposerDraft(client, '冷启动草稿')
    observations.push({ step: 'typed-while-not-ready', typed, readinessWasReady: readinessAtAttach?.state === 'ready' })
    if (!typed || typed.value !== '冷启动草稿' || !typed.focused) {
      failures.push({ check: 'composer accepts a draft before execution is ready', detail: typed })
    }

    // 2. A send attempt must not be reported as accepted while the Runtime is
    //    unavailable. When readiness already arrived this step is skipped, and
    //    that is recorded rather than guessed.
    if (readinessAtAttach?.state !== 'ready') {
      const attempted = await client.evaluate(`(() => {
        const input = document.querySelector('.composer textarea');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return { value: input.value };
      })()`)
      await delay(400)
      const after = await client.evaluate(`(() => ({
        value: document.querySelector('.composer textarea')?.value,
        notice: document.querySelector('.composer-error, .runtime-event-notice')?.textContent ?? null,
        loading: document.body.className.includes('loading'),
      }))()`)
      observations.push({ step: 'send-after-not-ready', attempted, after })
      if (after?.value !== '冷启动草稿') {
        failures.push({ check: 'a refused send keeps the draft in place', detail: after })
      }
    } else {
      observations.push({
        step: 'send-after-not-ready',
        skipped: 'execution was already ready when the debugger attached',
      })
    }

    // 2b. While execution is unavailable the window must say so with the
    //     Runtime's own words, and it must still be unavailable when this step
    //     runs - otherwise the assertions above proved nothing about a wider
    //     window. The surfaces are read from the DOM, not from the API.
    //     Placement is part of the contract: a normal start states its stage next
    //     to the send control, and only a failure may span the window.
    const noticeWhileNotReady = await client.evaluate(`(() => {
      const notice = document.querySelector('.runtime-readiness-notice');
      const hint = document.querySelector('.composer-readiness-hint');
      const input = document.querySelector('.composer textarea');
      const hintBox = hint ? hint.getBoundingClientRect() : null;
      return {
        text: hint ? hint.textContent.trim() : null,
        hintInsideControlRow: hint ? Boolean(hint.closest('.composer-right')) : false,
        hintSpanRatio: hintBox && window.innerWidth > 0 ? hintBox.width / window.innerWidth : null,
        stripText: notice ? notice.textContent.trim() : null,
        visible: hintBox ? hintBox.height > 0 : false,
        sendDisabled: (() => {
          const button = document.querySelector('.composer-run-actions .send-round');
          return button ? button.disabled : null;
        })(),
        draft: input ? input.value : null,
      };
    })()`)
    const stillNotReady = await readReadiness(locator)
    observations.push({ step: 'notice-while-not-ready', notice: noticeWhileNotReady, readiness: stillNotReady })
    if (stillNotReady?.state === 'ready') {
      failures.push({ check: 'the widened not-ready window is still open when the notice is read', detail: stillNotReady })
    }
    if (noticeWhileNotReady.visible !== true || !noticeWhileNotReady.text) {
      failures.push({ check: 'the not-ready window states the Runtime phase on screen', detail: noticeWhileNotReady })
    }
    if (noticeWhileNotReady.hintInsideControlRow !== true) {
      failures.push({ check: 'the startup stage text sits in the composer control row', detail: noticeWhileNotReady })
    }
    if (noticeWhileNotReady.stripText !== null) {
      failures.push({ check: 'a normal start does not raise the window-wide strip', detail: noticeWhileNotReady })
    }
    if (noticeWhileNotReady.sendDisabled !== true) {
      failures.push({ check: 'the send entry stays disabled while the notice is shown', detail: noticeWhileNotReady })
    }
    if (noticeWhileNotReady.draft !== '冷启动草稿') {
      failures.push({ check: 'the draft is still in the composer during the widened window', detail: noticeWhileNotReady })
    }

    // 2c. Opening another conversation while execution is unavailable must not
    //     start a run, must not raise an error banner, and must not be read as a
    //     send. What the composer holds afterwards is recorded rather than
    //     assumed: the live draft is a single text slot, so this observation is
    //     the evidence for how it behaves across a switch (the persisted draft is
    //     tagged with its conversation and is only restored into that one).
    const activeBeforeSwitch = await readComposerIdentity(client)
    const switchAttempt = await openOtherSession(client)
    await delay(700)
    const afterSwitch = await readComposerIdentity(client)
    const noticeAfterSwitch = await readNoticeSurfaces(client)
    const readinessDuringSwitch = await readReadiness(locator)
    observations.push({
      step: 'switch-session-while-not-ready',
      attempt: switchAttempt,
      before: activeBeforeSwitch.currentSession,
      after: afterSwitch.currentSession,
      draftAfterSwitch: afterSwitch.draft,
      notices: noticeAfterSwitch,
      readiness: readinessDuringSwitch,
    })
    if (switchAttempt.opened !== true) {
      failures.push({ check: 'a conversation can be opened while execution is unavailable', detail: switchAttempt })
    }
    if (switchAttempt.opened === true && afterSwitch.currentSession !== switchAttempt.title) {
      failures.push({
        check: 'opening another conversation actually switches the active one',
        detail: { expected: switchAttempt.title, after: afterSwitch.currentSession },
      })
    }
    if (readinessDuringSwitch?.state === 'ready') {
      failures.push({ check: 'the widened window is still open across the switch', detail: readinessDuringSwitch })
    }
    if (noticeAfterSwitch.errorText !== null) {
      failures.push({ check: 'switching conversation while unavailable raises no error banner', detail: noticeAfterSwitch })
    }
    if (noticeAfterSwitch.activeRunCount !== 0) {
      failures.push({ check: 'switching conversation starts no run', detail: noticeAfterSwitch })
    }
    // Back to the conversation the window opened with, then type the draft again:
    // the handoff assertions below must be about the handoff, not about the
    // switch. Whether the text had to be re-typed is itself recorded.
    const returnAttempt = await openSessionByTitle(client, switchAttempt.from)
    await delay(700)
    const afterReturn = await readComposerIdentity(client)
    const draftSurvivedSwitch = afterReturn.draft === '冷启动草稿'
    if (returnAttempt.opened !== true || afterReturn.currentSession !== switchAttempt.from) {
      failures.push({
        check: 'the first conversation can be reopened',
        detail: { attempt: returnAttempt, current: afterReturn.currentSession, expected: switchAttempt.from },
      })
    }
    if (!draftSurvivedSwitch) await typeComposerDraft(client, '冷启动草稿')
    const beforeHandoff = await readComposerIdentity(client)
    observations.push({
      step: 'return-to-first-session',
      attempt: returnAttempt,
      currentSession: afterReturn.currentSession,
      draftSurvivedSwitch,
      draftRetyped: !draftSurvivedSwitch,
      notices: await readNoticeSurfaces(client),
    })
    if (beforeHandoff.draft !== '冷启动草稿') {
      failures.push({ check: 'the draft is in the composer before the handoff', detail: beforeHandoff })
    }

    // 3. Wait for execution readiness and confirm the transition was in place.
    //    The widened window is measured rather than assumed: if the delay did not
    //    apply, the pre-ready steps above ran against an almost-ready runtime and
    //    the evidence would be worth much less. The window ends when readiness is
    //    observed, so the timestamp is taken after the wait, not before it.
    const readiness = await waitForReady(locator)
    const notReadyWindowMs = spawnRequestedAt === 0 ? null : Date.now() - spawnRequestedAt
    observations.push({ step: 'ready', readiness, notReadyWindowMs, requiredWindowMs: NOT_READY_WINDOW_MS })
    if (typeof notReadyWindowMs !== 'number' || notReadyWindowMs < NOT_READY_WINDOW_MS - 1_500) {
      failures.push({
        check: 'the not-ready window was actually widened before these steps ran',
        detail: { notReadyWindowMs, requiredWindowMs: NOT_READY_WINDOW_MS },
      })
    }
    const afterReady = await readComposerIdentity(client)
    // Compared against the state right before the wait, not against the first
    // read: the sidebar can still be empty when the debugger attaches, and a
    // comparison against that would pass for the wrong reason.
    observations.push({ step: 'after-ready', before: beforeHandoff, after: afterReady })
    if (afterReady.draft !== '冷启动草稿') {
      failures.push({ check: 'the draft survives the readiness handoff', detail: afterReady })
    }
    if (afterReady.focused !== true) {
      failures.push({ check: 'focus stays in the composer across the handoff', detail: afterReady })
    }
    if (afterReady.hasComposer !== true) {
      failures.push({ check: 'the composer is not remounted by the handoff', detail: afterReady })
    }
    if (afterReady.url !== beforeHandoff.url) {
      failures.push({ check: 'no page navigation happens across the handoff', detail: afterReady })
    }
    if (afterReady.currentSession !== beforeHandoff.currentSession) {
      failures.push({
        check: 'the current conversation is not switched by the handoff',
        detail: { before: beforeHandoff.currentSession, after: afterReady.currentSession },
      })
    }
    if (afterReady.readinessNotice !== null || afterReady.readinessHint !== null) {
      failures.push({ check: 'the readiness surfaces clear once execution is available', detail: afterReady })
    }
    const noticesAfterReady = await readNoticeSurfaces(client)
    observations.push({ step: 'notices-after-ready', ...noticesAfterReady })
    if (noticesAfterReady.errorText !== null) {
      failures.push({ check: 'no error banner survives the handoff', detail: noticesAfterReady })
    }

    // 4. Window close follows the configured policy. With the default
    //    `background-while-active` and no active run, closing the last window
    //    means quit — so this step only records the fact instead of pretending a
    //    background/hide cycle is reachable here.
    const closePolicy = await harness.desktopSnapshot(locator)
    observations.push({
      step: 'close-policy',
      trayAvailable: closePolicy.trayAvailable,
      activeRunCount: closePolicy.activeRunCount,
      closePolicy: closePolicy.closePolicy,
      expectedAction: !closePolicy.trayAvailable
        ? 'quit'
        : closePolicy.activeRunCount > 0 ? 'hide' : 'quit',
    })

    // 4b. Window lifecycle after startup: hiding and restoring the window, then
    //     minimizing and restoring it, must not reload the renderer or lose the
    //     draft. Requires `always-background`, so it runs as its own launch with
    //     its own data root.
    const lifecycle = await runWindowLifecycleCase(outDir)
    observations.push({ step: 'window-lifecycle', ...lifecycle.observation })
    failures.push(...lifecycle.failures)

    // 4c. The right workspace keeps its file while the conversation changes and
    //     while the window is hidden: the taskbook's CS-08 robustness list. The
    //     request/response race is induced by clicking a second file and switching
    //     conversation immediately after it, so a stale response landing late
    //     would show up as content that does not match the file the panel says it
    //     is showing.
    const workspacePreview = await runWorkspacePreviewCase()
    observations.push({ step: 'workspace-preview-robustness', ...workspacePreview.observation })
    failures.push(...workspacePreview.failures)

    await writeFile(join(outDir, 'cold-start-interaction.json'), `${JSON.stringify({
      check: 'desktop-cold-start-interaction',
      ok: failures.length === 0,
      observations,
      failures,
      gaps: [
        'a deliberately slow initialization (no product knob exists to delay it)',
        'typing continuously for the whole not-ready window (that window is ~300 ms here)',
        'external display changes (monitor unplug, DPI change) while the window is hidden',
        'close-to-background is only reachable while a run is active, so the live close/restore cycle is not exercised',
      ],
    }, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ ok: failures.length === 0, outDir, observations, failures }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      observations,
      electronLogTail: await readFile(logPath, 'utf8').then((text) => text.split(/\r?\n/u).slice(-25)).catch(() => []),
    }, null, 2))
    process.exitCode = 1
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

/** Two seeded conversations make "the handoff must not switch session" testable. */
/**
 * Hide/restore and minimize/restore around a startup.
 *
 * Both are window operations the user can perform while the Runtime is still
 * starting. What must hold: the process stays alive under `always-background`,
 * the renderer is not reloaded, the draft and the conversation survive, and
 * readiness keeps progressing to `ready` afterwards.
 */
async function runWindowLifecycleCase(dir) {
  const failures = []
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-cold-start-lifecycle-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  let client
  let child
  const observation = { steps: [] }

  try {
    await mkdir(dataDir, { recursive: true })
    await seedSessions(dataDir)
    // `always-background` is what makes hiding reachable without an active run.
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({
      version: 1,
      desktop: { closePolicy: 'always-background' },
    }, null, 2)}\n`, 'utf8')

    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: {
        LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
        LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS: String(NOT_READY_WINDOW_MS),
      },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
    await typeComposerDraft(client, '生命周期草稿')
    const before = await readComposerIdentity(client)
    observation.steps.push({ step: 'prepared', draft: before.draft, session: before.currentSession })

    // Hide → the process must survive and the window must come back intact.
    await harness.desktopAction(locator, 'close')
    await delay(700)
    const hidden = await harness.desktopSnapshot(locator).catch(() => undefined)
    const aliveWhileHidden = !child.killed && child.exitCode === null
    await harness.desktopAction(locator, 'show')
    await delay(700)
    const afterShow = await readComposerIdentity(client)
    observation.steps.push({ step: 'hide-show', aliveWhileHidden, windowVisible: hidden?.windowVisible, draft: afterShow.draft, focused: afterShow.focused })
    if (!aliveWhileHidden) {
      failures.push({ check: 'closing under always-background keeps the process alive', detail: { aliveWhileHidden, hidden } })
    }
    if (afterShow.draft !== '生命周期草稿') {
      failures.push({ check: 'hiding and restoring the window keeps the draft', detail: afterShow })
    }
    if (afterShow.currentSession !== before.currentSession) {
      failures.push({ check: 'hiding and restoring does not switch the conversation', detail: { before: before.currentSession, after: afterShow.currentSession } })
    }

    // Minimize → restore. A minimized window cannot be captured, so this checks
    // the DOM state the user gets back.
    await harness.desktopAction(locator, 'minimize', { minimized: true })
    await delay(700)
    const minimized = await readComposerIdentity(client)
    await harness.desktopAction(locator, 'minimize', { minimized: false })
    await delay(700)
    const afterRestore = await readComposerIdentity(client)
    observation.steps.push({ step: 'minimize-restore', minimizedHasComposer: minimized.hasComposer, draft: afterRestore.draft, focused: afterRestore.focused })
    if (afterRestore.draft !== '生命周期草稿') {
      failures.push({ check: 'minimizing and restoring the window keeps the draft', detail: afterRestore })
    }
    if (afterRestore.hasComposer !== true) {
      failures.push({ check: 'the composer is back after restoring the window', detail: afterRestore })
    }

    // Readiness must still arrive after all of that.
    const readiness = await waitForReady(locator)
    observation.steps.push({ step: 'ready', state: readiness?.state })
    if (readiness?.state !== 'ready') {
      failures.push({ check: 'readiness still arrives after the window was hidden and minimized', detail: readiness })
    }
    const afterReady = await readComposerIdentity(client)
    observation.steps.push({ step: 'after-ready', draft: afterReady.draft, notice: afterReady.readinessNotice })
    if (afterReady.draft !== '生命周期草稿') {
      failures.push({ check: 'the draft survives the whole lifecycle to readiness', detail: afterReady })
    }
  } catch (error) {
    failures.push({ check: 'the window lifecycle case ran', detail: error instanceof Error ? error.message : String(error) })
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    await harness.removeTemporaryRoot(root)
  }
  return { observation, failures }
}

/**
 * The right workspace across conversation switches and window hide/show (CS-08).
 *
 * Everything here happens inside the widened not-ready window except the final
 * readiness wait, because that is when the workspace is claimed to be usable.
 * The two fixture files carry unique markers, so "the panel is showing file X"
 * (breadcrumb) and "the body is file X's body" (marker) can be checked against
 * each other. That is what catches a stale response landing after a newer one:
 * the visible body would no longer match the file the panel says it shows.
 */
async function runWorkspacePreviewCase() {
  const failures = []
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-cold-start-workspace-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  let client
  let child
  const observation = { steps: [] }

  const readmeMarker = 'MARKER-README-DOCUMENT'
  const notesMarker = 'MARKER-NOTES-DOCUMENT'
  const markers = { readmeMarker, notesMarker }

  try {
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(workspaceDir, 'README.md'),
      `# 会话切换期间的工作区\n\n${readmeMarker}\n\n${'正文段落。\n\n'.repeat(120)}`,
      'utf8',
    )
    await writeFile(join(workspaceDir, 'notes.md'), `# notes\n\n${notesMarker}\n\n第二份文件。\n`, 'utf8')
    await seedSessions(dataDir)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({
      version: 1,
      agents: { defaults: { workspace: workspaceDir } },
      desktop: { closePolicy: 'always-background' },
    }, null, 2)}\n`, 'utf8')

    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: {
        LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
        LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS: String(NOT_READY_WINDOW_MS),
      },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)

    // A. The window starts as the *draft* conversation: the sidebar may already
    //    highlight a row, but the workspace layout the app records belongs to the
    //    draft bucket (verified by reading both mirrors, not by assuming). The
    //    right panel must still be usable here - that is the CS-08 claim.
    await openPanel(client)
    await waitForWorkspaceRows(client)
    const openedDraft = await openWorkspaceFile(client, 'README.md', markers)
    const inDraft = await readWorkspacePreview(client, markers)
    const readinessAtDraft = await readReadiness(locator)
    const draftLayouts = await readLayoutState(dataDir, client)
    observation.steps.push({
      step: 'draft-file-opened',
      readiness: readinessAtDraft?.state ?? null,
      opened: openedDraft,
      preview: inDraft,
      layouts: draftLayouts,
    })
    if (inDraft.marker !== 'readme') {
      failures.push({ check: 'the opened file body is the file the panel shows', detail: inDraft })
    }
    if (readinessAtDraft?.state !== 'starting') {
      failures.push({ check: 'the workspace was usable inside the not-ready window', detail: { readiness: readinessAtDraft } })
    }

    // B. Leave the startup conversation and come back to the same sidebar row.
    //    The taskbook asks exactly this: the file must not be reset to blank.
    //    The two layout mirrors are recorded with the observation, because the
    //    answer depends on which conversation bucket the app filed the file under.
    const awayAttempt = await openOtherSession(client)
    await delay(700)
    const away = await readWorkspacePreview(client, markers)
    const noticesAway = await readNoticeSurfaces(client)
    observation.steps.push({ step: 'switched-away', attempt: awayAttempt, preview: away, notices: noticesAway })
    if (awayAttempt.opened !== true) {
      failures.push({ check: 'the other conversation can be opened', detail: awayAttempt })
    }
    if (away.marker === 'readme') {
      failures.push({ check: 'the other conversation does not show the first one\'s file', detail: { draft: inDraft, away } })
    }
    if (noticesAway.errorText !== null) {
      failures.push({ check: 'switching conversation raises no error banner', detail: noticesAway })
    }
    if (noticesAway.activeRunCount > 0) {
      failures.push({ check: 'switching conversation starts no run', detail: noticesAway })
    }

    const backAttempt = await openSessionByTitle(client, awayAttempt.from)
    await delay(700)
    const returned = await reopenAndReadPreview(client, markers, true)
    const afterReturn = returned.preview
    observation.steps.push({
      step: 'returned-to-startup-conversation',
      attempt: backAttempt,
      panel: returned.panel,
      restore: returned.restore,
      preview: afterReturn,
      layouts: await readLayoutState(dataDir, client),
    })
    if (backAttempt?.opened !== true) {
      failures.push({ check: 'the startup conversation row can be reopened', detail: backAttempt })
    }
    if (!samePreview(afterReturn, inDraft)) {
      failures.push({
        check: 'returning to the startup conversation restores the file opened during startup',
        detail: { before: inDraft, after: afterReturn, layouts: await readLayoutState(dataDir, client) },
      })
    }

    // C. Control: after readiness, open a file in the conversation the window then
    //    has, and run the same round trip. This separates "the layout does not
    //    restore" from "the startup window filed the file under the draft".
    const readyBeforeControl = await waitForReady(locator)
    await delay(400)
    await openPanel(client)
    await waitForWorkspaceRows(client)
    const openedControl = await openWorkspaceFile(client, 'README.md', markers)
    const controlBefore = await readWorkspacePreview(client, markers)
    const controlAway = await openOtherSession(client)
    await delay(700)
    const controlBack = await openSessionByTitle(client, controlAway.from)
    await delay(700)
    const controlRead = await reopenAndReadPreview(client, markers, true)
    const controlAfter = controlRead.preview
    observation.steps.push({
      step: 'post-ready-round-trip',
      readiness: readyBeforeControl?.state ?? null,
      opened: openedControl,
      away: controlAway,
      back: controlBack,
      restore: controlRead.restore,
      before: controlBefore,
      after: controlAfter,
      layouts: await readLayoutState(dataDir, client),
    })
    if (controlBefore.marker !== 'readme') {
      failures.push({ check: 'a file can be opened once execution is ready', detail: controlBefore })
    }
    if (controlAway.opened !== true || controlBack?.opened !== true) {
      failures.push({ check: 'the post-ready round trip really switched conversation', detail: { away: controlAway, back: controlBack } })
    }
    if (!samePreview(controlAfter, controlBefore)) {
      failures.push({
        check: 'returning to a conversation restores a file opened in it',
        detail: { before: controlBefore, after: controlAfter, layouts: await readLayoutState(dataDir, client) },
      })
    }

    // D. Induced race on the file the panel is currently showing: open the second
    //    file and switch conversation immediately, so the preview request and the
    //    switch overlap. Whatever settles last, the body must belong to the file
    //    the breadcrumb names - that is what a stale response winning would break.
    const raceBefore = await readWorkspacePreview(client, markers)
    const openedNotes = await openWorkspaceFile(client, 'notes.md', markers).catch((error) => ({ opened: false, error: String(error) }))
    const raceSwitch = await openOtherSession(client)
    await delay(500)
    const backAgain = await openSessionByTitle(client, raceSwitch.from)
    await delay(900)
    const raceRead = await reopenAndReadPreview(client, markers, false)
    const afterRace = raceRead.preview
    observation.steps.push({ step: 'race-switch', raceBefore, opened: openedNotes, away: raceSwitch, back: backAgain, preview: afterRace })
    if (openedNotes?.opened !== true) {
      failures.push({ check: 'the second file could be opened for the race', detail: openedNotes })
    }
    if (raceSwitch.opened !== true || backAgain?.opened !== true) {
      failures.push({ check: 'the race really switched conversation and came back', detail: { away: raceSwitch, back: backAgain } })
    }
    if (afterRace.previewLength > 0 && !previewMatchesLabel(afterRace)) {
      failures.push({ check: 'the body belongs to the file the panel names after the race', detail: afterRace })
    }
    if (afterRace.marker === 'notes' && raceBefore.marker !== 'notes') {
      observation.raceWinner = 'the second file'
    }

    // Hide and restore the window with the file open.
    await harness.desktopAction(locator, 'close')
    await delay(700)
    await harness.desktopAction(locator, 'show')
    await delay(700)
    const afterShow = await readWorkspacePreview(client, markers)
    observation.steps.push({ step: 'hide-show', preview: afterShow })
    if (afterRace.previewLength > 0 && !samePreview(afterShow, afterRace)) {
      failures.push({ check: 'hiding and restoring the window keeps the open file', detail: { before: afterRace, after: afterShow } })
    }

    // Handoff to readiness must not reset the workspace either.
    const ready = await waitForReady(locator)
    await delay(300)
    const afterReady = await readWorkspacePreview(client, markers)
    observation.steps.push({ step: 'after-ready', state: ready?.state ?? null, preview: afterReady })
    if (ready?.state !== 'ready') {
      failures.push({ check: 'the workspace case still reaches readiness', detail: { readiness: ready } })
    }
    if (afterRace.previewLength > 0 && !samePreview(afterReady, afterRace)) {
      failures.push({ check: 'the readiness handoff does not reset the open file', detail: { before: afterRace, after: afterReady } })
    }
  } catch (error) {
    failures.push({ check: 'the workspace preview case ran', detail: error instanceof Error ? error.message : String(error) })
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    await harness.removeTemporaryRoot(root)
  }
  return { observation, failures }
}

/** The body must carry the marker of the file the breadcrumb names. */
function previewMatchesLabel(preview) {
  const label = preview.fileLabel ?? ''
  if (label.includes('notes.md')) return preview.marker === 'notes'
  if (label.includes('README.md')) return preview.marker === 'readme'
  return false
}

/** Same file, same body: the digest is what the equality claims are made of. */
function samePreview(left, right) {
  return left.previewLength === right.previewLength
    && left.previewHead === right.previewHead
    && left.marker === right.marker
    && left.fileLabel === right.fileLabel
}

/**
 * Restores the panel for the current conversation and waits for its file body.
 *
 * A conversation the user never opened keeps the default collapsed layout, so a
 * switch away may legitimately show no panel. Coming back must restore the file,
 * which is what this waits for - a collapsed panel after the return would mean
 * the layout was lost rather than merely not applied yet.
 */
async function reopenAndReadPreview(client, markers, expected) {
  const panel = await client.evaluate(`(() => {
    const node = document.querySelector('.workspace-panel');
    const open = Boolean(node && !node.classList.contains('collapsed'));
    if (!open) {
      const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
      if (toggle) toggle.click();
    }
    return { openBefore: open, toggled: !open };
  })()`)
  let restore = null
  if (!panel.openBefore) {
    // Only wait when a file is expected: a conversation with no saved file has
    // nothing to restore and must not be turned into a timeout.
    const before = await readWorkspacePreview(client, markers)
    if (expected && before.previewLength === 0) {
      // A timeout here must carry the facts, not just the elapsed time: "the
      // layout was lost" and "the harness clicked the wrong node" look identical
      // from the outside.
      restore = await harness.waitFor(async () => {
        const now = await readWorkspacePreview(client, markers)
        return now.previewLength > 60 ? now.previewLength : undefined
      }, harness.actionTimeoutMs, 'restored preview body').catch(async (error) => ({
        error: error instanceof Error ? error.message : String(error),
        diagnostics: await readPanelDiagnostics(client),
      }))
    }
  }
  return { panel, restore, preview: await readWorkspacePreview(client, markers) }
}

/**
 * Which conversation bucket actually holds the open file.
 *
 * Main persists one snapshot per conversation under `<data-root>/workspace/layout.json`;
 * the renderer mirrors the same shape in local storage. Reading both is what
 * separates "the switch dropped the file" from "the harness switched to a
 * conversation that never had one". Only fixture session ids appear here.
 */
async function readLayoutState(dataDir, client) {
  const raw = await readFile(join(dataDir, 'workspace', 'layout.json'), 'utf8').catch(() => null)
  let main = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      main = Object.fromEntries(Object.entries(parsed?.snapshots ?? {}).map(([key, snapshot]) => [key, {
        collapsed: snapshot?.collapsed ?? null,
        activeTabKind: typeof snapshot?.activeTab === 'string' ? snapshot.activeTab.split(':')[0] : null,
        openTabKinds: (snapshot?.openTabs ?? []).map((tab) => String(tab).split(':')[0]),
      }]))
    } catch {
      main = 'unreadable'
    }
  }
  const renderer = await client.evaluate(`(() => {
    try {
      const raw = localStorage.getItem('littlesheep.ui.workspaceSessionLayouts');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Object.fromEntries(Object.entries(parsed ?? {}).map(([key, value]) => [key, {
        collapsed: value?.collapsed ?? null,
        tabCount: Array.isArray(value?.openTabs) ? value.openTabs.length : null,
        openTabKinds: Array.isArray(value?.openTabs) ? value.openTabs.map((tab) => String(tab).split(':')[0]) : null,
      }]));
    } catch (error) { return 'unreadable' }
  })()`).catch(() => 'unavailable')
  return { main, renderer }
}

/** What the panel actually looks like when a restore did not happen. */
async function readPanelDiagnostics(client) {
  return client.evaluate(`(() => {
    const panel = document.querySelector('.workspace-panel');
    const tabs = [...document.querySelectorAll('.workspace-panel-header [role="tab"], .workspace-tab')].map((node) => node.textContent.trim());
    return {
      panelPresent: Boolean(panel),
      panelClass: panel ? panel.className : null,
      togglePresent: Boolean(document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target')),
      previewPanePresent: Boolean(document.querySelector('.workspace-preview-pane')),
      tabs,
      placeholder: document.querySelector('.workspace-preview-body .workspace-placeholder')?.textContent?.trim() ?? null,
      treeNotice: document.querySelector('.workspace-tree-notice')?.textContent?.trim() ?? null,
      bodyHead: (document.querySelector('.workspace-preview-body')?.textContent ?? '').slice(0, 80),
    };
  })()`)
}

/** Opens the workspace panel if the current conversation keeps it collapsed. */
async function openPanel(client) {
  return client.evaluate(`(() => {
    const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
    if (toggle && document.querySelector('.workspace-panel.collapsed')) toggle.click();
    return { toggled: Boolean(toggle) };
  })()`)
}

async function waitForWorkspaceRows(client) {
  return harness.waitFor(async () => {
    const rows = await client.evaluate(`document.querySelectorAll('.workspace-tree-row.file').length`)
    return rows > 0 ? rows : undefined
  }, harness.actionTimeoutMs, 'workspace tree rows')
}

/** Clicks a file row and waits until the preview body has real content. */
async function openWorkspaceFile(client, name, markers) {
  const clicked = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row.file')];
    const target = rows.find((row) => row.textContent.includes(${JSON.stringify(name)}));
    if (!target) return { opened: false, rows: rows.map((row) => row.textContent.trim()) };
    target.click();
    return { opened: true, label: target.textContent.trim() };
  })()`)
  if (clicked?.opened !== true) return clicked
  await harness.waitFor(async () => {
    const length = await readWorkspacePreview(client, markers).then((preview) => preview.previewLength).catch(() => 0)
    return length > 60 ? length : undefined
  }, harness.actionTimeoutMs, `preview body of ${name}`)
  return clicked
}

/** Breadcrumb, tree size and a bounded digest of the panel's body text. */
async function readWorkspacePreview(client, markers = { readmeMarker: '', notesMarker: '' }) {
  return client.evaluate(`(() => {
    const breadcrumbs = document.querySelector('.workspace-preview-breadcrumbs');
    const body = document.querySelector('.workspace-preview-body');
    const errors = [...document.querySelectorAll('.composer-error, .runtime-notice-error')];
    const text = body ? body.textContent : '';
    // Which fixture file the body actually is - the check that catches a stale
    // response winning the race against a newer one.
    const marker = text.includes(${JSON.stringify(markers.notesMarker)})
      ? 'notes'
      : text.includes(${JSON.stringify(markers.readmeMarker)}) ? 'readme' : 'unknown';
    return {
      panelOpen: Boolean(document.querySelector('.workspace-panel:not(.collapsed)')),
      fileLabel: breadcrumbs ? breadcrumbs.textContent.trim() : null,
      previewLength: text.length,
      previewHead: text.slice(0, 120),
      marker,
      rows: document.querySelectorAll('.workspace-tree-row.file').length,
      errorText: errors.length === 0 ? null : errors.map((node) => node.textContent.trim()).join(' | '),
    };
  })()`)
}

async function seedSessions(dataDir) {
  const { mkdir: makeDir } = await import('node:fs/promises')
  await makeDir(join(dataDir, 'sessions'), { recursive: true })
  const now = Date.now()
  const sessions = [0, 1].map((index) => ({
    id: `interaction-session-${index}`,
    title: `交互验证会话 ${index}`,
    createdAt: now - index * 1_000,
    lastMessageAt: now - index * 1_000,
    mode: 'research',
    scope: 'standalone',
  }))
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
}

async function readComposerIdentity(client) {
  return client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    const active = document.querySelector('.session-item.active');
    return {
      url: location.href,
      hasComposer: Boolean(input),
      draft: input ? input.value : null,
      focused: input ? document.activeElement === input : false,
      currentSession: active ? active.textContent : null,
      readinessNotice: document.querySelector('.runtime-readiness-notice')?.textContent ?? null,
      readinessHint: document.querySelector('.composer-readiness-hint')?.textContent?.trim() ?? null,
    };
  })()`)
}

/** Types into the composer through the same handler a real keypress reaches. */
async function typeComposerDraft(client, text) {
  return client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    if (!(input instanceof HTMLTextAreaElement)) return null;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
    return {
      value: input.value,
      focused: document.activeElement === input,
      sendDisabled: (() => {
        const button = document.querySelector('.composer-run-actions .send-round');
        return button ? button.disabled : null;
      })(),
    };
  })()`)
}

/** Error and status surfaces that must stay quiet while a conversation is opened. */
async function readNoticeSurfaces(client) {
  return client.evaluate(`(() => {
    const errors = [...document.querySelectorAll('.composer-error, .runtime-event-notice, .runtime-notice-error')];
    return {
      errorText: errors.length === 0 ? null : errors.map((node) => node.textContent.trim()).join(' | '),
      readinessNotice: document.querySelector('.runtime-readiness-notice')?.textContent?.trim() ?? null,
      readinessHint: document.querySelector('.composer-readiness-hint')?.textContent?.trim() ?? null,
      activeRunCount: document.querySelector('.run-activity-indicator, .composer-stop') ? 1 : 0,
      sessionTitles: [...document.querySelectorAll('.session-item')].map((node) => node.textContent.trim()),
    };
  })()`)
}

/** Opens the first conversation that is not the active one. */
async function openOtherSession(client) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.session-item')];
    const titles = rows.map((row) => row.textContent.trim());
    const activeRow = rows.find((row) => row.classList.contains('active'));
    // The active marker can lag the row list by a frame, so the fallback is the
    // first row: that is the conversation the window opened with.
    const from = activeRow ? activeRow.textContent.trim() : (titles[0] ?? null);
    const target = rows.find((row) => row.textContent.trim() !== from) ?? null;
    if (!target) return { opened: false, reason: 'no other conversation row', rows: rows.length, titles, from, activeKnown: Boolean(activeRow) };
    target.click();
    return { opened: true, title: target.textContent.trim(), from, activeKnown: Boolean(activeRow), rows: rows.length, titles };
  })()`)
}

/** Opens the conversation row whose text matches `title`. */
async function openSessionByTitle(client, title) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.session-item')];
    const target = rows.find((row) => row.textContent.trim() === ${JSON.stringify(title)});
    if (!target) return { opened: false, reason: 'no conversation row with that title', rows: rows.length };
    target.click();
    return { opened: true, title: target.textContent.trim(), rows: rows.length };
  })()`)
}

async function readReadiness(locator) {
  const response = await fetch(harness.apiUrl(locator, '/runtime/readiness')).catch(() => undefined)
  if (!response?.ok) return undefined
  return response.json().catch(() => undefined)
}

async function waitForReady(locator, timeoutMs = 90_000) {
  return harness.waitFor(async () => {
    const state = await readReadiness(locator)
    if (!state || typeof state.state !== 'string') return undefined
    return state.state === 'ready' ? state : undefined
  }, timeoutMs, 'execution readiness')
}

await main()
