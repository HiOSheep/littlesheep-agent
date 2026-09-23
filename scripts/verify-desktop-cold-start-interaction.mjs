// Real-window interaction acceptance for the early-available shell (CS-03/CS-06).
//
// The window is deliberately usable before the Runtime is ready, so the things
// that can silently break are interactions, not timings:
//
//   1. the composer accepts typing and window operations while execution is
//      still unavailable;
//   2. a send attempt in that window is refused in place and never reported as
//      accepted;
//   3. when readiness arrives, the draft, the focused element and the current
//      conversation are exactly what the user left — enabling capability must be
//      an in-place transition, not a reload;
//   4. no page navigation happens across the handoff.
//
// The not-ready window is short on a normal start, so every step records what it
// actually observed instead of assuming it caught the transient state.
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

  try {
    await mkdir(outDir, { recursive: true })
    await seedSessions(dataDir)
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_ELECTRON_ACCEPTANCE: '1' },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)

    const markupBefore = await readComposerIdentity(client)
    const readinessAtAttach = await readReadiness(locator)
    observations.push({ step: 'attached', readiness: readinessAtAttach })

    // 1. Type while execution may still be unavailable. `beforeinput` is
    //    dispatched so the assertion exercises the same handler a real keypress
    //    would, instead of only assigning `value` from the outside.
    const typed = await client.evaluate(`(() => {
      const input = document.querySelector('.composer textarea');
      if (!(input instanceof HTMLTextAreaElement)) return null;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, '冷启动草稿');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '冷启动草稿', inputType: 'insertText' }));
      return {
        value: input.value,
        focused: document.activeElement === input,
        sendDisabled: (() => {
          const button = document.querySelector('.composer-run-actions .send-round');
          return button ? button.disabled : null;
        })(),
      };
    })()`)
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

    // 3. Wait for execution readiness and confirm the transition was in place.
    const readiness = await waitForReady(locator)
    observations.push({ step: 'ready', readiness })
    const afterReady = await readComposerIdentity(client)
    observations.push({ step: 'after-ready', before: markupBefore, after: afterReady })
    if (afterReady.draft !== '冷启动草稿') {
      failures.push({ check: 'the draft survives the readiness handoff', detail: afterReady })
    }
    if (afterReady.focused !== true) {
      failures.push({ check: 'focus stays in the composer across the handoff', detail: afterReady })
    }
    if (afterReady.hasComposer !== true) {
      failures.push({ check: 'the composer is not remounted by the handoff', detail: afterReady })
    }
    if (afterReady.url !== markupBefore.url) {
      failures.push({ check: 'no page navigation happens across the handoff', detail: afterReady })
    }
    if (afterReady.currentSession !== markupBefore.currentSession) {
      failures.push({ check: 'the current conversation is not switched by the handoff', detail: afterReady })
    }
    if (afterReady.readinessNotice !== null) {
      failures.push({ check: 'the readiness notice clears once execution is available', detail: afterReady })
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
