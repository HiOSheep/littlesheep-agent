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

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DurableEventStore, ExecutionLogStore } from '../packages/runner/dist/index.js'
import { DurableHarnessKernel } from '../packages/harness/dist/index.js'
import { ReplyFingerprintStore } from '../packages/session/dist/index.js'
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
/**
 * Fractional device scale factors a Windows display can actually be set to. 1.25 and 1.5 are the
 * common laptop settings; DPR 2 was the only one measured before, which left the fractional
 * rasterisation path — where sub-pixel rounding is most likely to clip a border or overlap text —
 * unmeasured.
 */
const HIGH_DPI_SCALES = [1.25, 1.5, 2]
/** `shortActivityText(value, 180)` is the collapsed tool summary's contract. */
const TOOL_SUMMARY_MAX_CHARACTERS = 180
/** `.agent-tool-detail-section pre { max-height: 180px; overflow-y: auto }`. */
const TOOL_DETAIL_MAX_HEIGHT_PX = 180
/** The heading floor the chat stylesheet gives the sources meta line (`.web-sources-heading`). */
const WEB_SOURCES_HEADING_MIN_FONT_PX = 11
/** `.web-source-copy strong` / `.web-source-copy small` … the row text floor. */
const WEB_SOURCE_ROW_MIN_FONT_PX = 11

/**
 * UX-38 web-source fixture identities. The deterministic acceptance provider cannot emit web
 * evidence (only the real `web_search`/`web_fetch` tools produce a citation projection), so the
 * sources section is seeded exactly the way a settled run leaves it:
 *   1. durable Harness events proving `run_accepted → final_reply_proposed → final_reply_settled
 *      → run_completed` for one run,
 *   2. that run's entry in the session settlement registry (`.reply-fingerprints/<id>.sha256*`),
 *   3. the execution log `<data-root>/execution-logs/<runId>.json` carrying the bounded
 *      `webEvidence` projection and the tool call the detail-disclosure checks need,
 *   4. the session JSONL message that owns the run.
 * All four are required: `prepareAuthoritativeExecutionLog` blanks `webEvidence` unless the
 * durable settlement and the settlement registry both agree that this run published a final reply
 * (packages/runner/src/authoritative-reply.ts, packages/app/src/main/local-app-api/session-routes.ts).
 */
const WEB_SOURCES_SESSION_ID = 'ux38-web-sources-session'
const WEB_SOURCES_SESSION_TITLE = 'UX-38 网络来源可读性会话'
const WEB_SOURCES_RUN_ID = 'ux38-web-sources-run'
/** Present in the first citation title, so the fixture can prove its own projection rendered. */
const WEB_SOURCES_TITLE_MARKER = 'FIXTURE-WEB-SOURCE-9d21'
const WEB_SOURCES_REPLY = [
  '这次检索用到两个来源，它们都保留在回复下方的来源区块里。',
  '',
  '来源行可以逐字选中复制：标题、域名与读取状态都由 Runtime 签发，不由模型改写。',
  '这一段刻意写长一些，好让来源区块与正文同时出现在真实窗口里，',
  '从而在同一回合内比较正文与来源两种文字层级的对比度、字号与横向溢出。',
].join('\n')
/**
 * The seeded tool call. The input deliberately uses a key that is not a path and not one of
 * `query/pattern/glob/url/href`, so `toolSummaryText` falls through to
 * `shortActivityText(formatToolInput(tool), 180)` — the only branch that can prove the 180
 * character cap, because every shorter branch would fit inside the cap anyway.
 */
const LONG_TOOL_INPUT = {
  note: `验收用例：这一个输入刻意超过一百八十个字符，用来确认折叠摘要被 shortActivityText(…, 180) 截断，而不是把整段参数铺开。${'长'.repeat(20)}` + 'x'.repeat(160),
}
const LONG_TOOL_OUTPUT = Array.from({ length: 40 }, (_value, index) => `第 ${String(index + 1).padStart(2, '0')} 行：工具输出的这一段足够长，展开后的明细必须自己滚动，而不是把整段对话拉长。`).join('\n')

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

/**
 * Capture with a bounded retry, the same way `verify-desktop-cold-start-visuals` does it: a
 * frame Chromium has not produced yet (or an occluded window) is not a defect, and under a busy
 * machine it showed up here as a bare 10 s timeout. Three failed attempts still fail.
 */
