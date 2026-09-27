// Real-window acceptance for the composer's send gate (P0).
//
// Measured defect: on a fresh data root the composer said 还没有配置模型 and send was
// still enabled. Pressing it dispatched the message to `openai/gpt-5.6`, a provider
// with no key, and the turn sat at 正在工作 · 1m 14s with zero characters streamed,
// no error and no settlement. ChatGPT, Cursor and VS Code refuse that submit and
// point at model setup instead of dispatching to a provider that cannot answer.
//
// Two cases, deliberately paired so "refused" cannot be confused with "could not
// run at all":
//   A. fresh root, no provider key - the Runtime is ready, and the send entry
//      refuses with a visible reason while both entries (button and Enter) leave
//      the draft alone and start nothing;
//   B. a configured provider - the same window sends normally and the run streams
//      a settled answer.
//
// Usage:
//   node scripts/verify-composer-send-gate.mjs [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const PROVIDER_ID = 'acceptance-gw'
const PROVIDER_NAME = '验收网关'
const MODEL_ID = 'slow-a'
const API_KEY = 'acceptance-key-not-a-credential'
/** The deterministic reply every acceptance turn carries (`electron-acceptance-provider.mjs`). */
const ANSWER_MARKER = 'runtime-continuity-anchor-4827'
const DRAFT = '这条消息不应该被发出去。'

/**
 * Composer, transcript and gate state in one read.
 *
 * `.composer-send-block` is the model gate's own sentence; the readiness hint is
 * matched separately so a startup stage can never be mistaken for the reason this
 * gate states.
 */
const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const send = document.querySelector('.composer-run-actions .send-round:not(.stop)');
  const textarea = document.querySelector('.composer textarea');
  const trigger = document.querySelector('.runtime-picker-trigger');
  return {
    sendPresent: Boolean(send),
    sendDisabled: send ? send.disabled === true : null,
    sendLabel: send ? send.getAttribute('aria-label') : null,
    sendTitle: send ? send.getAttribute('title') : null,
    blockNotice: text('.composer-send-block'),
    readinessHint: text('.composer-readiness-hint:not(.composer-send-block)'),
    emptyCopy: text('.empty-copy'),
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    focused: textarea instanceof HTMLTextAreaElement && document.activeElement === textarea,
    userMessages: document.querySelectorAll('.message.user').length,
    assistantMessages: document.querySelectorAll('.message.assistant').length,
    running: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
    pickerLabel: trigger ? (trigger.textContent || '').trim() : null,
    pickerAria: trigger ? trigger.getAttribute('aria-label') : null,
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

async function waitForReadiness(locator, state, timeoutMs = 60_000) {
  return harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    const readiness = response?.body?.readiness ?? response?.body
    return readiness?.state === state ? readiness : undefined
  }, timeoutMs, `readiness ${state}`)
}

/** Real CDP key events: what the renderer receives from a keyboard, not a value setter. */
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

async function click(client, selector) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

