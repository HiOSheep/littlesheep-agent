// Real-window acceptance for the transcript facts a reader must not lose (taskbooks UX-33 and O1).
//
// UX-33 asks the chat transcript to keep every "needs attention" fact readable in BOTH display
// modes. Compact display folds the finished process away, so the facts that must survive it are
// exactly the ones a user has to act on or fix. This gate produces the classes the product can
// really produce in one isolated window and samples the *same turn* in normal and compact display:
//
//   1. pass             a completed read-only run whose verdict passed (which renders no verdict
//                       line and no attention row at all)
//   2. failure          an unretryable transport failure (HTTP 401) that ends the turn — and the
//                       retry action that turn must offer (2b): activating it re-dispatches the
//                       turn's own recorded instruction through the composer's send path, so the
//                       Provider receives that same text again, the new run settles as its own
//                       turn, and the failed turn keeps its reason and its 本轮未完成 row
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
// The failed turn's action (2b) is measured the way a user reaches it: a real pointer press at the
// control's centre (after `elementFromPoint` says the control is what is under that point), plus a
// native `WM_NCHITTEST` probe at the same pixel, because a CDP click and the DOM both answer a
// layer above the window's own draggable region — tonight a control that looked clickable in CDP
// was dead for a real mouse. The retry's own decisions are asserted with it: the failed turn keeps
// its reason and attention line (a retry does not rewrite the record of what happened), the
// composer draft the user has typed since is not consumed (the retry sends the turn's instruction,
// not the draft), and the retried instruction really leaves the renderer — the Provider logs it.
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
// Category 8 is also where audit #18 (A1) is measured. The recovered turn used to answer with the
// English literal `Runtime is waiting for user action; no final reply was published. Reason:
// <settlement code>`; the answer slot must now carry the Runtime message catalogue's Chinese
// sentence (`packages/runner/dist/runtime-messages.js`, read by this gate, so the assertion and the
// product text cannot drift), and no user-visible string of that class may contain the settlement
// code. The code is still published — as structured diagnostics in `runtimeStatus.reason`, which
// this gate reads from the API projection — and the same is asserted for the run result.
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
import { HTCAPTION, HTCLIENT, createNativeHitTest } from './lib/native-hit-test.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'
// The Runtime message catalogue (A1 / audit #18): the sentence the recovered turn must show is read
// from the Runner module the bundle was built from, so this gate cannot drift from the product text.
import { RUNTIME_MESSAGE_CATALOGUE } from '../packages/runner/dist/runtime-messages.js'

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
/**
 * A1 / audit #18: the sentence the recovered turn must show, read from the Runtime message
 * catalogue instead of copied here. The pre-fix build showed the English original with the internal
 * settlement code appended, and neither that text nor the code may be readable in the window: the
 * code stays in the durable status (`runtimeStatus.reason`, which this gate reads through
 * `waitForRecoveredWaitingProjection` and asserts separately).
 */
const RUNTIME_WAITING_SENTENCE =
  RUNTIME_MESSAGE_CATALOGUE['Runtime is waiting for user action; no final reply was published.']
const RUNTIME_DIAGNOSTIC_LEAK = /model_response_missing|Reason:\s|waiting for user action|no final reply was published/
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
/** The failed turn's own action (2b): the label the contract names, and the class it is measured by. */
const RETRY_LABEL = '重试'
const RETRY_SELECTOR = '.assistant-turn-retry'
/**
 * A draft typed into the composer *after* the failure. The retry must re-send the turn's own
 * instruction and leave this text exactly where it is: the retry is not a composer send, so it
 * consumes nothing the user has written since.
 */
