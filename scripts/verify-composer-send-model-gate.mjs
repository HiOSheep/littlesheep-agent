// Real-window acceptance for the composer's model prerequisite.
//
// The measured defect: with no model configured the composer showed
// 还没有配置模型, the send control was enabled, and pressing it started a run that
// sat at 正在工作 with zero characters streamed, no error and no settlement —
// because the Runtime reported `model: "openai/gpt-5.6"` while every built-in
// provider reported `hasKey: false`, so the request was dispatched to a provider
// that could not answer it. ChatGPT, Cursor and VS Code refuse that submit and
// point at model setup instead. Two entries reached it: the button and Enter.
//
// Half 1 — a fresh data root whose config carries the built-in default model and
// no provider of its own. The Runtime therefore reports *execution ready* (the
// Runner builds fine), which is the point: nothing but the model fact may refuse
// the submit. The contract asserted here:
//   - the send control refuses (disabled) and carries the Runtime's own reason;
//   - that reason is on screen in the composer row and in the first-run empty copy;
//   - Enter refuses the same way, with a draft in the box;
//   - no run starts: the Local App API's active-run list stays empty and the page
//     never posts to the run route.
//
// Half 2 — the same composer on a root where the deterministic acceptance
// Provider is configured the way the other gates configure it. Sending must
// behave exactly as before: one run route post, a real Provider request carrying
// the draft, a streamed answer in the transcript, and a settled Runtime.
//
// Usage:
//   node scripts/verify-composer-send-model-gate.mjs [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { runArtifact, runArtifactsRoot } from './lib/run-artifacts.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const DRAFT_TEXT = '这条草稿在没有可用模型之前不应该发出去'
const SENT_TEXT = '发送入口验收：模型已经配置，请回答'
const PROVIDER_ID = 'acceptance'
const MODEL_ID = 'slow-a'
/** The default model ref of a fresh install (`packages/config/src/defaults.ts`). */
const DEFAULT_MODEL_REF = 'openai/gpt-5.6'
/** Where the Runtime's own copy sends the user to fix a missing model. */
const CONFIGURE_HINT = '设置 → 模型供应商'
/** The deterministic acceptance answer always carries this anchor. */
const ANSWER_ANCHOR = 'runtime-continuity-anchor-4827'

/**
 * Counts what actually leaves the renderer towards the run route, so "no run was
 * started" is judged from the wire and not only from the Runtime's own list.
 * `localApiFetch` reads the global `fetch` at call time, so wrapping it here
 * intercepts every later request.
 */
const PROBE_SOURCE = `(() => {
  if (window.__lsRunRouteProbe) return true;
  const probe = { runRoutePosts: 0, runRouteUrls: [], eventPosts: 0 };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function probedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method === 'POST' && /\\/run\\/stream(?:\\?|$)/u.test(url)) {
      probe.runRoutePosts += 1;
      probe.runRouteUrls.push(url);
    }
    if (method === 'POST' && /\\/runs\\/[^/]+\\/events(?:\\?|$)/u.test(url)) probe.eventPosts += 1;
    return originalFetch(input, init);
  };
  window.__lsRunRouteProbe = probe;
  return true;
})()`