async function writePng(client, name, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send('Page.bringToFront').catch(() => undefined)
      const shot = await withTimeout(
        client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
        10_000,
        'Page.captureScreenshot',
      )
      if (!shot?.data) throw new Error('empty capture payload')
      const path = join(screenshotDir, `${name}.png`)
      await writeFile(path, Buffer.from(shot.data, 'base64'))
      return path
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw new Error(`${name}: ${lastError instanceof Error ? lastError.message : 'no frame'} (after ${attempts} attempts)`)
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
 * Seed the settled web-evidence run described above. Every store is written with the production
 * class, so the data root looks exactly like the data root of a run that really fetched sources.
 */
async function seedWebSourcesSession(dataDir) {
  const now = Date.now()
  const startedAt = new Date(now - 8_000).toISOString()
  const settledAt = new Date(now - 3_000).toISOString()
  const endedAt = new Date(now - 1_000).toISOString()
  const settlementId = `${WEB_SOURCES_RUN_ID}:final-reply-settled`
  const modelRequestId = `${WEB_SOURCES_RUN_ID}:model-request-1`
  const reservation = {
    version: 1,
    settlementId,
    reply: WEB_SOURCES_REPLY,
    replyFingerprint: createHash('sha256').update(WEB_SOURCES_REPLY, 'utf8').digest('hex'),
    modelRequestId,
  }
  const toolCallId = 'ux38-web-sources-tool-call'
  const webEvidence = {
    version: 1,
    providerId: 'acceptance',
    generatedAt: settledAt,
    completeness: 'partial',
    citationIds: ['web-ux38-source-1', 'web-ux38-source-2'],
    citations: [
      {
        id: 'web-ux38-source-1',
        origin: 'https://example.test',
        url: 'https://example.test/ux38-source-one',
        urlHash: '1'.repeat(64),
        title: `${WEB_SOURCES_TITLE_MARKER}：来源区块验收文档`,
        fetchedAt: settledAt,
        publishedAt: new Date(now - 86_400_000).toISOString(),
        status: 'fetched',
        truncated: false,
      },
      {
        id: 'web-ux38-source-2',
        origin: 'https://docs.example.test',
        urlHash: '2'.repeat(64),
        title: '第二个来源只有安全投影，没有保留完整链接',
        fetchedAt: settledAt,
        status: 'partial',
        truncated: true,
      },
    ],
    citationCount: 2,
    documentCount: 2,
    cached: false,
    partial: true,
    truncated: true,
    blocked: false,
    stale: false,
  }

  await Promise.all([
    mkdir(join(dataDir, 'sessions'), { recursive: true }),
    mkdir(join(dataDir, 'durable-events'), { recursive: true }),
  ])

  // 1. the durable facts of a settled run: without them the replay below is "unconfirmed" and
  //    `prepareAuthoritativeExecutionLog` replaces the log with a runtime status and no evidence.
  const kernel = new DurableHarnessKernel({
    eventStore: new DurableEventStore({ rootDir: join(dataDir, 'durable-events') }),
  })
  await kernel.initialize()
  const eventBase = { sessionId: WEB_SOURCES_SESSION_ID, runId: WEB_SOURCES_RUN_ID, source: 'runtime' }
  const events = [
    { suffix: 'accepted', type: 'run_accepted', occurredAt: startedAt, payload: { inboundText: '请给出这次检索的来源清单。' } },
    { suffix: 'reply-proposed', type: 'final_reply_proposed', occurredAt: settledAt, payload: reservation },
    { suffix: 'final-reply-settled', type: 'final_reply_settled', occurredAt: settledAt, payload: reservation },
    { suffix: 'completed', type: 'run_completed', occurredAt: endedAt, payload: {} },
  ]
  for (const event of events) {
    const eventId = `${WEB_SOURCES_RUN_ID}:${event.suffix}`
    const outcome = await kernel.append({ ...eventBase, eventId, idempotencyKey: eventId, type: event.type, occurredAt: event.occurredAt, payload: event.payload })
    if (outcome.kind !== 'appended') throw new Error(`could not seed durable event ${eventId}: ${outcome.kind}`)
  }

  // 2. the session's settlement registry: `replayAuthoritativeDurableFinalReply` refuses a
  //    settlement the registry does not also report as settled.
  const registry = new ReplyFingerprintStore(join(dataDir, 'sessions'), 60_000)
  if (!await registry.reserveSettlement(WEB_SOURCES_SESSION_ID, reservation)) {
    throw new Error('the seeded settlement identity was already reserved')
  }
  await registry.settleSettlement(WEB_SOURCES_SESSION_ID, reservation)

  // 3. the execution log: bounded web evidence plus the one tool call whose summary and detail
  //    disclosure this gate measures.
  const messages = [
    {
      id: `${WEB_SOURCES_RUN_ID}:inbound`,
      role: 'user',
      content: [{ type: 'text', text: '请给出这次检索的来源清单。' }],
      timestamp: startedAt,
      sessionId: WEB_SOURCES_SESSION_ID,
      runId: WEB_SOURCES_RUN_ID,
    },
    {
      id: `${WEB_SOURCES_RUN_ID}:tool-call`,
      role: 'assistant',
      content: [{ type: 'tool_calls', calls: [{ id: toolCallId, name: 'grep', input: LONG_TOOL_INPUT }] }],
      timestamp: new Date(now - 6_000).toISOString(),
      sessionId: WEB_SOURCES_SESSION_ID,
      runId: WEB_SOURCES_RUN_ID,
    },
    {
      id: `${WEB_SOURCES_RUN_ID}:tool-result`,
      role: 'tool',
      content: [{ type: 'tool_result', result: { callId: toolCallId, ok: true, output: LONG_TOOL_OUTPUT, durationMs: 42 } }],
      timestamp: new Date(now - 5_000).toISOString(),
      sessionId: WEB_SOURCES_SESSION_ID,
      runId: WEB_SOURCES_RUN_ID,
    },
    {
      id: `${WEB_SOURCES_RUN_ID}:reply`,
      role: 'assistant',
      stage: 'finalize',
      content: [{ type: 'text', text: WEB_SOURCES_REPLY }],
      timestamp: endedAt,
      sessionId: WEB_SOURCES_SESSION_ID,
      runId: WEB_SOURCES_RUN_ID,
      finalReplySettlement: { ...reservation, status: 'settled' },
    },
  ]
  await new ExecutionLogStore({ rootDir: join(dataDir, 'execution-logs') }).write({
    runId: WEB_SOURCES_RUN_ID,
    sessionId: WEB_SOURCES_SESSION_ID,
    startedAt,
    endedAt,
    status: 'ok',
    model: 'acceptance/slow-a',
    inboundText: '请给出这次检索的来源清单。',
    reply: WEB_SOURCES_REPLY,
    finalReplySettlement: { ...reservation, status: 'settled' },
    durableHarnessMode: 'next',
    trace: [],
    messages,
    webEvidence,
    durationMs: 7_000,
  })

  // 4. the transcript the renderer loads, plus the index row the sidebar lists.
  const lines = [
    JSON.stringify({
      type: 'metadata',
      metadata: {
        title: WEB_SOURCES_SESSION_TITLE,
        model: 'acceptance/slow-a',
        createdAt: startedAt,
        updatedAt: endedAt,
        messageCount: 2,
      },
    }),
    JSON.stringify(messages[0]),
    JSON.stringify(messages[3]),
  ]
  await writeFile(join(dataDir, 'sessions', `${WEB_SOURCES_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({
    sessions: [{
      id: WEB_SOURCES_SESSION_ID,
      title: WEB_SOURCES_SESSION_TITLE,
      createdAt: now - 8_000,
      lastMessageAt: now,
      mode: 'research',
      scope: 'standalone',
    }],
  }, null, 2)}\n`, 'utf8')
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
  const selectAndCount = (element) => {
    if (!(element instanceof HTMLElement)) return 0
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const characters = selection?.toString().length ?? 0
    selection?.removeAllRanges()
    return characters
  }
  const selectedCharacters = response ? selectAndCount(response) : 0
  const webSourcesElement = response?.querySelector('.web-sources') ?? document.querySelector('.web-sources')
  /**
   * Long tool result disclosure. The panel is 'grid-template-rows: 0fr' while closed, so the
   * panel's own rect — not the clipped pre's — is what proves it is collapsed.
   */
  const toolDisclosure = (() => {
    const row = document.querySelector('.messages .agent-tool-row')
    if (!(row instanceof HTMLElement)) return null
    const panel = document.querySelector('.messages .agent-tool-details-panel')
    const summaryElement = row.querySelector('.agent-flow-summary')
    const summary = (summaryElement?.textContent ?? '').trim()
    // A tool row can carry several detail blocks (Input and Output). The one the 180px cap is
    // about is the tallest one, so the measurement names the block it actually measured.
    const preBlocks = panel ? [...panel.querySelectorAll('.agent-tool-detail-section pre')] : []
    const pre = preBlocks.slice().sort((left, right) => right.scrollHeight - left.scrollHeight)[0] ?? null
    return {
      label: row.getAttribute('aria-label') ?? '',
      expanded: row.getAttribute('aria-expanded'),
      summary,
      summaryCharacters: summary.length,
      summaryHasEllipsis: summary.endsWith('…'),
      panelPresent: panel instanceof HTMLElement,
      panelAriaHidden: panel?.getAttribute('aria-hidden') ?? null,
      panelInert: panel instanceof HTMLElement ? panel.hasAttribute('inert') : null,
      panelHeightPx: panel instanceof HTMLElement ? Math.round(panel.getBoundingClientRect().height * 100) / 100 : null,
      preBlocks: preBlocks.length,
      preSectionLabel: pre?.closest('.agent-tool-detail-section')?.querySelector('.agent-tool-detail-label')?.textContent?.trim() ?? null,
      prePresent: pre instanceof HTMLElement,
      preMaxHeightPx: pre ? getComputedStyle(pre).maxHeight : null,
      preOverflowY: pre ? getComputedStyle(pre).overflowY : null,
      preClientHeightPx: pre ? pre.clientHeight : null,
      preScrollHeightPx: pre ? pre.scrollHeight : null,
      preTextCharacters: pre ? (pre.textContent ?? '').length : null,
    }
  })()
  return {
    samples: {
      body: sample('p', 'body paragraph'),
      heading: sample('h2', 'section heading'),
      link: sample('a', 'link'),
      quote: sample('blockquote', 'quote'),
      inlineCode: sample('p code', 'inline code'),
      codeBlock: sample('pre code, .code-block-source', 'code block'),
      listItem: sample('li', 'list item'),
      webSources: sample('.web-sources', 'web sources section'),
      webSourcesHeading: sample('.web-sources-heading', 'web sources heading'),
      webSourcesHeadingTitle: sample('.web-sources-heading strong', 'web sources heading title'),
      webSourceRow: sample('a.web-source-row', 'web source row'),
      webSourceTitle: sample('.web-source-copy strong', 'web source title'),
      webSourceMeta: sample('.web-source-copy small', 'web source meta line'),
      webSourceState: sample('.web-source-state', 'web source state label'),
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
    devicePixelRatio: window.devicePixelRatio,
    transcriptOverflowPx: root.scrollWidth - root.clientWidth,
    documentOverflowPx: document.documentElement.scrollWidth - window.innerWidth,
    selectedCharacters,
    webSources: webSourcesElement instanceof HTMLElement
      ? {
          present: true,
          selectedCharacters: selectAndCount(webSourcesElement),
          textCharacters: (webSourcesElement.textContent ?? '').length,
          overflowPx: webSourcesElement.scrollWidth - webSourcesElement.clientWidth,
          rowCount: webSourcesElement.querySelectorAll('a.web-source-row').length,
          rowHrefs: [...webSourcesElement.querySelectorAll('a.web-source-row')].map((row) => row.getAttribute('href')),
          headingLabel: webSourcesElement.querySelector('.web-sources-heading')?.textContent?.trim() ?? null,
        }
      : { present: false, selectedCharacters: 0, textCharacters: 0, overflowPx: 0, rowCount: 0, rowHrefs: [], headingLabel: null },
    toolDisclosure,
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
    // Seeded before the app starts, so the fixture is loaded the same way a restart would load it.
    await seedWebSourcesSession(dataDir)

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

    // A2. the same transcript in compact display: completed activity folds away, so this checks
    // that folding changes density and not legibility.
    await evaluate(client, `(() => {
      localStorage.setItem('littlesheep.ui.conversationDisplayMode', 'compact')
      window.dispatchEvent(new CustomEvent('littlesheep:conversation-display-mode', { detail: 'compact' }))
      return true
    })()`)
    await delay(500)
    const longAnswerCompact = await evaluate(client, MEASURE_EXPRESSION)
    const compactScreenshot = await writePng(client, 'long-answer-compact')
    await evaluate(client, `(() => {
      localStorage.setItem('littlesheep.ui.conversationDisplayMode', 'normal')
      window.dispatchEvent(new CustomEvent('littlesheep:conversation-display-mode', { detail: 'normal' }))
      return true
    })()`)
    await delay(400)

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

    // E. fractional and integer device-pixel-ratios at the working size. This emulates the
    // rasterisation half of Windows display scaling; the half that shrinks the CSS viewport is
    // covered by D above, because the window manager keeps a window at least MINIMUM_WINDOW CSS
    // pixels wide. The override is cleared before every step: an active override pins
    // `window.innerWidth`, so measuring the window while one is still set would re-apply the
    // previous geometry instead of the window's own.
    const highDpiRuns = []
    for (const scale of HIGH_DPI_SCALES) {
      await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      await harness.desktopAction(locator, 'resize', WORKING_WINDOW)
      await delay(500)
      const measuredWindow = await evaluate(client, `(() => ({ width: window.innerWidth, height: window.innerHeight }))()`)
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: measuredWindow.width,
        height: measuredWindow.height,
        deviceScaleFactor: scale,
        mobile: false,
      }).catch(() => undefined)
      await delay(600)
      highDpiRuns.push({
        scale,
        window: measuredWindow,
        measurement: await evaluate(client, MEASURE_EXPRESSION),
        screenshot: await writePng(client, `failure-dpr-${String(scale).replace('.', '_')}`),
      })
    }
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
    await harness.desktopAction(locator, 'resize', WORKING_WINDOW)
    await delay(400)

    // F. the seeded settled run that carries web evidence: the sources block, and the long tool
    // result whose collapsed summary and expanded detail this gate measures.
    const seededSessionOpened = await harness.waitFor(() => evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.session-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(WEB_SOURCES_SESSION_TITLE)}))
      if (!(item instanceof HTMLElement)) return null
      item.click()
      return true
    })()`), harness.startTimeoutMs, 'the seeded web-sources session row')
    if (!seededSessionOpened) throw new Error('the seeded web-sources session was not listed in the sidebar')
    const webSourcesFixture = await harness.waitFor(() => evaluate(client, `(() => {
      if (!document.querySelector('.web-sources')) return null
      const state = ${MEASURE_EXPRESSION}
      return state && state.toolDisclosure ? state : null
    })()`), harness.startTimeoutMs, 'the seeded sources section and tool row')
    await delay(400)
    const webSourcesMeasured = await evaluate(client, MEASURE_EXPRESSION)
    const webSourcesScreenshot = await writePng(client, 'web-sources')

    // F2. expand the disclosure with a real pointer click on the row, then measure the detail.
    //     The scroll settles first: clicking the rect read during a smooth scroll would miss.
    await evaluate(client, `(() => {
      const row = document.querySelector('.messages .agent-tool-row')
      row?.scrollIntoView({ block: 'center' })
      return true
    })()`)
    await delay(400)
    const toolRowPoint = await evaluate(client, `(() => {
      const row = document.querySelector('.messages .agent-tool-row')
      if (!(row instanceof HTMLElement)) return null
      const bounds = row.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return null
      return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) }
    })()`)
    if (!toolRowPoint) throw new Error('the seeded tool row disappeared before it could be expanded')
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: toolRowPoint.x, y: toolRowPoint.y, button: 'left', buttons: 1, clickCount: 1,
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toolRowPoint.x, y: toolRowPoint.y, button: 'left', buttons: 0, clickCount: 1,
    })
    await delay(600)
    const webSourcesExpanded = await evaluate(client, MEASURE_EXPRESSION)
    const webSourcesExpandedScreenshot = await writePng(client, 'web-sources-tool-expanded')

    const fixtures = {
      longAnswer: { measurement: longAnswer, samples: summarize(longAnswer) },
      longAnswerCompact: { measurement: longAnswerCompact, samples: summarize(longAnswerCompact) },
      toolRun: { measurement: toolRun, samples: summarize(toolRun) },
      failureRun: { measurement: failureRun, samples: summarize(failureRun) },
      narrowFailure: { measurement: narrow, samples: summarize(narrow) },
      webSources: { measurement: webSourcesMeasured, samples: summarize(webSourcesMeasured) },
      ...Object.fromEntries(highDpiRuns.map((run) => [
        `failureAtDpr${run.scale}`,
        { measurement: run.measurement, samples: summarize(run.measurement) },
      ])),
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

    // 6. Compact display keeps the same legibility contract as normal display.
    const compactSamples = Object.fromEntries(fixtures.longAnswerCompact.samples.map((sample) => [sample.key, sample]))
    expect(compactSamples.body !== undefined, 'compact display rendered no measurable body text')
    expect((compactSamples.body?.contrast ?? 0) >= AA_NORMAL, `compact body contrast ${compactSamples.body?.contrast}`)
    expect(compactSamples.body?.fontSizePx === longSamples.body?.fontSizePx,
      `compact display changed the body font size (${compactSamples.body?.fontSizePx} vs ${longSamples.body?.fontSizePx})`)
    expect(longAnswerCompact.transcriptOverflowPx <= 1, `compact display overflows horizontally by ${longAnswerCompact.transcriptOverflowPx}px`)
    expect(longAnswerCompact.selectedCharacters > 400, 'compact display made the answer unselectable')

    // 7. High DPI must not change the CSS layout contract at all — at every scale factor a real
    //    Windows session can be set to, not only at 2.
    const normalFailure = fixtures.failureRun.samples.find((sample) => sample.key === 'failure')
    for (const run of highDpiRuns) {
      const label = `deviceScaleFactor ${run.scale}`
      const samples = Object.fromEntries(fixtures[`failureAtDpr${run.scale}`].samples.map((sample) => [sample.key, sample]))
      const highDpiFailure = samples.failure
      // Chromium reports a fractional override back at float precision (1.2499999701976776), so
      // the scale check is a tolerance, not equality.
      expect(Math.abs(run.measurement.devicePixelRatio - run.scale) < 0.001,
        `${label} was not applied: devicePixelRatio is ${run.measurement.devicePixelRatio}`)
      expect(run.measurement.viewportWidthPx === run.window.width,
        `${label} changed the CSS viewport width (${run.measurement.viewportWidthPx} vs ${run.window.width})`)
      expect(run.measurement.documentOverflowPx <= 1,
        `the document overflows horizontally by ${run.measurement.documentOverflowPx}px at ${label}`)
      expect(run.measurement.transcriptOverflowPx <= 1,
        `the transcript overflows horizontally by ${run.measurement.transcriptOverflowPx}px at ${label}`)
      expect(highDpiFailure?.fontSizePx === normalFailure?.fontSizePx,
        `${label} changed the failure notice font size (${highDpiFailure?.fontSizePx} vs ${normalFailure?.fontSizePx})`)
      expect((highDpiFailure?.contrast ?? 0) >= AA_NORMAL, `failure contrast at ${label} is ${highDpiFailure?.contrast}`)
    }

    // 8. The sources block is part of the reading surface: same contrast table, same copyability.
    const webSourceSamples = Object.fromEntries(fixtures.webSources.samples.map((sample) => [sample.key, sample]))
    expect(webSourcesMeasured?.webSources?.present === true,
      'the seeded settled run rendered no .web-sources section (the fixture could not be made to render)')
    expect(webSourcesMeasured?.webSources?.rowCount === 2,
      `the sources section rendered ${webSourcesMeasured?.webSources?.rowCount} rows instead of the two seeded citations`)
    expect((webSourcesMeasured?.webSources?.rowHrefs ?? []).filter(Boolean).length === 1,
      `only the citation that kept its URL may be a link: ${JSON.stringify(webSourcesMeasured?.webSources?.rowHrefs)}`)
    expect((webSourceSamples.webSourceTitle?.text ?? '').includes(WEB_SOURCES_TITLE_MARKER),
      `the sources section did not render the seeded citation title: ${JSON.stringify(webSourceSamples.webSourceTitle?.text)}`)
    expect((webSourceSamples.webSourcesHeading?.contrast ?? 0) >= AA_NORMAL,
      `sources heading contrast ${webSourceSamples.webSourcesHeading?.contrast}`)
    expect((webSourceSamples.webSourcesHeadingTitle?.contrast ?? 0) >= AA_NORMAL,
      `sources heading title contrast ${webSourceSamples.webSourcesHeadingTitle?.contrast}`)
    expect((webSourceSamples.webSourceRow?.contrast ?? 0) >= AA_NORMAL,
      `source row contrast ${webSourceSamples.webSourceRow?.contrast}`)
    expect((webSourceSamples.webSourceMeta?.contrast ?? 0) >= AA_NORMAL,
      `source meta line contrast ${webSourceSamples.webSourceMeta?.contrast}`)
    expect((webSourceSamples.webSourceState?.contrast ?? 0) >= AA_NORMAL,
      `source state label contrast ${webSourceSamples.webSourceState?.contrast}`)
    expect((webSourceSamples.webSourcesHeading?.fontSizePx ?? 0) >= WEB_SOURCES_HEADING_MIN_FONT_PX,
      `sources heading font size ${webSourceSamples.webSourcesHeading?.fontSizePx}px is below ${WEB_SOURCES_HEADING_MIN_FONT_PX}px`)
    expect((webSourceSamples.webSourceTitle?.fontSizePx ?? 0) >= WEB_SOURCE_ROW_MIN_FONT_PX,
      `source title font size ${webSourceSamples.webSourceTitle?.fontSizePx}px is below ${WEB_SOURCE_ROW_MIN_FONT_PX}px`)
    expect(webSourceSamples.webSources?.truncatedHorizontally !== true, 'the sources section is clipped horizontally')
    expect(webSourceSamples.webSourceRow?.truncatedHorizontally !== true, 'a source row is clipped horizontally')
    expect((webSourcesMeasured?.webSources?.overflowPx ?? 1) <= 1,
      `the sources section scrolls horizontally by ${webSourcesMeasured?.webSources?.overflowPx}px`)
    expect(webSourcesMeasured?.webSources?.selectedCharacters >= 20,
      `only ${webSourcesMeasured?.webSources?.selectedCharacters} characters of the sources block could be selected`)
    expect(webSourceSamples.webSourceRow?.userSelect !== 'none', 'source rows must be selectable text')
    expect(webSourcesMeasured.transcriptOverflowPx <= 1,
      `the transcript with sources scrolls horizontally by ${webSourcesMeasured.transcriptOverflowPx}px`)

    // 9. A long tool result is collapsed by default, summarised within 180 characters, and only
    //    then expanded into a detail block that scrolls at 180px instead of stretching the turn.
    const seededToolRow = fixtures.webSources.samples.find((sample) => sample.key === 'toolRow')
    expect(seededToolRow !== undefined, 'the seeded run rendered no tool activity row')
    expect((seededToolRow?.contrast ?? 0) >= AA_NORMAL, `seeded tool row contrast ${seededToolRow?.contrast}`)
    const collapsed = webSourcesMeasured?.toolDisclosure
    expect(collapsed?.expanded === 'false', `the tool detail is not collapsed by default (aria-expanded=${collapsed?.expanded})`)
    expect(collapsed?.panelAriaHidden === 'true', `the collapsed tool detail panel is not aria-hidden (${collapsed?.panelAriaHidden})`)
    expect(collapsed?.panelInert === true, 'the collapsed tool detail panel is not inert')
    expect((collapsed?.panelHeightPx ?? 1) <= 1, `the collapsed tool detail panel still occupies ${collapsed?.panelHeightPx}px`)
    expect((collapsed?.summaryCharacters ?? 0) <= TOOL_SUMMARY_MAX_CHARACTERS,
      `the collapsed tool summary is ${collapsed?.summaryCharacters} characters, above the ${TOOL_SUMMARY_MAX_CHARACTERS} character cap`)
    expect(collapsed?.summaryCharacters === TOOL_SUMMARY_MAX_CHARACTERS && collapsed?.summaryHasEllipsis === true,
      `a ${JSON.stringify(LONG_TOOL_INPUT.note.slice(0, 12))}… input must be capped at exactly ${TOOL_SUMMARY_MAX_CHARACTERS} characters with an ellipsis, got ${collapsed?.summaryCharacters} characters (ellipsis: ${collapsed?.summaryHasEllipsis})`)
    const expanded = webSourcesExpanded?.toolDisclosure
    expect(expanded?.expanded === 'true', `the tool row did not expand from a pointer activation (aria-expanded=${expanded?.expanded})`)
    expect(expanded?.panelAriaHidden === 'false', `the expanded tool detail panel is still aria-hidden (${expanded?.panelAriaHidden})`)
    expect(expanded?.panelInert === false, 'the expanded tool detail panel is still inert')
    expect((expanded?.panelHeightPx ?? 0) > 0, 'the expanded tool detail panel has no height')
    expect(expanded?.prePresent === true, 'the expanded tool detail has no detail block')
    expect(expanded?.preMaxHeightPx === `${TOOL_DETAIL_MAX_HEIGHT_PX}px`,
      `the tool detail block is capped at ${expanded?.preMaxHeightPx} instead of ${TOOL_DETAIL_MAX_HEIGHT_PX}px`)
    expect(expanded?.preOverflowY === 'auto' || expanded?.preOverflowY === 'scroll',
      `the tool detail block does not scroll on its own (overflow-y: ${expanded?.preOverflowY})`)
    expect((expanded?.preClientHeightPx ?? 0) <= TOOL_DETAIL_MAX_HEIGHT_PX,
      `the tool detail block is ${expanded?.preClientHeightPx}px tall, above its ${TOOL_DETAIL_MAX_HEIGHT_PX}px cap`)
    expect((expanded?.preScrollHeightPx ?? 0) > (expanded?.preClientHeightPx ?? 0),
      `the tool detail block does not need its own scroll (${expanded?.preScrollHeightPx} vs ${expanded?.preClientHeightPx})`)
    expect((expanded?.preTextCharacters ?? 0) > TOOL_DETAIL_MAX_HEIGHT_PX * 2,
      'the seeded detail text is too short to prove the 180px cap')
    expect((webSourcesExpanded?.transcriptOverflowPx ?? 1) <= 1,
      `the expanded tool detail overflows the transcript horizontally by ${webSourcesExpanded?.transcriptOverflowPx}px`)

    const evidence = {
      window: WORKING_WINDOW,
      minimumWindow: MINIMUM_WINDOW,
      highDpiScales: HIGH_DPI_SCALES,
      highDpiRuns: highDpiRuns.map((run) => ({
        scale: run.scale,
        window: run.window,
        devicePixelRatio: run.measurement.devicePixelRatio,
        viewportWidthPx: run.measurement.viewportWidthPx,
        transcriptOverflowPx: run.measurement.transcriptOverflowPx,
        documentOverflowPx: run.measurement.documentOverflowPx,
        failureFontSizePx: fixtures[`failureAtDpr${run.scale}`].samples.find((sample) => sample.key === 'failure')?.fontSizePx ?? null,
        failureContrast: fixtures[`failureAtDpr${run.scale}`].samples.find((sample) => sample.key === 'failure')?.contrast ?? null,
      })),
      fixtures,
      toolDisclosure: {
        collapsed: webSourcesMeasured?.toolDisclosure ?? null,
        expanded: webSourcesExpanded?.toolDisclosure ?? null,
      },
      webSources: webSourcesMeasured?.webSources ?? null,
      screenshots: {
        longAnswer: longAnswerScreenshot,
        longAnswerCompact: compactScreenshot,
        toolRun: toolRunScreenshot,
        failure: failureScreenshot,
        narrowFailure: narrowScreenshot,
        webSources: webSourcesScreenshot,
        webSourcesToolExpanded: webSourcesExpandedScreenshot,
        highDpi: highDpiRuns.map((run) => ({ scale: run.scale, path: run.screenshot })),
      },
      failures,
      limits: [
        'Device scale factors 1.25/1.5/2 are applied with Emulation.setDeviceMetricsOverride, which is what the renderer reads as devicePixelRatio. This is the rasterisation half of Windows display scaling only: no physical display was set to 125%/150%/200%, and no OS-level DPI change, font fallback difference or ClearType behaviour is covered.',
        'The evidence and accessor data for every fixture in this script is Runtime data. No fixture image, source card, colour or geometry was injected into the DOM.',
        'The .web-sources fixture is a seeded settled run (durable events + settlement registry + execution log + session JSONL) because the deterministic acceptance provider cannot produce web evidence: only the real web_search/web_fetch tools produce a citation projection, and the gate must not reach the network or weaken the retrieval boundary.',
      ],
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
