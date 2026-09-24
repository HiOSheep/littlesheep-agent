// Real-window startup-recovery state acceptance (taskbook UX-05).
//
// UX-05 asks for five classes of the startup recovery surface: a failed discovery
// request, only unreadable records, a task that waits for the user, a silent
// continuation that fails, and one that succeeds. The claims around them are that
// each state is discoverable without opening anything, that the chat stays usable
// while it lasts, and that retrying never repeats already settled work.
//
// Evidence design:
//   - Four isolated data roots, each with its own window and the real Local App
//     API, checkpoint store and renderer under test.
//   - The two automatic-continuation classes use a checkpoint file the *product*
//     wrote: window 1 fails one real run (HTTP 500 injected at the acceptance
//     Provider) and keeps the checkpoint the runtime persisted. Windows 2 and 3
//     copy that file plus the session it belongs to into a fresh data root, so the
//     continuation is executed by the real runner against the fixture workspace
//     recorded inside the checkpoint.
//   - One response is injected, and only one: a page-level `fetch` probe answers
//     `GET /run-checkpoints` with HTTP 500 to produce the discovery-failure class.
//     Everything else in that window - the quiet entry, the retry, the untouched
//     chat - is the product's own behaviour. The probe is labelled as an injected
//     response in the printed evidence.
//   - The waiting-for-the-user class can no longer be produced by the runtime: a
//     run does not park itself on a question any more (`status: 'waiting_user'` is
//     only written by earlier versions). Its fixture is the real checkpoint file
//     with `status` and `resumeState.continuation` rewritten into the legacy shape
//     the store still validates and the dialog still renders. That is recorded as
//     a compatibility shape, not as a produced state.
//
// Usage:
//   node scripts/verify-recovery-states.mjs [--windows=1,2,3,4] [--keep]

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1180, height: 780 }
const MODEL_ID = 'slow-a'
const MODEL_REF = `acceptance/${MODEL_ID}`
const CAPTURE_PROMPT = '请列出工作区里的文件，然后告诉我一共有几个。'
const ANSWER_TEXT = '补充信息：只在 workplace 里找，忽略隐藏目录。'
const READY_TIMEOUT_MS = 90_000
const RESUME_TIMEOUT_MS = 90_000
const CAPTURE_TIMEOUT_MS = 90_000
/** Enough failures that no logical model call of the injected runs can succeed. */
const TRANSPORT_FAULTS = [{ kind: 'status', status: 500, times: 40 }]
/** Shortens only the backoff wait between transport retries; the budget is unchanged. */
const RETRY_BASE_DELAY_MS = '10'

/**
 * Page-side probe.
 *
 * `fail` makes the discovery request fail exactly like a Local App API error does;
 * `pass` forwards everything to the real listener. It also counts the two routes
 * this gate reasons about, so "a retry asked again" and "resuming was refused
 * before any request" are measured rather than inferred.
 */
const PROBE_SOURCE = `(() => {
  if (window.__littlesheepRecoveryProbe) return true;
  const MODE_KEY = 'littlesheep.verify.recoveryDiscoveryMode';
  const probe = { installed: true, mode: null, listRequests: 0, injectedFailures: 0, resumeRequests: 0, resumeBodies: [] };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function probedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const mode = window.localStorage.getItem(MODE_KEY) || 'pass';
    probe.mode = mode;
    if (/\\/run-checkpoints\\/[^/?#]+\\/resume\\/stream/u.test(url)) {
      probe.resumeRequests += 1;
      try { probe.resumeBodies.push(String((init && init.body) || '').slice(0, 512)); } catch (error) { probe.resumeBodies.push(''); }
      return originalFetch(input, init);
    }
    if (!/\\/run-checkpoints(?:\\?|$)/u.test(url)) return originalFetch(input, init);
    probe.listRequests += 1;
    if (mode !== 'fail') return originalFetch(input, init);
    probe.injectedFailures += 1;
    return new Response(JSON.stringify({ error: '验收夹具注入的发现失败：HTTP 500' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  window.__littlesheepRecoveryProbe = probe;
  return true;
})()`

/** Everything the five classes are judged by, read from the real window at once. */
const SURFACE_EXPRESSION = `(() => {
  const trigger = document.querySelector('.checkpoint-recovery-trigger');
  const dialog = document.querySelector('.checkpoint-recovery-dialog');
  const composer = document.querySelector('.composer textarea');
  const answer = document.querySelector('.checkpoint-recovery-answer textarea');
  const resume = document.querySelector('.checkpoint-recovery-actions button.primary');
  const list = [...document.querySelectorAll('.checkpoint-recovery-list button')];
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  return {
    trigger: trigger ? {
      label: (trigger.textContent || '').trim(),
      className: String(trigger.className),
      title: trigger.getAttribute('title'),
      count: trigger.querySelector('strong') ? Number((trigger.querySelector('strong').textContent || '').trim()) : 0,
    } : null,
    dialogOpen: Boolean(dialog),
    dialogError: text('.checkpoint-recovery-error'),
    dialogDiagnostic: text('.checkpoint-recovery-diagnostic'),
    dialogEmpty: text('.checkpoint-recovery-empty'),
    stateLine: text('.checkpoint-recovery-state-line'),
    blockers: text('.checkpoint-recovery-blockers'),
    listCount: list.length,
    listLabels: list.map((item) => (item.textContent || '').trim().slice(0, 60)),
    footerButtons: [...document.querySelectorAll('.checkpoint-recovery-actions button')].map((item) => (item.textContent || '').trim()),
    answerPresent: Boolean(answer),
    answerFocused: Boolean(answer) && document.activeElement === answer,
    answerValue: answer ? answer.value : null,
    resumePresent: Boolean(resume),
    resumeDisabled: resume ? resume.disabled : null,
    composerPresent: Boolean(composer),
    composerDisabled: composer ? composer.disabled : null,
    composerValue: composer ? composer.value : null,
    runActive: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
    runErrors: [...document.querySelectorAll('.run-status-error')].map((node) => (node.textContent || '').trim()),
    /**
     * Per-turn outcome. The global error list also carries rows the history
     * projection adds for a *previous* run (a copied transcript has no local
     * evidence for its own run), so "did this continuation fail" is only
     * answerable per turn.
     */
    turns: [...document.querySelectorAll('.assistant-turn')].map((turn) => ({
      key: turn.getAttribute('data-message-key'),
      error: turn.querySelector('.run-status-error') ? (turn.querySelector('.run-status-error').textContent || '').trim() : null,
      state: turn.querySelector('.assistant-response-stream')?.getAttribute('data-stream-state') ?? null,
      characters: (turn.querySelector('.assistant-response-stream')?.textContent ?? '').length,
    })),
    assistantTurns: document.querySelectorAll('.assistant-turn').length,
    activeSessionTitle: text('.session-item.active .session-title'),
    messageCount: document.querySelectorAll('.message').length,
  };
})()`

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function createRecorder(windowName) {
  const observations = []
  const failures = []
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      if (!condition) failures.push({ window: windowName, check, detail })
      return Boolean(condition)
    },
    finish: (extra = {}) => ({ window: windowName, ok: failures.length === 0, observations, failures, ...extra }),
    get failures() {
      return failures
    },
  }
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Electron Acceptance',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 10,
      models: [MODEL_ID],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: MODEL_REF,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        // The schema requires at least one recovery attempt; the failing windows
        // inject more faults than a whole run can consume instead of removing it.
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 16,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

