// Real-window measurement of "new conversation → first streamed token".
//
// WHY THIS EXISTS
// `scripts/measure-desktop-cold-start.mjs` stops before the thing a user waits for:
// `firstSendPreparationMs` ends when the renderer consumes the draft, and `executionReadyMs`
// ends when readiness is published. Nothing measured the cost between "the user asked" and
// "the first character of the answer is on screen", so that cost could not be attributed to
// anything. This script measures it on the real Electron app and keeps the decomposition.
//
// WHAT IT MEASURES (one clock: the renderer's `performance.now()`, unless labelled otherwise)
//   clickAt              the sidebar 「新对话」 button's own click handler returned
//   typedAt              the probe draft was written into `.composer textarea`
//   enterAt              the Enter keydown that submits the draft was dispatched
//   firstTokenAt         `.assistant-response-stream` holds its first non-empty text
//   settledAt            that container reports `data-stream-state="settled"`
//
//   clickToFirstTokenMs = firstTokenAt - clickAt, split into clickToEnterMs and
//   enterToFirstTokenMs so the pre-token cost is attributable instead of one opaque number.
//   The report's `timeline` adds the intermediate facts on the same clock — the local user row,
//   the reply container, the tool-call rows, `data-stream-state`, the run-in-flight flag — so a
//   sample says what changed when, instead of only its endpoints.
//
// WHAT IT DOES NOT PROVE (deliberately explicit)
//   - The model is a local deterministic fixture (`startElectronAcceptanceProvider`), not a real
//     Provider. This measures the application's own cost, not a network round trip to a vendor.
//   - The fixture answers the first tool-bearing request with one `glob` tool call (that is its
//     documented behaviour whenever `tools` are present and no tool result is in the request), so
//     the reply prose arrives after one tool round trip inside the same run. `enterToRunAcceptedMs`
//     and the `[run-timing]` marks separate "the run started" from "the first prose token arrived";
//     do not read `enterToFirstTokenMs` as pure model latency.
//   - The first token is observed by polling the DOM every ~25 ms, so the number is an upper bound
//     on the paint time with up to one poll interval of quantization.
//   - The reply is painted through the renderer's display-synced buffer. This script shows the
//     window (a real user's window is visible) and counts animation frames with its own rAF probe;
//     with the window left hidden, Chromium delivers almost no frames and the same app reports a
//     first token roughly 300 ms later. `--no-show` reproduces that and records it as such — never
//     compare a hidden sample with a shown one.
//   - One run is one sample. It is not a percentile, and it is only comparable with another run
//     on the same machine with the same fixture pacing and similar background load.
//
// Usage:
//   node scripts/measure-desktop-first-token.mjs [--deadline-ms=60000] [--out=<dir>] [--keep] [--no-show]
//   pnpm run measure:desktop-first-token

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const REPORT_FILE = 'desktop-first-token.json'
const READINESS_TIMEOUT_MS = 90_000
/** Poll cadence asked for by this metric: a DOM read every 25 ms plus its CDP round trip. */
const POLL_INTERVAL_MS = 25
/** Generous: the fixture replies in two model requests, one of them after a `glob` tool call. */
const FIRST_TOKEN_DEADLINE_MS = Number.parseInt(readOption('deadline-ms', '60000'), 10)
const SETTLE_DEADLINE_MS = 30_000
/**
 * Wait after the stream settles before reading the log. The Runner's marks are `console.log`
 * writes: the last one can still be in the pipe when the DOM already says "settled".
 */
const LOG_SETTLE_MS = 1_500
const MAX_TIMELINE_ENTRIES = 60
/**
 * The probe prompt is a fixed script constant. It deliberately contains none of the acceptance
 * provider's markers, so the fixture takes its documented default branch. No user text is read,
 * written or recorded by this script.
 */
