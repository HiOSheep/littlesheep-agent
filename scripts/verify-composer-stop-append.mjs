// Real-window acceptance for stopping a run while composing the next message (taskbook UX-03).
//
// UX-03 was the report that a draft in the composer replaced the stop control with send, so the
// user had to clear their text to stop. The contract now is:
//
//   - stop and the append/send entry coexist while a run is in flight;
//   - stopping keeps the draft and its attachments;
//   - one click stops once (a repeated click must not queue a second interrupt);
//   - "正在停止" stays visible until the run actually settles;
//   - appending a message while the run continues submits it once, even if the control is
//     clicked twice in the same task (the identity is what Main deduplicates on).
//
// The fixture drives a deliberately slow stream so both actions can be taken mid-run, and counts
// the runtime-event requests the renderer actually issues through a `fetch` probe.
//
// Usage:
//   node scripts/verify-composer-stop-append.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  LONG_MARKDOWN_MARKER,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-composer-stop-append')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1100, height: 720 }
const EVALUATE_TIMEOUT_MS = 15_000
const DRAFT_TEXT = '停止后的补充草稿'
const APPEND_TEXT = '运行中的补充验收'
const ATTACHMENT_NAME = 'stop-append-fixture.txt'

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
      id: 'acceptance', name: 'Electron Acceptance', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 30, models: ['slow-a'],
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
  }
}

/** Count the runtime events the renderer posts, with enough of the body to tell them apart. */
const INSTALL_EVENT_PROBE = `(() => {
  if (window.__lsEventProbe) return true
  const probe = { events: [] }
  window.__lsEventProbe = probe
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    if (method === 'POST' && /\\/runs\\/[^/]+\\/events$/u.test(url)) {
      let body = null
      try { body = JSON.parse(String(init?.body ?? 'null')) } catch { body = String(init?.body ?? '') }
      const entry = { at: Math.round(performance.now()), body, status: null, outcome: null }
      probe.events.push(entry)
      const response = await originalFetch(input, init)
      entry.status = response.status
      try { entry.outcome = (await response.clone().json())?.outcome ?? null } catch { entry.outcome = null }
      return response
    }
    return originalFetch(input, init)
  }
  return true
})()`

const COMPOSER_STATE_EXPRESSION = `(() => {
  const textarea = document.querySelector('.composer textarea')
  const stop = document.querySelector('.composer-run-actions .send-round.stop')
  const send = document.querySelector('.composer-run-actions .send-round:not(.stop)')
  return {
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    attachments: document.querySelectorAll('.attachment-preview-card').length,
    stopPresent: stop instanceof HTMLElement,
    stopLabel: stop?.getAttribute('aria-label') ?? null,
    stopDisabled: stop instanceof HTMLButtonElement ? stop.disabled : null,
    sendPresent: send instanceof HTMLElement,
    sendLabel: send?.getAttribute('aria-label') ?? null,
    notices: [...document.querySelectorAll('.runtime-event-notice')].map((element) => element.textContent?.trim() ?? ''),
    userMessages: [...document.querySelectorAll('.message.user')].map((element) => element.textContent?.trim() ?? ''),
    runStatus: [...document.querySelectorAll('.assistant-turn')].at(-1)?.querySelector('.run-status-error')?.textContent?.trim() ?? null,
    assistantText: [...document.querySelectorAll('.assistant-turn')].at(-1)?.querySelector('.assistant-response-stream')?.textContent?.trim() ?? '',
  }
})()`

