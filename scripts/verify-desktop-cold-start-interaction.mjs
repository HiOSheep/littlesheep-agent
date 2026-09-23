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
    //     window. The notice is read from the DOM, not from the API.
    const noticeWhileNotReady = await client.evaluate(`(() => {
      const notice = document.querySelector('.runtime-readiness-notice');
      const input = document.querySelector('.composer textarea');
      return {
        text: notice ? notice.textContent.trim() : null,
        visible: notice ? notice.getBoundingClientRect().height > 0 : false,
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
    if (afterReady.readinessNotice !== null) {
      failures.push({ check: 'the readiness notice clears once execution is available', detail: afterReady })
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

    await writeFile(join(outDir, 'cold-start-interaction.json'), `${JSON.stringify({
      check: 'desktop-cold-start-interaction',
      ok: failures.length === 0,
      observations,
      failures,
      gaps: [
        'a deliberately slow initialization (no product knob exists to delay it)',
        'switching conversations while the Runtime is still starting',
        'typing continuously for the whole not-ready window (that window is ~300 ms here)',
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