const PROBE_PROMPT = 'first-token probe 4f2c'
const NEW_CONVERSATION_SELECTOR = '.sidebar-quick-nav button[aria-label="新对话"]'
const COMPOSER_SELECTOR = '.composer textarea'
/**
 * A reply token is painted through the renderer's display-synced path: `assistant-delta-buffer`
 * flushes on `requestAnimationFrame` when the page is visible (and falls back to `setTimeout(16)`
 * while `document.hidden`). An acceptance window is held back and never shown, and Chromium then
 * delivers almost no frames even though the page still reports `visibilityState: "visible"`. The
 * flush waits for one, so the sample measures the missing compositor instead of the application.
 *
 * Measured on the same build and fixture (frames counted by a rAF probe this script installs,
 * one sample each):
 *   window never shown : 2 frames in ~2.1 s, Enter → first token 1262.9 ms, Runner mark → DOM 607.5 ms
 *   window shown       : 253 frames in ~2.1 s, Enter → first token 952.1 ms, Runner mark → DOM 237.3 ms
 * A real user's window is visible, so showing it is the default here. `--no-show` keeps the window
 * off the desktop and records `scenario.windowShown: false`, so such a sample is never compared
 * with a shown one. The three switches below are Playwright's standard background set; they stop
 * Chromium from throttling an occluded window's timers and change no application code (they were
 * not what produced the gap: they were already on in the 1262.9 ms sample).
 */
const CHROMIUM_BACKGROUND_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoot = process.argv.includes('--keep')
const showWindow = !process.argv.includes('--no-show')

/** A build with a stale manifest would measure sources that are not the ones on screen. */
async function assertReadyToMeasure() {
  await harness.assertBuildFresh()
}

/**
 * One DOM read that carries every fact the milestone timeline needs, so a poll describes one
 * instant instead of a sequence of instants.
 */
const TRANSCRIPT_POLL_EXPRESSION = `(() => {
  const userRows = document.querySelectorAll('.message-with-meta.user');
  const turns = [...document.querySelectorAll('.assistant-turn')];
  const turn = turns.length > 0 ? turns[turns.length - 1] : null;
  const reply = turn ? turn.querySelector('.assistant-response-stream') : null;
  const text = reply ? (reply.textContent || '').trim() : '';
  const notice = document.querySelector('.composer-error') || document.querySelector('.runtime-event-notice');
  const input = document.querySelector('.composer textarea');
  return {
    at: performance.now(),
    userRowCount: userRows.length,
    assistantTurnCount: turns.length,
    turnClass: turn ? turn.className : null,
    hasReplyContainer: Boolean(reply),
    hasReplyText: text.length > 0,
    streamState: reply ? reply.getAttribute('data-stream-state') : null,
    replyCharacters: text.length,
    replyHead: text.slice(0, 24),
    toolRows: turn ? turn.querySelectorAll('.agent-tool-call, .agent-tool-row').length : 0,
    preparingRows: turn ? turn.querySelectorAll('.agent-tool-preparing').length : 0,
    proseEntries: turn ? turn.querySelectorAll('.agent-transcript-prose').length : 0,
    runInFlight: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
    notice: notice ? (notice.textContent || '').slice(0, 200) : null,
    draft: input ? input.value : null,
  };
})()`

async function pollTranscript(client) {
  try {
    return await client.evaluate(TRANSCRIPT_POLL_EXPRESSION)
  } catch (error) {
    // A read that lands while the renderer swaps documents is retried, not fatal.
    return { at: null, readError: error instanceof Error ? error.message : String(error) }
  }
}

/** Boolean facts whose first change is worth a timeline entry. */
const TIMELINE_FACTS = [
  'userRowCount',
  'hasReplyContainer',
  'hasReplyText',
  'streamState',
  'toolRows',
  'preparingRows',
  'proseEntries',
  'runInFlight',
  'notice',
]