async function setDraft(client, text) {
  return evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, ${JSON.stringify(text)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function attachFile(client, name) {
  return evaluate(client, `(async () => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const transfer = new DataTransfer()
    transfer.items.add(new File(['stop append fixture\\n'], ${JSON.stringify(name)}, { type: 'text/plain' }))
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    const startedAt = performance.now()
    while (performance.now() - startedAt < 15000) {
      if (document.querySelectorAll('.attachment-preview-card').length > 0) return true
      await new Promise((done) => setTimeout(done, 100))
    }
    return false
  })()`)
}

async function submitPrompt(client, prompt) {
  if (!await setDraft(client, prompt)) throw new Error('could not set the composer draft')
  const submitted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    textarea.focus()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('could not submit the composer')
}

async function waitForStreaming(client, timeoutMs = 60_000) {
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    return response?.getAttribute('data-stream-state') === 'streaming' ? true : null
  })()`), timeoutMs, 'a streaming answer')
}

async function waitForRunSettled(client, timeoutMs = 90_000) {
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    const state = response?.getAttribute('data-stream-state')
    const failure = turn?.querySelector('.run-status-error')?.textContent?.trim()
    return (state === 'settled' && response?.textContent?.trim()) || failure ? state ?? 'failed' : null
  })()`), timeoutMs, 'the run settling')
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-composer-stop-append-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  // Slow enough that both a stop and an append can happen while the answer is still arriving.
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 120, streamChunkCharacters: 24 })
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
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
    if (!await evaluate(client, INSTALL_EVENT_PROBE)) throw new Error('the runtime-event probe could not be installed')

    // --- 1. a draft and an attachment while the run is in flight ------------------------------
    await submitPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForStreaming(client)
    await setDraft(client, DRAFT_TEXT)
    const attached = await attachFile(client, ATTACHMENT_NAME)
    await delay(200)
    const withDraft = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const draftScreenshot = await writePng(client, 'stop-with-draft')

    // --- 2. one stop, even when the control is clicked twice in the same task -------------------
    const stopClicks = await evaluate(client, `(() => {
      const stop = document.querySelector('.composer-run-actions .send-round.stop')
      if (!(stop instanceof HTMLElement)) return 0
      stop.click()
      stop.click()
      return 2
    })()`)
    await delay(150)
    const stopping = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const stoppingScreenshot = await writePng(client, 'stopping-visible')
    const settledState = await waitForRunSettled(client)
    await delay(400)
    const afterSettle = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const interruptEvents = await evaluate(client, `window.__lsEventProbe.events.filter((entry) => entry.body?.type === 'interrupt_requested')`)

    // --- 3. an append submitted once while the run continues ------------------------------------
    await evaluate(client, `window.__lsEventProbe.events.length = 0`)
    await submitPrompt(client, `请再输出一次这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForStreaming(client)
    await setDraft(client, APPEND_TEXT)
    const appendClicks = await evaluate(client, `(() => {
      const send = document.querySelector('.composer-run-actions .send-round:not(.stop)')
      if (!(send instanceof HTMLElement)) return 0
      send.click()
      send.click()
      return 2
    })()`)
    await delay(600)
    const appendEvents = await evaluate(client, `window.__lsEventProbe.events.filter((entry) => entry.body?.type === 'user_message')`)
    const appendScreenshot = await writePng(client, 'append-submitted')
    // The append lands in whichever request the loop makes next; give it a bounded chance to
    // appear before judging it.
    const appendedVisible = await harness.waitFor(() => evaluate(client, `(() => {
      const texts = [...document.querySelectorAll('.message.user')].map((element) => element.textContent ?? '')
      return texts.some((text) => text.includes(${JSON.stringify(APPEND_TEXT)})) ? true : null
    })()`), 30_000, 'the appended message in the transcript').catch(() => false)
    await waitForRunSettled(client, 90_000)
    await delay(400)
    const afterAppend = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const appendedMessages = afterAppend.userMessages.filter((text) => text.includes(APPEND_TEXT))
    const providerUserTexts = provider.requests
      .flatMap((request) => request.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => String(message.content ?? ''))
    const appendOutcomes = appendEvents.map((entry) => entry.outcome?.kind ?? `http:${entry.status}`)

    const results = {
      withDraft,
      stopClicks,
      stopping,
      settledState,
      afterSettle,
      interruptEvents,
      appendClicks,
      appendEvents,
      appendOutcomes,
      appendedVisible,
      appendedMessages,
      appendOccurrencesInProviderRequests: providerUserTexts.filter((text) => text.includes(APPEND_TEXT)).length,
      appendAssistantText: afterAppend.assistantText,
      afterAppend,
      screenshots: { draftScreenshot, stoppingScreenshot, appendScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. both entries coexist with a draft + attachment present.
    expect(withDraft.stopPresent, 'the stop control disappeared while a draft was present')
    expect(withDraft.sendPresent, 'the append/send entry was missing while a run was in flight')
    expect(withDraft.draft === DRAFT_TEXT, `the draft was not kept: ${JSON.stringify(withDraft.draft)}`)
    expect(attached === true && withDraft.attachments === 1, `the attachment was not kept: ${withDraft.attachments}`)
    // 2. one interrupt per run, "正在停止" until the run settles, draft survives.
    expect(stopClicks === 2, 'the stop control could not be clicked twice for the acceptance')
    expect(interruptEvents.length === 1, `a double click submitted ${interruptEvents.length} interrupts`)
    expect(stopping.stopLabel === '正在停止当前任务', `the stop label did not change to 正在停止: ${JSON.stringify(stopping.stopLabel)}`)
    expect(stopping.draft === DRAFT_TEXT, 'the draft was cleared by stopping')
    expect(afterSettle.draft === DRAFT_TEXT, `the draft was lost when the run settled: ${JSON.stringify(afterSettle.draft)}`)
    expect(afterSettle.attachments === 1, `the attachment was lost when the run settled: ${afterSettle.attachments}`)
    expect(afterSettle.stopPresent === false, 'the stop control is still offered after the run settled')
    expect(afterSettle.stopLabel === null || afterSettle.stopLabel !== '正在停止当前任务', '正在停止 outlived the run')
    // 3. an append clicked twice is submitted once: the two clicks carry one identity and Main
    // answers the second with `duplicate`. Delivery into the *same* answer is a timing property
    // (a single-request answer has no later request to carry it), so it is recorded, not asserted.
    expect(appendClicks === 2, 'the append control could not be clicked twice for the acceptance')
    expect(appendEvents.length >= 1, 'the append never reached the runtime')
    expect(new Set(appendEvents.map((entry) => entry.body?.dedupKey)).size === 1,
      `the double click produced ${new Set(appendEvents.map((entry) => entry.body?.dedupKey)).size} identities`)
    expect(appendOutcomes.filter((kind) => kind === 'accepted').length === 1,
      `the runtime accepted ${appendOutcomes.filter((kind) => kind === 'accepted').length} of the two clicks`)
    expect(appendOutcomes.filter((kind) => kind === 'duplicate').length === 1,
      `the runtime did not deduplicate the second click: ${JSON.stringify(appendOutcomes)}`)
    expect(afterAppend.draft === '', `the composer kept the appended text: ${JSON.stringify(afterAppend.draft)}`)
    expect(appendedVisible, 'the accepted update did not appear in the conversation')
    expect(appendedMessages.length === 1, `the conversation recorded the update ${appendedMessages.length} times`)
    expect(providerUserTexts.filter((text) => text.includes(APPEND_TEXT)).length >= 1,
      'the accepted update never reached a later Provider request')
    expect(afterAppend.assistantText.includes('已处理补充要求：运行中的补充验收'),
      `the final answer did not respond to the update: ${JSON.stringify(afterAppend.assistantText)}`)

    if (failures.length > 0) {
      throw new Error(`composer stop/append acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'composer-stop-append', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'composer-stop-append',
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
