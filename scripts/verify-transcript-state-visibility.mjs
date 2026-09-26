// Real-window acceptance for the transcript facts a reader must not lose (taskbook UX-33).
//
// UX-33 asks the chat transcript to keep every "needs attention" fact readable in BOTH display
// modes. Compact display folds the finished process away, so the facts that must survive it are
// exactly the ones a user has to act on or fix. This gate produces the five classes the product
// can really produce in one isolated window and samples the *same turn* in normal and compact
// display:
//
//   1. unverified       a completed run whose verification verdict is 未验证
//   2. failure          an unretryable transport failure (HTTP 401) that ends the turn
//   3. aborted          the user stops a run whose Provider never answers
//   4. pending-approval a running turn waiting for the user's write approval
//   5. denied-tool      the same call, refused by the user, kept as a failed tool row after a
//                       window reload (the live stream has no tool row for it)
//
// What each sample must show:
//   - normal mode: the rows and text a reader needs (the failed turn and its reason, the kept
//     failed tool row, the verification verdict, the live waiting/aborted status),
//   - compact mode: the `.agent-transcript-attention` line, plus proof that folding really
//     happened (fewer `.assistant-transcript [data-transcript-entry]` nodes than normal mode).
//
// Two classes the taskbook names cannot be produced by this build:
//   - 待用户 (`waiting_user`) is only written by older versions / crash recovery
//     (`packages/harness/src/durable-kernel.ts`); the live-producible equivalent is the pending
//     approval state measured here, and no synthetic checkpoint is fabricated.
//   - 部分完成 does not exist: `HistoryActivityStatus` has no `partial` member, so the taskbook's
//     instruction to rewrite it to a real state is followed with `aborted` (本轮已停止).
//
// Usage:
//   node scripts/verify-transcript-state-visibility.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-transcript-state-visibility')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1100, height: 760 }
const EVALUATE_TIMEOUT_MS = 20_000
/** The scripted Provider answers this prompt with a `write` tool call (research mode asks first). */
const DENIAL_PROMPT = '请使用 write 工具创建 UX07-APPROVAL-ESCAPE 验收文件'
const PLAIN_PROMPT = '请简短确认这条转录状态验收消息。'
const STOP_PROMPT = '请简短确认这条中止验收消息。'
const DISPLAY_MODE_KEY = 'littlesheep.ui.conversationDisplayMode'
const DISPLAY_MODE_EVENT = 'littlesheep:conversation-display-mode'
const SETTLE_TIMEOUT_MS = 90_000
/**
 * The abort fixture needs the run to survive its first model request with a real transcript
 * (system prompt + preparing + tool row) and then hang on the request that follows the tool
 * result. The Provider's `/control` delay matches on prompt text, and this workspace file name
 * only appears in the prompt once the glob result is part of it.
 */
const ABORT_ANCHOR_FILE = 'transcript-state-anchor.txt'
const ABORT_DELAY_MS = 30_000

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
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

function createRecorder() {
  const observations = []
  const failures = []
  const assertions = []
  let checks = 0
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      checks += 1
      const ok = Boolean(condition)
      assertions.push({ check, ok, detail })
      if (!ok) failures.push({ check, detail })
      return ok
    },
    failures,
    observations,
    assertions,
    count: () => checks,
  }
}

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
      id: 'acceptance',
      name: 'Transcript State Acceptance Provider',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      // Long enough that the abort fixture is the user's stop, never the client's own deadline.
      timeoutSeconds: 120,
      models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/slow-a',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 32,
      },
    },
    channels: { channels: [] },
    desktop: { closePolicy: 'always-background' },
  }
}

/**
 * One sample of everything the newest assistant turn currently says.
 *
 * Every field is read from the real DOM; the strings are returned verbatim so the recorded
 * observation is auditable against the screenshots taken in the same moment.
 */
