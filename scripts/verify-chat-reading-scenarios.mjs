// Real-window acceptance for the remaining reading-position scenarios (taskbook UX-19).
//
// `verify:electron-ui-state-continuity` covers viewport height and width changes and
// `verify:chat-streaming-rendering` covers text arriving while the reader is away. The scenarios
// left were the ones a reader triggers themselves, where the risk is that the app "helps" by
// moving them:
//
//   A. the composer grows to several lines while the reader is above the bottom;
//   B. the reader expands a tool detail at their reading position (the disclosure guard);
//   C. the reader switches to another conversation and comes back.
//
// A and B must not move the message being read. C is *recorded* rather than asserted: whether
// returning to a session should restore the old position or start at the newest message is a
// product decision, and the current behaviour (newest message) is documented as such.
//
// Usage:
//   node scripts/verify-chat-reading-scenarios.mjs [--out=<dir>] [--keep]

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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-reading-scenarios')))
const screenshotDir = join(outRoot, 'screenshots')
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1024, height: 640 }
const EVALUATE_TIMEOUT_MS = 15_000
/** A viewport or anchor may settle sub-pixel; anything larger is a real jump. */
const ANCHOR_TOLERANCE_PX = 1

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

/** The reading position: bottom gap, scrollTop, and the first keyed message still on screen. */
const POSITION_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const viewportTop = messages.getBoundingClientRect().top
  const visible = [...messages.querySelectorAll('[data-message-key]')].find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight
  })
  return {
    scrollTop: Math.round(messages.scrollTop * 100) / 100,
    gap: Math.round((messages.scrollHeight - messages.scrollTop - messages.clientHeight) * 100) / 100,
    anchorKey: visible?.getAttribute('data-message-key') ?? null,
    anchorTop: visible ? Math.round((visible.getBoundingClientRect().top - viewportTop) * 100) / 100 : null,
  }
})()`

/** Put the reader 400 px above the bottom and report where they ended up. */
const SCROLL_AWAY_EXPRESSION = `(async () => {
  const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 400)
  messages.dispatchEvent(new Event('scroll', { bubbles: true }))
  for (let index = 0; index < 6; index += 1) await raf()
  return true
})()`

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

async function waitForSettledTurn(client, timeoutMs) {
  // `error` is a page global (window.error), so the local must not shadow it here.
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    const failureNotice = turn?.querySelector('.run-status-error')
    if (response?.getAttribute('data-stream-state') === 'settled') return 'settled'
    if (failureNotice?.textContent?.trim()) return 'failed'
    return null
  })()`), timeoutMs, 'settled turn')
}