/**
 * Copy the session index and transcripts of a finished fixture root.
 *
 * A checkpoint belongs to a session, so a window that resumes one needs both the
 * checkpoint file and the conversation it came from - otherwise the continuation
 * would run against an empty history and prove less than it claims. The copied
 * session runs with full access, the same way the API-level continuation fixtures
 * do: the classes under test are the recovery states, not the approval flow, and a
 * research-mode tool call would otherwise park the run on an unanswered prompt.
 */
async function copySessions(sourceDataDir, targetDataDir, mode = 'full') {
  const index = JSON.parse(await readFile(join(sourceDataDir, 'sessions.json'), 'utf8'))
  const sessions = (index.sessions ?? []).map((session) => ({ ...session, mode }))
  await writeFile(join(targetDataDir, 'sessions.json'), `${JSON.stringify({ ...index, sessions }, null, 2)}\n`, 'utf8')
  const sourceDir = join(sourceDataDir, 'sessions')
  const targetDir = join(targetDataDir, 'sessions')
  await mkdir(targetDir, { recursive: true })
  if (!existsSync(sourceDir)) return []
  const copied = []
  for (const name of await readdir(sourceDir)) {
    if (!name.endsWith('.jsonl')) continue
    const raw = await readFile(join(sourceDir, name), 'utf8')
    // The copied conversation came from another data root, so the runs it names
    // have no execution log or durable evidence here - and the history projection
    // says so, loudly, on their behalf. The copied turns keep their text but drop
    // the run id, which is what makes this root self-consistent: no run is claimed
    // that this root cannot prove.
    const rewritten = raw.split(/\r?\n/u).filter(Boolean).map((line) => {
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && parsed.runId !== undefined) delete parsed.runId
        return JSON.stringify(parsed)
      } catch {
        return line
      }
    })
    await writeFile(join(targetDir, name), `${rewritten.join('\n')}\n`, 'utf8')
    copied.push(name)
  }
  return copied
}

/**
 * Point a copied checkpoint at the workspace of the window that continues it.
 *
 * The record names the directory the original run worked in, which belonged to the
 * data root that wrote it. Continuing it from a fresh data root would put that
 * workspace outside the new container and make the first read ask for approval, so
 * the fixture relocates it into the continuing window's own workplace.
 */
function relocateCheckpoint(contents, workspaceDir) {
  const checkpoint = JSON.parse(contents)
  checkpoint.resumeState.cwd = workspaceDir
  if (checkpoint.resumeState.workspaceContext) {
    checkpoint.resumeState.workspaceContext = { boundaryKind: 'agent_workplace' }
  }
  return `${JSON.stringify(checkpoint, null, 2)}\n`
}

async function readSessionIndex(dataDir) {
  return JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'))
}

/** The persisted transcript of one session, as the store wrote it. */
async function readSessionMessages(dataDir, sessionId) {
  const path = join(dataDir, 'sessions', `${sessionId}.jsonl`)
  if (!existsSync(path)) return { path, lines: [] }
  const raw = await readFile(path, 'utf8')
  const lines = raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  return { path, lines }
}

async function listCheckpointFiles(dataDir) {
  const dir = join(dataDir, 'run-checkpoints')
  if (!existsSync(dir)) return []
  const files = []
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.json'))) {
    const path = join(dir, name)
    const raw = await readFile(path, 'utf8')
    let checkpoint = null
    try {
      checkpoint = JSON.parse(raw)
    } catch {
      checkpoint = null
    }
    files.push({ name, path, bytes: raw.length, hash: sha256(raw), checkpoint })
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * The durable disposition of every checkpoint: the record of what the runtime
 * decided about it (claimed, interrupted, resumed ...) and with which result.
 */
async function listDispositions(dataDir) {
  const dir = join(dataDir, 'run-checkpoint-dispositions')
  if (!existsSync(dir)) return []
  const records = []
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
      records.push({
        checkpointId: String(parsed.checkpointId ?? ''),
        status: parsed.status ?? null,
        resultStatus: parsed.resultStatus ?? null,
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : null,
        nextCheckpointId: parsed.nextCheckpointId ?? null,
        /** How often the runtime claimed this checkpoint for a continuation. */
        resumeAttempts: Array.isArray(parsed.history)
          ? parsed.history.filter((entry) => entry?.status === 'resuming').length
          : 0,
      })
    } catch {
      records.push({ checkpointId: name, status: 'unreadable', resultStatus: null, reason: null, nextCheckpointId: null })
    }
  }
  return records
}

/**
 * Append one assistant message carrying a clarification request.
 *
 * Only the waiting-for-input class needs this: the current runtime never writes a
 * `waiting_user` checkpoint, and a continuation of one resolves its entry stage
 * from the question it answered, which the runner reads back out of the session.
 */
async function appendClarificationMessage(dataDir, sessionId, request) {
  const path = join(dataDir, 'sessions', `${sessionId}.jsonl`)
  const message = {
    id: `${request.id}:message`,
    role: 'assistant',
    content: [{ type: 'text', text: `执行已停下，等待补充信息：${request.blockingReason}` }],
    timestamp: new Date().toISOString(),
    sessionId,
    clarificationRequest: request,
  }
  await writeFile(path, `${await readFile(path, 'utf8')}${JSON.stringify(message)}\n`, 'utf8')
  return message.id
}

/** The layout of one fixture window, so a caller can seed it before it starts. */
function windowPaths(root, label) {
  const home = join(root, label)
  const dataDir = join(home, 'data')
  return {
    home,
    dataDir,
    workspaceDir: join(dataDir, 'workplace'),
    chromiumDir: join(home, 'chromium'),
    logPath: join(home, 'electron.log'),
    screenshotDir: join(home, 'screenshots'),
  }
}

async function openWindow({ root, label, provider, seeds = [], useProbe = false }) {
  const { dataDir, workspaceDir, chromiumDir, logPath, screenshotDir } = windowPaths(root, label)
  await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true }), mkdir(screenshotDir, { recursive: true })])
  for (const seed of seeds) {
    if (seed.kind === 'checkpoint') {
      await mkdir(join(dataDir, 'run-checkpoints'), { recursive: true })
      await writeFile(join(dataDir, 'run-checkpoints', seed.name), seed.contents, 'utf8')
    } else if (seed.kind === 'broken-checkpoint') {
      await mkdir(join(dataDir, 'run-checkpoints'), { recursive: true })
      await writeFile(join(dataDir, 'run-checkpoints', seed.name), seed.contents, 'utf8')
    } else if (seed.kind === 'sessions') {
      await copySessions(seed.from, dataDir, seed.mode)
    }
  }
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

  const debuggingPort = await harness.reservePort()
  const electron = await harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath,
    extraEnv: {
      LITTLESHEEP_BOOTSTRAP_TIMING: '1',
      LITTLESHEEP_ACCEPTANCE_RETRY_BASE_DELAY_MS: RETRY_BASE_DELAY_MS,
    },
  })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
    harness.startTimeoutMs,
    'composer textarea',
  )
  const handle = { dataDir, workspaceDir, chromiumDir, logPath, screenshotDir, locator, electron, client, label }
  if (useProbe) await installProbe(handle)
  return handle
}