const TURN_SAMPLE_EXPRESSION = `(() => {
  const turns = [...document.querySelectorAll('.assistant-turn')];
  const pick = PICK_SELECTOR;
  const matched = pick ? [...turns].reverse().find((candidate) => candidate.querySelector(pick)) : turns.at(-1);
  const turn = matched ?? turns.at(-1);
  if (!turn) return null;
  const text = (node) => ((node && node.textContent) || '').replace(/\\s+/gu, ' ').trim();
  const transcript = turn.querySelector('.assistant-transcript');
  const entries = transcript ? [...transcript.querySelectorAll('[data-transcript-entry]')] : [];
  const attention = turn.querySelector('.agent-transcript-attention');
  const verification = turn.querySelector('[data-transcript-verification="true"]');
  const failedTools = [...turn.querySelectorAll('.agent-tool-call.fail[data-call-id]')];
  const allTools = [...turn.querySelectorAll('.agent-tool-call[data-call-id]')];
  // Tool rows are rendered from transcript entries but carry data-call-id instead of
  // data-transcript-entry, so the container is queried separately for them.
  const transcriptTools = transcript ? [...transcript.querySelectorAll('.agent-tool-call[data-call-id]')] : [];
  const transcriptFailedTools = transcript ? [...transcript.querySelectorAll('.agent-tool-call.fail[data-call-id]')] : [];
  const stageRows = [...turn.querySelectorAll('.agent-active-stage-row .agent-flow-summary')];
  const prompt = document.querySelector('.approval-prompt');
  return {
    displayMode: localStorage.getItem(${JSON.stringify(DISPLAY_MODE_KEY)}) || 'normal',
    turnClass: typeof turn.className === 'string' ? turn.className : null,
    turnStatus: [...turn.classList].find((name) => name !== 'assistant-turn') || null,
    responseState: turn.querySelector('.assistant-response-stream')?.getAttribute('data-stream-state') || null,
    responseText: text(turn.querySelector('.assistant-response-stream')).slice(0, 240),
    runStatusError: text(turn.querySelector('.run-status-error')) || null,
    transcriptPresent: transcript instanceof HTMLElement,
    entryCount: entries.length,
    entries: entries.map((entry) => ({
      id: entry.getAttribute('data-transcript-entry'),
      className: typeof entry.className === 'string' ? entry.className : '',
      text: text(entry).slice(0, 60),
    })),
    attentionPresent: attention instanceof HTMLElement,
    attentionText: text(attention) || null,
    verificationPresent: verification instanceof HTMLElement,
    verificationText: text(verification) || null,
    toolRows: allTools.length,
    failedToolRows: failedTools.length,
    transcriptToolRows: transcriptTools.length,
    transcriptFailedToolRows: transcriptFailedTools.length,
    failedToolTexts: failedTools.map((row) => text(row).slice(0, 200)),
    activeStageTexts: stageRows.map((row) => text(row)),
    approvalPrompt: prompt
      ? {
        title: text(prompt.querySelector('h2')),
        actions: [...prompt.querySelectorAll('.approval-action')].map((button) => text(button)),
        detail: text(prompt.querySelector('pre')).slice(0, 160),
      }
      : null,
    turnCount: document.querySelectorAll('.assistant-turn').length,
    userMessageCount: document.querySelectorAll('.message.user').length,
    // A picked fact that is on screen but not inside any turn is a different finding from a fact
    // that is simply not rendered; the numbers say which one this is.
    pickMissed: pick ? !matched : false,
    documentFailedToolRows: document.querySelectorAll('.agent-tool-call.fail[data-call-id]').length,
  };
})()`

async function sampleTurn(client, attempts = 4, pick = '') {
  const expression = TURN_SAMPLE_EXPRESSION.replace('PICK_SELECTOR', JSON.stringify(pick))
  let lastError = null
  for (let index = 0; index < attempts; index += 1) {
    try {
      const sample = await evaluate(client, expression)
      if (sample) return sample
      lastError = new Error('no assistant turn is rendered')
    } catch (error) {
      lastError = error
    }
    await delay(400)
  }
  throw lastError ?? new Error('the turn could not be sampled')
}

/**
 * The transcript keeps filling in after a reload (history arrives in pages), so a sample taken the
 * moment one turn exists can be followed by a different "last turn" a moment later. When the step
 * follows a particular fact, wait for that fact to be on screen before sampling it.
 */
