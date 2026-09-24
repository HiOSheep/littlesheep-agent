// Real-window acceptance for streamed Markdown rendering (taskbook UX-20 and the streaming
// half of UX-19).
//
// The user report is "some characters change colour and some text looks swallowed". The
// layer probe in `packages/app/src/renderer/chat/stream-text-integrity.test.ts` covers the
// transport, buffering and settlement layers headlessly; this script covers what only a real
// window can show:
//
//   1. while a deterministic long answer streams, the DOM text grows monotonically and never
//      loses characters that were already painted;
//   2. a reader who scrolls away during the stream keeps their position, is told that new
//      content arrived, and can return to the newest message with one click;
//   3. the settled DOM text equals the persisted settlement text byte for byte;
//   4. the colours of representative blocks (heading, link, inline code, quote, code block)
//      are recorded while the code fence is still on its plain-text fallback and again after
//      the lazy highlighter has loaded, so a colour change is evidence instead of a guess.
//
// Usage:
//   node scripts/verify-chat-streaming-rendering.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  LONG_MARKDOWN_END,
  LONG_MARKDOWN_MARKER,
  LONG_MARKDOWN_START,
  longMarkdownAnswer,
  projectMarkdownToText,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-chat-rendering')))
const screenshotDir = join(outRoot, 'screenshots')
const keepRoot = process.argv.includes('--keep')
const EXPECTED = longMarkdownAnswer()
const EVALUATE_TIMEOUT_MS = 5_000

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
  const path = join(screenshotDir, `${name}.png`)
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

/**
 * Everything the assertions need from the transcript, read in one evaluation so the samples
 * describe one instant.
 */
