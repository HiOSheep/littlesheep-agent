// Real-window readability acceptance for the chat output (taskbook UX-22).
//
// UX-22 asks for a *measurement* before any visual change: hierarchy, default disclosure, line
// width, paragraph spacing, copyability, keyboard focus, state contrast and narrow-window
// wrapping, judged by "read the result, find the failure, continue the task". This script
// produces those numbers from the real window so a later change can be justified by evidence
// instead of taste, and so a state that is genuinely unreadable fails a gate.
//
// Three fixtures, one launch:
//   A. a long deterministic Markdown answer (headings, list, link, quote, inline code, fence)
//   B. an ordinary bounded run that calls a tool (the activity row and its disclosure)
//   C. an injected 401 (the failure state, which must stay legible and visible)
//
// Measured per fixture: computed colours with their effective background, WCAG contrast,
// font size/weight, paragraph spacing, content width, horizontal overflow, selection
// (copyability), and the keyboard reachability of the interactive rows. Then the same
// transcript is re-measured at the window's minimum width.
//
// Usage:
//   node scripts/verify-chat-output-readability.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-chat-readability')))
const screenshotDir = join(outRoot, 'screenshots')
const keepRoot = process.argv.includes('--keep')
const MINIMUM_WINDOW = { width: 800, height: 660 }
const WORKING_WINDOW = { width: 1280, height: 720 }
const EVALUATE_TIMEOUT_MS = 5_000
/** WCAG 2.1 AA for normal body text. Large text (>= 18.66px bold or >= 24px) is held to 3.0. */
const AA_NORMAL = 4.5
const AA_LARGE = 3

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
      apiKey: 'acceptance-key', timeoutSeconds: 10, models: ['slow-a'],
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
 * Everything measured in one pass. Colours come with the first non-transparent ancestor
 * background, because the chat paints on a surface rather than on the page colour.
 */
const MEASURE_EXPRESSION = `(() => {
  const root = document.querySelector('.messages')
  const content = document.querySelector('.messages-content')
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
  const response = turn?.querySelector('.assistant-response-stream') ?? null
  if (!(root instanceof HTMLElement) || !(content instanceof HTMLElement)) return null

  const parseColor = (value) => {
    const match = /rgba?\\(([^)]+)\\)/u.exec(value ?? '')
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number.parseFloat(part))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const effectiveBackground = (element) => {
    let node = element
    while (node instanceof HTMLElement) {
      const colour = parseColor(getComputedStyle(node).backgroundColor)
      if (colour && colour.a > 0.95) return colour
      node = node.parentElement
    }
    return parseColor(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }
  }
  const sample = (selector, label) => {
    const element = selector ? (response ?? document).querySelector(selector) : response
    if (!(element instanceof HTMLElement)) return null
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      label,
      color: parseColor(style.color),
      background: effectiveBackground(element),
      fontSizePx: Number.parseFloat(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
      lineHeightPx: Number.parseFloat(style.lineHeight) || null,
      marginBottomPx: Number.parseFloat(style.marginBottom) || 0,
      widthPx: Math.round(rect.width),
      truncatedHorizontally: element.scrollWidth - element.clientWidth > 1,
      userSelect: style.userSelect,
      text: (element.textContent ?? '').slice(0, 40),
    }
  }
  const paragraph = response?.querySelector('p') ?? null
  const paragraphStyle = paragraph ? getComputedStyle(paragraph) : null
  const focusables = [...document.querySelectorAll('.messages button, .messages textarea, .messages a[href], .chat-jump-to-latest')]
    .map((element) => ({
      tag: element.tagName,
      className: typeof element.className === 'string' ? element.className : '',
      label: element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 30),
      text: (element.textContent ?? '').trim().slice(0, 40),
    }))
  // Copyability: a real selection over the answer, read back through the DOM Selection API.
  let selectedCharacters = 0
  if (response) {
    const range = document.createRange()
    range.selectNodeContents(response)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    selectedCharacters = selection?.toString().length ?? 0
    selection?.removeAllRanges()
  }
  return {
    samples: {
      body: sample('p', 'body paragraph'),
      heading: sample('h2', 'section heading'),
      link: sample('a', 'link'),
      quote: sample('blockquote', 'quote'),
      inlineCode: sample('p code', 'inline code'),
      codeBlock: sample('pre code, .code-block-source', 'code block'),
      listItem: sample('li', 'list item'),
      failure: sample(null, null) && turn?.querySelector('.run-status-error')
        ? (() => {
            const element = turn.querySelector('.run-status-error')
            const style = getComputedStyle(element)
            return {
              label: 'runtime failure notice',
              color: parseColor(style.color),
              background: effectiveBackground(element),
              fontSizePx: Number.parseFloat(style.fontSize),
              fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
              userSelect: style.userSelect,
              text: (element.textContent ?? '').slice(0, 60),
            }
          })()
        : null,
      toolRow: (() => {
        const element = document.querySelector('.messages .agent-tool-row')
        if (!(element instanceof HTMLElement)) return null
        const style = getComputedStyle(element)
        return {
          label: 'tool activity row',
          color: parseColor(style.color),
          background: effectiveBackground(element),
          fontSizePx: Number.parseFloat(style.fontSize),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          userSelect: style.userSelect,
          text: (element.textContent ?? '').trim().slice(0, 40),
        }
      })(),
    },
    paragraphSpacing: {
      marginBottomPx: paragraphStyle ? Number.parseFloat(paragraphStyle.marginBottom) : null,
      lineHeightPx: paragraphStyle ? Number.parseFloat(paragraphStyle.lineHeight) : null,
      lineHeightRatio: paragraphStyle && Number.parseFloat(paragraphStyle.fontSize) > 0
        ? Number.parseFloat(paragraphStyle.lineHeight) / Number.parseFloat(paragraphStyle.fontSize)
        : null,
    },
    contentWidthPx: Math.round(content.getBoundingClientRect().width),
    viewportWidthPx: window.innerWidth,
    transcriptOverflowPx: root.scrollWidth - root.clientWidth,
    documentOverflowPx: document.documentElement.scrollWidth - window.innerWidth,
    selectedCharacters,
    focusables,
  }
})()`