function timelineEntry(previous, current) {
  if (!previous) return { at: round(current.at), event: 'first-observation', facts: pickFacts(current) }
  const changed = {}
  for (const fact of TIMELINE_FACTS) {
    if (previous[fact] !== current[fact]) changed[fact] = { from: previous[fact], to: current[fact] }
  }
  if (Object.keys(changed).length === 0) return null
  return { at: round(current.at), changed, replyCharacters: current.replyCharacters }
}

function pickFacts(sample) {
  return Object.fromEntries(TIMELINE_FACTS.map((fact) => [fact, sample[fact]]))
}

/**
 * The Runtime's own acceptance moment, read from `/application/active-runs`.
 *
 * `startedAt` is the Runner's timestamp, so the poll cadence does not quantize the number; it
 * only decides how soon the script notices. A route that is missing (older build) or refuses
 * (no Runner yet) is recorded as unavailable rather than failing the measurement.
 */
async function collectRunAcceptance({ locator, deadlineMs }) {
  const startedAt = Date.now()
  let lastStatus
  while (Date.now() - startedAt < deadlineMs) {
    const response = await harness.fetchJson(locator, '/application/active-runs').catch(() => undefined)
    lastStatus = response?.status
    const run = response?.body?.runs?.[0]
    if (run?.startedAt) {
      return {
        available: true,
        observed: true,
        noticedAfterEnterMs: round(Date.now() - startedAt),
        runIdPrefix: String(run.runId ?? '').slice(0, 8),
        phase: run.phase,
        controlStatus: run.controlStatus,
        startedAt: run.startedAt,
      }
    }
    await delay(POLL_INTERVAL_MS)
  }
  return {
    available: lastStatus === 200,
    observed: false,
    noticedAfterEnterMs: round(Date.now() - startedAt),
    lastStatus,
  }
}

/**
 * Wait for exactly one condition, sampling `read()` on the metric's cadence.
 *
 * Returns every fact it saw: a timeout is then diagnosable from the samples instead of being a
 * bare "timed out".
 */
async function waitForCondition(read, predicate, deadlineMs, onSample) {
  const startedAt = Date.now()
  const samples = []
  let last
  while (Date.now() - startedAt < deadlineMs) {
    const value = await read()
    last = value
    samples.push(value)
    const matched = value ? predicate(value) : undefined
    onSample?.(value)
    if (matched) return { matched, value, waitedMs: Date.now() - startedAt, samples }
    await delay(POLL_INTERVAL_MS)
  }
  return { matched: undefined, value: last, waitedMs: Date.now() - startedAt, samples }
}