const SAMPLE_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
  const response = turn?.querySelector('.assistant-response-stream')
  if (!(messages instanceof HTMLElement) || !response) return null
  const viewportTop = messages.getBoundingClientRect().top
  const keyed = [...messages.querySelectorAll('[data-message-key]')]
  const visible = keyed.find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight
  })
  const code = response.querySelector('pre code, .code-block-source')
  return {
    state: response.getAttribute('data-stream-state'),
    text: response.textContent ?? '',
    scrollTop: messages.scrollTop,
    gap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
    jumpButton: document.querySelector('.chat-jump-to-latest')?.getAttribute('data-new-content') ?? null,
    anchorKey: visible?.getAttribute('data-message-key') ?? null,
    anchorTop: visible ? visible.getBoundingClientRect().top - viewportTop : null,
    codeClass: code?.className ?? null,
    codeChildElementCount: code?.childElementCount ?? null,
    hasFence: Boolean(response.querySelector('pre')),
  }
})()`

/** Computed colours of one settled answer: the blocks whose look could "suddenly change". */
const COLOR_EXPRESSION = `(() => {
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
  const response = turn?.querySelector('.assistant-response-stream')
  if (!response) return null
  const read = (selector) => {
    const element = response.querySelector(selector)
    if (!element) return null
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor, fontWeight: style.fontWeight }
  }
  const codeToken = response.querySelector('pre code span, .code-block-source span')
  const codeTokenStyle = codeToken ? getComputedStyle(codeToken) : null
  return {
    heading: read('h2'),
    link: read('a'),
    inlineCode: read('p code'),
    quote: read('blockquote'),
    codeBlock: read('pre code, .code-block-source'),
    codeToken: codeTokenStyle ? { color: codeTokenStyle.color, fontWeight: codeTokenStyle.fontWeight } : null,
  }
})()`

/**
 * Move the reader 420 px above the bottom, let the renderer register it, and report both the
 * reading position and the way back. Used while the answer is still streaming, which is the
 * only ordering in which the new-content hint can appear.
 */
const AWAY_EXPRESSION = `(async () => {
  const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 420)
  messages.dispatchEvent(new Event('scroll', { bubbles: true }))
  for (let index = 0; index < 6; index += 1) await raf()
  const viewportTop = messages.getBoundingClientRect().top
  const keyed = [...messages.querySelectorAll('[data-message-key]')]
  const visible = keyed.find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight
  })
  return {
    scrollTop: messages.scrollTop,
    gap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
    anchorKey: visible?.getAttribute('data-message-key') ?? null,
    anchorTop: visible ? visible.getBoundingClientRect().top - viewportTop : null,
    jumpButton: document.querySelector('.chat-jump-to-latest')?.getAttribute('data-new-content') ?? null,
  }
})()`

/** Per-block colour differences between the streaming sample and the settled one. */
function compareColors(during, settled) {
  if (!during || !settled) return null
  const changes = {}
  for (const key of Object.keys(settled)) {
    const before = during[key]
    const after = settled[key]
    if (!before || !after) {
      changes[key] = { status: 'not-comparable', before: before ?? null, after: after ?? null }
      continue
    }
    const differs = Object.keys(after).some((property) => before[property] !== after[property])
    changes[key] = differs ? { status: 'changed', before, after } : { status: 'stable' }
  }
  return changes
}

async function main() {  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-chat-rendering-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  // Small chunks with a delay: the answer must be observable while it is still arriving, and
  // the code fence must exist long enough for the lazy highlighter to be a separate event.
  const provider = await startElectronAcceptanceProvider({
    streamChunkDelayMs: 35,
    streamChunkCharacters: 24,
  })
  let electron
  let client
  let locator
  let preserve = false

  try {
    await mkdir(screenshotDir, { recursive: true })
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(dirname(join(dataDir, 'config.json')), { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // A smaller-than-default window is what makes a settled answer scroll: the fixture needs a
    // reading position to hold, and a taller window would leave the transcript un-scrollable.
    await harness.desktopAction(locator, 'resize', { width: 1024, height: 620 })
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer',
    )
    // A prompt submitted before the Runtime is ready is answered with the readiness refusal
    // ("The runtime is still starting…") — text streams, settles and never reaches a Provider,
    // which looks exactly like a passing fixture. Wait for the authoritative state first.
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    const submitted = await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '请输出这份验收文档：${LONG_MARKDOWN_MARKER}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    if (!submitted) throw new Error('streaming fixture could not submit the composer')
    const sessionAtSend = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)

    // Frame-level style recorder. The user report is "some characters change colour": a change
    // that happens while the answer is still arriving can be missed by polling, so this samples
    // the computed style of one heading, paragraph and code block on every animation frame and
    // keeps only the distinct signatures with when they appeared.
    const recorderInstalled = await evaluate(client, `(() => {
      const signatures = new Map()
      const readStyle = (element) => {
        if (!(element instanceof HTMLElement)) return null
        const style = getComputedStyle(element)
        return [style.color, style.fontSize, style.fontWeight, style.backgroundColor].join('|')
      }
      const record = (kind, element, characters) => {
        const signature = readStyle(element)
        if (!signature) return
        const previous = signatures.get(kind)
        if (previous && previous.signature === signature) {
          previous.lastSeenAt = performance.now()
          return
        }
        const entries = signatures.get(kind)?.history ?? []
        entries.push({ signature, firstSeenAt: Math.round(performance.now()), characters })
        signatures.set(kind, { signature, lastSeenAt: performance.now(), history: entries })
      }
      let running = true
      const tick = () => {
        if (!running) return
        const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
        const response = turn?.querySelector('.assistant-response-stream')
        if (response) {
          const characters = (response.textContent ?? '').length
          record('heading', response.querySelector('h2'), characters)
          record('paragraph', response.querySelector('p'), characters)
          record('link', response.querySelector('a'), characters)
          record('inlineCode', response.querySelector('p code'), characters)
          record('codeBlock', response.querySelector('pre code, .code-block-source'), characters)
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      window.__lsStyleRecorder = {
        stop: () => {
          running = false
          const summary = {}
          for (const [kind, entry] of signatures) summary[kind] = entry.history
          return summary
        },
      }
      return true
    })()`)
    if (!recorderInstalled) throw new Error('the frame-level style recorder could not be installed')

    // --- 1. monotonic growth while streaming -------------------------------------------------
    // Markdown syntax becomes structure as it completes, so the DOM text can legitimately
    // shrink by the marker characters of one inline span (`` `x` `` → `x`). Anything beyond
    // that is painted text disappearing, which is the defect this fixture exists to catch.
    const MARKDOWN_SYNTAX_TOLERANCE = 16
    const growth = []
    let highWater = 0
    const regressions = []
    let codeDuringStream = null
    let colorsDuringStream = null
    let awayDuringStream = null
    let codeScreenshot = null
    const startedAt = Date.now()
    while (Date.now() - startedAt < 60_000) {
      const sample = await evaluate(client, SAMPLE_EXPRESSION)
      if (sample) {
        const length = sample.text.length
        highWater = Math.max(highWater, length)
        if (length < highWater - MARKDOWN_SYNTAX_TOLERANCE) {
          regressions.push({ highWater, length, at: Date.now() - startedAt, tail: sample.text.slice(-80) })
        }
        if (length !== growth.at(-1)?.length) growth.push({ ms: Date.now() - startedAt, length, state: sample.state })
        // The code fence is where the renderer swaps its plain-text fallback for the lazy
        // highlighter, so its colour is sampled the moment the block exists and again once
        // the answer has settled. Anything the user sees "change colour" lives here.
        if (!codeDuringStream && sample.hasFence) {
          codeDuringStream = {
            at: Date.now() - startedAt,
            codeClass: sample.codeClass,
            childElementCount: sample.codeChildElementCount,
          }
          colorsDuringStream = await evaluate(client, COLOR_EXPRESSION)
          await writePng(client, 'streaming-code').then((path) => { codeScreenshot = path }).catch(() => undefined)
        }
        // A reader who scrolls away *while the answer is still arriving* is the case the
        // reading position exists for. Only this ordering can show the new-content hint.
        if (!awayDuringStream && sample.state === 'streaming') {
          const range = await evaluate(client, `(() => {
            const messages = document.querySelector('.messages')
            return messages ? messages.scrollHeight - messages.clientHeight : 0
          })()`)
          // 420 px above the bottom is well outside the sticky band, and it is reachable as
          // soon as the streamed answer has filled the viewport once.
          if (range >= 420) awayDuringStream = await evaluate(client, AWAY_EXPRESSION)
        }
        if (sample.state === 'settled' && length > 0) break
      }
      await delay(100)
    }
    if (growth.length === 0) throw new Error('no streamed text was ever observed in the DOM')
    if (regressions.length > 0) {
      throw new Error(`streamed text was lost while it was arriving: ${JSON.stringify(regressions)}`)
    }
    if (!codeDuringStream) throw new Error('the streamed answer never rendered a code fence')
    if (!awayDuringStream) throw new Error('the reading position could not be taken while the answer was streaming')
    if (awayDuringStream.jumpButton === null) {
      throw new Error(`no way back was offered after scrolling away mid-stream: ${JSON.stringify(awayDuringStream)}`)
    }
    const streamingFrame = await evaluate(client, SAMPLE_EXPRESSION)
    if (streamingFrame?.state !== 'settled') {
      throw new Error(`the streamed answer never settled: ${JSON.stringify(streamingFrame)}`)
    }
    const sessionIdAtSettle = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)

    // --- 2. the reader who left the bottom while the answer was still arriving -----------------
    // Everything here is measured against the mid-stream snapshot: the rest of the answer
    // arrived after it, which is what the reading position and the hint exist for.
    const anchorDrift = Math.abs(Number(streamingFrame.anchorTop) - Number(awayDuringStream.anchorTop))
    if (awayDuringStream.anchorKey !== streamingFrame.anchorKey || anchorDrift > 1) {
      throw new Error(`the reading position moved while the answer finished streaming: ${JSON.stringify({
        awayDuringStream, streamingFrame, anchorDrift,
        sessionIdentity: { atSend: sessionAtSend, atSettle: sessionIdAtSettle },
      })}`)
    }
    if (streamingFrame.jumpButton !== 'true') {
      throw new Error(`new content arrived while the reader was away without the hint: ${JSON.stringify(streamingFrame.jumpButton)}`)
    }
    const settledScreenshot = await writePng(client, 'settled')
    const awayScreenshot = await writePng(client, 'reading-away')

    const returned = await evaluate(client, `(async () => {
      const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
      document.querySelector('.chat-jump-to-latest')?.click()
      for (let index = 0; index < 8; index += 1) await raf()
      const messages = document.querySelector('.messages')
      return {
        gap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
        jumpButton: document.querySelector('.chat-jump-to-latest')?.getAttribute('data-new-content') ?? null,
      }
    })()`)
    if (returned.gap > 1 || returned.jumpButton !== null) {
      throw new Error(`returning to the newest message failed: ${JSON.stringify(returned)}`)
    }

    // --- 3. settled DOM text versus the persisted settlement ----------------------------------
    const sessionId = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)
    const renderedText = streamingFrame.text
    const persisted = typeof sessionId === 'string' && sessionId.trim()
      ? await harness.fetchJson(locator, `/sessions/${encodeURIComponent(sessionId.trim())}/messages?limit=20`)
      : undefined
    const persistedText = (persisted?.body?.messages ?? [])
      .filter((message) => message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim())
      .at(-1)?.text ?? ''
    const normalize = (value) => value.replace(/\s+/gu, ' ').trim()
    const normalizedRendered = normalize(renderedText)
    const normalizedPersisted = normalize(persistedText)
    const normalizedExpected = normalize(EXPECTED)
    // The DOM holds text, the settlement and the fixture hold Markdown source: compare the
    // rendered text against the source's plain-text projection, and both sources to each other.
    const projectedExpected = normalize(projectMarkdownToText(EXPECTED))
    const projectedPersisted = normalize(projectMarkdownToText(persistedText))
    const sentinels = {
      startInDom: renderedText.includes(LONG_MARKDOWN_START),
      endInDom: renderedText.includes(LONG_MARKDOWN_END),
      startInPersisted: persistedText.includes(LONG_MARKDOWN_START),
      endInPersisted: persistedText.includes(LONG_MARKDOWN_END),
      persistedMatchesExpected: normalizedPersisted === normalizedExpected,
      domMatchesProjectedExpected: normalizedRendered === projectedExpected,
      domMatchesProjectedPersisted: normalizedRendered === projectedPersisted,
    }
    const missing = Object.entries(sentinels).filter(([, ok]) => !ok).map(([name]) => name)
    if (missing.length > 0) {
      const firstDifference = (left, right) => {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          if (left[index] !== right[index]) return { index, left: left.slice(index, index + 60), right: right.slice(index, index + 60) }
        }
        return null
      }
      throw new Error(`streamed text did not survive to the settled transcript: ${JSON.stringify({
        missing,
        renderedCharacters: renderedText.length,
        projectedCharacters: projectedExpected.length,
        persistedCharacters: persistedText.length,
        expectedCharacters: EXPECTED.length,
        domVersusExpected: firstDifference(normalizedRendered, projectedExpected),
        domVersusPersisted: firstDifference(normalizedRendered, projectedPersisted),
      })}`)
    }

    // --- 4. colour evidence across the highlighter swap ---------------------------------------
    // The block is sampled the moment the fence appears (`codeDuringStream`/`colorsDuringStream`)
    // and again here, which is the comparison that matters for the "text changed colour" report.
    const colorsSettled = await evaluate(client, COLOR_EXPRESSION)
    if (!colorsSettled) throw new Error('the settled answer had no measurable blocks')
    // The frame-level recorder answers the same question at display resolution: a signature
    // that appears more than once per block kind is a change the reader could have seen.
    const styleTimeline = await evaluate(client, `window.__lsStyleRecorder ? window.__lsStyleRecorder.stop() : null`)
    const styleChanges = Object.fromEntries(Object.entries(styleTimeline ?? {}).map(([kind, history]) => [kind, history.length]))
    const codeRendering = {
      duringStreamCodeClass: codeDuringStream.codeClass,
      duringStreamChildElementCount: codeDuringStream.childElementCount,
      settledCodeClass: streamingFrame.codeClass,
      settledChildElementCount: streamingFrame.codeChildElementCount,
      fenceVisibleAfterMs: codeDuringStream.at,
    }

    console.log(JSON.stringify({
      check: 'chat-streaming-rendering',
      ok: true,
      evidence: {
        growthSamples: growth.length,
        firstStreamedLength: growth[0]?.length ?? 0,
        settledCharacters: renderedText.length,
        projectedCharacters: projectedExpected.length,
        expectedCharacters: EXPECTED.length,
        textRegressions: regressions.length,
        readingAway: awayDuringStream,
        readingAwayAnchorDrift: anchorDrift,
        sessionIdentity: { atSend: sessionAtSend, atSettle: sessionId },
        returned,
        sentinels,
        codeRendering,
        colorsDuringStream,
        colorsSettled,
        colorChanges: compareColors(colorsDuringStream, colorsSettled),
        styleTimeline,
        styleChanges,
        screenshots: { streamingCode: codeScreenshot, settled: settledScreenshot, readingAway: awayScreenshot },
        providerRequests: provider.requests.length,
      },
    }))
  } catch (error) {
    preserve = true
    const diagnostics = {
      dom: await evaluate(client, `(() => {
        const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
        const response = turn?.querySelector('.assistant-response-stream')
        return response ? { state: response.getAttribute('data-stream-state'), characters: (response.textContent ?? '').length, tail: (response.textContent ?? '').slice(-160) } : null
      })()`).catch(() => null),
      turns: await evaluate(client, `document.querySelectorAll('.assistant-turn').length`).catch(() => null),
      providerRequests: provider.requests.slice(-4).map((request) => ({
        index: request.requestIndex,
        stream: request.stream,
        lastUser: [...request.messages].reverse().find((message) => message.role === 'user')?.content?.slice(-80) ?? '',
      })),
    }
    console.error(JSON.stringify({
      check: 'chat-streaming-rendering',
      ok: false,
      root,
      logPath,
      diagnostics,
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