function parseRgb(value) {
  if (!value) return null
  return { r: value.r, g: value.g, b: value.b }
}

/** WCAG 2.1 relative luminance and contrast ratio. */
function contrastRatio(foreground, background) {
  const toLinear = (channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = ({ r, g, b }) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

/** Every measured sample with its contrast and the threshold that applies to it. */
function summarize(measurement) {
  const entries = []
  for (const [key, value] of Object.entries(measurement?.samples ?? {})) {
    if (!value?.color) continue
    const ratio = contrastRatio(parseRgb(value.color), parseRgb(value.background))
    const large = value.fontSizePx >= 24 || (value.fontSizePx >= 18.66 && value.fontWeight >= 700)
    entries.push({
      key,
      label: value.label,
      contrast: ratio,
      required: large ? AA_LARGE : AA_NORMAL,
      fontSizePx: value.fontSizePx,
      fontWeight: value.fontWeight,
      truncatedHorizontally: value.truncatedHorizontally ?? false,
      userSelect: value.userSelect,
      text: value.text,
    })
  }
  return entries
}

async function submitPrompt(client, prompt) {
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

async function waitForSettledTurn(client, timeoutMs) {
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    const failureRow = turn?.querySelector('.run-status-error')
    if (response?.getAttribute('data-stream-state') === 'settled') return 'settled'
    if (failureRow?.textContent?.trim()) return 'failed'
    return null
  })()`), timeoutMs, 'settled turn')
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-chat-readability-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 15, streamChunkCharacters: 60 })
  let electron
  let client
  let preserve = false

  try {
    await mkdir(screenshotDir, { recursive: true })
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WORKING_WINDOW)
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

    // A. the long answer: hierarchy, spacing, line width, copyability.
    await startNewConversation(client)
    await submitPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await delay(400)
    const longAnswer = await evaluate(client, MEASURE_EXPRESSION)
    const longAnswerScreenshot = await writePng(client, 'long-answer')

    // B. an ordinary bounded run: the tool activity row and its disclosure.
    await startNewConversation(client)
    await submitPrompt(client, '请使用 glob 工具列出当前工作区顶层条目')
    await waitForSettledTurn(client, 60_000)
    await delay(600)
    const toolRun = await evaluate(client, MEASURE_EXPRESSION)
    const toolRunScreenshot = await writePng(client, 'tool-run')

    // C. the failure state: it has to stay findable and legible.
    await startNewConversation(client)
    await provider.setFaults([{ kind: 'status', status: 401, times: 40 }])
    await submitPrompt(client, '请简短确认收到这条可读性验收消息。')
    await waitForSettledTurn(client, 45_000)
    await delay(400)
    const failureRun = await evaluate(client, MEASURE_EXPRESSION)
    const failureScreenshot = await writePng(client, 'failure')
    await provider.setFaults(null)

    // D. the same failure state at the minimum window width.
    await harness.desktopAction(locator, 'resize', MINIMUM_WINDOW)
    await delay(600)
    const narrow = await evaluate(client, MEASURE_EXPRESSION)
    const narrowScreenshot = await writePng(client, 'failure-narrow')

    const fixtures = {
      longAnswer: { measurement: longAnswer, samples: summarize(longAnswer) },
      toolRun: { measurement: toolRun, samples: summarize(toolRun) },
      failureRun: { measurement: failureRun, samples: summarize(failureRun) },
      narrowFailure: { measurement: narrow, samples: summarize(narrow) },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }

    // 1. Every state the reader must read clears WCAG AA at its own size.
    for (const [fixtureName, fixture] of Object.entries(fixtures)) {
      for (const sample of fixture.samples) {
        expect(
          sample.contrast >= sample.required,
          `${fixtureName}/${sample.key} (${sample.label}) contrast ${sample.contrast} < ${sample.required}`,
        )
      }
    }

    // 2. The long answer keeps a readable measure and hierarchy.
    const longSamples = Object.fromEntries(fixtures.longAnswer.samples.map((sample) => [sample.key, sample]))
    expect(longSamples.body?.contrast >= AA_NORMAL, 'body text must clear AA')
    expect(longAnswer.contentWidthPx <= WORKING_WINDOW.width, 'the transcript must fit the window width')
    expect(longAnswer.transcriptOverflowPx <= 1, `the transcript scrolls horizontally by ${longAnswer.transcriptOverflowPx}px`)
    expect(longAnswer.paragraphSpacing.lineHeightRatio >= 1.4, `line height ratio ${longAnswer.paragraphSpacing.lineHeightRatio} is below 1.4`)
    expect((longAnswer.paragraphSpacing.marginBottomPx ?? 0) > 0, 'paragraphs have no vertical spacing')
    expect(longAnswer.selectedCharacters > 400, `only ${longAnswer.selectedCharacters} characters could be selected`)
    expect(longSamples.body?.userSelect !== 'none', 'body text must be selectable')
    expect(longSamples.failure?.truncatedHorizontally !== true, 'a failure notice must not be clipped horizontally')

    // 3. The tool row stays reachable, labelled and legible for keyboard users.
    const toolSample = fixtures.toolRun.samples.find((sample) => sample.key === 'toolRow')
    expect(toolSample !== undefined, 'the bounded run rendered no tool activity row')
    expect((toolSample?.contrast ?? 0) >= AA_NORMAL, `tool activity row contrast ${toolSample?.contrast}`)
    const toolFocusable = (toolRun?.focusables ?? []).some((entry) => entry.className.includes('agent-tool-row') && entry.label.length > 0)
    expect(toolFocusable, 'the tool activity row is not a labelled focusable control')

    // 4. The failure state is visible, legible and not clipped.
    const failureSample = fixtures.failureRun.samples.find((sample) => sample.key === 'failure')
    const failureText = failureRun?.samples?.failure?.text ?? ''
    expect(failureText.length > 0, 'the failed run rendered no visible reason')
    expect(failureSample !== undefined, 'the failed run rendered no measurable failure notice')
    expect((failureSample?.contrast ?? 0) >= AA_NORMAL, `failure notice contrast ${failureSample?.contrast}`)
    expect(failureSample?.truncatedHorizontally !== true, 'the failure notice is clipped horizontally')

    // 5. At the minimum window width nothing overflows horizontally.
    expect(narrow.documentOverflowPx <= 1, `the document overflows horizontally by ${narrow.documentOverflowPx}px at ${MINIMUM_WINDOW.width}px`)
    expect(narrow.transcriptOverflowPx <= 1, `the transcript overflows horizontally by ${narrow.transcriptOverflowPx}px at the minimum width`)
    expect(narrow.contentWidthPx <= MINIMUM_WINDOW.width, 'the transcript content is wider than the minimum window')

    const evidence = {
      window: WORKING_WINDOW,
      minimumWindow: MINIMUM_WINDOW,
      fixtures,
      screenshots: {
        longAnswer: longAnswerScreenshot,
        toolRun: toolRunScreenshot,
        failure: failureScreenshot,
        narrowFailure: narrowScreenshot,
      },
      failures,
    }
    if (failures.length > 0) {
      throw new Error(`chat output readability is below the recorded contract: ${JSON.stringify(evidence)}`)
    }
    console.log(JSON.stringify({ check: 'chat-output-readability', ok: true, evidence }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'chat-output-readability',
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