async function waitForFact(client, selector, timeoutMs = 30_000) {
  await harness.waitFor(
    () => evaluate(client, `document.querySelector(${JSON.stringify(selector)}) ? true : null`).catch(() => null),
    timeoutMs,
    `the turn holding ${selector}`,
  ).catch(() => undefined)
}

async function waitForTurn(client, predicate, label, timeoutMs = SETTLE_TIMEOUT_MS, pick = '') {
  const expression = TURN_SAMPLE_EXPRESSION.replace('PICK_SELECTOR', JSON.stringify(pick))
  return harness.waitFor(async () => {
    const sample = await evaluate(client, expression).catch(() => null)
    return sample && predicate(sample) ? sample : undefined
  }, timeoutMs, label)
}

async function setDisplayMode(client, mode) {
  const applied = await evaluate(client, `(() => {
    localStorage.setItem(${JSON.stringify(DISPLAY_MODE_KEY)}, ${JSON.stringify(mode)});
    window.dispatchEvent(new CustomEvent(${JSON.stringify(DISPLAY_MODE_EVENT)}, { detail: ${JSON.stringify(mode)} }));
    return localStorage.getItem(${JSON.stringify(DISPLAY_MODE_KEY)});
  })()`)
  if (applied !== mode) throw new Error(`the ${mode} display mode could not be written (read ${applied})`)
  await delay(350)
}

/** A settled turn folds in compact mode; the attention row is the visible proof it re-rendered. */
async function waitForCompactAttention(client, timeoutMs = 15_000) {
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1);
    return turn && turn.querySelector('.agent-transcript-attention') ? true : null;
  })()`), timeoutMs, 'the compact attention row').catch(() => false)
}

async function submitPrompt(client, prompt) {
  const submitted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(prompt)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`)
  if (!submitted) throw new Error('the composer could not be submitted')
}

async function startNewConversation(client) {
  const clicked = await evaluate(client, `(() => {
    const selectors = [
      '.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]',
      '.conversation-section .sidebar-new-action',
      '.sidebar-new-action',
    ];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)]
        .find((node) => node instanceof HTMLElement && !node.closest('[inert]'));
      if (button instanceof HTMLElement) { button.click(); return selector; }
    }
    return null;
  })()`)
  if (!clicked) throw new Error('a new conversation could not be started')
  await harness.waitFor(() => evaluate(client, `(() => {
    const turns = document.querySelectorAll('.assistant-turn').length;
    const users = document.querySelectorAll('.message.user').length;
    return turns === 0 && users === 0 ? true : null;
  })()`), harness.startTimeoutMs, 'an empty transcript for the new conversation')
  return clicked
}

async function clickStop(client) {
  return evaluate(client, `(() => {
    const button = document.querySelector('.composer-run-actions .send-round.stop');
    if (!(button instanceof HTMLElement)) return null;
    const label = button.getAttribute('aria-label');
    button.click();
    return label;
  })()`)
}

/** The dialog's first action is 拒绝; Escape means the same thing (`approval/prompt.tsx`). */
async function denyApproval(client) {
  return evaluate(client, `(() => {
    const prompt = document.querySelector('.approval-prompt');
    if (!(prompt instanceof HTMLElement)) return null;
    const buttons = [...prompt.querySelectorAll('.approval-action')];
    const deny = buttons.find((button) => (button.textContent || '').includes('拒绝')) || buttons[0];
    if (!(deny instanceof HTMLElement)) return null;
    const label = (deny.textContent || '').trim();
    deny.click();
    return { label, actions: buttons.map((button) => (button.textContent || '').trim()) };
  })()`)
}

async function reloadRenderer(client, label) {
  const previousTimeOrigin = await evaluate(client, 'performance.timeOrigin')
  await client.send('Page.reload', { ignoreCache: false })
  return harness.waitFor(async () => {
    const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
      .catch(() => undefined)
    if (!state) return undefined
    return state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? state.timeOrigin : undefined
  }, harness.startTimeoutMs, label)
}

