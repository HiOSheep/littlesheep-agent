// Real-window acceptance for bounded transport retries (taskbook UX-21).
//
// The policy layer is unit-tested in `packages/llm/src/retry.test.ts` and the progress wording
// in `packages/harness/src/model-observability.test.ts`. What only the real product path can
// show is whether a user actually sees it: the retry wording is published on the request's own
// activity line and is replaced in place when the request settles, so it exists only *while*
// the retry is happening. A fixture therefore has to sample the DOM during the failure window.
//
// The Provider is told to fail on purpose (`/control` faults). The acceptance build shortens
// only the backoff wait (LITTLESHEEP_ACCEPTANCE_RETRY_BASE_DELAY_MS), never the retry budget.
//
// Cases:
//   A. 503 twice, then success  → the run continues, "第 1/2 次重试 / 最多 5 次" is visible
//   B. 429 with Retry-After     → one retry, the wording names the status
//   C. 401                      → never retried, the failure is visible and the run stops
//   D. 503 six times            → first request + exactly 5 retries, then a visible failure
//   E. stream cut mid-answer    → one retry, and the answer is complete exactly once
//
// Usage:
//   node scripts/verify-transport-retry-feedback.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider, LONG_MARKDOWN_END, LONG_MARKDOWN_MARKER, LONG_MARKDOWN_START } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-retry-feedback')))
const keepRoot = process.argv.includes('--keep')
const EVALUATE_TIMEOUT_MS = 5_000
const PROMPT = '请简短确认收到这条重试验收消息。'
/**
 * The acceptance Provider answers either with the tool-loop sentence or the continuity
 * sentence depending on whether the run still has a tool result to consume; both carry this
 * marker, so it is the stable "the run produced a real answer" signal.
 */
const ANSWER_MARKER = 'runtime-continuity-anchor-4827'

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

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Electron Acceptance', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 5, models: ['slow-a'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/slow-a',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        // The schema requires at least one recovery attempt; the exhaustion case therefore
        // injects more faults than the whole run can consume instead of removing recovery.
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 32,
      },
    },
  }
}

/** One sample of what the user can currently see in the newest assistant turn. */
const OBSERVE_EXPRESSION = `(() => {
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
  if (!turn) return null
  const response = turn.querySelector('.assistant-response-stream')
  const stages = [...turn.querySelectorAll('.agent-active-stage-row .agent-flow-summary')]
  return {
    state: response?.getAttribute('data-stream-state') ?? null,
    text: response?.textContent ?? '',
    activeStage: stages.at(-1)?.textContent ?? null,
    error: turn.querySelector('.run-status-error')?.textContent ?? null,
  }
})()`

async function startNewConversation(client) {
  const started = await evaluate(client, `(() => {
    const button = document.querySelector('.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`)
  if (!started) throw new Error('could not start a new conversation')
  await harness.waitFor(
    () => evaluate(client, `document.querySelectorAll('.assistant-turn').length === 0 || null`),
    harness.startTimeoutMs,
    'empty transcript',
  )
}

