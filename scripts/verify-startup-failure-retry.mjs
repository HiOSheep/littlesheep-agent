// Real-window acceptance for the pre-renderer startup failure (P1).
//
// Measured defect: when bootstrap fails before the renderer loads, the window
// shows the standalone 无法启动 page with the raw message and no controls at all.
// Main already marks that failure retryable (`index.ts`, `readiness.fail(..., {
// retryable: true })`), but the only retry control lived in the React notice
// (`runtime-readiness-notice.tsx`), which by definition never mounted. VS Code's
// window-failure page offers Reload; Slack and Notion offer Retry.
//
// The failure is staged for real (unparseable `config.json`, so stage 1 throws
// before the Local App API exists) and the whole round trip is driven:
//   1. the page offers the retry, and it is reachable from that document;
//   2. pressing it while the configuration is still broken really retries - Main
//      runs the bounded attempt, the page states the reason it came back with, and
//      the control stays offered while the budget lasts;
//   3. fixing the configuration and pressing it again brings the application back
//      (the renderer loads, execution becomes ready, and a turn can run).
//
// Usage:
//   node scripts/verify-startup-failure-retry.mjs [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const PROVIDER_ID = 'acceptance-gw'
const MODEL_ID = 'slow-a'
const API_KEY = 'acceptance-key-not-a-credential'
const ANSWER_MARKER = 'runtime-continuity-anchor-4827'