/**
 * Sample the same turn in both display modes and take one screenshot per mode.
 *
 * `waitForCompact` is only used for a settled turn: a running turn is never folded
 * (`compactCompleted` requires a non-running activity), so no attention row can appear for it.
 */
async function captureBothModes({ client, recorder, screenshots, name, waitForCompact = true, pick = '' }) {
  if (pick) await waitForFact(client, pick)
  // Both modes are sampled back to back, and the screenshots are taken afterwards: a screenshot
  // can take a second, and the transcript may move on in the meantime (a run that is still
  // finishing appends its own turn), which would otherwise be read as the row disappearing.
  await setDisplayMode(client, 'normal')
  const normal = await sampleTurn(client, pick ? 12 : 4, pick)
  await setDisplayMode(client, 'compact')
  if (waitForCompact) await waitForCompactAttention(client)
  const compact = await sampleTurn(client, pick ? 12 : 4, pick)

  await setDisplayMode(client, 'normal')
  screenshots[`${name}-normal`] = await writePng(client, `${name}-normal`)
  await setDisplayMode(client, 'compact')
  screenshots[`${name}-compact`] = await writePng(client, `${name}-compact`)
  recorder.note({ step: `${name}-normal`, sample: normal })
  recorder.note({ step: `${name}-compact`, sample: compact })
  return { normal, compact }
}

/** The exact strings the evidence turns on, so a reader can audit them without the screenshots. */
function recordStrings(recorder, step, sample) {
  recorder.note({
    step: `${step}-strings`,
    strings: {
      turnClass: sample.turnClass,
      runStatusError: sample.runStatusError,
      attentionText: sample.attentionText,
      verificationText: sample.verificationText,
      failedToolTexts: sample.failedToolTexts,
      activeStageTexts: sample.activeStageTexts,
      transcriptEntries: sample.entries.map((entry) => `${entry.id}: ${entry.className}`),
      transcriptToolRows: sample.transcriptToolRows,
      transcriptFailedToolRows: sample.transcriptFailedToolRows,
    },
  })
}