async function closeWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

async function installProbe(handle) {
  const { identifier } = await handle.client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE })
  handle.probeIdentifier = identifier
  await handle.client.evaluate(`window.localStorage.setItem('littlesheep.verify.recoveryDiscoveryMode', 'pass')`)
  return identifier
}

async function setProbeMode(client, mode) {
  await client.evaluate(`window.localStorage.setItem('littlesheep.verify.recoveryDiscoveryMode', ${JSON.stringify(mode)})`)
}

async function readProbe(client) {
  return client.evaluate(`(() => {
    const probe = window.__littlesheepRecoveryProbe;
    return probe ? {
      installed: true,
      mode: probe.mode,
      listRequests: probe.listRequests,
      injectedFailures: probe.injectedFailures,
      resumeRequests: probe.resumeRequests,
      resumeBodies: probe.resumeBodies,
    } : { installed: false, mode: null, listRequests: 0, injectedFailures: 0, resumeRequests: 0, resumeBodies: [] };
  })()`)
}

async function reloadRenderer(client, label) {
  const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
  await client.send('Page.reload', { ignoreCache: false })
  return harness.waitFor(async () => {
    const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
      .catch(() => undefined)
    if (!state) return undefined
    return state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? state.timeOrigin : undefined
  }, harness.actionTimeoutMs, label)
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

async function typeInto(client, selector, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLTextAreaElement)) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
    return true;
  })()`)
}

async function click(client, selector) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function submitComposer(client, prompt) {
  const typed = await typeInto(client, '.composer textarea', prompt)
  if (!typed) throw new Error('composer textarea is not available')
  await client.evaluate(`(() => {
    const input = document.querySelector('.composer textarea');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`)
}

async function startNewConversation(client) {
  const started = await click(client, '.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
  if (!started) return false
  await harness.waitFor(
    () => client.evaluate(`document.querySelectorAll('.assistant-turn').length === 0 || null`),
    harness.startTimeoutMs,
    'empty transcript',
  )
  return true
}

async function waitForReady(locator, timeoutMs = READY_TIMEOUT_MS) {
  return harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    const readiness = response?.body?.readiness ?? response?.body
    return readiness?.state === 'ready' || readiness?.state === 'failed' ? readiness : undefined
  }, timeoutMs, 'execution readiness')
}

async function listCheckpoints(locator) {
  const response = await harness.fetchJson(locator, '/run-checkpoints')
  if (!response?.ok) throw new Error(`checkpoint list failed: ${response?.status}`)
  return response.body
}

/**
 * Window 1 - three classes, and the checkpoint material the later windows need.
 *
 * The discovery failure is the one injected response in this gate. The unreadable
 * record is a real broken file in the real store, and the checkpoint is what the
 * runtime itself persisted when a real run could not reach its Provider.
 */
async function windowDiscoveryAndCapture({ root, provider }) {
  const recorder = createRecorder('discovery-and-capture')
  const handle = await openWindow({ root, label: 'window-1', provider, useProbe: true })
  let capture = null
  try {
    const readiness = await waitForReady(handle.locator)
    recorder.note({ step: 'readiness', state: readiness.state, phase: readiness.phase })

    // 1. A failed discovery must be visible without opening anything, and it must
    //    not be presented as "nothing pending" or steal the composer.
    await setProbeMode(handle.client, 'fail')
    await reloadRenderer(handle.client, 'renderer reload before discovery failure')
    const failed = await waitForSurface(
      handle.client,
      (surface) => surface.trigger && surface.trigger.className.includes('discovery-failed'),
      45_000,
      'discovery failure entry',
    )
    const typedBeforeRetry = await typeInto(handle.client, '.composer textarea', '恢复失败期间仍然可以聊天')
    const failedProbe = await readProbe(handle.client)
    recorder.note({
      step: 'discovery-failure',
      surface: failed,
      probe: { listRequests: failedProbe.listRequests, injectedFailures: failedProbe.injectedFailures },
      providerRequests: provider.requests.length,
      typedBeforeRetry,
    })
    recorder.check(failed.trigger.label.includes('恢复检查失败'), 'a failed discovery shows its own entry', failed.trigger)
    recorder.check(failed.trigger.className.includes('discovery-failed'), 'the entry carries the failure state, not the pending state', failed.trigger)
    recorder.check(Boolean(failed.trigger.title), 'the entry explains itself on hover', failed.trigger)
    recorder.check(!failed.dialogOpen, 'a failed discovery does not open the recovery dialog by itself', failed)
    recorder.check(failed.composerDisabled === false, 'the composer stays usable while the discovery state is unknown', failed)
    recorder.check(typedBeforeRetry === true, 'text can still be typed while discovery is failed', { typedBeforeRetry })
    recorder.check(!failed.runActive, 'a failed discovery starts no run', failed)
    recorder.check(provider.requests.length === 0, 'a failed discovery makes no provider request', { requests: provider.requests.length })
    recorder.check(failedProbe.injectedFailures === 1, 'the entry came from the injected failure, not from an empty result', failedProbe)

    // 2. Retrying re-reads the list through the real listener: the entry clears
    //    itself, the draft survives, and nothing is executed.
    await setProbeMode(handle.client, 'pass')
    await click(handle.client, '.checkpoint-recovery-trigger')
    const cleared = await waitForSurface(
      handle.client,
      (surface) => surface.trigger === null && !surface.dialogOpen,
      30_000,
      'discovery entry cleared by retry',
    )
    const clearedProbe = await readProbe(handle.client)
    recorder.note({ step: 'retry-discovery', surface: cleared, probe: { listRequests: clearedProbe.listRequests }, providerRequests: provider.requests.length })
    recorder.check(clearedProbe.listRequests >= 2, 'retrying asks the Local App API again instead of reusing the failure', clearedProbe)
    recorder.check(cleared.composerValue === '恢复失败期间仍然可以聊天', 'a discovery retry does not clear the user draft', cleared)
    recorder.check(provider.requests.length === 0, 'a discovery retry executes no settled work', { requests: provider.requests.length })
    recorder.check(!cleared.runActive, 'a discovery retry starts no run', cleared)

    // 3. Only unreadable records: a real broken file in the real store. The entry
    //    must appear, the diagnostic must name the file count, and the original
    //    must stay on disk after another check.
    const brokenPath = join(handle.dataDir, 'run-checkpoints', 'broken-checkpoint.json')
    await mkdir(join(handle.dataDir, 'run-checkpoints'), { recursive: true })
    await writeFile(brokenPath, '{"version": 1, "id": "broken-fixture", "runId":\n', 'utf8')
    await reloadRenderer(handle.client, 'renderer reload before damaged-only discovery')
    const damaged = await waitForSurface(
      handle.client,
      (surface) => surface.trigger && surface.trigger.className.includes('damaged'),
      45_000,
      'damaged records entry',
    )
    recorder.note({ step: 'damaged-entry', surface: damaged, brokenFileExists: existsSync(brokenPath) })
    recorder.check(damaged.trigger.label.includes('恢复记录异常'), 'unreadable records are announced on their own entry', damaged.trigger)
    recorder.check(damaged.trigger.count === 1, 'the entry counts the unreadable records', damaged.trigger)
    recorder.check(!damaged.dialogOpen, 'unreadable records do not open a dialog by themselves', damaged)
    recorder.check(provider.requests.length === 0, 'unreadable records execute nothing', { requests: provider.requests.length })

    await click(handle.client, '.checkpoint-recovery-trigger')
    const opened = await waitForSurface(handle.client, (surface) => surface.dialogOpen, 20_000, 'recovery dialog for unreadable records')
    const checksBefore = (await readProbe(handle.client)).listRequests
    await click(handle.client, '.checkpoint-recovery-actions button')
    await delay(900)
    const rechecked = await readSurface(handle.client)
    const recheckProbe = await readProbe(handle.client)
    // Nothing readable appeared, so the surface goes back to its quiet entry; the
    // same dialog must still state the same single unreadable record.
    await click(handle.client, '.checkpoint-recovery-trigger')
    const reopened = await waitForSurface(handle.client, (surface) => surface.dialogOpen, 20_000, 'dialog reopened after a re-check')
    recorder.note({
      step: 'damaged-dialog',
      opened: { diagnostic: opened.dialogDiagnostic, empty: opened.dialogEmpty, error: opened.dialogError, footer: opened.footerButtons },
      rechecked: { diagnostic: rechecked.dialogDiagnostic, dialogOpen: rechecked.dialogOpen, trigger: rechecked.trigger },
      reopened: { diagnostic: reopened.dialogDiagnostic, empty: reopened.dialogEmpty, footer: reopened.footerButtons },
      probe: { listRequests: recheckProbe.listRequests },
      brokenFileExists: existsSync(brokenPath),
    })
    recorder.check(opened.dialogOpen === true, 'unreadable records open a dialog with the fact inside', opened)
    recorder.check(
      opened.dialogDiagnostic === '另有 1 份恢复记录无法读取；LS 已保留原文件并停止自动处理。',
      'the dialog states the unreadable count and that originals are preserved',
      opened.dialogDiagnostic,
    )
    recorder.check(opened.dialogError === null, 'unreadable records are not reported as a failed discovery', { error: opened.dialogError })
    recorder.check(existsSync(brokenPath), 'the unreadable original is preserved after a re-check', { brokenPath })
    recorder.check(recheckProbe.listRequests > checksBefore, 're-check asks the API again', { before: checksBefore, after: recheckProbe.listRequests })
    // One broken file is one unreadable record, however often the user checks again:
    // the counts used to accumulate per process, so one retry doubled the finding.
    recorder.check(
      rechecked.trigger?.count === 1,
      'a repeated check does not count the same unreadable record twice',
      { first: damaged.trigger.count, afterRecheck: rechecked.trigger?.count },
    )
    recorder.check(
      reopened.dialogDiagnostic === opened.dialogDiagnostic,
      'the wording stays the same across checks of an unchanged directory',
      { before: opened.dialogDiagnostic, after: reopened.dialogDiagnostic },
    )
    recorder.check(provider.requests.length === 0, 're-checking unreadable records executes nothing', { requests: provider.requests.length })

    // 4. Capture the real checkpoint: one real run the user stops while it is
    //    waiting for the model. A checkpoint taken at `execute` is what the other
    //    windows need - a continuation re-enters the main loop instead of the
    //    escalation stage that a run failing at `ask_user` would leave behind.
    if (reopened.dialogOpen) await click(handle.client, '.checkpoint-recovery-header button')
    await delay(400)
    const messagesBefore = await readSurface(handle.client)
    await startNewConversation(handle.client)
    // Hold the first model call so the run really is in flight when it is stopped.
    await provider.setDelay({ promptContains: CAPTURE_PROMPT, delayMs: 30_000 })
    const requestsBefore = provider.requests.length
    await submitComposer(handle.client, CAPTURE_PROMPT)
    await harness.waitFor(
      () => (provider.requests.length > requestsBefore ? true : undefined),
      30_000,
      'the capture run to reach the Provider',
    )
    const stopClicked = await click(handle.client, '.composer-run-actions .send-round.stop')
    await provider.setDelay({ promptContains: 'acceptance-clear-delay', delayMs: 0 })
    const captured = await harness.waitFor(async () => {
      const files = await listCheckpointFiles(handle.dataDir)
      const found = files.find((file) => file.checkpoint && file.checkpoint.resumeState && file.name !== 'broken-checkpoint.json')
      return found ?? undefined
    }, CAPTURE_TIMEOUT_MS, 'runtime-persisted checkpoint after an interrupted run')
    await harness.waitFor(
      () => readSurface(handle.client).then((surface) => (surface.runActive ? undefined : surface)),
      30_000,
      'interrupted run settled',
    )
    const settled = await readSurface(handle.client)
    const attempts = provider.requests.slice(requestsBefore)
    const sessionId = String(captured.checkpoint.sessionId)
    const transcript = await readSessionMessages(handle.dataDir, sessionId)
    const listing = await listCheckpoints(handle.locator)
    const listed = (listing.checkpoints ?? []).find((item) => item.id === captured.checkpoint.id)
    recorder.note({
      step: 'capture',
      checkpoint: {
        id: captured.checkpoint.id,
        name: captured.name,
        status: captured.checkpoint.status,
        currentStage: captured.checkpoint.currentStage,
        runtimeControl: captured.checkpoint.runtimeControl?.state ?? null,
        reason: captured.checkpoint.reason,
        sessionId: sessionId.slice(0, 8),
        workspace: captured.checkpoint.resumeState.cwd,
        model: captured.checkpoint.resumeState.model,
        sideEffects: (captured.checkpoint.sideEffects ?? []).map((effect) => effect.status),
        hash: captured.hash,
      },
      listed: listed ? { resumable: listed.resumable, blockers: listed.blockers, waitingForInput: listed.waitingForInput, status: listed.status } : null,
      stopClicked,
      attempts: attempts.length,
      transcriptLines: transcript.lines.length,
      runErrors: settled.runErrors,
      assistantTurnsBefore: messagesBefore.assistantTurns,
    })
    recorder.check(stopClicked === true, 'the capture run could be stopped from the composer', { stopClicked })
    recorder.check(Boolean(captured.checkpoint.resumeState), 'the interrupted run persisted a checkpoint with resumable state', captured.checkpoint.id)
    // A continuation re-enters the stage the checkpoint stopped at, so the capture
    // must not sit on a stage that can only ask the user or finish.
    recorder.check(
      ['enter', 'classify', 'reply', 'execute', 'recover', 'verify', 'decide'].includes(captured.checkpoint.currentStage),
      'the captured checkpoint resumes into the main loop, not an escalation stage',
      { currentStage: captured.checkpoint.currentStage, reason: captured.checkpoint.reason },
    )
    recorder.check(listed !== undefined, 'the captured checkpoint is listed by the startup discovery route', { id: captured.checkpoint.id })
    recorder.check(listed?.resumable === true, 'the captured checkpoint is resumable, without blockers', listed)
    recorder.check((listed?.blockers ?? []).length === 0, 'the captured checkpoint has no blockade', listed)
    capture = {
      name: captured.name,
      contents: await readFile(captured.path, 'utf8'),
      checkpoint: captured.checkpoint,
      sessionId,
      hash: captured.hash,
      workspace: captured.checkpoint.resumeState.cwd,
      transcriptTail: transcript.lines.slice(-3).map((line) => ({ role: line.role, text: (line.content ?? []).map((block) => block.text ?? '').join('').slice(0, 80) })),
      sessionTitle: (await readSessionIndex(handle.dataDir)).sessions?.find((session) => session.id === sessionId)?.title ?? null,
    }
  } catch (error) {
    recorder.check(false, 'window 1 completed without an unexpected failure', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await closeWindow(handle)
  }
  return { ...recorder.finish({ dataDir: handle.dataDir }), capture }
}

/**
 * Window 2 - the silent continuation that succeeds.
 *
 * Nothing is typed in this window. The only evidence that the work continued is
 * the Provider traffic and the reply that lands in the checkpoint's own session.
 */
async function windowAutoResumeSuccess({ root, provider, capture }) {
  const recorder = createRecorder('auto-resume-success')
  const { workspaceDir } = windowPaths(root, 'window-2')
  const handle = await openWindow({
    root,
    label: 'window-2',
    provider,
    seeds: [
      { kind: 'sessions', from: capture.sourceDataDir },
      { kind: 'checkpoint', name: capture.name, contents: relocateCheckpoint(capture.contents, workspaceDir) },
    ],
  })
  try {
    const requestsBefore = provider.requests.length
    const transcriptBefore = (await readSessionMessages(handle.dataDir, capture.sessionId)).lines.length
    await waitForReady(handle.locator)
    // The copied transcript's own run has no evidence in this data root, so the
    // history projection states one Runtime status row for it. Only rows added
    // after that point belong to the continuation under test.
    const runErrorsBefore = (await readSurface(handle.client)).runErrors
    const timeline = []
    let dialogEverOpened = false
    /** Whatever happened must still be recorded when the continuation never settles. */
    const recordFailure = async (step) => {
      const surface = await readSurface(handle.client).catch(() => null)
      const transcript = await readSessionMessages(handle.dataDir, capture.sessionId)
      const listing = await listCheckpoints(handle.locator).catch(() => null)
      recorder.note({
        step,
        timeline,
        dialogEverOpened,
        providerRequests: provider.requests.length - requestsBefore,
        surface,
        transcriptLines: transcript.lines.map((line) => ({
          role: line.role,
          text: (line.content ?? []).map((block) => block.text ?? '').join('').slice(0, 160),
        })),
        pending: (listing?.checkpoints ?? []).map((item) => ({ id: item.id.slice(0, 24), currentStage: item.currentStage, resumable: item.resumable, blockers: item.blockers })),
        dispositions: await listDispositions(handle.dataDir),
      })
    }
    let settled
    try {
      settled = await harness.waitFor(async () => {
        const surface = await readSurface(handle.client)
        if (surface.dialogOpen) dialogEverOpened = true
        const requests = provider.requests.length - requestsBefore
        const changed = requests > 0 || surface.runActive || surface.trigger !== null
        if (changed) {
          const last = timeline.at(-1)
          const signature = `${surface.trigger?.className ?? 'none'}|${surface.runActive}|${requests}`
          if (!last || last.signature !== signature) {
            timeline.push({ signature, ms: Date.now(), trigger: surface.trigger?.label ?? null, runActive: surface.runActive, providerRequests: requests, dialogOpen: surface.dialogOpen })
          }
        }
        const transcript = await readSessionMessages(handle.dataDir, capture.sessionId)
        const continued = transcript.lines.length > transcriptBefore
        return continued && !surface.runActive && requests > 0 ? { surface, transcript, requests } : undefined
      }, RESUME_TIMEOUT_MS, 'silent continuation to finish')
    } catch (error) {
      await recordFailure('silent-continuation-timeout')
      throw error
    }
    const listing = await listCheckpoints(handle.locator)
    const finalSurface = await waitForSurface(handle.client, (surface) => surface.trigger === null, 20_000, 'recovery entry to clear after a successful continuation')
    const transcript = await readSessionMessages(handle.dataDir, capture.sessionId)
    const appended = transcript.lines.slice(transcriptBefore)
    const appendedText = appended.map((line) => ({
      role: line.role,
      text: (line.content ?? []).map((block) => block.text ?? '').join(''),
    }))
    recorder.note({
      step: 'silent-continuation',
      timeline,
      dialogEverOpened,
      providerRequests: settled.requests,
      entryAfter: finalSurface.trigger,
      activeSessionTitle: finalSurface.activeSessionTitle,
      expectedSessionTitle: capture.sessionTitle,
      appendedLines: appendedText.map((line) => ({ role: line.role, text: line.text.slice(0, 120) })),
      originalUserTurnKept: transcript.lines.some((line) => line.role === 'user' && (line.content ?? []).some((block) => (block.text ?? '').includes('工作区里的文件'))),
      pendingAfter: (listing.checkpoints ?? []).map((item) => ({ id: item.id.slice(0, 24), disposition: item.disposition?.status ?? null })),
      turnsBefore: runErrorsBefore.turns,
      turnsAfter: finalSurface.turns,
    })
    recorder.check(!dialogEverOpened, 'a successful silent continuation never opens the recovery dialog', { timeline })
    recorder.check(settled.requests > 0, 'the continuation really called the model without any user input', { requests: settled.requests })
    recorder.check(
      appendedText.some((line) => line.role === 'assistant' && line.text.trim().length > 0),
      'the continuation published a reply into the checkpoint session',
      { appended: appendedText.map((line) => line.role) },
    )
    recorder.check(
      transcript.lines.some((line) => line.role === 'user' && (line.content ?? []).some((block) => (block.text ?? '').includes('工作区里的文件'))),
      'the continued transcript still holds the turn the checkpoint came from',
      { lines: transcript.lines.length },
    )
    const addedErrors = finalSurface.runErrors.filter((text) => !runErrorsBefore.runErrors.includes(text))
    const realTurns = finalSurface.turns.filter((turn) => !String(turn.key ?? '').endsWith(':runtime-status'))
    const continuationTurn = realTurns.at(-1) ?? null
    recorder.check(
      Boolean(continuationTurn) && continuationTurn.error === null && continuationTurn.state === 'settled',
      'the continuation turn itself is settled and carries no Runtime failure',
      { turn: continuationTurn, turnsBefore: runErrorsBefore.turns },
    )
    recorder.check(addedErrors.length === 0, 'the silent continuation settled without adding a Runtime failure of its own', { addedErrors, runErrorsBefore })
    recorder.check(finalSurface.activeSessionTitle === capture.sessionTitle, 'the continuation belongs to the session it came from', { active: finalSurface.activeSessionTitle, expected: capture.sessionTitle })
    recorder.check((listing.checkpoints ?? []).length === 0, 'a finished continuation leaves nothing pending', { pending: listing.checkpoints ?? [] })
    recorder.check(finalSurface.trigger === null, 'the quiet entry disappears once the continuation settles', finalSurface.trigger)
  } catch (error) {
    recorder.check(false, 'window 2 completed without an unexpected failure', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await closeWindow(handle)
  }
  return recorder.finish({ dataDir: handle.dataDir })
}

/**
 * Window 3 - the silent continuation that fails.
 *
 * The Provider is unreachable from the first moment, so the continuation the
 * runtime starts on its own cannot finish. The failure has to be discoverable
 * without opening the dialog, the chat has to keep working, and nothing settled
 * may be executed twice.
 */
async function windowAutoResumeFailure({ root, provider, capture }) {
  const recorder = createRecorder('auto-resume-failure')
  const { workspaceDir } = windowPaths(root, 'window-3')
  const seededContents = relocateCheckpoint(capture.contents, workspaceDir)
  const seededHash = sha256(seededContents)
  const handle = await openWindow({
    root,
    label: 'window-3',
    provider,
    seeds: [
      { kind: 'sessions', from: capture.sourceDataDir },
      { kind: 'checkpoint', name: capture.name, contents: seededContents },
    ],
  })
  try {
    await provider.setFaults(TRANSPORT_FAULTS)
    const requestsBefore = provider.requests.length
    await waitForReady(handle.locator)
    const observable = await waitForSurface(
      handle.client,
      (surface) => surface.trigger !== null && !surface.runActive && surface.trigger.className.includes('pending'),
      90_000,
      'failed automatic continuation to leave a discoverable entry',
    )
    const filesAfterFailure = await listCheckpointFiles(handle.dataDir)
    const requestsAfterFailure = provider.requests.length - requestsBefore
    await delay(4_000)
    const filesAfterSettle = await listCheckpointFiles(handle.dataDir)
    const requestsAfterSettle = provider.requests.length - requestsBefore
    const listing = await listCheckpoints(handle.locator)
    const sourceAfter = filesAfterSettle.find((file) => file.name === capture.name)
    const dispositions = await listDispositions(handle.dataDir)
    const sourceDisposition = dispositions.find((item) => item.checkpointId === capture.checkpoint.id) ?? null
    recorder.note({
      step: 'failed-continuation',
      entry: observable.trigger,
      dialogOpen: observable.dialogOpen,
      providerRequests: requestsAfterFailure,
      providerRequestsAfterSettle: requestsAfterSettle,
      checkpointFiles: filesAfterFailure.length,
      checkpointFilesAfterSettle: filesAfterSettle.length,
      sourceCheckpointUnchanged: sourceAfter?.hash === capture.hash,
      sourceDisposition,
      dispositions: dispositions.length,
      pending: (listing.checkpoints ?? []).map((item) => ({
        id: item.id.slice(0, 24),
        status: item.status,
        currentStage: item.currentStage,
        resumable: item.resumable,
        disposition: item.disposition?.status ?? null,
        sourceRunId: item.sourceRunId.slice(0, 24),
      })),
      sourceRunId: String(capture.checkpoint.runId).slice(0, 24),
    })
    recorder.check(observable.trigger.label.includes('待恢复任务'), 'a failed automatic continuation leaves a discoverable entry', observable.trigger)
    recorder.check(!observable.dialogOpen, 'the failed continuation does not force the dialog open', observable)
    recorder.check(requestsAfterFailure >= 2, 'the failing continuation really reached the Provider', { requests: requestsAfterFailure })
    recorder.check(requestsAfterSettle === requestsAfterFailure, 'a failed continuation is not retried on its own', { after: requestsAfterFailure, later: requestsAfterSettle })
    recorder.check(filesAfterSettle.length === filesAfterFailure.length, 'a failed continuation writes no further checkpoints while it waits for the user', { first: filesAfterFailure.length, later: filesAfterSettle.length })
    recorder.check(sourceAfter?.hash === seededHash, 'the source checkpoint file is not rewritten by a failed attempt', { before: seededHash, after: sourceAfter?.hash })
    // A continuation that fails leaves its own runtime state behind and marks the
    // checkpoint it consumed: the failure is what the user is offered next.
    recorder.check(
      sourceDisposition?.status === 'resumed',
      'the consumed checkpoint records that its continuation was attempted',
      { sourceDisposition },
    )
    recorder.check(
      sourceDisposition?.resultStatus === 'error',
      'the failed attempt is recorded with its result, not silently dropped',
      { sourceDisposition },
    )
    recorder.check(
      (listing.checkpoints ?? []).length === 1 && listing.checkpoints[0]?.id !== capture.checkpoint.id,
      'the failed continuation offers its own runtime state for the next attempt',
      { pending: listing.checkpoints ?? [] },
    )
    recorder.check(
      (listing.checkpoints ?? []).every((item) => item.resumable === true),
      'what the failed continuation leaves behind can be continued',
      { pending: listing.checkpoints ?? [] },
    )
    recorder.check(dispositions.length >= 1, 'the disposition store recorded the attempt durably', { dispositions: dispositions.length })

    // The failure has to be readable inside the surface, and the chat has to keep
    // working: a normal message sent after the failure must be answered.
    await click(handle.client, '.checkpoint-recovery-trigger')
    const dialog = await waitForSurface(handle.client, (surface) => surface.dialogOpen, 20_000, 'recovery dialog after a failed continuation')
    const resumeCallsBefore = (await readProbe(handle.client)).resumeRequests
    await click(handle.client, '.checkpoint-recovery-header button')
    await waitForSurface(handle.client, (surface) => !surface.dialogOpen, 20_000, 'recovery dialog to close before chatting')
    await provider.setFaults(null)
    const chatTranscriptBefore = (await readSessionMessages(handle.dataDir, capture.sessionId)).lines.length
    const attemptsBeforeChat = provider.requests.length
    const chatRunErrorsBefore = (await readSurface(handle.client)).runErrors
    await submitComposer(handle.client, '恢复失败之后，这条普通消息还能收到回答吗？')
    let chat
    try {
      chat = await harness.waitFor(async () => {
        const surface = await readSurface(handle.client)
        if (surface.runActive) return undefined
        const transcript = await readSessionMessages(handle.dataDir, capture.sessionId)
        return transcript.lines.length > chatTranscriptBefore ? { surface, transcript } : undefined
      }, RESUME_TIMEOUT_MS, 'a normal message to be answered after a failed continuation')
    } catch (error) {
      recorder.note({
        step: 'chat-timeout',
        surface: await readSurface(handle.client).catch(() => null),
        providerRequests: provider.requests.length - attemptsBeforeChat,
        providerLog: provider.requests.slice(attemptsBeforeChat).map((request) => ({
          fault: request.fault ? `${request.fault.kind}:${request.fault.status ?? ''}` : 'none',
          tools: request.tools.length,
          lastUser: request.messages.at(-1)?.content?.slice(0, 80) ?? null,
        })),
        transcriptLines: (await readSessionMessages(handle.dataDir, capture.sessionId)).lines.map((line) => ({
          role: line.role,
          text: (line.content ?? []).map((block) => block.text ?? '').join('').slice(0, 160),
        })),
        pending: (await listCheckpoints(handle.locator).catch(() => null))?.checkpoints ?? [],
      })
      throw error
    }
    const chatAppended = chat.transcript.lines.slice(chatTranscriptBefore).map((line) => ({
      role: line.role,
      text: (line.content ?? []).map((block) => block.text ?? '').join(''),
    }))
    recorder.note({
      step: 'failure-surface-and-chat',
      dialogError: dialog.dialogError,
      dialogStateLine: dialog.stateLine,
      dialogListCount: dialog.listCount,
      dialogFooter: dialog.footerButtons,
      resumeCallsBefore: resumeCallsBefore,
      chatProviderRequests: provider.requests.length - attemptsBeforeChat,
      chatAppended: chatAppended.map((line) => ({ role: line.role, text: line.text.slice(0, 120) })),
      chatRunErrorsBefore,
      chatRunErrorsAfter: chat.surface.runErrors,
      chatActiveSessionTitle: chat.surface.activeSessionTitle,
      expectedSessionTitle: capture.sessionTitle,
    })
    // With one pending checkpoint the dialog shows that checkpoint instead of a
    // list, so the failure is read from its own state line and the error slot.
    recorder.check(
      (typeof dialog.dialogError === 'string' && dialog.dialogError.length > 0)
      || (typeof dialog.stateLine === 'string' && dialog.stateLine.length > 0),
      'the surface states the state of the work it could not continue',
      { error: dialog.dialogError, stateLine: dialog.stateLine },
    )
    recorder.check(
      sourceDisposition?.resumeAttempts === 1,
      'the failed continuation claimed the checkpoint exactly once before the user is asked',
      { sourceDisposition },
    )
    recorder.check(
      chatAppended.some((line) => line.role === 'assistant' && line.text.trim().length > 0),
      'the chat answers a normal message after a failed continuation',
      { appended: chatAppended.map((line) => line.role) },
    )
    const chatAddedErrors = chat.surface.runErrors.filter((text) => !chatRunErrorsBefore.includes(text))
    recorder.check(
      chatAddedErrors.length === 0,
      'the answering run is an ordinary run, not another failure',
      { addedErrors: chatAddedErrors, before: chatRunErrorsBefore },
    )
    recorder.check(chat.surface.activeSessionTitle === capture.sessionTitle, 'the answering run stayed in the same session', { active: chat.surface.activeSessionTitle })
  } catch (error) {
    recorder.check(false, 'window 3 completed without an unexpected failure', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await provider.setFaults(null)
    await closeWindow(handle)
  }
  return recorder.finish({ dataDir: handle.dataDir })
}

/**
 * Window 4 - a checkpoint that waits for the user.
 *
 * The fixture is the captured real file with the legacy `waiting_user` status and
 * its continuation identity restored, because the current runtime never writes
 * that status. Everything else - the entry, the answer box, the refusal to resume
 * without an answer, the continuation itself - is the product's own behaviour.
 */
async function windowWaitingInput({ root, provider, capture }) {
  const recorder = createRecorder('waiting-input')
  const waiting = JSON.parse(capture.contents)
  waiting.status = 'waiting_user'
  delete waiting.resumeState.lastError
  const clarification = {
    id: `${capture.checkpoint.runId}:clarification`,
    kind: 'recovery_decision',
    sourceStage: 'execute',
    createdAt: new Date().toISOString(),
    originalRequest: CAPTURE_PROMPT,
    copySource: 'runtime_fallback',
    blockingReason: 'execute: 夹具模拟一次等待补充信息的执行现场',
    questions: [{
      id: 'question-1',
      field: 'recoveryDecision',
      prompt: '你希望我接下来如何处理？',
      required: true,
    }],
  }
  waiting.resumeState.continuation = {
    version: 1,
    requestId: clarification.id,
    sourceStage: clarification.sourceStage,
  }
  const handle = await openWindow({
    root,
    label: 'window-4',
    provider,
    useProbe: true,
    seeds: [
      { kind: 'sessions', from: capture.sourceDataDir },
      { kind: 'checkpoint', name: capture.name, contents: relocateCheckpoint(`${JSON.stringify(waiting, null, 2)}\n`, windowPaths(root, 'window-4').workspaceDir) },
    ],
  })
  try {
    // The continuation of a waiting checkpoint resolves its entry stage from the
    // question it answered, and the runner reads that back out of the session.
    await appendClarificationMessage(handle.dataDir, capture.sessionId, clarification)
    await waitForReady(handle.locator)
    // The probe only exists in documents created after it was installed, so the
    // renderer is reloaded once and discovery runs again with it in place.
    await setProbeMode(handle.client, 'pass')
    await reloadRenderer(handle.client, 'renderer reload with the recovery probe')
    const entry = await waitForSurface(
      handle.client,
      (surface) => surface.trigger && surface.trigger.className.includes('waiting-input'),
      45_000,
      'waiting-for-input entry',
    )
    const baselineRequests = provider.requests.length
    const runErrorsBefore = entry.runErrors
    await delay(3_000)
    const idleRequests = provider.requests.length
    recorder.note({ step: 'waiting-entry', surface: entry, baselineRequests, idleRequests, runErrorsBefore })
    recorder.check(entry.trigger.label.includes('待补充信息'), 'a checkpoint waiting for the user has its own entry', entry.trigger)
    recorder.check(entry.trigger.count === 1, 'the waiting entry counts the waiting task', entry.trigger)
    recorder.check(!entry.dialogOpen, 'a waiting task is not resumed and does not open a dialog by itself', entry)
    recorder.check(idleRequests === baselineRequests, 'a waiting task is not executed silently', { baselineRequests, idleRequests })

    await click(handle.client, '.checkpoint-recovery-trigger')
    const dialog = await waitForSurface(handle.client, (surface) => surface.dialogOpen && surface.answerPresent, 20_000, 'waiting dialog with the answer box')
    recorder.note({
      step: 'waiting-dialog',
      answerPresent: dialog.answerPresent,
      answerFocused: dialog.answerFocused,
      resumeDisabled: dialog.resumeDisabled,
      stateLine: dialog.stateLine,
      blockers: dialog.blockers,
      listCount: dialog.listCount,
    })
    recorder.check(dialog.answerPresent === true, 'the waiting task asks for the missing information in the dialog', dialog)
    recorder.check(dialog.answerFocused === true, 'the answer box takes the focus', dialog)
    recorder.check(dialog.resumeDisabled === false, 'a waiting task can be continued once answered', dialog)

    // Continuing without an answer must be refused before any request is made.
    const probeBeforeEmpty = await readProbe(handle.client)
    await click(handle.client, '.checkpoint-recovery-actions button.primary')
    await delay(900)
    const refused = await readSurface(handle.client)
    const probeAfterEmpty = await readProbe(handle.client)
    recorder.note({
      step: 'waiting-refusal',
      error: refused.dialogError,
      dialogOpen: refused.dialogOpen,
      resumeRequests: probeAfterEmpty.resumeRequests,
      listRequests: probeAfterEmpty.listRequests - probeBeforeEmpty.listRequests,
      providerRequests: provider.requests.length - baselineRequests,
    })
    recorder.check(
      refused.dialogError === '这个任务正在等待补充信息，请填写后再继续。',
      'continuing an unanswered task states what is missing instead of starting a run',
      { error: refused.dialogError },
    )
    recorder.check(probeAfterEmpty.resumeRequests === probeBeforeEmpty.resumeRequests, 'the refusal makes no resume request', probeAfterEmpty)
    recorder.check(provider.requests.length === baselineRequests, 'the refusal executes nothing', { requests: provider.requests.length - baselineRequests })

    // Answering it continues the real task in the checkpoint's own session.
    const transcriptBefore = (await readSessionMessages(handle.dataDir, capture.sessionId)).lines.length
    const typed = await typeInto(handle.client, '.checkpoint-recovery-answer textarea', ANSWER_TEXT)
    await click(handle.client, '.checkpoint-recovery-actions button.primary')
    const continued = await harness.waitFor(async () => {
      const surface = await readSurface(handle.client)
      if (surface.runActive || surface.dialogOpen) return undefined
      const transcript = await readSessionMessages(handle.dataDir, capture.sessionId)
      const answered = transcript.lines.some((line) => line.role === 'user' && (line.content ?? []).some((block) => (block.text ?? '').includes('忽略隐藏目录')))
      const replied = transcript.lines.length > transcriptBefore && transcript.lines.some((line) => line.role === 'assistant')
      return answered && replied ? { surface, transcript } : undefined
    }, RESUME_TIMEOUT_MS, 'answered continuation to finish').catch(async (error) => {
      recorder.note({
        step: 'waiting-continued-timeout',
        surface: await readSurface(handle.client).catch(() => null),
        probe: await readProbe(handle.client).catch(() => null),
        providerRequests: provider.requests.length - baselineRequests,
        transcriptLines: (await readSessionMessages(handle.dataDir, capture.sessionId)).lines.map((line) => ({
          role: line.role,
          text: (line.content ?? []).map((block) => block.text ?? '').join('').slice(0, 160),
        })),
        pending: (await listCheckpoints(handle.locator).catch(() => null))?.checkpoints ?? [],
        dispositions: await listDispositions(handle.dataDir),
      })
      throw error
    })
    const probeAfterAnswer = await readProbe(handle.client)
    const appended = continued.transcript.lines.slice(transcriptBefore)
    const answeredDisposition = (await listDispositions(handle.dataDir)).find((item) => item.checkpointId === capture.checkpoint.id) ?? null
    recorder.note({
      step: 'waiting-continued',
      typed,
      clarificationMessageId: clarification.id,
      resumeRequests: probeAfterAnswer.resumeRequests,
      resumeBodies: probeAfterAnswer.resumeBodies,
      providerRequests: provider.requests.length - baselineRequests,
      dialogOpen: continued.surface.dialogOpen,
      trigger: continued.surface.trigger,
      activeSessionTitle: continued.surface.activeSessionTitle,
      expectedSessionTitle: capture.sessionTitle,
      disposition: answeredDisposition,
      runErrorsBefore,
      runErrorsAfter: continued.surface.runErrors,
      appendedLines: appended.map((line) => ({ role: line.role, text: (line.content ?? []).map((block) => block.text ?? '').join('').slice(0, 120) })),
    })
    recorder.check(typed === true, 'the answer can be typed into the dialog', { typed })
    recorder.check(probeAfterAnswer.resumeRequests === 1, 'answering resumes the task exactly once', probeAfterAnswer)
    recorder.check(
      probeAfterAnswer.resumeBodies.some((body) => body.includes('忽略隐藏目录') && body.includes('"continuationDirective":"answer"')),
      'the answer is sent as the explicit recovery answer, not as an ordinary message',
      { bodies: probeAfterAnswer.resumeBodies },
    )
    recorder.check(appended.some((line) => line.role === 'user' && (line.content ?? []).some((block) => (block.text ?? '').includes('忽略隐藏目录'))), 'the answer is recorded in the checkpoint session', { appended: appended.length })
    recorder.check(
      appended.some((line) => line.role === 'assistant' && (line.content ?? []).some((block) => (block.text ?? '').trim().length > 0)),
      'the continued task published a reply',
      { appended: appended.map((line) => line.role) },
    )
    recorder.check(continued.surface.dialogOpen === false, 'the dialog closes once the waiting task is continued', continued.surface)
    recorder.check(continued.surface.activeSessionTitle === capture.sessionTitle, 'the continued task stays in its own session', { active: continued.surface.activeSessionTitle })
    recorder.check(continued.surface.trigger === null, 'nothing is left pending after the waiting task is continued', continued.surface.trigger)
    const waitingAddedErrors = continued.surface.runErrors.filter((text) => !runErrorsBefore.includes(text))
    recorder.check(
      waitingAddedErrors.length === 0,
      'the answered continuation settled without adding a Runtime failure of its own',
      { addedErrors: waitingAddedErrors, runErrorsBefore },
    )
  } catch (error) {
    recorder.check(false, 'window 4 completed without an unexpected failure', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    await closeWindow(handle)
  }
  return recorder.finish({ dataDir: handle.dataDir })
}

async function main() {
  await harness.assertBuildFresh()
  const requested = readOption('windows', '1,2,3,4').split(',').map((value) => value.trim()).filter(Boolean)
  const keep = process.argv.includes('--keep')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-recovery-states-'))
  const evidence = {
    check: 'recovery-states',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    injectedResponses: [
      'GET /run-checkpoints answered with HTTP 500 by the page fetch probe (discovery-failure class only)',
      'the acceptance Provider holds and then fails every model request (the failing automatic continuation; it never reaches a real model)',
    ],
    windows: {},
    failures: [],
    limits: [
      'The waiting-for-input class uses the captured real checkpoint rewritten into the legacy waiting_user shape plus the matching clarification message in its session, because the current runtime never writes that status: a run no longer parks itself on a question.',
      'The automatic-continuation classes continue a checkpoint the product wrote when a fixture run was stopped mid-answer; the workspace recorded in it is the fixture workspace under the temporary root, never a real one.',
      'Only the discovery-failure class injects an HTTP response, and only the failing-continuation class injects Provider faults. The unreadable-record class is a real broken file in the real store, and every continuation is executed by the real runner.',
      'The capture run is stopped by the fixture while it waits for its first model answer, so the checkpoint proves the interruption path, not any particular task shape.',
    ],
  }
  try {
    if (!requested.includes('1')) throw new Error('window 1 is required: windows 2-4 continue the checkpoint it captures')
    const first = await windowDiscoveryAndCapture({ root, provider })
    const capture = first.capture
    evidence.windows.discoveryAndCapture = { ...first, capture: undefined }
    evidence.capture = capture
      ? {
        id: capture.checkpoint.id,
        status: capture.checkpoint.status,
        currentStage: capture.checkpoint.currentStage,
        sessionId: capture.sessionId.slice(0, 8),
        name: capture.name,
        hash: capture.hash,
        workspaceLabel: '<fixture workspace>',
        sessionTitle: capture.sessionTitle,
      }
      : null
    if (!capture) throw new Error('no real checkpoint was captured, so the continuation classes cannot run')
    const seeded = { ...capture, sourceDataDir: first.dataDir }
    if (requested.includes('2')) evidence.windows.autoResumeSuccess = await windowAutoResumeSuccess({ root, provider, capture: seeded })
    if (requested.includes('3')) evidence.windows.autoResumeFailure = await windowAutoResumeFailure({ root, provider, capture: seeded })
    if (requested.includes('4')) evidence.windows.waitingInput = await windowWaitingInput({ root, provider, capture: seeded })
  } catch (error) {
    evidence.ok = false
    evidence.error = error instanceof Error ? error.message : String(error)
  } finally {
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }
  for (const value of Object.values(evidence.windows)) {
    for (const failure of value.failures ?? []) evidence.failures.push(failure)
  }
  evidence.ok = evidence.failures.length === 0 && evidence.error === undefined
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