const PAGE_EXPRESSION = `(() => {
  const error = document.querySelector('.startup-error');
  const retry = document.querySelector('.startup-retry');
  const note = document.querySelector('.startup-retry-note');
  return {
    url: location.href,
    isFailureDocument: location.href.startsWith('data:text/html'),
    errorText: error ? error.textContent.trim() : null,
    retryCount: document.querySelectorAll('.startup-retry').length,
    retryLabel: retry ? retry.textContent.trim() : null,
    retryDisabled: retry ? retry.disabled === true : null,
    note: note ? note.textContent.trim() : null,
    bridgeRetry: typeof window.littlesheep?.retryExecution === 'function',
    hasRendererRoot: Boolean(document.querySelector('#root')),
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

/** Click the page's retry and read what the click itself changed, in one turn. */
async function pressRetry(client) {
  return client.evaluate(`(() => {
    const button = document.querySelector('.startup-retry');
    if (!(button instanceof HTMLElement)) return { clicked: false };
    const label = button.textContent.trim();
    button.click();
    return { clicked: true, label, pendingLabel: button.textContent.trim(), pendingDisabled: button.disabled === true };
  })()`)
}

async function readPage(client) {
  return client.evaluate(PAGE_EXPRESSION).catch(() => undefined)
}

function buildRecoverableConfig(workspaceDir, provider) {
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

async function waitForReadiness(locator, state, timeoutMs = 90_000) {
  return harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    const readiness = response?.body?.readiness ?? response?.body
    return readiness?.state === state ? readiness : undefined
  }, timeoutMs, `readiness ${state}`)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-startup-retry-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  let child
  let client
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    // Stage 1 fails on the config, so the renderer never loads and no locator is
    // written: this is the failure the standalone page owns.
    await writeFile(join(dataDir, 'config.json'), '{ "version": 1, ', 'utf8')
    const debuggingPort = await harness.reservePort()
    child = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    client = await harness.connectDebugger(debuggingPort, 'startup failure page')
    await client.send('Runtime.enable')
    await client.send('Page.enable')

    const failed = await harness.waitFor(async () => {
      const page = await readPage(client)
      return page?.isFailureDocument === true && page.errorText !== null ? page : undefined
    }, 90_000, 'the startup failure page')
    recorder.note({ step: 'failure-page', ...failed })
    recorder.check(failed.hasRendererRoot === false, 'the renderer never loaded in this failure', failed)
    recorder.check(failed.retryCount === 1, 'the failure page carries exactly one retry control', failed)
    recorder.check(
      failed.retryLabel === '重试启动运行能力',
      'the control names the same action the renderer notice offers',
      { retryLabel: failed.retryLabel },
    )
    recorder.check(failed.bridgeRetry === true, 'the control can reach the existing retry bridge', failed)

    // --- 1. retry while the configuration is still broken ---------------------
    const firstClick = await pressRetry(client)
    const afterFirst = await harness.waitFor(async () => {
      const page = await readPage(client)
      return page?.note ? page : undefined
    }, 60_000, 'the first retry outcome')
    const logAfterFirst = await readFile(logPath, 'utf8').catch(() => '')
    recorder.note({
      step: 'retry-still-broken',
      click: firstClick,
      note: afterFirst.note,
      retryDisabled: afterFirst.retryDisabled,
      retryAttemptLogged: /\[retry\] execution retry 1\/3 failed/u.test(logAfterFirst),
    })
    recorder.check(firstClick.clicked === true, 'the retry control is clickable', firstClick)
    recorder.check(
      firstClick.pendingDisabled === true && firstClick.pendingLabel === '正在重试…',
      'the control reports the attempt in flight instead of inviting a second click',
      firstClick,
    )
    recorder.check(
      /\[retry\] execution retry 1\/3 failed/u.test(logAfterFirst),
      'pressing it ran Main\'s bounded retry path',
      logAfterFirst.split(/\r?\n/u).filter((line) => line.includes('[retry]')).slice(-3),
    )
    recorder.check(
      (afterFirst.note ?? '').includes('重试失败'),
      'the page states what the attempt came back with instead of staying silent',
      { note: afterFirst.note },
    )
    recorder.check(
      afterFirst.retryDisabled === false,
      'the control stays offered while Main still allows an attempt',
      { retryDisabled: afterFirst.retryDisabled },
    )

    // --- 2. fix the configuration, then retry: the app must come back ---------
    await writeFile(
      join(dataDir, 'config.json'),
      `${JSON.stringify(buildRecoverableConfig(workspaceDir, provider), null, 2)}\n`,
      'utf8',
    )
    const secondClick = await pressRetry(client)
    recorder.note({ step: 'retry-recover', click: secondClick })
    recorder.check(secondClick.clicked === true, 'the retry control is clickable after a failed attempt', secondClick)

    const renderer = await harness.connectRenderer(debuggingPort)
    await renderer.send('Runtime.enable')
    await renderer.send('Page.enable')
    const locator = await harness.waitForLocator(dataDir, child.pid).catch(() => undefined)
    const readiness = locator ? await waitForReadiness(locator, 'ready') : undefined
    const recovered = await harness.waitFor(async () => {
      const state = await renderer.evaluate(`(() => ({
        hasRoot: Boolean(document.querySelector('#root')),
        hasComposer: Boolean(document.querySelector('.composer textarea')),
        pickerLabel: document.querySelector('.runtime-picker-trigger')?.textContent?.trim() ?? null,
      }))()`).catch(() => undefined)
      return state?.hasComposer ? state : undefined
    }, 60_000, 'the recovered application renderer')
    recorder.note({
      step: 'recovered',
      readiness: readiness?.state,
      renderer: recovered,
      retryLogLines: (await readFile(logPath, 'utf8').catch(() => ''))
        .split(/\r?\n/u).filter((line) => line.includes('[retry]')).slice(-3),
    })
    recorder.check(Boolean(locator), 'the Local App API started on the retried bootstrap', locator ?? null)
    recorder.check(readiness?.state === 'ready', 'execution became ready after the retry', readiness ?? null)
    recorder.check(recovered.hasRoot === true, 'the window left the failure page for the application', recovered)
    recorder.check(
      recovered.pickerLabel?.includes(MODEL_ID) === true,
      'the recovered window shows the configured model',
      recovered,
    )

    // The recovered window is a working application, not just a mounted shell.
    await renderer.evaluate(`(() => {
      const textarea = document.querySelector('.composer textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '恢复之后仍然可以执行任务');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: textarea.value, inputType: 'insertText' }));
      return true;
    })()`)
    await renderer.evaluate(`document.querySelector('.composer-run-actions .send-round:not(.stop)')?.click()`)
    const settled = await harness.waitFor(async () => {
      const state = await renderer.evaluate(`(() => ({
        running: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
        assistantMessages: document.querySelectorAll('.message.assistant').length,
        reply: [...document.querySelectorAll('.message.assistant')].pop()?.textContent ?? null,
      }))()`).catch(() => undefined)
      return state && !state.running && state.assistantMessages > 0 ? state : undefined
    }, 90_000, 'a turn in the recovered window').catch(() => undefined)
    recorder.note({ step: 'recovered-turn', settled })
    recorder.check(
      (settled?.reply ?? '').includes(ANSWER_MARKER),
      'a turn runs in the recovered window',
      settled ?? null,
    )
  } catch (error) {
    recorder.check(false, 'the startup failure walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root).catch(() => undefined)
  }

  const evidence = {
    check: 'startup-failure-retry',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'One pre-renderer failure cause is staged (unparseable config.json). Other causes reach the same page through the same `bootstrap().catch` path but are not sampled.',
      'The retry re-reads config.json, so the "fix it and press retry" half edits the file the way a user repairs it; it does not drive the settings page, which is unreachable while no renderer exists.',
      'The page\'s own states (in flight, failed with the real reason, recovered) are read from the standalone document; the renderer that appears afterwards is connected separately.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