/** A tool row that is actually on screen, so clicking it is a reading action. */
const VISIBLE_TOOL_ROW_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const viewportTop = messages.getBoundingClientRect().top
  const row = [...messages.querySelectorAll('.agent-tool-row')].find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.top - viewportTop > 8 && bounds.bottom - viewportTop < messages.clientHeight - 8
  })
  if (!(row instanceof HTMLElement)) return null
  return { label: row.getAttribute('aria-label') ?? row.textContent?.trim().slice(0, 30) ?? '', expanded: row.getAttribute('aria-expanded') }
})()`

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-reading-scenarios-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 10, streamChunkCharacters: 80 })
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

    // A tall transcript with at least one tool row: two long answers and one tool run.
    await submitPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await submitPrompt(client, '请使用 glob 工具列出当前工作区顶层条目')
    await waitForSettledTurn(client, 60_000)
    await submitPrompt(client, `请再输出一次这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await delay(500)

    // --- A. the composer grows while the reader is above the bottom ---------------------------
    await evaluate(client, SCROLL_AWAY_EXPRESSION)
    await delay(200)
    const beforeComposer = await evaluate(client, POSITION_EXPRESSION)
    const composerGrowth = await evaluate(client, `(async () => {
      const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
      const textarea = document.querySelector('.composer textarea')
      const overlay = document.querySelector('.chat')
      if (!(textarea instanceof HTMLTextAreaElement) || !(overlay instanceof HTMLElement)) return null
      const before = Number.parseFloat(getComputedStyle(overlay).getPropertyValue('--composer-overlay-height'))
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, ['第一行', '第二行', '第三行', '第四行', '第五行', '第六行'].join('\\n'))
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      for (let index = 0; index < 20; index += 1) await raf()
      const after = Number.parseFloat(getComputedStyle(overlay).getPropertyValue('--composer-overlay-height'))
      return { overlayBefore: before, overlayAfter: after }
    })()`)
    await delay(400)
    const afterComposer = await evaluate(client, POSITION_EXPRESSION)
    const composerScreenshot = await writePng(client, 'composer-grown')
    await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await delay(400)

    // --- B. expanding a tool detail at the reading position ------------------------------------
    await evaluate(client, SCROLL_AWAY_EXPRESSION)
    await delay(200)
    const beforeDisclosure = await evaluate(client, POSITION_EXPRESSION)
    // Move the reading position so a tool row sits inside the viewport, then click it.
    const disclosure = await evaluate(client, `(async () => {
      const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
      const messages = document.querySelector('.messages')
      const rows = [...messages.querySelectorAll('.agent-tool-row')]
      if (!messages || rows.length === 0) return null
      const target = rows[rows.length - 1]
      target.scrollIntoView({ block: 'center' })
      messages.dispatchEvent(new Event('scroll', { bubbles: true }))
      for (let index = 0; index < 6; index += 1) await raf()
      return true
    })()`)
    const beforeRow = await evaluate(client, POSITION_EXPRESSION)
    const rowInfo = await evaluate(client, VISIBLE_TOOL_ROW_EXPRESSION)
    const expanded = await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      const viewportTop = messages.getBoundingClientRect().top
      const row = [...messages.querySelectorAll('.agent-tool-row')].find((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.top - viewportTop > 0 && bounds.bottom - viewportTop < messages.clientHeight
      })
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return row.getAttribute('aria-expanded') !== null
    })()`)
    await delay(700)
    const afterRow = await evaluate(client, POSITION_EXPRESSION)
    const disclosureScreenshot = await writePng(client, 'tool-expanded')

    // --- C. switching away and coming back (recorded, not asserted) ----------------------------
    // A second conversation has to exist first, and it has to be a real session: the draft the
    // fixture worked in only gains its id once it has run.
    await evaluate(client, `(() => {
      const button = document.querySelector('.sidebar-quick-nav .sidebar-nav-button[aria-label="新对话"]')
      if (button instanceof HTMLElement) button.click()
      return true
    })()`)
    await delay(400)
    await submitPrompt(client, '请简短确认收到这条第二会话的消息。')
    await waitForSettledTurn(client, 45_000)
    await delay(600)

    const sessionTitles = await evaluate(client, `(() => [...document.querySelectorAll('.session-item')]
      .map((element) => ({ title: element.textContent?.trim() ?? '', active: element.classList.contains('active') }))
      .filter((entry) => entry.title))()`)
    let sessionReturn = null
    if (Array.isArray(sessionTitles) && sessionTitles.length >= 2) {
      // Back to the long conversation, then away and back again.
      const toFirst = await evaluate(client, `(() => {
        const items = [...document.querySelectorAll('.session-item')].filter((element) => !element.classList.contains('active'))
        const target = items[0]
        if (!(target instanceof HTMLElement)) return false
        target.click()
        return true
      })()`)
      if (toFirst) {
        await delay(1000)
        await evaluate(client, SCROLL_AWAY_EXPRESSION)
        await delay(250)
        const beforeSwitch = await evaluate(client, POSITION_EXPRESSION)
        const switched = await evaluate(client, `(() => {
          const items = [...document.querySelectorAll('.session-item')]
          const target = items.find((element) => !element.classList.contains('active'))
          if (!(target instanceof HTMLElement)) return false
          target.click()
          return true
        })()`)
        await delay(1000)
        const otherSession = await evaluate(client, POSITION_EXPRESSION)
        const returned = await evaluate(client, `(() => {
          const items = [...document.querySelectorAll('.session-item')]
          const target = items.find((element) => !element.classList.contains('active'))
          if (!(target instanceof HTMLElement)) return false
          target.click()
          return true
        })()`)
        await delay(1200)
        const back = await evaluate(client, POSITION_EXPRESSION)
        sessionReturn = { sessionTitles, beforeSwitch, switched, otherSession, returned, back }
      }
    }

    const results = {
      composerGrowth: { before: beforeComposer, after: afterComposer, overlay: composerGrowth },
      disclosure: { before: beforeRow, after: afterRow, rowInfo, expanded, entry: disclosure, beforeScrollAway: beforeDisclosure },
      sessionReturn,
      screenshots: { composerScreenshot, disclosureScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    const drift = (before, after) => Math.abs(Number(after.anchorTop) - Number(before.anchorTop))

    expect(composerGrowth !== null, 'the composer overlay height could not be measured')
    expect((composerGrowth?.overlayAfter ?? 0) > (composerGrowth?.overlayBefore ?? 0), 'the composer did not actually grow')
    expect(beforeComposer.gap > 300, `the reading position was not away from the bottom: ${beforeComposer.gap}`)
    expect(afterComposer.anchorKey === beforeComposer.anchorKey, 'the composer growth changed which message is being read')
    expect(drift(beforeComposer, afterComposer) <= ANCHOR_TOLERANCE_PX,
      `the composer growth moved the message being read by ${drift(beforeComposer, afterComposer)}px`)
    expect(afterComposer.gap > 300, `the composer growth pulled the reader toward the bottom: ${afterComposer.gap}`)

    expect(expanded, 'no visible tool row could be expanded')
    expect(beforeRow.anchorKey === afterRow.anchorKey, 'expanding a tool detail changed which message is being read')
    expect(drift(beforeRow, afterRow) <= ANCHOR_TOLERANCE_PX,
      `expanding a tool detail moved the message being read by ${drift(beforeRow, afterRow)}px`)

    if (failures.length > 0) {
      throw new Error(`chat reading-position scenarios failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'chat-reading-scenarios', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'chat-reading-scenarios',
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