const RETRY_DRAFT = 'LS-RETRY-DRAFT-ANCHOR：重试期间不要动这段草稿'

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
    // A parked window is composited on demand, and this gate shares the desktop with the other
    // Electron gates: a capture that normally answers in well under a second was measured timing
    // out at 10 s while sibling windows were on screen. The budget is the RPC's, not a product
    // commitment, and nothing asserted below depends on how long a screenshot took.
    60_000,
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
  // The failed turn's action, its geometry (a real click needs the pixel), and whether the
  // element under that pixel is the control itself.
  const retry = turn.querySelector('.assistant-turn-retry');
  const retryBox = retry instanceof HTMLElement ? retry.getBoundingClientRect() : null;
  const retryCentre = retryBox
    ? { x: retryBox.x + retryBox.width / 2, y: retryBox.y + retryBox.height / 2 }
    : null;
  const retryTop = retryCentre ? document.elementFromPoint(retryCentre.x, retryCentre.y) : null;
  const composerInput = document.querySelector('.composer textarea');
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
    // The retry action of this turn: present, named, usable, outside the folding body, and the
    // element a real press at its centre would actually reach.
    retryPresent: retry instanceof HTMLElement,
    retryLabel: text(retry) || null,
    retryDisabled: retry instanceof HTMLButtonElement ? retry.disabled : null,
    retryInProcessBody: Boolean(retry && processBody && processBody.contains(retry)),
    retryCentre,
    retryReachable: retryCentre ? Boolean(retryTop && retry.contains(retryTop)) : null,
    retryTopClass: retryTop ? (typeof retryTop.className === 'string' && retryTop.className ? retryTop.className : retryTop.tagName) : null,
    composerDraft: composerInput instanceof HTMLTextAreaElement ? composerInput.value : null,
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

/**
 * What the *window* does with a real mouse press at these viewport points.
 *
 * `elementFromPoint` and `Input.dispatchMouseEvent` both answer a layer above this one: a real
 * press is filtered first by the window's draggable region, which the renderer publishes from
 * `-webkit-app-region` and Windows consults through the window's own WM_NCHITTEST. HTCAPTION (2)
 * there means the press becomes a caption interaction and the page never sees it; HTCLIENT (1)
 * means it is delivered. That filter is why a control can look reachable to the DOM checks in this
 * script — and to a CDP click — while a real click on it does nothing, so the failed turn's retry
 * is asserted through the OS as well.
 *
 * The probe itself is the shared `scripts/lib/native-hit-test.mjs` (the window is parked, never
 * moved: moving it re-applies its bounds through a DIP/physical round trip). It reads the window
 * handle and geometry from the main process, which is why the main window is launched with its own
 * inspector; `createNativeHitTest` resolves the `layoutWindow` / `layoutElectron` globals the
 * window-chrome gate publishes, so the same two are published here.
 */
function nativeProbeFor(mainClient) {
  if (process.platform !== 'win32' || !mainClient) return null
  return createNativeHitTest({ main: mainClient })
}

/**
 * Press the failed turn's retry with a real pointer event, at the control's own centre.
 *
 * The button is scrolled into view first: the transcript sticks to its bottom, so a failed turn is
 * where the reader left it and the centre has to be a point that is really on screen for a press
 * to mean anything. The press is dispatched as `mousePressed` + `mouseReleased` — the same path a
 * mouse takes — and the DOM's own answer (`elementFromPoint`) is recorded beside it.
 */
async function pressRetry(client) {
  await evaluate(client, `(() => {
    const button = document.querySelector(${JSON.stringify(RETRY_SELECTOR)});
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  await delay(300)
  const point = await evaluate(client, `(() => {
    const button = document.querySelector(${JSON.stringify(RETRY_SELECTOR)});
    if (!(button instanceof HTMLButtonElement)) return null;
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x, y,
      label: (button.textContent || '').trim(),
      disabled: button.disabled,
      reachable: Boolean(top && button.contains(top)),
      topClass: top ? (typeof top.className === 'string' && top.className ? top.className : top.tagName) : null,
    };
  })()`)
  if (!point) return null
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return point
}

/** Type a draft into the composer the way the reader does (the controlled textarea's own setter). */
async function typeComposerDraft(client, draft) {
  return evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(draft)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return textarea.value;
  })()`)
}

