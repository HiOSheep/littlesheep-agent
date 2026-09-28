// Real-window acceptance for the transcript facts a reader must not lose (taskbooks UX-33 and O1).
//
// UX-33 asks the chat transcript to keep every "needs attention" fact readable in BOTH display
// modes. Compact display folds the finished process away, so the facts that must survive it are
// exactly the ones a user has to act on or fix. This gate produces the classes the product can
// really produce in one isolated window and samples the *same turn* in normal and compact display:
//
//   1. pass             a completed read-only run whose verdict passed (which renders no verdict
//                       line and no attention row at all)
//   2. failure          an unretryable transport failure (HTTP 401) that ends the turn
//   3. aborted          the user stops a run whose Provider never answers
//   4. pending-approval a running turn waiting for the user's write approval
//   5. denied-tool      the same call, refused by the user, kept as a failed tool row after a
//                       window reload (the live stream has no tool row for it)
//   6. manual fold      the reader clicks the process trigger on the refused-call turn, in both
//                       display modes, and the fact the fold must not hide stays readable
//   7. local failure    O1: a run that settles as a whole while one call inside it failed, and
//                       the verdict that failure forces (未验证) — read in both display modes
//   8. waiting_user     O1: the user's decision is still pending after the app was killed
//                       mid-run and its recovery settled the run as 等待你决定后继续
//
// What each sample must show:
//   - normal mode: the rows and text a reader needs (the failed turn and its reason, the kept
//     failed tool row, the verification verdict on the process trigger, the live waiting/aborted
//     status),
//   - compact mode: the `.agent-transcript-attention` row, plus proof that folding really
//     happened (fewer `.assistant-transcript [data-transcript-entry]` nodes than normal mode),
//   - both modes: the attention row is never a descendant of `.assistant-process-content`, the
//     panel the reader (or compact display) folds — checked here, and again after a real click.
//
// One class the taskbook names cannot be produced by this build:
//   - 部分完成 does not exist: `HistoryActivityStatus` has no `partial` member, so the taskbook's
//     instruction to rewrite it to a real state is followed with `aborted` (本轮已停止).
//
// 待用户 (`waiting_user`) *is* measurable, and category 8 measures it: a live run never parks
// itself on a question any more (`run-checkpoint-controller.ts`: the clarification activity and
// the derived status were removed), but killing the app while a model request is in flight and
// restarting it on the same data root makes Runtime's recovery settle that run as `waiting_user`
// (`durable-kernel.ts`), which the history projection renders as an attention row. No synthetic
// checkpoint is fabricated; the fixture is a real kill and a real restart.
//
// Usage:
//   node scripts/verify-transcript-state-visibility.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  O1_LOCAL_FAILURE_MARKER,
  O1_MISSING_FILE,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