/** One read of every surface this gate judges. */
const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const send = document.querySelector('.composer-run-actions .send-round:not(.stop)');
  const stop = document.querySelector('.composer-run-actions .send-round.stop');
  const picker = document.querySelector('.runtime-picker-trigger');
  const reason = document.querySelector('.composer-right .composer-send-block')
    || document.querySelector('.composer-right .composer-readiness-hint');
  const textarea = document.querySelector('.composer textarea');
  const lastAssistant = [...document.querySelectorAll('.assistant-turn')].at(-1);
  return {
    send: send ? {
      disabled: send.disabled === true,
      ariaLabel: send.getAttribute('aria-label'),
      title: send.getAttribute('title'),
    } : null,
    stopPresent: stop instanceof HTMLElement,
    stopLabel: stop ? stop.getAttribute('aria-label') : null,
    picker: picker ? {
      label: (picker.textContent || '').trim(),
      ariaLabel: picker.getAttribute('aria-label'),
      title: picker.getAttribute('title'),
    } : null,
    sendReason: reason ? {
      className: reason.className,
      text: (reason.textContent || '').trim(),
      title: reason.getAttribute('title'),
    } : null,
    emptyCopy: text('.empty-copy'),
    emptyHintPresent: Boolean(document.querySelector('.messages.is-empty .empty-hint')),
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    attachments: document.querySelectorAll('.attachment-preview-card').length,
    userMessages: [...document.querySelectorAll('.message.user')].map((node) => (node.textContent || '').trim()),
    assistantTurns: document.querySelectorAll('.assistant-turn').length,
    assistantText: lastAssistant?.querySelector('.assistant-response-stream')?.textContent?.trim() ?? '',
    runStatusError: lastAssistant?.querySelector('.run-status-error')?.textContent?.trim() ?? null,
    composerError: text('.composer-error'),
    probe: window.__lsRunRouteProbe
      ? {
        runRoutePosts: window.__lsRunRouteProbe.runRoutePosts,
        eventPosts: window.__lsRunRouteProbe.eventPosts,
        runRouteUrls: [...window.__lsRunRouteProbe.runRouteUrls],
      }
      : null,
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

/**
 * A real first-run config: no provider of its own, and the built-in default
 * model ref. `withProviderPresets` adds the three presets with `$…_API_KEY`
 * references, so whether anything is callable depends on the environment — which
 * the fixture clears explicitly.
 */
function buildUnconfiguredConfig(workspaceDir) {
  return {
    version: 1,
    providers: [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: DEFAULT_MODEL_REF,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

/** The configured root, built the way the other real-window gates build it. */
function buildConfiguredConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: PROVIDER_ID,
      name: 'Electron Acceptance',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 30,
      models: [MODEL_ID],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `${PROVIDER_ID}/${MODEL_ID}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

async function startWindow({ dataDir, workspaceDir, chromiumDir, logPath, config, extraEnv = {} }) {
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(chromiumDir, { recursive: true }),
  ])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const debuggingPort = await harness.reservePort()
  const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath, extraEnv })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
    harness.startTimeoutMs,
    'the composer textarea',
  )
  return { electron, locator, client }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

async function readSurface(client) {
  return client.evaluate(SURFACE_EXPRESSION)
}

async function waitForSurface(client, predicate, timeoutMs, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client)
    return predicate(surface) ? surface : undefined
  }, timeoutMs, label)
}

/** Execution readiness as the Main process reports it, not as the DOM renders it. */
async function readReadiness(locator) {
  const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
  return response?.body ?? null
}

/** The Runtime's own list of runs that are still alive. */
async function readActiveRuns(locator) {
  const response = await harness.fetchJson(locator, '/application/active-runs').catch(() => undefined)
  return Array.isArray(response?.body?.runs) ? response.body.runs : null
}

async function setDraft(client, value) {
  return client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
    return true;
  })()`)
}

/** A real pointer click on the send control, the way a user presses it. */
async function clickSend(client) {
  return client.evaluate(`(() => {
    const button = document.querySelector('.composer-run-actions .send-round:not(.stop)');
    if (!(button instanceof HTMLElement)) return null;
    const rect = button.getBoundingClientRect();
    return { disabled: button.disabled === true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`).then(async (box) => {
    if (!box) return false
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    return true
  })
}

/** Plain Enter on the focused composer; the same key a user presses. */
async function dispatchEnter(client) {
  await client.evaluate(`document.querySelector('.composer textarea')?.focus()`)
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  })
}

async function captureScreenshot(client, name) {
  try {
    await client.send('Page.bringToFront').catch(() => undefined)
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const path = runArtifact('composer-send-model-gate', `${name}.png`)
    await mkdir(join(runArtifactsRoot, 'composer-send-model-gate'), { recursive: true })
    await writeFile(path, Buffer.from(shot.data, 'base64'))
    return path
  } catch {
    return null
  }
}

/**
 * Half 1 — the blocked root, runnable on its own (`--case=blocked`).
 *
 * A fresh isolated data root, every provider key removed from the environment for
 * this launch, and the Runtime's own default model ref in the config: exactly the
 * state in which the measured defect dispatched the turn to a provider with no key.
 * Asserts that the send control refuses with a visible reason (button *and* Enter),
 * that the Local App API's active-run list stays empty, and that the renderer never
 * posts the run route.
 */