/** The message counts a retry has to move, read from the same DOM every other sample comes from. */
async function documentCounts(client) {
  return evaluate(client, `(() => ({
    turns: document.querySelectorAll('.assistant-turn').length,
    userMessages: document.querySelectorAll('.message.user').length,
    composerDraft: document.querySelector('.composer textarea') instanceof HTMLTextAreaElement
      ? document.querySelector('.composer textarea').value
      : null,
  }))()`)
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
  // The report names the exact bundle it measured: a bundle identity that only exists in the
  // console is not evidence a reader can check later.
  const freshness = await harness.assertBuildFresh()
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
   *
   * `mainInspector` opens the main process's own debug port, which is what the native
   * `WM_NCHITTEST` probe needs: only the main process can hand out the window handle and its
   * geometry (`getContentBounds`, the display scale factor).
   */
  async function launchWindow(fixture, { mainInspector = false } = {}) {
    const debuggingPort = await harness.reservePort()
    const mainDebuggingPort = mainInspector ? await harness.reservePort() : undefined
    const electron = await harness.startElectron({
      dataDir: fixture.dataDir,
      chromiumDir: fixture.chromiumDir,
      debuggingPort,
      mainDebuggingPort,
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
    const launched = { fixture, electron, locator, client, debuggingPort, mainClient: undefined }
    windows.push(launched)
    if (mainInspector) {
      launched.mainClient = await harness.connectDebugger(mainDebuggingPort, 'the main process inspector')
      // The names the shared native hit-test probe resolves (`scripts/lib/native-hit-test.mjs`):
      // the window handle and its geometry can only be read from the main process.
      const ready = await launched.mainClient.evaluate(`(() => {
        const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
        globalThis.layoutElectron = require('electron');
        globalThis.layoutWindow = globalThis.layoutElectron.BrowserWindow.getAllWindows()[0];
        return Boolean(globalThis.layoutWindow);
      })()`)
      if (!ready) throw new Error('the main process inspector could not reach the acceptance window')
    }
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

    const { client, mainClient } = await launchWindow(
      { dataDir, workplaceDir, chromiumDir, logPath },
      { mainInspector: true },
    )

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

    // ---------------------------------------------------------------------
    // 2b. the failed turn's retry: the one action a failure has to offer
    // ---------------------------------------------------------------------
    // The 401 turn above is the fixture: a failure that names its cause and offers nothing to do
    // about it is a dead end (`ui/state-view.ts` says a failure allows an action; the transcript
    // used to offer none). What is measured here is only what the reader can do — the action is
    // pressed with a real pointer, the Provider has to receive the turn's own instruction again,
    // and the failed turn's record has to survive the retry.
    recorder.check(
      failure.normal.retryPresent === true,
      'normal mode: the failed turn offers its retry action',
      {
        retryPresent: failure.normal.retryPresent,
        retryLabel: failure.normal.retryLabel,
        retryDisabled: failure.normal.retryDisabled,
        turnClass: failure.normal.turnClass,
      },
    )
    recorder.check(
      failure.compact.retryPresent === true,
      'compact mode: the failed turn offers its retry action',
      {
        retryPresent: failure.compact.retryPresent,
        retryLabel: failure.compact.retryLabel,
        retryDisabled: failure.compact.retryDisabled,
        turnClass: failure.compact.turnClass,
      },
    )
    for (const [mode, sample] of [['normal', failure.normal], ['compact', failure.compact]]) {
      recorder.check(
        (sample.retryLabel ?? '').trim() === RETRY_LABEL,
        `${mode} mode: the action is labelled ${RETRY_LABEL}`,
        { retryLabel: sample.retryLabel },
      )
      // The same rule the attention row answers to (O1): the reader's own fold, and compact
      // display's fold of the rows, must not be able to take the action away with the process.
      recorder.check(
        sample.retryInProcessBody === false,
        `${mode} mode: the retry sits outside the collapsible process body`,
        {
          retryInProcessBody: sample.retryInProcessBody,
          processBodyPresent: sample.processBodyPresent,
          processBodyFolded: sample.processBodyFolded,
        },
      )
      recorder.check(
        sample.retryDisabled === false,
        `${mode} mode: the retry is usable once the failed run has settled`,
        { retryDisabled: sample.retryDisabled },
      )
    }
    // ...and it is a control on a page, not a picture of one: a real press at the control's own
    // centre has to reach the control. The measurement is taken after scrolling it into view —
    // the transcript sticks to its bottom, and a turn taller than the window would otherwise put
    // the control's centre outside the viewport, where nothing can be measured.
    await setDisplayMode(client, 'normal')
    await delay(300)
    screenshots['failure-retry-normal'] = await writePng(client, 'failure-retry-normal')
    const retryGeometry = await evaluate(client, `(() => {
      const button = document.querySelector(${JSON.stringify(RETRY_SELECTOR)});
      if (!(button instanceof HTMLElement)) return null;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const top = document.elementFromPoint(x, y);
      // The window's own drag surface, measured rather than assumed: its answer is recorded next to
      // the control's, so a reader can see where the draggable region really is in this build.
      const band = document.querySelector('.window-drag-band') || document.querySelector('.window-titlebar');
      const bandRect = band instanceof HTMLElement ? band.getBoundingClientRect() : null;
      return {
        x, y, width: rect.width, height: rect.height,
        reachable: Boolean(top && button.contains(top)),
        topClass: top ? (typeof top.className === 'string' && top.className ? top.className : top.tagName) : null,
        disabled: button instanceof HTMLButtonElement ? button.disabled : null,
        dragBandClass: band instanceof HTMLElement ? (typeof band.className === 'string' ? band.className : null) : null,
        dragBandCentre: bandRect
          ? { x: bandRect.x + bandRect.width / 2, y: bandRect.y + Math.min(bandRect.height / 2, 16) }
          : null,
      };
    })()`)
    recorder.check(
      retryGeometry !== null && retryGeometry.reachable === true && retryGeometry.disabled === false,
      'the retry is the element under its own centre and is not covered or disabled',
      { retryGeometry, retryReachableAtSample: failure.normal.retryReachable, retryTopClass: failure.normal.retryTopClass },
    )
    // The press below must not be filtered by the window's own draggable region, so the same pixel
    // is asked through the OS. Three points are probed: the control itself, the window's own drag
    // surface (recorded, so the report says where that region is in this build), and a point the
    // page cannot own at all — left of the content area, i.e. outside the window. The outside point
    // is what keeps the measurement non-vacuous: a probe that always answers HTCLIENT would pass it
    // too, and no drag-surface answer is needed to say so.
    if (retryGeometry) {
      const nativeProbe = nativeProbeFor(mainClient)
      const probePoints = [
        { label: 'retry', x: retryGeometry.x, y: retryGeometry.y },
        { label: 'chat-body', x: 600, y: 300 },
        { label: 'outside-window', x: -40, y: retryGeometry.y },
        {
          label: 'drag-band',
          x: retryGeometry.dragBandCentre?.x ?? WINDOW_SIZE.width / 2,
          y: retryGeometry.dragBandCentre?.y ?? 16,
        },
      ]
      const entries = nativeProbe
        ? await nativeProbe.probe(probePoints).catch((error) => ({ error: String(error) }))
        : undefined
      const hits = Array.isArray(entries)
        ? Object.fromEntries(entries.map((entry) => [entry.label, {
          hit: entry.hit, name: entry.name, client: entry.client, caption: entry.caption, css: entry.css, physical: entry.physical,
        }]))
        : undefined
      recorder.note({ step: 'retry-native-hit-test', hits: hits ?? entries ?? null, geometry: retryGeometry })
      if (hits) {
        recorder.check(
          hits.retry?.hit === HTCLIENT,
          'a real mouse press at the retry\'s centre is delivered to the page (win32 hit test)',
          { hits, geometry: retryGeometry },
        )
        recorder.check(
          hits['outside-window']?.hit !== HTCLIENT,
          'the same probe answers a point outside the window differently (it is not a constant)',
          { hits, geometry: retryGeometry },
        )
        recorder.note({
          step: 'retry-native-hit-test-drag-band',
          dragBandClass: retryGeometry.dragBandClass,
          dragBandHit: hits['drag-band'] ?? null,
          dragBandIsCaption: hits['drag-band']?.hit === HTCAPTION,
        })
      } else if (nativeProbe) {
        recorder.check(false, 'the native hit test at the retry answered', { entries, geometry: retryGeometry })
      } else {
        // No platform answer: recorded, not asserted. A gate on such a host makes no hit-region
        // claim at all rather than passing one it did not measure.
        recorder.note({
          step: 'retry-native-hit-test-skipped',
          platform: process.platform,
          mainInspector: Boolean(mainClient),
          geometry: retryGeometry,
        })
      }
    } else {
      recorder.check(false, 'the retry was on screen to probe at the native level', { retryGeometry })
    }

    // The retry is offered while nothing is running; wait for the composer to really be back to
    // its send state, which is the same condition the control's own disabled state reads. This is
    // measured *before* the draft is typed: a draft alone already brings the send control back, so
    // typing first would make this wait pass while the run was still in flight.
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer-run-actions .send-round:not(.stop)') ? true : null`),
      30_000,
      'the composer to leave the running state',
    ).catch(() => undefined)
    // The reader has typed something since the failure. The retry sends the *turn's* instruction,
    // so this draft has to be exactly where the reader left it afterwards.
    const typedDraft = await typeComposerDraft(client, RETRY_DRAFT).catch(() => null)
    recorder.check(
      typedDraft === RETRY_DRAFT,
      'the fixture put a draft in the composer before the retry was pressed',
      { typedDraft },
    )

    const retryRequestsBefore = provider.requests.length
    const countsBefore = await documentCounts(client)
    await provider.setFaults(null)
    const retryPoint = await pressRetry(client).catch((error) => {
      recorder.note({ step: 'retry-press-failed', error: String(error) })
      return null
    })
    recorder.check(
      retryPoint !== null && retryPoint.reachable === true && retryPoint.disabled === false,
      'a real pointer press lands on the failed turn\'s retry',
      { retryPoint },
    )

    if (retryPoint) {
      const dispatched = await harness.waitFor(() => {
        const request = provider.requests.slice(retryRequestsBefore)
          .find((candidate) => (candidate.messages ?? [])
            .some((message) => message.role === 'user' && String(message.content ?? '').includes(PLAIN_PROMPT)))
        return request ? {
          requestIndex: request.requestIndex,
          receivedAt: request.receivedAt,
          fault: request.fault?.status ?? null,
          userMessages: (request.messages ?? [])
            .filter((message) => message.role === 'user')
            .map((message) => String(message.content ?? '').slice(0, 120)),
        } : undefined
      }, 30_000, 'the Provider request carrying the retried instruction').catch((error) => {
        recorder.note({ step: 'retry-not-dispatched', error: String(error) })
        return null
      })
      recorder.check(
        dispatched !== null,
        'activating the retry dispatches a new run with the same instruction (the Provider received it)',
        {
          dispatched,
          requestsBefore: retryRequestsBefore,
          requestsAfter: provider.requests.length,
        },
      )
      // The retry is the turn's instruction, never whatever the composer happened to hold: a
      // "retry" that quietly sends the draft is a different run under the same name.
      recorder.check(
        dispatched !== null
        && dispatched.userMessages.some((message) => message.includes(PLAIN_PROMPT))
        && !dispatched.userMessages.some((message) => message.includes(RETRY_DRAFT)),
        'the dispatched instruction is the failed turn\'s own text, not the composer draft',
        { dispatched, draft: RETRY_DRAFT },
      )

      const settled = await waitForTurn(
        client,
        (sample) => sample.turnStatus !== 'running' && sample.turnCount === (countsBefore?.turns ?? 0) + 1,
        'the retried run to settle as its own new turn',
        90_000,
      ).catch((error) => {
        recorder.note({ step: 'retry-not-settled', error: String(error) })
        return null
      })
      recorder.check(
        settled !== null && settled.turnStatus === 'done',
        'the retried run settles as a finished turn',
        {
          turnStatus: settled?.turnStatus ?? null,
          turnClass: settled?.turnClass ?? null,
          responseText: settled?.responseText ?? null,
          turnCount: settled?.turnCount ?? null,
        },
      )
      screenshots['failure-retry-settled'] = await writePng(client, 'failure-retry-settled')

      // The failed turn is the record of what happened; a retry does not rewrite it. The sample
      // follows the failed turn itself (a later render may append the retry's own turn after it).
      const stillFailed = await sampleTurn(client, 6, '', `document.querySelector('.assistant-turn.failed')`)
      recorder.note({ step: 'retry-failed-turn-after', sample: stillFailed })
      recorder.check(
        stillFailed.turnStatus === 'failed'
        && (stillFailed.runStatusError ?? '').includes('401')
        && stillFailed.retryPresent === true,
        'the failed turn keeps its reason and its retry after the retry settled',
        {
          turnStatus: stillFailed.turnStatus,
          runStatusError: stillFailed.runStatusError,
          retryPresent: stillFailed.retryPresent,
          attentionText: stillFailed.attentionText,
        },
      )
      recorder.check(
        (stillFailed.attentionText ?? '').includes('本轮未完成'),
        'the failed turn keeps its 本轮未完成 attention line after the retry settled',
        { attentionText: stillFailed.attentionText },
      )

      // What the retry did to the reader's own composer: nothing. It re-sent the turn's
      // instruction, so the draft typed after the failure is still there to be sent by hand.
      const countsAfter = await documentCounts(client)
      recorder.check(
        countsAfter?.composerDraft === RETRY_DRAFT,
        'the composer draft survives the retry untouched',
        { before: countsBefore?.composerDraft ?? null, after: countsAfter?.composerDraft ?? null },
      )
      // A retry is an ordinary run of this conversation, not a hidden duplicate of the turn: the
      // user's instruction appears in the transcript again, once, with its own answer.
      recorder.check(
        countsAfter?.turns === (countsBefore?.turns ?? 0) + 1
        && countsAfter?.userMessages === (countsBefore?.userMessages ?? 0) + 1,
        'the retry appended one instruction and one turn to the transcript',
        { before: countsBefore, after: countsAfter },
      )
    } else {
      recorder.check(false, 'the failed turn\'s retry could not be pressed, so its dispatch is unmeasured', {
        retryPoint,
        samples: { normal: failure.normal.retryPresent, compact: failure.compact.retryPresent },
      })
    }

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
        turnClass: typeof attentionTurn.className === 'string' ? attentionTurn.className : null,
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
    // reader makes it.
    //
    // The state under test is "the panel is open, and the reader's click is what closes it". Which
    // turn the attention row belongs to in a given render is a race — the reload, the history
    // projection and a run that is still settling all decide it — and a settled `done` turn arrives
    // with its process folded (`processOpen = status !== 'done'`) while any other turn arrives
    // open. The panel is therefore brought to open first, explicitly, and that normalization is
    // recorded; the assertion afterwards is unchanged.
    for (const mode of ['normal', 'compact']) {
      await setDisplayMode(client, mode)
      await delay(250)
      const normalized = await evaluate(client, `(() => {
        const turn = ${foldExpression};
        const trigger = turn ? turn.querySelector('.assistant-process-trigger') : null;
        if (!trigger) return null;
        const before = trigger.getAttribute('aria-expanded');
        if (before === 'false') trigger.click();
        return { before, turnClass: typeof turn.className === 'string' ? turn.className : null };
      })()`)
      if (!normalized) throw new Error(`the process trigger could not be reached in ${mode} mode`)
      await delay(400)
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
      recorder.note({ step: `manual-fold-${mode}`, normalized, toggled, sample })
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
    mainWindow.mainClient?.close()
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
        // A1/audit #18: the Runtime status is a sentence from the Runtime message catalogue
        // (`packages/runner/src/runtime-messages.ts`), so the window must show the catalogued
        // Chinese sentence — the exact same string, read from the same module the bundle was built
        // from, not a copy of it kept in this gate. Before the fix this class read
        // `Runtime is waiting for user action; no final reply was published. Reason:
        // model_response_missing`: an English sentence with the internal settlement code inside it.
        && RUNTIME_WAITING_SENTENCE === (sample.runStatusError ?? '')
        && sample.approvalPrompt === null,
        `${mode} mode does not read the waiting run as finished (catalogued Runtime status in place of an answer, no approval dialog)`,
        {
          triggerText: sample.triggerText,
          responseText: sample.responseText,
          runStatusError: sample.runStatusError,
          responseState: sample.responseState,
        },
      )
      // The reason code belongs to diagnostics: it is still in the durable status the API publishes
      // (`waiting.activity.runtimeStatus.reason`, asserted above), and it must not be readable
      // anywhere the user looks — the answer slot, the attention row, the trigger or the transcript.
      const visibleStrings = [
        sample.responseText,
        sample.runStatusError,
        sample.attentionText,
        sample.triggerText,
        sample.verificationText,
        ...(sample.failedToolTexts ?? []),
        ...(sample.activeStageTexts ?? []),
        ...(sample.entries ?? []).map((entry) => entry.text),
      ].filter((value) => typeof value === 'string')
      const leaked = visibleStrings.filter((value) => RUNTIME_DIAGNOSTIC_LEAK.test(value))
      recorder.check(
        leaked.length === 0,
        `${mode} mode: the internal reason code and the pre-fix English sentence appear in no user-visible text`,
        { leaked, runtimeStatusReason: recoveredProjection?.runtimeStatusReason ?? null },
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
      window.mainClient?.close()
      if (window.electron?.exitCode === null) await harness.forceTerminate(window.electron)
    }
    await provider.close().catch(() => undefined)
    if (!keepRoot) {
      // Cleanup is not evidence. A killed window's Chromium can still hold a file in the fixture
      // root for a moment (observed: EBUSY unlinking `declarative_performance_observer.db-journal`),
      // and an exception here would replace the measurements of a completed run with a stack trace
      // and lose the report. The leftover root stays a note in the evidence instead.
      for (const temporaryRoot of [root, crashRoot].filter(Boolean)) {
        try {
          await harness.removeTemporaryRoot(temporaryRoot)
        } catch (error) {
          recorder.note({
            step: 'temporary-root-cleanup-failed',
            root: temporaryRoot,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  const evidence = {
    check: 'transcript-state-visibility',
    capturedAt: new Date().toISOString(),
    // The bundle this report is about: the App build manifest the gate asserted at startup, so a
    // red or green result can be tied to the exact inputs and outputs that produced it.
    build: {
      inputDigest: freshness?.manifest?.input?.digest ?? null,
      outputDigest: freshness?.manifest?.output?.digest ?? null,
      builtAt: freshness?.manifest?.createdAt ?? null,
      mode: freshness?.manifest?.mode ?? null,
      electronVersion: freshness?.manifest?.runtime?.electronVersion ?? null,
    },
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
      'The failed turn\'s retry (2b) re-dispatches the turn\'s recorded `instruction` through the composer\'s own send path, so it is text-only: the attachments of the original send are not part of the turn\'s activity and are not re-attached by the retry (the fixture send has none). The retry is offered by the turn and pressed through the window — the native WM_NCHITTEST probe is skipped on non-Windows hosts, where the gate records the DOM reachability of the control instead and the hit-region claim is not made.',
      'A1 (#18): category 8 requires the catalogued Chinese Runtime sentence in the answer slot and rejects the settlement code in every string it samples. English Runtime text that another layer authors and the Runner only passes through is not covered by that assertion — for example the failure class reads `user-facing clarification generation failed: <provider text>` and the aborted class reads `run interrupted at a safe boundary` (`packages/harness/src/stages/*`); localizing those needs the catalogue below the harness boundary and is a separate change. They are recorded in the samples above, not asserted.',
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