async function main() {
  await harness.assertBuildFresh()
  const recorder = createRecorder()
  const screenshots = {}
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 15, streamChunkCharacters: 40 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-transcript-state-visibility-'))
  const dataDir = join(root, 'data')
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  let handle

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    // The abort fixture hangs the request that carries this file's glob result (see
    // ABORT_ANCHOR_FILE); the file itself is never read or written by the Agent.
    await writeFile(join(workplaceDir, ABORT_ANCHOR_FILE), 'transcript state visibility anchor\n', 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // Parked outside every display and shown inactively: the window still renders for screenshots.
    await harness.desktopAction(locator, 'park-offscreen')
    await delay(1200)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    handle = { electron, locator, client }
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // ---------------------------------------------------------------------
    // 1. unverified: a completed run whose verification verdict did not pass
    // ---------------------------------------------------------------------
    await startNewConversation(client)
    await setDisplayMode(client, 'normal')
    await submitPrompt(client, PLAIN_PROMPT)
    await waitForTurn(
      client,
      (sample) => sample.turnStatus !== 'running' && sample.verificationPresent,
      'a settled turn with a verification verdict',
    )
    const unverified = await captureBothModes({ client, recorder, screenshots, name: 'unverified' })
    recordStrings(recorder, 'unverified-normal', unverified.normal)
    recordStrings(recorder, 'unverified-compact', unverified.compact)
    recorder.check(
      unverified.normal.verificationPresent === true
      && (unverified.normal.verificationText ?? '').includes('验证：未验证'),
      'normal mode renders the unverified verdict as its own status row (验证：未验证)',
      { verificationText: unverified.normal.verificationText, turnClass: unverified.normal.turnClass },
    )
    recorder.check(
      unverified.normal.attentionPresent === false,
      'normal mode does not need the compact attention line',
      { attentionText: unverified.normal.attentionText },
    )
    recorder.check(
      unverified.normal.transcriptPresent === true && unverified.normal.entryCount >= 1,
      'the normal-mode turn carries transcript rows, so folding is measurable',
      { transcriptPresent: unverified.normal.transcriptPresent, entryCount: unverified.normal.entryCount, entries: unverified.normal.entries.map((entry) => entry.id) },
    )
    recorder.check(
      unverified.compact.attentionPresent === true
      && (unverified.compact.attentionText ?? '').includes('验证：未验证'),
      'compact mode keeps the unverified verdict in the attention line',
      { attentionText: unverified.compact.attentionText },
    )
    recorder.check(
      unverified.compact.entryCount < unverified.normal.entryCount,
      'compact mode folds the unverified turn\'s non-attention rows away',
      { normalEntries: unverified.normal.entryCount, compactEntries: unverified.compact.entryCount },
    )
    recorder.check(
      unverified.compact.verificationPresent === false,
      'the verdict row itself is folded once the attention line carries it',
      { verificationText: unverified.compact.verificationText, attentionText: unverified.compact.attentionText },
    )

    // ---------------------------------------------------------------------
    // 2. failure: every transport attempt fails with an unretryable 401
    // ---------------------------------------------------------------------
    await startNewConversation(client)
    await provider.setFaults([{ kind: 'status', status: 401, times: 8 }])
    const failureRequestsBefore = provider.requests.length
    await submitPrompt(client, PLAIN_PROMPT)
    await waitForTurn(
      client,
      (sample) => sample.turnStatus !== 'running' && (sample.runStatusError ?? '').length > 0,
      'a failed turn with a visible reason',
    )
    const failure = await captureBothModes({ client, recorder, screenshots, name: 'failure' })
    recordStrings(recorder, 'failure-normal', failure.normal)
    recordStrings(recorder, 'failure-compact', failure.compact)
    const failureFaults = provider.requests.slice(failureRequestsBefore).map((request) => request.fault?.status ?? 'none')
    recorder.note({ step: 'failure-provider-attempts', attemptCount: failureFaults.length, faultLog: failureFaults })
    recorder.check(
      failure.normal.turnStatus === 'failed',
      'the failed turn is marked failed in normal mode',
      { turnClass: failure.normal.turnClass },
    )
    recorder.check(
      (failure.normal.runStatusError ?? '').includes('401'),
      'normal mode names the transport failure (401) instead of an answer',
      { runStatusError: failure.normal.runStatusError, responseText: failure.normal.responseText },
    )
    recorder.check(
      failure.normal.transcriptPresent === true && failure.normal.entryCount >= 1,
      'the failed normal-mode turn still shows its transcript rows',
      { transcriptPresent: failure.normal.transcriptPresent, entryCount: failure.normal.entryCount, entries: failure.normal.entries.map((entry) => entry.id) },
    )
    recorder.check(
      failure.compact.attentionPresent === true
      && (failure.compact.attentionText ?? '').includes('本轮未完成'),
      'compact mode keeps the failed turn readable as 本轮未完成',
      { attentionText: failure.compact.attentionText },
    )
    recorder.check(
      (failure.compact.runStatusError ?? '').includes('401'),
      'compact mode still shows the failure reason',
      { runStatusError: failure.compact.runStatusError },
    )
    recorder.check(
      failure.compact.entryCount < failure.normal.entryCount,
      'compact mode folds the failed turn\'s non-attention rows away',
      { normalEntries: failure.normal.entryCount, compactEntries: failure.compact.entryCount },
    )
    await provider.setFaults(null)

    // ---------------------------------------------------------------------
    // 3. aborted: the user stops a run that is waiting on its Provider
    // ---------------------------------------------------------------------
    await startNewConversation(client)
    // The delay only matches the request that already carries the glob result, so the first
    // request completes (leaving a real transcript) and the second one never answers.
    await provider.setDelay({ promptContains: ABORT_ANCHOR_FILE, delayMs: ABORT_DELAY_MS })
    await submitPrompt(client, STOP_PROMPT)
    const beforeStop = await waitForTurn(
      client,
      (sample) => sample.toolRows >= 1 && sample.turnStatus === 'running',
      'the run to reach its second model request with a transcript row',
      60_000,
    )
    recorder.note({ step: 'aborted-before-stop', sample: beforeStop })
    await delay(700)
    const stopLabel = await clickStop(client)
    if (!stopLabel) throw new Error('the stop control was not available while the run was hanging')
    const aborted = await waitForTurn(
      client,
      (sample) => sample.turnStatus !== 'running',
      'the stopped run to leave the running state',
    ).catch((error) => {
      recorder.note({ step: 'aborted-not-settled', error: String(error), sample: null })
      return null
    })
    await provider.setDelay({ promptContains: ABORT_ANCHOR_FILE, delayMs: 0 })
    recorder.note({ step: 'aborted-stop', stopLabel, settled: aborted !== null })
    const abortedModes = await captureBothModes({ client, recorder, screenshots, name: 'aborted' })
    recordStrings(recorder, 'aborted-normal', abortedModes.normal)
    recordStrings(recorder, 'aborted-compact', abortedModes.compact)
    recorder.check(
      abortedModes.normal.turnStatus === 'aborted',
      'the stopped turn is marked aborted in normal mode',
      { turnClass: abortedModes.normal.turnClass, stopLabel },
    )
    recorder.check(
      // The normal-mode home of the abort fact is the turn's own state plus the Runtime status
      // the user sees in place of an answer.
      abortedModes.normal.turnStatus === 'aborted'
      && (abortedModes.normal.runStatusError ?? '').length > 0,
      'normal mode keeps the abort readable as Runtime status text',
      { runStatusError: abortedModes.normal.runStatusError, responseText: abortedModes.normal.responseText },
    )
    recorder.check(
      abortedModes.normal.entryCount >= 1 && abortedModes.normal.transcriptPresent === true,
      'the stopped turn keeps the transcript rows it had produced before the stop',
      { entryCount: abortedModes.normal.entryCount, entries: abortedModes.normal.entries.map((entry) => entry.id) },
    )
    recorder.check(
      abortedModes.compact.attentionPresent === true
      && (abortedModes.compact.attentionText ?? '').includes('本轮已停止'),
      'compact mode keeps the stopped turn readable as 本轮已停止',
      { attentionText: abortedModes.compact.attentionText, turnClass: abortedModes.compact.turnClass },
    )
    recorder.check(
      (abortedModes.compact.runStatusError ?? '').length > 0,
      'compact mode still shows the Runtime status that replaced the answer',
      { runStatusError: abortedModes.compact.runStatusError },
    )
    recorder.check(
      abortedModes.compact.entryCount < abortedModes.normal.entryCount,
      'compact mode folds the stopped turn\'s non-attention rows away',
      { normalEntries: abortedModes.normal.entryCount, compactEntries: abortedModes.compact.entryCount },
    )

    // ---------------------------------------------------------------------
    // 4. pending approval: the live "waiting for the user to decide" state
    // ---------------------------------------------------------------------
    await startNewConversation(client)
    await setDisplayMode(client, 'normal')
    await submitPrompt(client, DENIAL_PROMPT)
    const waiting = await waitForTurn(
      client,
      (sample) => sample.approvalPrompt !== null
        && sample.activeStageTexts.some((text) => text.includes('正在等待 write 的权限批准')),
      'the write approval prompt with its waiting status',
      60_000,
    )
    recorder.note({ step: 'pending-approval-live', sample: waiting })
    const pending = await captureBothModes({
      client, recorder, screenshots, name: 'pending-approval', waitForCompact: false,
    })
    recordStrings(recorder, 'pending-approval-normal', pending.normal)
    recordStrings(recorder, 'pending-approval-compact', pending.compact)
    recorder.check(
      pending.normal.activeStageTexts.some((text) => text.includes('正在等待 write 的权限批准')),
      'normal mode shows the turn is waiting for the write approval',
      { activeStageTexts: pending.normal.activeStageTexts, turnClass: pending.normal.turnClass },
    )
    recorder.check(
      pending.normal.approvalPrompt !== null
      && pending.normal.approvalPrompt.title.includes('允许写入文件'),
      'the approval dialog itself is open and named',
      { approvalPrompt: pending.normal.approvalPrompt },
    )
    recorder.check(
      pending.compact.activeStageTexts.some((text) => text.includes('正在等待 write 的权限批准')),
      'compact mode keeps the waiting-for-approval fact readable',
      { activeStageTexts: pending.compact.activeStageTexts },
    )
    recorder.check(
      pending.compact.entryCount === pending.normal.entryCount
      && pending.compact.entryCount >= 1
      && pending.compact.attentionPresent === false,
      // A running turn is never folded (`compactCompleted` requires a non-running activity), so
      // compact display must not hide part of the process the user is being asked about.
      'compact mode does not fold a running turn that is waiting for a decision',
      {
        normalEntries: pending.normal.entryCount,
        compactEntries: pending.compact.entryCount,
        compactAttention: pending.compact.attentionText,
      },
    )

    // ---------------------------------------------------------------------
    // 5. denied tool: refusing the approval, then reloading the window
    // ---------------------------------------------------------------------
    const denial = await denyApproval(client)
    if (!denial) throw new Error('the approval prompt could not be denied')
    recorder.note({ step: 'approval-denied', denial })
    // The live stream publishes no tool row for a denied call; record that before the reload.
    const liveAfterDenial = await waitForTurn(
      client,
      (sample) => sample.approvalPrompt === null,
      'the approval dialog to close',
      30_000,
    ).catch(() => null)
    await delay(1000)
    const liveSample = await sampleTurn(client)
    // Recorded, not asserted: the live model stream is a different surface from the durable
    // history projection, and this gate measures the transcript's kept facts.
    recorder.note({ step: 'denied-live', sample: liveSample, afterDialog: liveAfterDenial })

    await reloadRenderer(client, 'the reloaded renderer')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer after the reload',
    )
    await setDisplayMode(client, 'normal')
    // A renderer reload sometimes stays on 加载历史消息 instead of finishing the history read; the
    // gate retries the reload and records how many attempts the kept row needed, so a green run
    // never hides that this happened.
    let keptRowAttempts = 0
    let keptRowError = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      keptRowAttempts = attempt
      const found = await harness.waitFor(
        () => evaluate(client, `document.querySelector('.agent-tool-call.fail[data-call-id]') ? true : null`).catch(() => null),
        attempt === 1 ? 30_000 : 20_000,
        `the kept failed tool row after the reload (attempt ${attempt})`,
      ).then(() => true).catch((error) => { keptRowError = String(error); return false })
      if (found) break
      await reloadRenderer(client, `the reloaded renderer (attempt ${attempt})`)
      await harness.waitFor(
        () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
        harness.startTimeoutMs,
        'the composer after the reload',
      ).catch(() => undefined)
      await setDisplayMode(client, 'normal')
    }
    recorder.note({ step: 'denied-reload', keptRowAttempts, keptRowError })
    recorder.note({
      step: 'denied-row-shape',
      sample: await evaluate(client, `(() => {
        const row = document.querySelector('.agent-tool-call.fail[data-call-id]');
        if (!row) return { row: null };
        const chain = [];
        let node = row;
        while (node && chain.length < 10) { chain.push(typeof node.className === 'string' && node.className ? node.className : node.tagName); node = node.parentElement }
        return {
          chain,
          turns: document.querySelectorAll('.assistant-turn').length,
          messages: document.querySelectorAll('.messages > *').length,
          mode: localStorage.getItem(${JSON.stringify(DISPLAY_MODE_KEY)}) || 'normal',
          loadingHistory: (document.querySelector('.messages')?.textContent ?? '').includes('加载历史消息'),
        };
      })()`),
    })
    const denied = await captureBothModes({
      client,
      recorder,
      screenshots,
      name: 'denied',
      // The refused call is the fact under test: the run that follows it appends its own turn, so
      // the sample follows the row instead of whichever turn happens to be last.
      pick: '.agent-tool-call.fail[data-call-id]',
    })
    recordStrings(recorder, 'denied-normal', denied.normal)
    recordStrings(recorder, 'denied-compact', denied.compact)
    // What the transcript looks like once history has finished loading, recorded rather than
    // asserted: the denied row is read from the projection that is on screen when the reload
    // settles, and this says whether the later render keeps it.
    await delay(3000)
    recorder.note({
      step: 'denied-after-settle',
      sample: await evaluate(client, `(() => ({
        turns: document.querySelectorAll('.assistant-turn').length,
        rows: document.querySelectorAll('.assistant-turn .agent-tool-call[data-call-id]').length,
        failedRows: document.querySelectorAll('.assistant-turn .agent-tool-call.fail[data-call-id]').length,
        loading: (document.querySelector('.messages')?.textContent ?? '').includes('加载历史消息'),
      }))()`),
    })
    recorder.check(
      denied.normal.failedToolRows >= 1,
      'after the reload the refused call is kept as a failed tool row in normal mode',
      { failedToolRows: denied.normal.failedToolRows, failedToolTexts: denied.normal.failedToolTexts },
    )
    recorder.check(
      // The kept row is only evidence if it says what happened: the refusal itself, not an
      // empty "failed" marker (`denied by approval gate` is the Runtime's own reason).
      denied.normal.failedToolTexts.some((text) => /denied|approval|拒绝|未获批准/u.test(text)),
      'the kept tool row carries the refusal as text',
      { failedToolTexts: denied.normal.failedToolTexts },
    )
    recorder.check(
      denied.normal.transcriptPresent === true
      && denied.normal.entryCount >= 1
      && denied.normal.transcriptFailedToolRows >= 1,
      'the reloaded normal-mode turn renders the refused call inside the transcript',
      {
        transcriptPresent: denied.normal.transcriptPresent,
        entryCount: denied.normal.entryCount,
        entries: denied.normal.entries.map((entry) => entry.id),
        transcriptFailedToolRows: denied.normal.transcriptFailedToolRows,
      },
    )
    recorder.check(
      denied.compact.transcriptFailedToolRows >= 1,
      'compact mode keeps the refused call row inside the folded transcript (an attention row)',
      {
        transcriptToolRows: denied.compact.transcriptToolRows,
        transcriptFailedToolRows: denied.compact.transcriptFailedToolRows,
        failedToolTexts: denied.compact.failedToolTexts,
      },
    )
    recorder.check(
      denied.compact.attentionPresent === true && (denied.compact.attentionText ?? '').length > 0,
      'compact mode keeps an attention line for the turn with the refused call',
      { attentionText: denied.compact.attentionText },
    )
    recorder.check(
      denied.compact.entryCount < denied.normal.entryCount,
      'compact mode folds the refused turn\'s non-attention rows away',
      { normalEntries: denied.normal.entryCount, compactEntries: denied.compact.entryCount },
    )
  } catch (error) {
    recorder.check(false, 'the five transcript states were produced without an unexpected failure', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  } finally {
    handle?.client?.close()
    if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
    await provider.close().catch(() => undefined)
    if (!keepRoot) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'transcript-state-visibility',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keepRoot ? root : '<temporary root removed>',
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    assertions: recorder.assertions,
    screenshots,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      '待用户 (waiting_user) is not producible by this build: `status: waiting_user` is only written by older versions / crash recovery (packages/harness/src/durable-kernel.ts), so no synthetic checkpoint was fabricated. The live-producible equivalent measured here is the pending write approval (category 4), whose fact is a running turn\'s status row rather than a settled attention line.',
      '部分完成 does not exist: HistoryActivityStatus is running | done | failed | aborted | paused | waiting_user (packages/app/src/shared/history-activity.ts). Following the taskbook instruction to rewrite the phrase to a real state, the aborted class (本轮已停止) is measured instead (category 3).',
      'Compact folding (and therefore the .agent-transcript-attention row) applies only to a turn that is no longer running (assistant-turn.tsx `compactCompleted`), so a *running* turn — including the pending-approval category — renders identically in both modes and its compact evidence is the live status row plus an unchanged transcript, not an attention line.',
      'The refused call has no live transcript tool row: category 5 is measured after a real window reload, where the durable history projection keeps it as .agent-tool-call.fail[data-call-id].',
      'The Provider is the deterministic acceptance fixture (scripted answers, injected faults); it is not a real model.',
      'Screenshots stay in the temporary output directory; the fixture data root is removed unless --keep is passed.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