async function runBlockedHalf({ root, recorder, reports }) {
  const freshDataDir = join(root, 'fresh', 'data')
  let handle
  try {
    // --- half 1: no usable model ---------------------------------------------
    handle = await startWindow({
      dataDir: freshDataDir,
      workspaceDir: join(freshDataDir, 'workplace'),
      chromiumDir: join(root, 'fresh', 'chromium'),
      logPath: join(root, 'fresh', 'electron.log'),
      config: buildUnconfiguredConfig(join(freshDataDir, 'workplace')),
      // A fixture root has to decide what counts as configured; the harness
      // reads these names for the built-in presets (`$OPENAI_API_KEY` …).
      extraEnv: {
        OPENAI_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        GLM_API_KEY: undefined,
      },
    })
    await harness.desktopAction(handle.locator, 'resize', WINDOW_SIZE)
    if (!await handle.client.evaluate(PROBE_SOURCE)) throw new Error('the run-route probe could not attach')

    const unconfigured = await waitForSurface(
      handle.client,
      (surface) => (surface.picker?.label.includes('还没有配置模型') ? surface : undefined),
      30_000,
      'the unconfigured model picker',
    )
    // Readiness is waited for, then asserted: the refusal below must be the model
    // fact, not the startup window that already had its own disabled reason.
    const readiness = await harness.waitFor(async () => {
      const snapshot = await readReadiness(handle.locator)
      return snapshot?.state === 'ready' ? snapshot : undefined
    }, 60_000, 'execution readiness on the fresh root')
    const runtimeState = await harness.fetchJson(handle.locator, '/runtime')
    const activeRunsBefore = await readActiveRuns(handle.locator)
    // The premise of this half: execution itself is available, so the only fact
    // that can refuse the send is the model one.
    recorder.check(
      readiness?.state === 'ready',
      'the Runtime reports execution ready while no provider has a key',
      { readiness },
    )
    recorder.check(
      runtimeState?.body?.model === DEFAULT_MODEL_REF,
      'the Runtime reports the built-in default model ref',
      { model: runtimeState?.body?.model ?? null },
    )
    const providers = Array.isArray(runtimeState?.body?.providers) ? runtimeState.body.providers : []
    recorder.check(
      providers.length > 0 && providers.every((entry) => entry.hasKey === false),
      'every provider the Runtime lists reports no usable key',
      { providers: providers.map((entry) => ({ id: entry.id, hasKey: entry.hasKey, models: entry.models?.length ?? 0, requiresKey: entry.requiresKey })) },
    )
    recorder.check(
      activeRunsBefore !== null && activeRunsBefore.length === 0,
      'the Runtime starts with no active run',
      { activeRuns: activeRunsBefore },
    )

    await setDraft(handle.client, DRAFT_TEXT)
    const beforeSend = await readSurface(handle.client)
    recorder.note({
      step: 'unconfigured',
      readiness,
      runtimeModel: runtimeState?.body?.model ?? null,
      picker: unconfigured.picker,
      send: beforeSend.send,
      sendReason: beforeSend.sendReason,
      emptyCopy: beforeSend.emptyCopy,
      draft: beforeSend.draft,
    })
    recorder.check(
      beforeSend.send?.disabled === true,
      'the send control refuses while no model can answer',
      { send: beforeSend.send },
    )
    recorder.check(
      (beforeSend.send?.ariaLabel ?? '').includes(CONFIGURE_HINT)
        || (beforeSend.send?.ariaLabel ?? '').includes('还没有配置'),
      'the send control carries the Runtime reason as its accessible name',
      { ariaLabel: beforeSend.send?.ariaLabel ?? null },
    )
    recorder.check(
      (beforeSend.sendReason?.text ?? '').includes(CONFIGURE_HINT),
      'the reason is stated in the composer control row',
      { sendReason: beforeSend.sendReason },
    )
    recorder.check(
      (beforeSend.sendReason?.title ?? '').includes(CONFIGURE_HINT),
      'the stated reason carries the full Runtime sentence as its title',
      { sendReason: beforeSend.sendReason },
    )
    recorder.check(
      beforeSend.emptyHintPresent === true && (beforeSend.emptyCopy ?? '').includes(CONFIGURE_HINT),
      'the first-run empty copy points at model setup instead of inviting a send',
      { emptyCopy: beforeSend.emptyCopy },
    )

    // Entry 1: the button. A real pointer click on a disabled control does nothing.
    const clicked = await clickSend(handle.client)
    await delay(1_500)
    const afterClick = await readSurface(handle.client)
    const activeRunsAfterClick = await readActiveRuns(handle.locator)
    recorder.note({
      step: 'click',
      clicked,
      probe: afterClick.probe,
      activeRuns: activeRunsAfterClick,
      userMessages: afterClick.userMessages,
      stopPresent: afterClick.stopPresent,
      draft: afterClick.draft,
    })
    recorder.check(clicked === true, 'the send control is present and was pressed', { clicked })
    recorder.check(
      (afterClick.probe?.runRoutePosts ?? -1) === 0,
      'pressing the send control never posted the run route',
      { probe: afterClick.probe },
    )
    recorder.check(
      Array.isArray(activeRunsAfterClick) && activeRunsAfterClick.length === 0,
      'the Runtime lists no run after pressing the send control',
      { activeRuns: activeRunsAfterClick },
    )
    recorder.check(
      afterClick.userMessages.length === 0 && afterClick.assistantTurns === 0,
      'no turn was added to the transcript by pressing the send control',
      { userMessages: afterClick.userMessages, assistantTurns: afterClick.assistantTurns },
    )
    recorder.check(afterClick.draft === DRAFT_TEXT, 'the refused send kept the draft', { draft: afterClick.draft })

    // Entry 2: Enter, the second way into the same hung run.
    await dispatchEnter(handle.client)
    await delay(2_500)
    const afterEnter = await readSurface(handle.client)
    const activeRunsAfterEnter = await readActiveRuns(handle.locator)
    const screenshot = await captureScreenshot(handle.client, 'unconfigured-refusal')
    recorder.note({
      step: 'enter',
      probe: afterEnter.probe,
      activeRuns: activeRunsAfterEnter,
      userMessages: afterEnter.userMessages,
      assistantTurns: afterEnter.assistantTurns,
      stopPresent: afterEnter.stopPresent,
      draft: afterEnter.draft,
      sendReason: afterEnter.sendReason,
      screenshot,
    })
    recorder.check(
      (afterEnter.probe?.runRoutePosts ?? -1) === 0,
      'pressing Enter never posted the run route',
      { probe: afterEnter.probe },
    )
    recorder.check(
      Array.isArray(activeRunsAfterEnter) && activeRunsAfterEnter.length === 0,
      'the Runtime lists no run after Enter',
      { activeRuns: activeRunsAfterEnter },
    )
    recorder.check(
      afterEnter.userMessages.length === 0 && afterEnter.assistantTurns === 0,
      'no turn was added to the transcript by Enter',
      { userMessages: afterEnter.userMessages, assistantTurns: afterEnter.assistantTurns },
    )
    recorder.check(afterEnter.draft === DRAFT_TEXT, 'the refused Enter kept the draft', { draft: afterEnter.draft })
    recorder.check(
      afterEnter.stopPresent === false,
      'no run control appeared, so nothing is in flight',
      { stopPresent: afterEnter.stopPresent },
    )
    reports.unconfiguredRoot = {
      readiness,
      model: runtimeState?.body?.model ?? null,
      providers: providers.map((entry) => ({ id: entry.id, hasKey: entry.hasKey, models: entry.models?.length ?? 0 })),
      send: afterEnter.send,
      sendReason: afterEnter.sendReason,
      emptyCopy: afterEnter.emptyCopy,
      probe: afterEnter.probe,
      activeRuns: activeRunsAfterEnter,
      screenshot,
    }
  } catch (error) {
    recorder.check(false, 'the blocked half ran without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await stopWindow(handle)
  }
}

/**
 * Half 2 — the working path, runnable on its own (`--case=ready`).
 *
 * The same composer on a root where the deterministic acceptance Provider is
 * configured the way the other gates configure it: sending must still post the run
 * route, reach the Provider with the typed draft, stream the answer into the
 * transcript, and settle with the Runtime's active-run list empty again.
 */
async function runReadyHalf({ root, recorder, reports, provider }) {
  const configuredDataDir = join(root, 'configured', 'data')
  let handle
  try {
    // --- half 2: a configured provider still sends end to end -----------------
    handle = await startWindow({
      dataDir: configuredDataDir,
      workspaceDir: join(configuredDataDir, 'workplace'),
      chromiumDir: join(root, 'configured', 'chromium'),
      logPath: join(root, 'configured', 'electron.log'),
      config: buildConfiguredConfig(join(configuredDataDir, 'workplace'), provider.baseURL),
    })
    await harness.desktopAction(handle.locator, 'resize', WINDOW_SIZE)
    if (!await handle.client.evaluate(PROBE_SOURCE)) throw new Error('the run-route probe could not attach')

    const configured = await waitForSurface(
      handle.client,
      (surface) => (surface.picker?.ariaLabel?.includes(MODEL_ID) ? surface : undefined),
      30_000,
      'the configured model picker',
    )
    // The model fact can arrive before execution does (the Local App API serves
    // `/runtime` while the Runner is still being built), so this half waits for
    // both Runtime facts before it judges the control: readiness ready, and — with
    // a draft in the box, since an empty draft disables send by design — the send
    // control enabled. Otherwise it would measure the startup window instead of
    // the configured path.
    const configuredReadiness = await harness.waitFor(async () => {
      const snapshot = await readReadiness(handle.locator)
      return snapshot?.state === 'ready' ? snapshot : undefined
    }, 60_000, 'execution readiness on the configured root')
    await setDraft(handle.client, SENT_TEXT)
    const readyToSend = await waitForSurface(
      handle.client,
      (surface) => (surface.send?.disabled === false ? surface : undefined),
      30_000,
      'the enabled send control',
    )
    const requestsBefore = provider.requests.length
    const beforeConfiguredSend = await readSurface(handle.client)
    recorder.note({
      step: 'configured-ready',
      readiness: configuredReadiness,
      picker: configured.picker,
      send: beforeConfiguredSend.send,
      sendReason: beforeConfiguredSend.sendReason,
      emptyCopy: beforeConfiguredSend.emptyCopy,
    })
    recorder.check(
      readyToSend.send?.disabled === false && beforeConfiguredSend.send?.disabled === false,
      'a configured model leaves the send control enabled',
      { send: beforeConfiguredSend.send },
    )
    recorder.check(
      beforeConfiguredSend.sendReason === null,
      'no refusal is stated once a model can answer',
      { sendReason: beforeConfiguredSend.sendReason },
    )

    const clickedConfigured = await clickSend(handle.client)
    const providerRequest = await harness.waitFor(
      () => (provider.requests.length > requestsBefore ? provider.requests.at(-1) : null),
      60_000,
      'the acceptance Provider request',
    )
    const answered = await waitForSurface(
      handle.client,
      (surface) => (surface.assistantText.includes(ANSWER_ANCHOR) ? surface : undefined),
      60_000,
      'the streamed answer',
    )
    // Settled: the stop control is gone and the Runtime has released the run.
    await waitForSurface(
      handle.client,
      (surface) => (surface.stopPresent === false ? surface : undefined),
      60_000,
      'the run to settle',
    )
    const settledRuns = await harness.waitFor(async () => {
      const runs = await readActiveRuns(handle.locator)
      return Array.isArray(runs) && runs.length === 0 ? runs : undefined
    }, 60_000, 'the Runtime to release the active run')
    const afterConfiguredSend = await readSurface(handle.client)
    recorder.note({
      step: 'configured-sent',
      clicked: clickedConfigured,
      providerRequests: provider.requests.length - requestsBefore,
      providerMessages: providerRequest?.messages?.map((message) => message.role) ?? [],
      probe: afterConfiguredSend.probe,
      assistantText: afterConfiguredSend.assistantText,
      runStatusError: afterConfiguredSend.runStatusError,
      composerError: afterConfiguredSend.composerError,
      draft: afterConfiguredSend.draft,
      activeRuns: settledRuns,
    })
    recorder.check(
      clickedConfigured === true && (afterConfiguredSend.probe?.runRoutePosts ?? 0) >= 1,
      'sending on a configured root posts the run route',
      { clicked: clickedConfigured, probe: afterConfiguredSend.probe },
    )
    recorder.check(
      provider.requests.length > requestsBefore,
      'the run reached the configured Provider',
      { requests: provider.requests.length - requestsBefore },
    )
    recorder.check(
      JSON.stringify(providerRequest?.messages ?? []).includes(SENT_TEXT),
      'the dispatched request carried the typed draft',
      { messages: providerRequest?.messages ?? [] },
    )
    recorder.check(
      answered.assistantText.includes(ANSWER_ANCHOR),
      'the streamed answer reached the transcript',
      { assistantText: answered.assistantText.slice(0, 400) },
    )
    recorder.check(
      afterConfiguredSend.draft === '',
      'a successful send clears the draft',
      { draft: afterConfiguredSend.draft },
    )
    recorder.check(
      afterConfiguredSend.runStatusError === null && afterConfiguredSend.composerError === null,
      'the completed run reported no failure',
      { runStatusError: afterConfiguredSend.runStatusError, composerError: afterConfiguredSend.composerError },
    )
    reports.configuredRoot = {
      providerRequests: provider.requests.length - requestsBefore,
      probe: afterConfiguredSend.probe,
      assistantText: afterConfiguredSend.assistantText.slice(0, 400),
      activeRuns: settledRuns,
      runRoutePosts: afterConfiguredSend.probe?.runRoutePosts ?? null,
    }
  } catch (error) {
    recorder.check(false, 'the ready half ran without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await stopWindow(handle)
  }
}

/** One evidence file per case, written outside the checkout (`scripts/lib/run-artifacts.mjs`). */
async function writeEvidence(name, evidence) {
  const directory = runArtifact('composer-send-model-gate')
  await mkdir(directory, { recursive: true })
  const body = `${JSON.stringify(evidence, null, 2)}\n`
  const path = join(directory, `${name}.json`)
  await writeFile(path, body, 'utf8')
  await writeFile(join(directory, `${name}-latest.json`), body, 'utf8')
  return path
}

function readCaseSelection() {
  const argument = process.argv.find((value) => value.startsWith('--case='))
  const selected = argument ? argument.slice('--case='.length) : 'both'
  if (!['blocked', 'ready', 'both'].includes(selected)) {
    throw new Error(`unknown --case=${selected}; expected blocked, ready or both`)
  }
  return selected
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const selected = readCaseSelection()
  const recorder = createRecorder()
  const reports = {}
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-send-model-gate-'))
  let provider = null
  let scratchRootRemoved = null
  let scratchRootError = null

  try {
    if (selected !== 'ready') await runBlockedHalf({ root, recorder, reports })
    if (selected !== 'blocked') {
      provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
      await runReadyHalf({ root, recorder, reports, provider })
    }
  } finally {
    await provider?.close().catch(() => undefined)
    if (!keep) {
      // Chromium keeps a SQLite journal in its user-data dir open for a moment
      // after the process tree exits. A locked scratch root is a cleanup problem,
      // not a gate failure, so it is reported instead of thrown.
      await delay(1_000)
      try {
        await harness.removeTemporaryRoot(root)
        scratchRootRemoved = true
      } catch (error) {
        scratchRootRemoved = false
        scratchRootError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  const evidence = {
    check: 'composer-send-model-gate',
    case: selected,
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : (scratchRootRemoved ? '<temporary root removed>' : root),
    scratchRootRemoved,
    scratchRootError,
    environmentKeysClearedForTheFreshHalf: ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY'],
    reports,
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'Half 1 proves the submit is refused on a fresh root whose Runtime reports execution ready; it does not prove what the Provider would have done with the request, because no request is sent.',
      'Half 2 uses the deterministic acceptance Provider stub, so it proves the composer still dispatches and renders a settled answer; it is not evidence about any real provider being reachable.',
      'The run-route count comes from a page-level fetch probe installed before the first interaction; the active-run list comes from the Local App API.',
    ],
  }
  const path = await writeEvidence(
    selected === 'both' ? 'composer-send-model-gate' : `composer-send-model-gate-${selected}`,
    evidence,
  )
  console.log(JSON.stringify({ ...evidence, evidencePath: path }, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