async function submitPrompt(client, prompt = PROMPT) {
  const submitted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, ${JSON.stringify(prompt)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('could not submit the composer')
}

/**
 * Run one injected-fault case and observe the user-visible states while it happens.
 * Sampling is what makes the retry wording observable at all: it is published on the request's
 * own activity line and replaced in place when that request settles.
 *
 * A run can make more than one logical model request (the loop calls the model again after a
 * tool result), so a case is judged by the *fault log* plus the retry wording, never by the
 * raw request count alone.
 */
async function runCase({ client, provider, name, prompt = PROMPT, faults, timeoutMs = 45_000 }) {
  await startNewConversation(client)
  await provider.setFaults(faults)
  const before = provider.requests.length
  await submitPrompt(client, prompt)

  const timeline = []
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeoutMs) {
    const sample = await evaluate(client, OBSERVE_EXPRESSION)
    if (sample && (sample.state || sample.error)) {
      if (sample.activeStage !== last?.activeStage || sample.state !== last?.state || sample.error !== last?.error) {
        timeline.push({ ms: Date.now() - startedAt, state: sample.state, activeStage: sample.activeStage, error: sample.error })
      }
      last = sample
      // The turn is finished when the stream settled *or* a Runtime error row replaced it.
      if (sample.state === 'settled' || sample.error) break
    }
    await delay(30)
  }
  const attempts = provider.requests.slice(before)
  const faultLog = attempts.map((request) => request.fault
    ? `${request.fault.kind}:${request.fault.status ?? request.fault.afterChunks ?? ''}`
    : 'none')
  return {
    name,
    attempts: attempts.length,
    faultLog,
    /** Faults consumed by the leading run of failures, i.e. the first logical request. */
    leadingFailures: faultLog.findIndex((entry) => entry === 'none') === -1
      ? faultLog.length
      : faultLog.findIndex((entry) => entry === 'none'),
    retryWording: timeline.map((entry) => entry.activeStage).filter((value) => typeof value === 'string' && value.includes('次重试')),
    answer: last?.text ?? '',
    settled: last?.state === 'settled',
    error: last?.error ?? null,
    timeline,
  }
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-retry-feedback-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 20, streamChunkCharacters: 40 })
  let electron
  let client
  let preserve = false

  try {
    await mkdir(outRoot, { recursive: true })
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      // Shorten only the wait between attempts; the budget itself stays the product's.
      extraEnv: { LITTLESHEEP_ACCEPTANCE_RETRY_BASE_DELAY_MS: '60' },
    })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', { width: 1024, height: 640 })
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    const cases = []
    cases.push(await runCase({
      client, provider, name: 'transient-two-then-success',
      faults: [{ kind: 'status', status: 503, times: 2 }],
    }))
    cases.push(await runCase({
      client, provider, name: 'rate-limit-hint',
      faults: [{ kind: 'status', status: 429, times: 1, retryAfterSeconds: 1 }],
    }))
    cases.push(await runCase({
      client, provider, name: 'auth-not-retryable',
      // Every attempt fails: a 401 must never be replayed by the transport, and the run has
      // to end visibly instead of pretending the answer arrived.
      faults: [{ kind: 'status', status: 401, times: 8 }],
      timeoutMs: 30_000,
    }))
    cases.push(await runCase({
      client, provider, name: 'exhausted-budget',
      // More faults than the run can consume: every attempt fails, so the run has to end in a
      // visible failure instead of recovering on a later logical request.
      faults: [{ kind: 'status', status: 503, times: 40 }],
      timeoutMs: 90_000,
    }))
    cases.push(await runCase({
      client, provider, name: 'stream-cut-mid-answer',
      prompt: `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`,
      faults: [{ kind: 'stream_break', afterChunks: 5, times: 1 }],
    }))

    const [transient, rateLimit, auth, exhausted, streamCut] = cases
    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }

    // A. two transient failures then success: first request + 2 retries = 3 attempts for the
    // first logical call, the run continues, and both retries were visible.
    expect(transient.leadingFailures === 2, `503×2 must be retried twice, saw ${transient.leadingFailures} leading failures`)
    expect(transient.settled && transient.answer.includes(ANSWER_MARKER), 'the run did not continue after two transient failures')
    expect(transient.retryWording.some((value) => value.includes('第 1 次重试')), 'the first retry was never shown')
    expect(transient.retryWording.some((value) => value.includes('第 2 次重试')), 'the second retry was never shown')
    expect(transient.retryWording.every((value) => value.includes('最多 5 次')), 'the retry wording omitted the budget')

    // B. a rate limit with a Provider hint is retried once and the status is named.
    expect(rateLimit.leadingFailures === 1, `429 must be retried once, saw ${rateLimit.leadingFailures}`)
    expect(rateLimit.retryWording.some((value) => value.includes('429')), 'the retry wording did not name the rate limit status')
    expect(rateLimit.settled && rateLimit.answer.includes(ANSWER_MARKER), 'the run did not continue after a rate limit')

    // C. 401 is never replayed by the transport, and the failure is visible rather than a
    // fabricated answer. (The run may still settle its turn — it publishes the Runtime error
    // as the turn's statement, which is the intended behaviour.)
    expect(auth.attempts >= 1, 'the auth case never reached the Provider')
    expect(auth.retryWording.length === 0, `401 produced retry wording: ${JSON.stringify(auth.retryWording)}`)
    expect(typeof auth.error === 'string' && auth.error.length > 0, 'an unretryable failure left no visible reason')
    expect(!auth.answer.includes(ANSWER_MARKER), 'an unretryable failure still produced a successful answer')

    // D. exhausting the budget: the first request plus exactly five retries, then failure with
    // a visible reason. The retry wording restarts at 1 for the next logical request, so the
    // ceiling is proven by "1..5 and never 6", not by the raw attempt count.
    const firstCallRetries = exhausted.retryWording.slice(0, 5).map((value) => /第 (\d) 次重试/u.exec(value)?.[1])
    expect(firstCallRetries.join('') === '12345', `the first call's retry sequence was ${JSON.stringify(firstCallRetries)}`)
    expect(!exhausted.retryWording.some((value) => /第 [6-9] 次重试/u.test(value)), 'a sixth retry was attempted')
    expect(typeof exhausted.error === 'string' && exhausted.error.length > 0, 'exhausting the budget left no visible reason')
    expect(!exhausted.answer.includes(ANSWER_MARKER), 'the exhausted run still produced a successful answer')

    // E. a stream cut mid-answer is detected (the Provider never signalled completion),
    // replayed, and the answer survives exactly once.
    expect(streamCut.faultLog[0] === 'stream_break:5', `the stream cut was not the first fault: ${JSON.stringify(streamCut.faultLog)}`)
    expect(streamCut.retryWording.some((value) => value.includes('第 1 次重试')), 'a cut stream was not retried')
    expect(streamCut.settled, 'the run did not recover from a mid-answer stream cut')
    expect(streamCut.answer.includes(LONG_MARKDOWN_START) && streamCut.answer.includes(LONG_MARKDOWN_END),
      'the recovered answer is missing its sentinels, so it is not a complete settlement')
    const answerOccurrences = streamCut.answer.split(LONG_MARKDOWN_START).length - 1
    expect(answerOccurrences === 1, `the retried answer was not exactly one settlement (found ${answerOccurrences})`)

    const evidence = { cases, failures }
    if (failures.length > 0) {
      throw new Error(`transport retry acceptance failed: ${JSON.stringify(evidence)}`)
    }
    console.log(JSON.stringify({ check: 'transport-retry-feedback', ok: true, evidence }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'transport-retry-feedback',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    if (!preserve && !keepRoot) await harness.removeTemporaryRoot(root)
  }
}

await main()