function buildConfig(workspaceDir, provider) {
  return {
    version: 1,
    providers: provider
      ? [{
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        baseURL: provider.baseURL,
        apiKey: API_KEY,
        models: [{ id: MODEL_ID, name: MODEL_ID }],
      }]
      : [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        // Case A leaves the model out on purpose: the Runtime then keeps its own
        // default ref (`openai/gpt-5.6`), which is exactly the ref the measured
        // defect dispatched to.
        ...(provider ? { model: `${PROVIDER_ID}/${MODEL_ID}` } : {}),
        reasoning: 'auto',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

async function startWindow({ root, config, env }) {
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const electron = await harness.startElectron({
    dataDir, chromiumDir, debuggingPort, logPath, extraEnv: env,
  })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await waitForSurface(client, (surface) => (surface.pickerLabel ? surface : undefined), 60_000, 'the composer runtime picker')
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  return { electron, locator, client, dataDir, logPath }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

/**
 * Case A. Nothing is configured; execution is ready.
 *
 * The point is the pair "ready" + "refused": if execution were unavailable, a
 * disabled send entry would prove nothing about the model gate.
 */
async function runUnconfiguredCase(recorder) {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-send-gate-none-'))
  let handle
  try {
    handle = await startWindow({
      root,
      config: buildConfig(join(root, 'data', 'workplace'), null),
      // Ambient provider keys would make this root "configured"; the fixture
      // decides what counts as configured, so they are removed for this launch.
      env: { OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GLM_API_KEY: undefined },
    })
    const readiness = await waitForReadiness(handle.locator, 'ready')
    const ready = await waitForSurface(
      handle.client,
      (surface) => (surface.pickerLabel?.includes('还没有配置模型') ? surface : undefined),
      30_000,
      'the unconfigured model picker',
    )
    // Focus explicitly: this case is about the gate, and script
    // `verify-composer-focus.mjs` owns whether the caret arrives by itself.
    await handle.client.evaluate(`document.querySelector('.composer textarea')?.focus()`)
    await typeText(handle.client, DRAFT)
    const typed = await readSurface(handle.client)
    recorder.check(readiness?.state === 'ready', 'execution itself is available in this fixture', readiness)
    recorder.check(typed.draft === DRAFT, 'the draft was typed with real key events', { draft: typed.draft })
    recorder.check(typed.sendPresent === true && typed.sendDisabled === true, 'the send control refuses the submit', typed)
    recorder.check(
      (typed.blockNotice ?? '').includes('设置 → 模型供应商'),
      'the refusal states where a model is configured, visibly',
      { blockNotice: typed.blockNotice },
    )
    recorder.check(
      typed.sendLabel === typed.blockNotice && (typed.blockNotice ?? '').length > 0,
      'the disabled control carries the same reason in its accessible name',
      { sendLabel: typed.sendLabel, blockNotice: typed.blockNotice },
    )
    recorder.check(
      typed.emptyCopy === typed.blockNotice,
      'the empty conversation states the same fact instead of inviting the send',
      { emptyCopy: typed.emptyCopy },
    )

    // Enter is the same send entry as the button.
    await pressEnter(handle.client)
    await delay(400)
    const afterEnter = await readSurface(handle.client)
    // ...and the button itself.
    await click(handle.client, '.composer-run-actions .send-round:not(.stop)')
    await delay(600)
    const afterClick = await readSurface(handle.client)
    const snapshot = await harness.desktopSnapshot(handle.locator)
    const sessions = await harness.fetchJson(handle.locator, '/sessions')
    recorder.note({
      step: 'unconfigured-refusal',
      readiness: readiness?.state,
      pickerLabel: ready.pickerLabel,
      blockNotice: typed.blockNotice,
      afterEnter: { draft: afterEnter.draft, userMessages: afterEnter.userMessages, running: afterEnter.running },
      afterClick: { draft: afterClick.draft, userMessages: afterClick.userMessages, running: afterClick.running },
      activeRunCount: snapshot?.activeRunCount,
      runnerActiveRuns: snapshot?.runtime?.currentRunnerActiveRunCount,
      sessionCount: sessions?.body?.sessions?.length ?? null,
    })
    for (const [label, surface] of [['Enter', afterEnter], ['the button', afterClick]]) {
      recorder.check(surface.userMessages === 0 && surface.assistantMessages === 0, `${label} started no turn`, surface)
      recorder.check(surface.running === false, `${label} started no run`, surface)
      recorder.check(surface.draft === DRAFT, `${label} left the draft in place`, { draft: surface.draft })
    }
    recorder.check(snapshot?.activeRunCount === 0, 'the desktop reports no active run', snapshot?.activeRunCount)
    recorder.check(
      (sessions?.body?.sessions?.length ?? 0) === 0,
      'refusing the send created no session',
      sessions?.body?.sessions?.length ?? null,
    )

    // The user is sent to the model picker, which still carries the fix.
    await click(handle.client, '.runtime-picker-trigger')
    const menuState = await harness.waitFor(async () => {
      const state = await handle.client.evaluate(`(() => {
        const empty = document.querySelector('.runtime-menu-shell.open .runtime-empty');
        return empty ? {
          label: empty.querySelector('span')?.textContent?.trim() ?? null,
          action: empty.querySelector('.runtime-configure-action')?.textContent?.trim() ?? null,
        } : null;
      })()`).catch(() => undefined)
      return state?.action ? state : undefined
    }, 15_000, 'the empty picker menu').catch(() => undefined)
    recorder.note({ step: 'unconfigured-picker', menu: menuState })
    recorder.check(menuState?.action === '配置模型', 'the refusal points at the picker action that fixes it', menuState)
    return { root, ok: true }
  } catch (error) {
    recorder.check(false, 'the unconfigured case ran', { error: error instanceof Error ? error.message : String(error) })
    return { root, ok: false }
  } finally {
    await stopWindow(handle)
    await harness.removeTemporaryRoot(root).catch(() => undefined)
  }
}

/** Case B. The working path: a configured provider still sends normally. */
async function runConfiguredCase(recorder, provider) {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-send-gate-ready-'))
  let handle
  try {
    handle = await startWindow({
      root,
      config: buildConfig(join(root, 'data', 'workplace'), provider),
      env: { OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GLM_API_KEY: undefined },
    })
    await waitForReadiness(handle.locator, 'ready')
    const ready = await waitForSurface(
      handle.client,
      (surface) => (surface.pickerAria?.includes(MODEL_ID) ? surface : undefined),
      30_000,
      'the picker to show the configured model',
    )
    // An empty draft disables the control too, so the gate is read from its label:
    // "发送" is the plain send tip, never a refusal reason.
    recorder.check(
      ready.blockNotice === null && ready.sendLabel === '发送',
      'a configured model leaves the send entry with its normal label, not a refusal',
      ready,
    )
    recorder.check(
      ready.emptyCopy === '选择模型、推理强度和工作目录后，直接交给 LittleSheep。',
      'the empty conversation keeps its normal copy',
      { emptyCopy: ready.emptyCopy },
    )

    await handle.client.evaluate(`document.querySelector('.composer textarea')?.focus()`)
    await typeText(handle.client, '你好')
    const typed = await readSurface(handle.client)
    recorder.check(typed.draft === '你好', 'the draft was typed with real key events', { draft: typed.draft })
    recorder.check(typed.sendDisabled === false, 'a readable draft is sendable with a configured model', typed)
    await pressEnter(handle.client)
    const running = await waitForSurface(
      handle.client,
      (surface) => (surface.running && surface.userMessages === 1 ? surface : undefined),
      20_000,
      'the sent turn to start',
    ).catch(() => undefined)
    const settled = await waitForSurface(
      handle.client,
      (surface) => (!surface.running && surface.assistantMessages === 1 && surface.draft === '' ? surface : undefined),
      60_000,
      'the turn to settle with an answer',
    ).catch(() => undefined)
    const reply = await handle.client.evaluate(
      `(() => { const node = [...document.querySelectorAll('.message.assistant')].pop(); return node ? node.textContent : null })()`,
    )
    const providerRequests = await (await fetch(provider.requestsURL)).json()
    recorder.note({
      step: 'configured-send',
      running: running ? { running: running.running, userMessages: running.userMessages } : null,
      settled: settled ? { running: settled.running, assistantMessages: settled.assistantMessages, draft: settled.draft } : null,
      reply,
      providerRequestCount: providerRequests.requests.length,
      providerModels: providerRequests.requests.map((entry) => entry.model),
    })
    recorder.check(Boolean(running), 'Enter dispatched a real run', running ?? null)
    recorder.check(Boolean(settled), 'the run settled', settled ?? null)
    recorder.check((reply ?? '').includes(ANSWER_MARKER), 'the settled answer is the provider reply', { reply })
    // The fixture answers a tool turn before the text turn, so more than one
    // request is normal; every one of them must name the configured model.
    recorder.check(
      providerRequests.requests.length >= 1
      && providerRequests.requests.every((entry) => entry.model === MODEL_ID),
      'every Provider request used the configured model',
      providerRequests.requests.map((entry) => entry.model),
    )
    return { ok: true }
  } catch (error) {
    recorder.check(false, 'the configured case ran', { error: error instanceof Error ? error.message : String(error) })
    return { ok: false }
  } finally {
    await stopWindow(handle)
    await harness.removeTemporaryRoot(root).catch(() => undefined)
  }
}

async function main() {
  await harness.assertBuildFresh()
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  try {
    await runUnconfiguredCase(recorder)
    await runConfiguredCase(recorder, provider)
  } finally {
    await provider.close().catch(() => undefined)
  }

  const evidence = {
    check: 'composer-send-gate',
    capturedAt: new Date().toISOString(),
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'Case A leaves the model unset so the Runtime keeps its own default ref (openai/gpt-5.6); ambient OPENAI_API_KEY/DEEPSEEK_API_KEY/GLM_API_KEY are removed for that launch, because a key in the environment would make the root configured.',
      'The refusal is asserted from the DOM and from the desktop snapshot (no active run, no session); the audit already recorded what the refused submit did before this gate existed (a run that streamed nothing for over a minute).',
      'The Provider stub is an OpenAI-compatible local endpoint, so case B proves the working path dispatches and settles, not that any real provider is reachable.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