/** `[bootstrap-timing]` and `[run-timing]` lines, in log order. */
async function readTimingMarks(logPath) {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  const bootstrap = []
  const run = []
  for (const line of contents.split(/\r?\n/u)) {
    const bootstrapAt = line.indexOf('[bootstrap-timing] ')
    if (bootstrapAt >= 0) {
      const entry = parseJson(line.slice(bootstrapAt + '[bootstrap-timing] '.length))
      if (entry && typeof entry.stage === 'string') bootstrap.push(entry)
      continue
    }
    const runAt = line.indexOf('[run-timing] ')
    if (runAt >= 0) {
      const entry = parseJson(line.slice(runAt + '[run-timing] '.length))
      if (entry && typeof entry.stage === 'string') run.push(entry)
    }
  }
  return { bootstrap, run }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function main() {
  await assertReadyToMeasure()
  const startedAt = new Date()
  const spawnRequestedAt = { at: 0 }
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-first-token-'))
  const dataDir = join(root, 'data')
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider()
  let electron
  let client
  let locator
  const diagnostics = { pollSamples: 0 }

  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
    ])
    // A non-empty workspace keeps the fixture's `glob` call from being a degenerate case.
    await writeFile(join(workplaceDir, 'README.md'), '# first-token fixture\n', 'utf8')
    await writeFile(
      join(dataDir, 'config.json'),
      `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`,
      'utf8',
    )

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraArgs: CHROMIUM_BACKGROUND_FLAGS,
      // The app only prints its own stage marks with this switch; they are the app's account of
      // where the wait went, which is what makes this metric attributable.
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
      onSpawn: ({ spawnRequestedAt: at }) => { spawnRequestedAt.at = at },
    })
    diagnostics.pid = electron.pid
    locator = await harness.waitForLocator(dataDir, electron.pid)
    if (showWindow) {
      // The window is held back in acceptance runs; showing it is what gives the reply's
      // frame-synced flush a compositor to flush on (see CHROMIUM_BACKGROUND_FLAGS).
      await harness.waitForDesktop(locator)
      await harness.desktopAction(locator, 'show')
    }
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, COMPOSER_SELECTOR, 0, harness.actionTimeoutMs)
    const composerUsableAt = Date.now()
    // `timeOrigin + performance.now()` is the renderer's wall clock. The Runtime's run
    // `startedAt` is on the same OS clock, so "Enter → the run was accepted" can be computed
    // without borrowing a parent-process timestamp for the Enter moment.
    const timeOrigin = await client.evaluate('performance.timeOrigin').catch(() => undefined)
    // Independent evidence about the environment the metric was taken in: a page Chromium has no
    // compositor for delivers no animation frames, and the reply's frame-synced flush then waits
    // for one. This probe only counts frames; it changes nothing in the application.
    const frameProbe = await client.evaluate(`(() => {
      window.__firstTokenFrames = { frames: 0, firstFrameAt: null, lastFrameAt: null };
      const tick = () => {
        const probe = window.__firstTokenFrames;
        probe.frames += 1;
        probe.lastFrameAt = performance.now();
        if (probe.firstFrameAt === null) probe.firstFrameAt = probe.lastFrameAt;
        if (probe.frames < 5_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return { hidden: document.hidden, visibilityState: document.visibilityState };
    })()`)
    diagnostics.pageVisibility = frameProbe

    // The script drives the composer, so it must not type into a window that cannot accept the
    // send yet: an Enter before readiness is refused by the Runtime and would measure the
    // refusal. The wait itself is reported, not hidden inside the token number.
    const readiness = await waitForExecutionReady(locator)
    const readyObservedAt = Date.now()
    diagnostics.readiness = readiness

    // 1. A genuinely new conversation. The transcript must be empty afterwards, which is what
    //    makes the following send the first turn of a new one rather than a reply to old state.
    const clicked = await client.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(NEW_CONVERSATION_SELECTOR)});
      if (!button) return { clicked: false, candidates: [...document.querySelectorAll('.sidebar-nav-button')].map((node) => node.getAttribute('aria-label')) };
      button.click();
      return { clicked: true, at: performance.now(), activeSessionBefore: localStorage.getItem('littlesheep.ui.activeSession') };
    })()`)
    if (clicked?.clicked !== true) {
      throw new Error(`the sidebar new-conversation entry was not found: ${JSON.stringify(clicked)}`)
    }
    const clickAt = clicked.at
    const clickWallClock = Date.now()
    const cleared = await waitForCondition(
      () => client.evaluate(`(() => ({
        at: performance.now(),
        userRowCount: document.querySelectorAll('.message-with-meta.user').length,
        assistantTurnCount: document.querySelectorAll('.assistant-turn').length,
      }))()`).catch(() => undefined),
      (value) => value.userRowCount === 0 && value.assistantTurnCount === 0,
      5_000,
    )

    // 2. Type the probe through the same native-setter + input-event path a real keystroke takes,
    //    then submit with Enter. Typing is a separate round trip on purpose: React must have
    //    committed the draft before `send()` reads it.
    const typed = await client.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
      if (!input) return null;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(PROBE_PROMPT)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { at: performance.now(), accepted: input.value === ${JSON.stringify(PROBE_PROMPT)} };
    })()`)
    if (typed?.accepted !== true) throw new Error(`the composer did not accept the probe draft: ${JSON.stringify(typed)}`)

    // Start watching the Runtime's active-run list first: the run is accepted somewhere between
    // this instant and the first token, and the route carries the Runner's own `startedAt`.
    const acceptance = collectRunAcceptance({ locator, deadlineMs: 45_000 })

    const submitted = await client.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
      if (!input) return null;
      const before = performance.now();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      return { before, after: performance.now() };
    })()`)
    if (submitted === null) throw new Error('the composer disappeared before the Enter keydown')
    const enterDispatchedAt = Date.now()
    const enterAtWallClock = typeof timeOrigin === 'number' ? timeOrigin + submitted.after : enterDispatchedAt

    // 3. Poll until the reply container carries text. The renderer clock is the only clock used
    //    for the metric, so no cross-process skew enters the number.
    const timeline = []
    let previousSample = null
    const firstToken = await waitForCondition(
      () => pollTranscript(client),
      (sample) => typeof sample.replyCharacters === 'number' && sample.replyCharacters > 0,
      FIRST_TOKEN_DEADLINE_MS,
      (sample) => {
        if (!sample || typeof sample.at !== 'number') return
        diagnostics.pollSamples += 1
        const entry = timelineEntry(previousSample, sample)
        previousSample = sample
        diagnostics.lastSample = sample
        if (entry && timeline.length < MAX_TIMELINE_ENTRIES) timeline.push(entry)
      },
    )
    if (!firstToken.matched) {
      throw new Error(`no reply token arrived within ${FIRST_TOKEN_DEADLINE_MS} ms`)
    }
    const firstTokenAt = firstToken.value.at
    const firstTokenWallClock = Date.now()

    // 4. Let the turn settle. Cheap while the container already exists, and it gives the app the
    //    chance to publish the run marks that follow the first token.
    const settled = await waitForCondition(
      () => pollTranscript(client),
      (sample) => sample.streamState === 'settled',
      SETTLE_DEADLINE_MS,
      (sample) => {
        if (!sample || typeof sample.at !== 'number') return
        const entry = timelineEntry(previousSample, sample)
        previousSample = sample
        diagnostics.lastSample = sample
        if (entry && timeline.length < MAX_TIMELINE_ENTRIES) timeline.push(entry)
      },
    )
    const settledAt = settled.matched ? settled.value.at : undefined

    // The last poll of either loop is the most informative DOM snapshot for the report.
    const finalSample = settled.value ?? firstToken.value
    const acceptedRun = await acceptance
    const frames = await client.evaluate('window.__firstTokenFrames ?? null').catch(() => null)
    await delay(LOG_SETTLE_MS)
    const marks = await readTimingMarks(logPath)

    const milestones = {
      clickAt: round(clickAt),
      typedAt: round(typed.at),
      enterAt: round(submitted.after),
      firstTokenAt: round(firstTokenAt),
      ...(settledAt === undefined ? {} : { settledAt: round(settledAt) }),
    }
    // Two more milestones the timeline already carries, because the reply is not the first thing
    // the model streams: a tool call's arguments arrive (and are drawn as a "preparing" row)
    // before the tool runs and the prose is produced. Reporting both is what keeps
    // `enterToFirstTokenMs` from being read as "the model's own latency".
    const firstModelOutput = timeline.find((entry) => (
      (entry.facts?.preparingRows ?? 0) > 0
      || (entry.facts?.toolRows ?? 0) > 0
      || (entry.changed?.preparingRows?.to ?? 0) > 0
      || (entry.changed?.toolRows?.to ?? 0) > 0
    ))
    const firstToolRow = timeline.find((entry) => (
      (entry.facts?.toolRows ?? 0) > 0 || (entry.changed?.toolRows?.to ?? 0) > 0
    ))
    const metrics = {
      clickToFirstTokenMs: round(firstTokenAt - clickAt),
      clickToEnterMs: round(submitted.after - clickAt),
      enterToFirstTokenMs: round(firstTokenAt - submitted.after),
      enterToFirstModelOutputMs: firstModelOutput === undefined ? undefined : round(firstModelOutput.at - submitted.after),
      enterToToolRowMs: firstToolRow === undefined ? undefined : round(firstToolRow.at - submitted.after),
      typedToEnterMs: round(submitted.after - typed.at),
      enterToRunAcceptedMs: acceptedRun.observed
        ? round(Date.parse(acceptedRun.startedAt) - enterAtWallClock)
        : undefined,
      /**
       * When the poller *noticed* the run, not when it started — and therefore also a rough
       * responsiveness reading for Main: measured ~550–575 ms, because the run's first half second
       * keeps the process busy. Use `enterToRunAcceptedMs` (the Runner's own `startedAt`) as the
       * acceptance time.
       */
      runAcceptedNoticedByPollerMs: acceptedRun.noticedAfterEnterMs,
      enterToSettledMs: settledAt === undefined ? undefined : round(settledAt - submitted.after),
      readinessWaitMs: round(readyObservedAt - composerUsableAt),
      spawnToReadyMs: round(readyObservedAt - spawnRequestedAt.at),
      spawnToFirstTokenMs: round(firstTokenWallClock - spawnRequestedAt.at),
      clickToFirstTokenNodeClockMs: round(firstTokenWallClock - clickWallClock),
      firstTokenCharacters: firstToken.value.replyCharacters,
      replyCharactersAtSettle: finalSample?.replyCharacters,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollQuantizationMs: POLL_INTERVAL_MS,
      pollCount: diagnostics.pollSamples,
    }
    // A cross-check between two accounts of the same instant: the Runner's own `first-token`
    // mark (run-relative) placed on the renderer timeline, against the DOM observation. The two
    // clocks are joined through the run's `startedAt`, which is captured within a few ms of the
    // Runner's timing origin, so treat this as a ~10 ms-resolution attribution, not an exact one.
    const firstTokenMark = marks.run.find((mark) => mark.stage === 'first-token')
    metrics.appFirstTokenMarkToDomMs = firstTokenMark === undefined || metrics.enterToRunAcceptedMs === undefined
      ? undefined
      : round(metrics.enterToFirstTokenMs - (metrics.enterToRunAcceptedMs + firstTokenMark.sinceRunStartMs))

    const report = {
      check: 'desktop-first-token',
      ok: true,
      measuredAt: startedAt.toISOString(),
      metric: 'new conversation → first streamed token (real Electron window, deterministic local model)',
      machine: await readMachineDescription(),
      app: {
        kind: 'dev',
        entry: 'packages/app/out (dev entry)',
        buildInputDigest: await readAppBuildDigest(),
        timingSwitch: 'LITTLESHEEP_BOOTSTRAP_TIMING=1',
      },
      scenario: {
        newConversationEntry: NEW_CONVERSATION_SELECTOR,
        transcriptEmptyAfterClick: cleared.matched === true,
        probePrompt: PROBE_PROMPT,
        replySource: 'deterministic acceptance provider on loopback (startElectronAcceptanceProvider)',
        dataRoot: 'isolated os.tmpdir() root, removed after the run',
        windowShown: showWindow,
        pageVisibilityAtEnter: diagnostics.pageVisibility,
        animationFrames: frames,
        chromiumFlags: CHROMIUM_BACKGROUND_FLAGS,
        clockForMetrics: 'renderer performance.now()',
      },
      readiness,
      milestones,
      metrics,
      runMarks: marks.run,
      bootstrapMarks: marks.bootstrap,
      providerRequests: provider.requests.map((request) => ({
        requestIndex: request.requestIndex,
        receivedAt: request.receivedAt,
        model: request.model,
        stream: request.stream === true,
        tools: request.tools ?? [],
        ...(request.fault === undefined ? {} : { fault: request.fault }),
      })),
      runAcceptance: acceptedRun,
      timeline,
      finalTranscriptSample: finalSample,
      limits: [
        'the model is a local deterministic fixture, so this is the application\'s cost and not a vendor round trip',
        'the fixture answers a tool-bearing request with one glob call, so the first prose token follows one tool round trip inside the same run',
        'first-token time is observed by polling the DOM every ~25 ms, so it is an upper bound with up to one interval of quantization',
        'the sample is taken with the window shown (real-user condition) and Chromium\'s background throttling disabled by harness switches (see scenario.chromiumFlags); with the window hidden the renderer gets almost no animation frames and the reply\'s frame-synced flush adds roughly 300 ms that a visible window does not pay',
        'appFirstTokenMarkToDomMs joins the Runner\'s timing origin to the run\'s startedAt, which are captured a few ms apart: read it as an attribution aid, not an exact figure. It is not decomposed further — between the mark and the paint sit the Main-to-Renderer SSE hop, the display-synced flush, the React render and at most one poll interval, and no mark exists inside that span yet',
        'the data root is freshly created, so the first run in it also pays first-ever index and memory bootstrap work that a warm installation has already done',
        'one run is one sample: no percentile is claimed, and comparisons need the same machine, fixture pacing, window visibility and background load',
        'readinessWaitMs is Node wall clock between "the composer was usable" and "readiness was observed", not a renderer measurement',
      ],
    }
    await writeFile(join(outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      ok: true,
      clickToFirstTokenMs: metrics.clickToFirstTokenMs,
      readinessWaitMs: metrics.readinessWaitMs,
      runMarks: report.runMarks,
      metrics,
      report: `${outDir.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '')}/${REPORT_FILE}`,
    }, null, 2))
  } catch (error) {
    const failure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      report: 'not written: the run did not produce a first token',
      metrics: undefined,
      diagnostics,
    }
    console.error(JSON.stringify(failure, null, 2))
    // The tail is what makes a failure diagnosable; it stays on stdout and out of the report,
    // because application logs can carry machine paths.
    console.error('[first-token] electron log tail:\n' + await readLogTail(logPath))
    process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    if (keepRoot) console.log(`[first-token] kept ${root}`)
    else await harness.removeTemporaryRoot(root).catch(() => undefined)
  }
}

/**
 * `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS` is deliberately not set: this metric is about a
 * normally-started app, not about a widened startup window.
 */
function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'First Token Acceptance Provider',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 60,
      models: [{ id: 'first-token', name: 'First Token Fixture', contextWindow: 128_000 }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/first-token',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
    channels: { channels: [] },
  }
}

async function waitForExecutionReady(locator) {
  let lastState
  const state = await harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    lastState = response?.body ?? lastState
    if (response?.body?.state === 'failed') {
      throw new Error(`execution readiness failed: ${response.body.reason ?? 'no reason reported'}`)
    }
    return response?.body?.state === 'ready' ? response.body : undefined
  }, READINESS_TIMEOUT_MS, 'execution readiness')
  return { state: state?.state, phase: state?.phase, retryable: state?.retryable, lastState: lastState?.state }
}

async function readAppBuildDigest() {
  const manifest = await readFile(join(repoRoot, 'packages/app/out/.littlesheep-build-fingerprint.json'), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return manifest?.input?.digest ?? manifest?.inputDigest
}

async function readMachineDescription() {
  const os = await import('node:os')
  const electron = await readFile(join(repoRoot, 'packages/app/node_modules/electron/package.json'), 'utf8')
    .then((text) => JSON.parse(text).version)
    .catch(() => undefined)
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    electronVersion: electron,
  }
}

async function readLogTail(logPath, lines = 30) {
  const contents = await readFile(logPath, 'utf8').catch(() => '')
  return contents.split(/\r?\n/u).slice(-lines).join('\n')
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined
}

await main()