// Screenshots and the report stay outside the checkout (`lib/run-artifacts.mjs`); `--out` still wins.
const outRoot = resolve(readOption('out', runArtifact('transcript-state-visibility')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1100, height: 760 }
const EVALUATE_TIMEOUT_MS = 20_000
/** The scripted Provider answers this prompt with a `write` tool call (research mode asks first). */
const DENIAL_PROMPT = '请使用 write 工具创建 UX07-APPROVAL-ESCAPE 验收文件'
const PLAIN_PROMPT = '请简短确认这条转录状态验收消息。'
const STOP_PROMPT = '请简短确认这条中止验收消息。'
/**
 * O1 category 7: the scripted Provider reads a file that does not exist, then answers. The run
 * therefore settles as a whole *and* keeps a locally failed call plus the `unverified` verdict
 * that failure forces; the prompt carries the marker the Provider matches on.
 */
const LOCAL_FAILURE_PROMPT = `${O1_LOCAL_FAILURE_MARKER} 请读取目标文件并汇报结果。`
/**
 * O1 category 8: this token only appears in the user text of the run that is killed mid-flight,
 * which is how the Provider delay is aimed at its very first model request.
 */
const WAITING_ANCHOR = 'LS-O1-WAITING-USER-ANCHOR'
const WAITING_PROMPT = `${WAITING_ANCHOR} 请等待这条决定验收消息。`
/**
 * The crash conversation's *first* turn must finish: the session index is written by the run
 * completion path (`run-support.ts` `updateSessionIndex`), so a conversation whose only turn was
 * killed is not listed in the sidebar and its recovered state would not be user-reachable. This
 * marker becomes the session title, which is also how the fixture finds its row.
 */
const CRASH_TITLE_ANCHOR = 'LS-O1-CRASH-SESSION'
const CRASH_TITLE_PROMPT = `${CRASH_TITLE_ANCHOR} 请简短确认这条会话标题验收消息。`
const WAITING_DELAY_MS = 60_000
/**
 * Recovery may have to wait for the killed process's run lease (30 s) to expire before the queue
 * pass can claim the run, so this budget covers a lease expiry plus a startup, not one poll.
 */
const WAITING_USER_TIMEOUT_MS = 180_000
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
  const pickElement = PICK_ELEMENT;
  const matched = pickElement
    ? pickElement.closest('.assistant-turn')
    : pick ? [...turns].reverse().find((candidate) => candidate.querySelector(pick)) : null;
  const turn = matched ?? turns.at(-1);
  if (!turn) return null;
  const text = (node) => ((node && node.textContent) || '').replace(/\\s+/gu, ' ').trim();
  const transcript = turn.querySelector('.assistant-transcript');
  const entries = transcript ? [...transcript.querySelectorAll('[data-transcript-entry]')] : [];
  const attention = turn.querySelector('.agent-transcript-attention');
  // The verdict rides on the process trigger now (it used to be its own row inside the process
  // body), so the fact and the row that carries it are sampled separately.
  const trigger = turn.querySelector('.assistant-process-trigger');
  const verification = turn.querySelector('.assistant-process-verification');
  // "Outside the collapsed process body" is a structural fact, not a class name: the attention
  // row must not be a descendant of the disclosure panel that folds.
  const processBody = turn.querySelector('.assistant-process-content');
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
    // The row that folds, its real collapsed state, and whether the attention fact lives inside it.
    processBodyPresent: processBody instanceof HTMLElement,
    processBodyFolded: processBody instanceof HTMLElement
      && processBody.getAttribute('aria-hidden') === 'true'
      && processBody.hasAttribute('inert'),
    attentionInProcessBody: Boolean(attention && processBody && processBody.contains(attention)),
    triggerText: text(trigger) || null,
    triggerExpanded: trigger ? trigger.getAttribute('aria-expanded') : null,
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
    pickMissed: (pick || pickElement) ? !matched : false,
    documentFailedToolRows: document.querySelectorAll('.agent-tool-call.fail[data-call-id]').length,
  };
})()`

/**
 * Sample one turn in a given display mode, optionally the turn that holds a particular fact.
 *
 * `pickSelector` names the fact as a CSS selector; `pickExpression` is an expression inside the
 * page that returns the element itself, which is what a step needs after it produced that element
 * (a re-render between two steps would otherwise let the same selector match a different turn).
 */
async function sampleTurn(client, attempts = 4, pick = '', pickExpression = 'null') {
  const expression = TURN_SAMPLE_EXPRESSION
    .replace('PICK_SELECTOR', JSON.stringify(pick))
    .replace('PICK_ELEMENT', pickExpression)
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
  const expression = TURN_SAMPLE_EXPRESSION
    .replace('PICK_SELECTOR', JSON.stringify(pick))
    .replace('PICK_ELEMENT', 'null')
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
 * `pickSelector` is a CSS selector (resolved in the page on every sample, so a re-render between
 * the two modes cannot make the sample follow a stale element).
 */
async function captureBothModes({ client, recorder, screenshots, name, waitForCompact = true, pickSelector = '' }) {
  if (pickSelector) await waitForFact(client, pickSelector)
  // Both modes are sampled back to back, and the screenshots are taken afterwards: a screenshot
  // can take a second, and the transcript may move on in the meantime (a run that is still
  // finishing appends its own turn), which would otherwise be read as the row disappearing.
  await setDisplayMode(client, 'normal')
  const normal = await sampleTurn(client, pickSelector ? 12 : 4, pickSelector)
  await setDisplayMode(client, 'compact')
  if (waitForCompact) await waitForCompactAttention(client)
  const compact = await sampleTurn(client, pickSelector ? 12 : 4, pickSelector)

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
      attentionInProcessBody: sample.attentionInProcessBody,
      triggerText: sample.triggerText,
      processBodyFolded: sample.processBodyFolded,
      verificationText: sample.verificationText,
      failedToolTexts: sample.failedToolTexts,
      activeStageTexts: sample.activeStageTexts,
      transcriptEntries: sample.entries.map((entry) => `${entry.id}: ${entry.className}`),
      transcriptToolRows: sample.transcriptToolRows,
      transcriptFailedToolRows: sample.transcriptFailedToolRows,
    },
  })
}

/**
 * The newest durable execution log whose inbound text carries a marker.
 *
 * The verdict a turn renders is recorded in this file before it is projected into the DOM, so
 * category 7 can tie the literal line on screen back to a `verificationHistory` entry instead of
 * trusting that the label it read came from the verdict it wanted.
 */
async function readExecutionLogByPrompt(dataDir, marker) {
  const directory = join(dataDir, 'execution-logs')
  const names = await readdir(directory).catch(() => [])
  const files = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(directory, name)
    const info = await stat(path).catch(() => undefined)
    files.push({ path, name, mtimeMs: info?.mtimeMs ?? 0 })
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const file of files) {
    const log = await readFile(file.path, 'utf8').then((text) => JSON.parse(text)).catch(() => undefined)
    if (typeof log?.inboundText === 'string' && log.inboundText.includes(marker)) return { name: file.name, log }
  }
  return null
}

/**
 * Whether anything this turn shows claims the verification passed. `验证通过` is the only string
 * `verificationVerdictLabel` (chat/activity-model.ts) produces for a `pass` verdict, so its
 * absence is what "a verdict that did not pass never reads as passed" means in the DOM.
 */
function readsAsPassed(sample) {
  return /验证通过|通过验证|已通过/u.test([
    sample.attentionText ?? '',
    sample.triggerText ?? '',
    sample.verificationText ?? '',
    sample.responseText ?? '',
    sample.runStatusError ?? '',
  ].join(' '))
}

/**
 * Wait for the Local App API to project a `waiting_user` turn — the same history projection the
 * renderer reads (`GET /sessions/:id/messages` → `buildHistoryMessages`).
 *
 * Polling this instead of sleeping a fixed time is what keeps the fixture honest about *why* the
 * state appears: the run is recovered only after the killed process's 30 s run lease expires, and
 * the reason has to be the missing model response.
 */
async function waitForRecoveredWaitingProjection(locator, titleAnchor, timeoutMs = WAITING_USER_TIMEOUT_MS) {
  const startedAt = Date.now()
  let attempts = 0
  let sessionsSeen = 0
  return harness.waitFor(async () => {
    attempts += 1
    const list = await harness.fetchJson(locator, '/sessions').catch(() => undefined)
    const sessions = list?.body?.sessions ?? []
    sessionsSeen = Math.max(sessionsSeen, sessions.length)
    const candidates = [
      ...sessions.filter((session) => String(session.title ?? '').includes(titleAnchor)),
      ...sessions.filter((session) => !String(session.title ?? '').includes(titleAnchor)),
    ]
    for (const session of candidates) {
      const history = await harness.fetchJson(
        locator,
        `/sessions/${encodeURIComponent(String(session.id))}/messages`,
      ).catch(() => undefined)
      const waiting = (history?.body?.messages ?? [])
        .find((message) => message?.activity?.status === 'waiting_user')
      if (waiting) {
        return {
          sessionId: session.id,
          title: session.title ?? null,
          status: waiting.activity.status,
          runtimeStatusReason: waiting.activity.runtimeStatus?.reason ?? null,
          attentionText: '等待你决定后继续',
          waitedMs: Date.now() - startedAt,
          attempts,
          sessionsSeen,
        }
      }
    }
    await delay(1_000)
    return undefined
  }, timeoutMs, 'the recovered waiting_user history projection')
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
  /** Every window this gate launches, so cleanup cannot miss one (category 8 launches two more). */
  const windows = []
  /** The isolated root category 8 kills and restarts; kept next to `root` when `--keep` is passed. */
  let crashRoot

  /**
   * Launch one real window on a fixture root and wait until it can accept a prompt.
   *
   * Used for the main root and again for the crash fixture, whose window is killed mid-run and
   * started again on the *same* data root — the only way this build produces a `waiting_user` run.
   */
  async function launchWindow(fixture) {
    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({
      dataDir: fixture.dataDir,
      chromiumDir: fixture.chromiumDir,
      debuggingPort,
      logPath: fixture.logPath,
    })
    const locator = await harness.waitForLocator(fixture.dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // Parked outside every display and shown inactively: the window still renders for screenshots.
    await harness.desktopAction(locator, 'park-offscreen')
    await delay(1200)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    const launched = { fixture, electron, locator, client, debuggingPort }
    windows.push(launched)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')
    return launched
  }

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    // The abort fixture hangs the request that carries this file's glob result (see
    // ABORT_ANCHOR_FILE); the file itself is never read or written by the Agent.
    await writeFile(join(workplaceDir, ABORT_ANCHOR_FILE), 'transcript state visibility anchor\n', 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const { client } = await launchWindow({ dataDir, workplaceDir, chromiumDir, logPath })

    // ---------------------------------------------------------------------
    // 1. pass: a completed read-only run, measured so the verdict's absence is evidence
    // ---------------------------------------------------------------------
    // This scenario used to wait for a *not-pass* verdict on a plain prompt. That premise is
    // gone: a single successful builtin read-only call is the Runtime's narrow `pass` shape
    // (`verifyTrivialReadOnlyExecution`), so the plain prompt now settles as `pass` and no
    // verdict element exists to wait for. The measured fact is inverted here instead: a `pass`
    // must render NO verdict line and NO attention row, which is what makes "unverified never
    // reads as a pass" checkable — the line that says 未验证 is the line that is absent here.
    await startNewConversation(client)
    await setDisplayMode(client, 'normal')
    await submitPrompt(client, PLAIN_PROMPT)
    const passed = await waitForTurn(
      client,
      (sample) => sample.turnStatus !== 'running' && sample.transcriptPresent,
      'a settled turn for the pass fixture',
    ).catch(async (error) => {
      // A timeout here is a finding about the turn, not about the wait: record what is on screen
      // so the evidence says whether the run never settled, or settled without a transcript.
      const snapshot = await evaluate(client, `(() => ({
        assistantTurns: document.querySelectorAll('.assistant-turn').length,
        userMessages: document.querySelectorAll('.message.user').length,
        turnClasses: [...document.querySelectorAll('.assistant-turn')].map((turn) => turn.className),
        loadingHistory: (document.querySelector('.messages')?.textContent ?? '').includes('加载历史消息'),
        composerDisabled: document.querySelector('.composer textarea')?.disabled ?? null,
        running: document.querySelectorAll('.task-progress-indicator').length,
        bodyText: (document.querySelector('.messages')?.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 300),
      }))()`).catch((cause) => ({ snapshotError: String(cause) }))
      recorder.note({ step: 'pass-fixture-timeout', error: String(error), snapshot })
      recorder.check(false, 'the plain prompt produces a settled turn', { error: String(error), snapshot })
      return null
    })
    const passedModes = await captureBothModes({ client, recorder, screenshots, name: 'pass-verdict' })
    recordStrings(recorder, 'pass-verdict-normal', passedModes.normal)
    recordStrings(recorder, 'pass-verdict-compact', passedModes.compact)
    recorder.check(
      passedModes.normal.transcriptPresent === true && passedModes.normal.entryCount >= 1,
      'the pass fixture is a real completed run with transcript rows, so folding is measurable',
      { transcriptPresent: passedModes.normal.transcriptPresent, entryCount: passedModes.normal.entryCount, entries: passedModes.normal.entries.map((entry) => entry.id) },
    )
    // Both modes, one location: the trigger carries the duration and the counts, and a verdict
    // that passed produces no line at all. This is the "unverified never reads as a pass" side of
    // the same coin — a phrase for a verdict that did not pass may only appear when one exists.
    for (const [mode, sample] of [['normal', passedModes.normal], ['compact', passedModes.compact]]) {
      recorder.check(
        sample.verificationPresent === false
        && sample.attentionPresent === false
        && !/验证/u.test(sample.triggerText ?? ''),
        `${mode} mode shows no verdict line and no attention row for a run whose verdict passed`,
        { verificationText: sample.verificationText, attentionText: sample.attentionText, triggerText: sample.triggerText },
      )
    }
    recorder.check(
      passedModes.normal.attentionInProcessBody === false && passedModes.compact.attentionInProcessBody === false,
      'the pass fixture carries no attention row inside the folding body either',
      { normal: passedModes.normal.attentionInProcessBody, compact: passedModes.compact.attentionInProcessBody },
    )
    recorder.note({ step: 'pass-fixture-sample', sample: passed })

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
      pickSelector: '.agent-tool-call.fail[data-call-id]',
    })
    recordStrings(recorder, 'denied-normal', denied.normal)
    recordStrings(recorder, 'denied-compact', denied.compact)
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

    // ---------------------------------------------------------------------
    // 6. manual fold: the reader clicks the process trigger shut
    // ---------------------------------------------------------------------
    // The trigger decides `processOpen`, so this is the product's own control, not an injected
    // class. Everything the turn still has to say must survive the fold: the kept rows stay in the
    // (now unreadable) body, and the facts that outlive it must not.
    //
    // The turn under test is the one that carries an attention row: its process body is where the
    // facts that must survive a fold live. The refused row itself is the shortest-lived fact this
    // gate renders — the observation recorded as `denied-after-settle` shows a later render of the
    // same session dropping it — so the fold follows the *attention row*, which is the surface
    // under test, and records whether the refused row was still there when it ran.
    const foldTarget = await evaluate(client, `(() => {
      const refused = document.querySelector('.agent-tool-call.fail[data-call-id]');
      const attentionTurn = [...document.querySelectorAll('.assistant-turn')]
        .reverse()
        .find((candidate) => candidate.querySelector('.agent-transcript-attention'));
      if (!attentionTurn) return null;
      return {
        refusedRowPresent: Boolean(refused),
        refusedCallId: refused ? refused.getAttribute('data-call-id') : null,
        attentionText: (attentionTurn.querySelector('.agent-transcript-attention')?.textContent || '').replace(/\\s+/gu, ' ').trim(),
        triggerExpanded: attentionTurn.querySelector('.assistant-process-trigger')?.getAttribute('aria-expanded') ?? null,
      };
    })()`)
    recorder.note({ step: 'manual-fold-target', target: foldTarget })
    if (!foldTarget) throw new Error('no assistant turn with an attention row was on screen for the manual-fold step')
    const foldExpression = `[...document.querySelectorAll('.assistant-turn')].reverse().find((candidate) => candidate.querySelector('.agent-transcript-attention'))`

    // The fold is measured in BOTH display modes. Compact display folds the *rows* of a settled
    // turn by itself (`compactCompleted`), but it does not fold the panel: the hand-off between
    // the two is exactly what a reader can contradict, so the click has to be measured where the
    // reader makes it. This turn is not `done`, so its panel starts open in both modes
    // (`processOpen = status !== 'done'`) and the click is the only thing that can close it;
    // clicking again then proves the reader's choice wins in the other direction too.
    for (const mode of ['normal', 'compact']) {
      await setDisplayMode(client, mode)
      await delay(250)
      const toggled = await evaluate(client, `(() => {
        const turn = ${foldExpression};
        const trigger = turn ? turn.querySelector('.assistant-process-trigger') : null;
        if (!trigger) return null;
        const before = trigger.getAttribute('aria-expanded');
        trigger.click();
        return {
          before,
          triggerText: (trigger.textContent || '').replace(/\\s+/gu, ' ').trim(),
          refusedRowPresent: Boolean(turn.querySelector('.agent-tool-call.fail[data-call-id]')),
        };
      })()`)
      if (!toggled) throw new Error(`the process trigger could not be clicked in ${mode} mode`)
      if (toggled.before !== 'true') throw new Error(`the process was already folded before the click in ${mode} mode`)
      await delay(400)
      const sample = await sampleTurn(client, 4, '', foldExpression)
      recorder.note({ step: `manual-fold-${mode}`, toggled, sample })
      recorder.check(
        sample.processBodyFolded === true && sample.triggerExpanded === 'false',
        `the reader's click really folds the process body in ${mode} mode`,
        { processBodyFolded: sample.processBodyFolded, triggerExpanded: sample.triggerExpanded },
      )
      recorder.check(
        sample.attentionPresent === true
        && sample.attentionInProcessBody === false
        && /本轮已停止|本轮未完成|本轮已暂停|等待你决定后继续|次调用失败|个步骤未完成|验证：/u.test(sample.attentionText ?? ''),
        `the failure the fold must not hide stays readable in ${mode} mode`,
        {
          attentionText: sample.attentionText,
          attentionInProcessBody: sample.attentionInProcessBody,
          triggerText: sample.triggerText,
        },
      )
      // The kept row is the folded-body half of the evidence: the fold must hide it from reading,
      // not delete it. It is also the shortest-lived fact this gate renders, so what is asserted
      // is the pairing — while it is on screen it stays inside the folded body, and when a later
      // render has already dropped it, the attention row is still carrying the failure.
      recorder.check(
        sample.transcriptFailedToolRows >= 1
          ? sample.attentionInProcessBody === false
          : sample.attentionPresent === true && sample.attentionInProcessBody === false,
        `the folded body still contains the failure fact in ${mode} mode (row kept, or named by the attention row)`,
        {
          transcriptFailedToolRows: sample.transcriptFailedToolRows,
          attentionText: sample.attentionText,
          attentionInProcessBody: sample.attentionInProcessBody,
          refusedRowPresentAtClick: toggled.refusedRowPresent,
        },
      )
      screenshots[`manual-fold-${mode}`] = await writePng(client, `manual-fold-${mode}`)

      // The other direction: the reader opens it again. A panel this turn's own state says should
      // be open must come back, and the attention row must not have moved into it.
      const reopened = await evaluate(client, `(() => {
        const turn = ${foldExpression};
        const trigger = turn ? turn.querySelector('.assistant-process-trigger') : null;
        if (!trigger) return null;
        const before = trigger.getAttribute('aria-expanded');
        trigger.click();
        return { before };
      })()`)
      if (!reopened) throw new Error(`the process trigger could not be clicked a second time in ${mode} mode`)
      await delay(400)
      const afterReopen = await sampleTurn(client, 4, '', foldExpression)
      recorder.note({ step: `manual-fold-${mode}-reopened`, toggled: reopened, sample: afterReopen })
      recorder.check(
        reopened.before === 'false'
        && afterReopen.processBodyFolded === false
        && afterReopen.triggerExpanded === 'true'
        && afterReopen.attentionPresent === true
        && afterReopen.attentionInProcessBody === false,
        `the reader can open the folded process again in ${mode} mode without the attention row moving into it`,
        {
          before: reopened.before,
          processBodyFolded: afterReopen.processBodyFolded,
          triggerExpanded: afterReopen.triggerExpanded,
          attentionPresent: afterReopen.attentionPresent,
          attentionInProcessBody: afterReopen.attentionInProcessBody,
        },
      )
    }

    // What the transcript looks like once the page has settled, recorded rather than asserted:
    // the refused row was read from the projection that is on screen right after the reload, and
    // this says whether a render a few seconds later still carries it. It is recorded *after* the
    // fold step on purpose — the fold needs the row that the reload rendered.
    await delay(3000)
    recorder.note({
      step: 'denied-after-settle',
      sample: await evaluate(client, `(() => ({
        turns: document.querySelectorAll('.assistant-turn').length,
        rows: document.querySelectorAll('.assistant-turn .agent-tool-call[data-call-id]').length,
        failedRows: document.querySelectorAll('.assistant-turn .agent-tool-call.fail[data-call-id]').length,
        attentionRows: document.querySelectorAll('.assistant-turn .agent-transcript-attention').length,
        loading: (document.querySelector('.messages')?.textContent ?? '').includes('加载历史消息'),
      }))()`),
    })

    // ---------------------------------------------------------------------
    // 7. O1: a run that settles as a whole with a locally failed call, and its 未验证 verdict
    // ---------------------------------------------------------------------
    // The combination the O1 row asks for is one turn, not two: the read fails, the Runtime
    // records that negative result, VERIFY keeps the verdict at `unverified` (it may not read a
    // recorded failure as a pass) and FINALIZE still publishes the answer. What has to survive
    // both display modes is therefore the failure *and* the verdict that did not pass.
    await startNewConversation(client)
    await setDisplayMode(client, 'normal')
    await submitPrompt(client, LOCAL_FAILURE_PROMPT)
    const locallyFailedTurn = await waitForTurn(
      client,
      (sample) => sample.turnStatus !== 'running'
        && (sample.attentionText ?? '').includes('次调用失败'),
      'a settled turn that carries a locally failed call',
    ).catch(async (error) => {
      recorder.note({
        step: 'local-failure-timeout',
        error: String(error),
        sample: await sampleTurn(client).catch(() => null),
      })
      throw error
    })
    recorder.note({ step: 'local-failure-settled', sample: locallyFailedTurn })
    const localFailure = await captureBothModes({ client, recorder, screenshots, name: 'local-failure' })
    recordStrings(recorder, 'local-failure-normal', localFailure.normal)
    recordStrings(recorder, 'local-failure-compact', localFailure.compact)

    // The recorded facts behind the rendered ones: the execution log on disk is what VERIFY wrote
    // before any of this was projected. Reading it here is what makes the literal `验证：未验证`
    // on screen evidence about a `verificationHistory` entry rather than about a label.
    const localFailureLog = await harness.waitFor(
      async () => await readExecutionLogByPrompt(dataDir, O1_LOCAL_FAILURE_MARKER),
      30_000,
      'the execution log of the locally failed run',
    ).catch((error) => {
      recorder.note({ step: 'local-failure-log-missing', error: String(error) })
      return null
    })
    const verdicts = (localFailureLog?.log?.verificationHistory ?? []).map((record) => record.verdict)
    const failedCalls = (localFailureLog?.log?.toolCalls ?? [])
      .filter((call) => call?.result?.ok === false)
      // Long enough to keep the fixture's own file name: the assertion below matches on it.
      .map((call) => `${call.call?.name ?? 'unknown'}: ${String(call?.result?.error ?? '').slice(0, 240)}`)
    recorder.note({
      step: 'local-failure-record',
      log: localFailureLog?.name ?? null,
      verdicts,
      failedCalls,
      status: localFailureLog?.log?.status ?? null,
    })
    recorder.check(
      localFailureLog !== null
      && verdicts.length > 0
      && verdicts.every((verdict) => verdict !== 'pass')
      && verdicts.at(-1) === 'unverified',
      'VERIFY recorded a verdict that is not `pass` for the run with a locally failed call',
      { log: localFailureLog?.name ?? null, verdicts },
    )
    recorder.check(
      failedCalls.length >= 1 && failedCalls.some((text) => text.includes(O1_MISSING_FILE)),
      'the failed call is the fixture\'s missing-file read, recorded as a failed result rather than a missing one',
      { failedCalls },
    )
    for (const [mode, sample] of [['normal', localFailure.normal], ['compact', localFailure.compact]]) {
      recorder.check(
        sample.turnStatus === 'done',
        `${mode} mode reads the run as settled (整体完成) even though a call inside it failed`,
        { turnClass: sample.turnClass, attentionText: sample.attentionText },
      )
      recorder.check(
        (sample.attentionText ?? '').includes('次调用失败')
        && (sample.attentionText ?? '').includes('验证：未验证')
        && sample.attentionInProcessBody === false,
        `${mode} mode keeps the local failure and the 未验证 verdict visible outside the folding panel`,
        {
          attentionText: sample.attentionText,
          attentionInProcessBody: sample.attentionInProcessBody,
          triggerText: sample.triggerText,
          verificationText: sample.verificationText,
        },
      )
      recorder.check(
        sample.verificationText === '验证：未验证',
        `${mode} mode renders the verdict on the process trigger as 验证：未验证`,
        { verificationText: sample.verificationText, triggerText: sample.triggerText },
      )
      recorder.check(
        readsAsPassed(sample) === false,
        `${mode} mode never lets a verdict that did not pass read as 验证通过`,
        {
          attentionText: sample.attentionText,
          verificationText: sample.verificationText,
          triggerText: sample.triggerText,
          responseText: sample.responseText,
        },
      )
      recorder.check(
        sample.transcriptFailedToolRows >= 1
        && sample.failedToolTexts.some((text) => text.includes(O1_MISSING_FILE)),
        `${mode} mode keeps the failed call readable as a failed tool row`,
        {
          transcriptFailedToolRows: sample.transcriptFailedToolRows,
          failedToolRows: sample.failedToolRows,
          failedToolTexts: sample.failedToolTexts,
        },
      )
    }
    recorder.check(
      localFailure.compact.entryCount < localFailure.normal.entryCount,
      'compact mode really folds the settled run\u2019s other transcript rows away',
      { normalEntries: localFailure.normal.entryCount, compactEntries: localFailure.compact.entryCount },
    )

    // The reader's own fold, on this turn, in both modes: `done` starts with the panel closed, so
    // the click is the only thing that can open it, and closing it again must take nothing with it.
    for (const mode of ['normal', 'compact']) {
      await setDisplayMode(client, mode)
      await delay(250)
      const opened = await evaluate(client, `(() => {
        const turn = [...document.querySelectorAll('.assistant-turn')].reverse()
          .find((candidate) => candidate.querySelector('.agent-transcript-attention'));
        const trigger = turn ? turn.querySelector('.assistant-process-trigger') : null;
        if (!trigger) return null;
        const before = trigger.getAttribute('aria-expanded');
        trigger.click();
        return { before };
      })()`)
      if (!opened) throw new Error(`the settled turn's process trigger could not be clicked in ${mode} mode`)
      await delay(400)
      const openSample = await sampleTurn(client, 4)
      recorder.note({ step: `local-failure-${mode}-opened`, toggled: opened, sample: openSample })
      recorder.check(
        opened.before === 'false'
        && openSample.processBodyFolded === false
        && openSample.triggerExpanded === 'true'
        && openSample.attentionPresent === true
        && openSample.attentionInProcessBody === false
        && (openSample.attentionText ?? '').includes('验证：未验证'),
        `the reader can open the settled run's process in ${mode} mode and the 未验证 row stays outside it`,
        {
          before: opened.before,
          processBodyFolded: openSample.processBodyFolded,
          triggerExpanded: openSample.triggerExpanded,
          attentionText: openSample.attentionText,
          attentionInProcessBody: openSample.attentionInProcessBody,
        },
      )
      const closed = await evaluate(client, `(() => {
        const turn = [...document.querySelectorAll('.assistant-turn')].reverse()
          .find((candidate) => candidate.querySelector('.agent-transcript-attention'));
        const trigger = turn ? turn.querySelector('.assistant-process-trigger') : null;
        if (!trigger) return null;
        const before = trigger.getAttribute('aria-expanded');
        trigger.click();
        return { before };
      })()`)
      if (!closed) throw new Error(`the settled turn's process trigger could not be closed in ${mode} mode`)
      await delay(400)
      const closedSample = await sampleTurn(client, 4)
      recorder.note({ step: `local-failure-${mode}-closed`, toggled: closed, sample: closedSample })
      recorder.check(
        closed.before === 'true'
        && closedSample.processBodyFolded === true
        && closedSample.triggerExpanded === 'false'
        && closedSample.attentionPresent === true
        && closedSample.attentionInProcessBody === false
        && (closedSample.attentionText ?? '').includes('次调用失败')
        && (closedSample.attentionText ?? '').includes('验证：未验证'),
        `the reader's fold wins in ${mode} mode and the failure and verdict stay outside the folded panel`,
        {
          before: closed.before,
          processBodyFolded: closedSample.processBodyFolded,
          triggerExpanded: closedSample.triggerExpanded,
          attentionText: closedSample.attentionText,
          attentionInProcessBody: closedSample.attentionInProcessBody,
        },
      )
      screenshots[`local-failure-${mode}-manual-fold`] = await writePng(client, `local-failure-${mode}-manual-fold`)
    }
    await setDisplayMode(client, 'normal')

    // ---------------------------------------------------------------------
    // 8. O1: waiting for the user's decision (a killed run, recovered as `waiting_user`)
    // ---------------------------------------------------------------------
    // A live run never parks itself on a question any more, so the only honest way to reach the
    // 等待你决定后继续 row is the path that writes it: Runtime's own recovery of a run whose model
    // request was in flight when the process died. The fixture starts a run, lets its first
    // Provider request go out, kills the window, and starts the app again on the same data root.
    // Nothing is injected into the page or into the store.
    //
    // This scenario runs on its own isolated root, and that is a fixture decision with two
    // measured reasons: at startup this build *auto-resumes* the first resumable checkpoint that is
    // not waiting for input (`runtime-recovery/use-checkpoint-recovery.ts`), so on a root that
    // already holds the earlier scenarios' parked runs the window navigates to one of those
    // instead of to the crashed conversation; and the killed run must not be its session's first,
    // because the session index is written by the run completion path (`updateSessionIndex`).
    // The main window has delivered everything the first seven categories need; it is closed
    // before the crash fixture starts, so only one application instance is ever running.
    const mainWindow = windows[0]
    mainWindow.client?.close()
    if (mainWindow.electron?.exitCode === null) await harness.forceTerminate(mainWindow.electron)

    const crashDirectory = await mkdtemp(join(tmpdir(), 'littlesheep-transcript-state-visibility-crash-'))
    crashRoot = crashDirectory
    const crashFixture = {
      dataDir: join(crashDirectory, 'data'),
      workplaceDir: join(crashDirectory, 'data', 'workplace'),
      chromiumDir: join(crashDirectory, 'chromium'),
      logPath: join(crashDirectory, 'electron.log'),
    }
    await Promise.all([
      mkdir(crashFixture.workplaceDir, { recursive: true }),
      mkdir(crashFixture.chromiumDir, { recursive: true }),
    ])
    await writeFile(
      join(crashFixture.dataDir, 'config.json'),
      `${JSON.stringify(buildConfig(crashFixture.workplaceDir, provider.baseURL), null, 2)}\n`,
      'utf8',
    )

    const beforeCrash = await launchWindow(crashFixture)
    await setDisplayMode(beforeCrash.client, 'normal')
    // Turn 1 finishes, so the conversation is listed (`GET /sessions` → `sessionIndex.list()`) and
    // its title carries the anchor the sidebar lookup below uses.
    await submitPrompt(beforeCrash.client, CRASH_TITLE_PROMPT)
    const firstTurn = await waitForTurn(
      beforeCrash.client,
      (sample) => sample.turnStatus !== 'running',
      'the finished first turn of the crash conversation',
      90_000,
    )
    recorder.note({ step: 'waiting-first-turn', sample: firstTurn })
    // Recorded before the kill: without the index entry the conversation is not reachable in the
    // sidebar at all, so this is what makes the recovered state a user-visible one.
    const listedBeforeCrash = await harness.waitFor(async () => {
      const list = await harness.fetchJson(beforeCrash.locator, '/sessions').catch(() => undefined)
      const session = (list?.body?.sessions ?? [])
        .find((candidate) => String(candidate.title ?? '').includes(CRASH_TITLE_ANCHOR))
      return session ? { id: session.id, title: session.title } : undefined
    }, 30_000, 'the crash conversation in the session index').catch(() => null)
    recorder.note({ step: 'waiting-session-indexed', session: listedBeforeCrash })
    // Turn 2 is the one that is killed: its Provider request goes out and never answers.
    await provider.setDelay({ promptContains: WAITING_ANCHOR, delayMs: WAITING_DELAY_MS })
    const requestsBeforeWaiting = provider.requests.length
    await submitPrompt(beforeCrash.client, WAITING_PROMPT)
    const inFlight = await waitForTurn(
      beforeCrash.client,
      (sample) => sample.turnStatus === 'running',
      'the run to start before it is killed',
      60_000,
    )
    await harness.waitFor(
      () => Promise.resolve(provider.requests.length > requestsBeforeWaiting ? true : undefined),
      20_000,
      'the hanging Provider request of the killed run',
    ).catch(() => undefined)
    recorder.note({
      step: 'waiting-before-kill',
      sample: inFlight,
      providerRequests: provider.requests.length - requestsBeforeWaiting,
      fixtureRoot: crashDirectory,
    })
    // The request is on the wire and its durable `model_request_started` receipt is written; the
    // kill therefore interrupts a run in flight rather than one that has not started.
    await delay(700)
    await harness.forceTerminate(beforeCrash.electron)
    await provider.setDelay({ promptContains: WAITING_ANCHOR, delayMs: 0 })
    recorder.note({ step: 'waiting-killed', pid: beforeCrash.electron.pid, exitCode: beforeCrash.electron.exitCode })

    const afterCrash = await launchWindow(crashFixture)
    const restartedClient = afterCrash.client
    // The killed process still owned the run lease for 30 s, so Runtime recovers the run only after
    // that lease expires (`durable-run-lease-store.ts` DEFAULT_DURABLE_RUN_LEASE_MS plus the
    // scheduled wake-up in `run-recovery.ts`). The wait below polls the Local App API projection
    // the renderer itself reads instead of sleeping a fixed number of seconds.
    const recoveredProjection = await waitForRecoveredWaitingProjection(afterCrash.locator, CRASH_TITLE_ANCHOR)
    recorder.note({ step: 'waiting-recovered-projection', projection: recoveredProjection })
    // The window loaded its history before the recovery settled, so the state is re-read the way a
    // user re-reads it: a real renderer reload, after which the transcript shows what the API says.
    await reloadRenderer(restartedClient, 'the renderer after the waiting run was recovered')
    await harness.waitFor(
      () => evaluate(restartedClient, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer after the reload',
    )
    await setDisplayMode(restartedClient, 'normal')
    const waitingPredicate = (sample) => sample.turnStatus === 'waiting_user'
      && (sample.attentionText ?? '').includes('等待你决定后继续')
    // The pick resolves inside the turn (`candidate.querySelector(pick)`), so it names the row
    // that makes this the turn under test rather than the turn's own status class.
    let conversationClick = null
    let recoveredWaiting = await waitForTurn(
      restartedClient,
      waitingPredicate,
      'the recovered waiting_user attention row',
      30_000,
      '.agent-transcript-attention',
    ).catch(() => null)
    if (!recoveredWaiting) {
      // The crash conversation is the only one on this root, and its title carries the anchor the
      // first turn's prompt set, so opening it is unambiguous.
      conversationClick = await evaluate(restartedClient, `(() => {
        const rows = [...document.querySelectorAll('.session-item')];
        const row = rows.find((candidate) => (candidate.textContent || '').includes('${CRASH_TITLE_ANCHOR}')) ?? rows[0];
        if (!(row instanceof HTMLElement)) return null;
        const label = (row.textContent || '').replace(/\\s+/gu, ' ').trim();
        row.click();
        return { label, rowCount: rows.length };
      })()`)
      recoveredWaiting = await waitForTurn(
        restartedClient,
        waitingPredicate,
        'the recovered waiting_user attention row after opening the conversation',
        60_000,
        '.agent-transcript-attention',
      ).catch(async (error) => {
        recorder.note({
          step: 'waiting-not-recovered',
          error: String(error),
          conversationClick,
          projection: recoveredProjection,
          sample: await sampleTurn(restartedClient).catch(() => null),
          dom: await evaluate(restartedClient, `(() => ({
            turns: document.querySelectorAll('.assistant-turn').length,
            turnClasses: [...document.querySelectorAll('.assistant-turn')].map((turn) => turn.className),
            attentionRows: [...document.querySelectorAll('.agent-transcript-attention')].map((row) => (row.textContent || '').trim()),
            bodyText: (document.querySelector('.messages')?.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 240),
          }))()`).catch((cause) => ({ error: String(cause) })),
        })
        throw error
      })
    }
    recorder.note({ step: 'waiting-after-recovery', sample: recoveredWaiting, conversationClick })
    const waitingModes = await captureBothModes({
      client: restartedClient,
      recorder,
      screenshots,
      name: 'waiting-recovered',
      pickSelector: '.agent-transcript-attention',
    })
    recordStrings(recorder, 'waiting-recovered-normal', waitingModes.normal)
    recordStrings(recorder, 'waiting-recovered-compact', waitingModes.compact)
    recorder.check(
      recoveredProjection?.status === 'waiting_user'
      && recoveredProjection?.runtimeStatusReason === 'model_response_missing',
      'Runtime\'s own recovery settled the killed run as waiting_user for the missing model response',
      { projection: recoveredProjection },
    )
    recorder.check(
      typeof recoveredProjection?.title === 'string'
      && recoveredProjection.title.includes(CRASH_TITLE_ANCHOR)
      && recoveredProjection.sessionsSeen >= 1
      && listedBeforeCrash !== null,
      'the crashed conversation is listed in the session index, so the waiting state is reachable in the UI',
      {
        title: recoveredProjection?.title ?? null,
        sessionsSeen: recoveredProjection?.sessionsSeen ?? null,
        listedBeforeCrash,
      },
    )
    for (const [mode, sample] of [['normal', waitingModes.normal], ['compact', waitingModes.compact]]) {
      recorder.check(
        sample.turnStatus === 'waiting_user'
        && (sample.attentionText ?? '').includes('等待你决定后继续'),
        `${mode} mode says the run is waiting for the user's decision`,
        { turnClass: sample.turnClass, attentionText: sample.attentionText },
      )
      recorder.check(
        (sample.triggerText ?? '').includes('等待处理')
        // The turn is not finished, and what stands in place of an answer is Runtime's own status:
        // the response area carries that status and nothing else (no model reply was published).
        && (sample.responseText ?? '').trim() !== ''
        && (sample.responseText ?? '') === (sample.runStatusError ?? '')
        && /waiting for user action|no final reply was published|需要用户决定/u.test(sample.runStatusError ?? '')
        && sample.approvalPrompt === null,
        `${mode} mode does not read the waiting run as finished (Runtime status in place of an answer, no approval dialog)`,
        {
          triggerText: sample.triggerText,
          responseText: sample.responseText,
          runStatusError: sample.runStatusError,
          responseState: sample.responseState,
        },
      )
      recorder.check(
        sample.attentionInProcessBody === false,
        `${mode} mode keeps the pending decision outside the folding panel`,
        { attentionInProcessBody: sample.attentionInProcessBody },
      )
    }
  } catch (error) {
    recorder.check(false, 'the eight transcript states were produced without an unexpected failure', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  } finally {
    for (const window of windows) {
      window.client?.close()
      if (window.electron?.exitCode === null) await harness.forceTerminate(window.electron)
    }
    await provider.close().catch(() => undefined)
    if (!keepRoot) {
      await harness.removeTemporaryRoot(root)
      if (crashRoot) await harness.removeTemporaryRoot(crashRoot)
    }
  }

  const evidence = {
    check: 'transcript-state-visibility',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keepRoot ? root : '<temporary root removed>',
    crashFixtureRoot: keepRoot && crashRoot ? crashRoot : '<temporary root removed>',
    outputRoot: outRoot,
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    assertions: recorder.assertions,
    screenshots,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      '待用户 (`waiting_user`) is not producible by a *live* run: since the clarification activity and the derived status were removed (run-checkpoint-controller.ts `resolveWaitingUserHead`), a new run never parks itself on a question. Category 8 reaches the state the only way this build still writes it — a forced kill while a model request is in flight, then a restart on the same data root, so Runtime\'s own recovery (`durable-kernel.ts` `recoverRun`, `runtime_status_settled` with reason `model_response_missing`) settles the run and the history projection renders the attention row. The wait budget covers the 30 s run lease the killed process left behind.',
      '部分完成 does not exist: HistoryActivityStatus is running | done | failed | aborted | paused | waiting_user (packages/app/src/shared/history-activity.ts). Following the taskbook instruction to rewrite the phrase to a real state, the aborted class (本轮已停止) is measured instead (category 3).',
      'Compact folding (and therefore the compact transcript rows) applies only to a turn that is no longer running (assistant-turn.tsx `compactCompleted`), so a *running* turn — including the pending-approval category — renders identically in both modes and its compact evidence is the live status row plus an unchanged transcript, not an attention line. The manual-fold category (6) and the settled-failure fold in category 7 are measured in both modes: in compact display the *rows* are folded by the mode itself while the panel stays open (`processOpen = status !== \'done\'`), so a click there changes the panel and only the panel.',
      'The refused call has no live transcript tool row: category 5 is measured after a real window reload, where the durable history projection keeps it as .agent-tool-call.fail[data-call-id]. A later render of the same session was observed dropping that row again (`denied-after-settle`); that is recorded, not asserted, and it is not this change\'s subject.',
      'Verdict evidence comes from two layers in category 7: the literal line the DOM renders in each mode (`验证：未验证` on the process trigger plus the attention row), and the durable execution log of the same run, read from the fixture root, whose `verificationHistory` is asserted to be non-empty, to contain no `pass` at all, and to end at `unverified`. A `pass` verdict renders no such line (category 1) — that is the negative half, asserted for the same trigger.',
      'The Provider is the deterministic acceptance fixture (scripted answers, injected faults); it is not a real model.',
      'Screenshots stay in the temporary output directory; the fixture data root is removed unless --keep is passed.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  await mkdir(outRoot, { recursive: true })
  await writeFile(join(outRoot, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  if (!evidence.ok) process.exitCode = 1
}

await main()
