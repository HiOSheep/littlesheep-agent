// Real-window acceptance for loading older history (taskbook UX-19).
//
// The last scenario UX-19 lists is "loading older messages": the reader is somewhere in the
// transcript, a whole page is prepended above them, and their reading position must survive the
// height change. The session history page is 120 messages, so this fixture seeds a session with
// more than one page directly into the store (`<data-root>/sessions/<id>.jsonl`, which is the
// same JSONL the app appends to) instead of driving 61 runs to produce it.
//
// Measured: the page the renderer asks for, how many messages it holds, the reader's anchor
// before and after the older page arrives, and the horizontal/vertical geometry afterwards.
//
// Usage:
//   node scripts/verify-chat-history-paging.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-history-paging')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1024, height: 640 }
const SESSION_ID = 'history-paging-session'
const SESSION_TITLE = '历史分页会话'
/** More than `SESSION_HISTORY_PAGE_SIZE` (120) messages, so a second page must exist. */
const SEEDED_MESSAGES = 150
const EVALUATE_TIMEOUT_MS = 20_000

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
  const path = join(outRoot, 'screenshots', `${name}.png`)
  await mkdir(join(outRoot, 'screenshots'), { recursive: true })
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
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
  }
}

/** A conversation longer than one history page, written in the store's own JSONL format. */
async function seedSession(dataDir) {
  const now = Date.now()
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  const lines = [JSON.stringify({
    type: 'metadata',
    metadata: {
      title: SESSION_TITLE,
      model: '',
      createdAt: new Date(now - SEEDED_MESSAGES * 1_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      messageCount: SEEDED_MESSAGES,
    },
  })]
  for (let index = 0; index < SEEDED_MESSAGES; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    lines.push(JSON.stringify({
      id: `history-message-${String(index).padStart(4, '0')}`,
      role,
      content: [{
        type: 'text',
        text: `第 ${index + 1} 条历史消息：这一段用于让历史有一页以上，并让读物在插入更早内容时保持原位。`,
      }],
      timestamp: new Date(now - (SEEDED_MESSAGES - index) * 1_000).toISOString(),
      sessionId: SESSION_ID,
    }))
  }
  await writeFile(join(dataDir, 'sessions', `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({
    sessions: [{
      id: SESSION_ID,
      title: SESSION_TITLE,
      createdAt: now - SEEDED_MESSAGES * 1_000,
      lastMessageAt: now,
      mode: 'research',
      scope: 'standalone',
    }],
  }, null, 2)}\n`, 'utf8')
}

const POSITION_EXPRESSION = `(() => {
  const messages = document.querySelector('.messages')
  if (!(messages instanceof HTMLElement)) return null
  const viewportTop = messages.getBoundingClientRect().top
  const visible = [...messages.querySelectorAll('[data-message-key]')].find((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight
  })
  return {
    renderedMessages: document.querySelectorAll('.message').length,
    scrollTop: Math.round(messages.scrollTop * 100) / 100,
    gap: Math.round((messages.scrollHeight - messages.scrollTop - messages.clientHeight) * 100) / 100,
    anchorKey: visible?.getAttribute('data-message-key') ?? null,
    anchorTop: visible ? Math.round((visible.getBoundingClientRect().top - viewportTop) * 100) / 100 : null,
    overflowX: messages.scrollWidth - messages.clientWidth,
    loadOlderPresent: Boolean(document.querySelector('.history-load-older')),
    loadOlderDisabled: document.querySelector('.history-load-older')?.disabled ?? null,
  }
})()`

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-history-paging-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  // The app resolves a model ref during startup, so a runtime needs a configured provider even
  // though this fixture never makes a model call: without one, readiness fails and the history
  // loader (which waits for execution readiness) never asks for the page.
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await seedSession(dataDir)
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

    // Open the seeded conversation from the sidebar.
    const openedSession = await harness.waitFor(() => evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.session-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(SESSION_TITLE)}))
      if (!(item instanceof HTMLElement)) return null
      item.click()
      return true
    })()`), harness.startTimeoutMs, 'seeded session row')
    if (!openedSession) throw new Error('the seeded session was not listed in the sidebar')

    const firstPage = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${POSITION_EXPRESSION}
      return state && state.renderedMessages > 0 ? state : null
    })()`), harness.startTimeoutMs, 'first history page').catch(async (error) => {
      const diagnostics = {
        readiness: await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined),
        sessions: await evaluate(client, `document.querySelectorAll('.session-item').length`).catch(() => null),
        activeSession: await evaluate(client, `document.querySelector('.session-item.active')?.textContent?.trim() ?? null`).catch(() => null),
        historyLoading: await evaluate(client, `Boolean(document.querySelector('.history-loading'))`).catch(() => null),
        emptyHint: await evaluate(client, `Boolean(document.querySelector('.empty-hint'))`).catch(() => null),
        runtimeError: await evaluate(client, `document.querySelector('.runtime-error, .startup-error, .run-status-error')?.textContent?.trim() ?? null`).catch(() => null),
        composerDisabled: await evaluate(client, `document.querySelector('.composer textarea')?.disabled ?? null`).catch(() => null),
        directRead: await harness.fetchJson(locator, `/sessions/${SESSION_ID}/messages?limit=5`).catch(() => undefined),
      }
      throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`)
    })
    if (!firstPage.loadOlderPresent) throw new Error(`the seeded session rendered no "load older" entry: ${JSON.stringify(firstPage)}`)

    // Read from the top: that is where the button is, and where an insertion above the reader
    // is the strongest test of the anchor.
    await evaluate(client, `(async () => {
      const raf = () => new Promise((done) => requestAnimationFrame(() => done()))
      const messages = document.querySelector('.messages')
      messages.scrollTop = 0
      messages.dispatchEvent(new Event('scroll', { bubbles: true }))
      for (let index = 0; index < 6; index += 1) await raf()
      return true
    })()`)
    await delay(250)
    const beforeLoad = await evaluate(client, POSITION_EXPRESSION)
    const pageRequests = await evaluate(client, `performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/messages'))
      .map((entry) => ({ name: entry.name.split('/sessions/')[1] ?? '', durationMs: Math.round(entry.duration) }))`)

    const clickedAt = await evaluate(client, `(() => {
      const button = document.querySelector('.history-load-older')
      if (!(button instanceof HTMLElement)) return null
      button.click()
      return performance.now()
    })()`)
    if (clickedAt === null) throw new Error('the "load older" control disappeared before it could be used')

    const afterLoad = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${POSITION_EXPRESSION}
      return state && state.renderedMessages > ${beforeLoad.renderedMessages} ? state : null
    })()`), harness.startTimeoutMs, 'older history page')
    await delay(400)
    const settled = await evaluate(client, POSITION_EXPRESSION)
    // The message the reader was looking at is tracked *by key*: "the first visible message" is
    // expected to change when the newly prepended page puts another message at the viewport edge,
    // and comparing those two keys would report a jump that the reader never sees.
    const anchorAfterLoad = await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      const element = messages?.querySelector('[data-message-key=${JSON.stringify(beforeLoad.anchorKey)}]')
      if (!(messages instanceof HTMLElement) || !(element instanceof HTMLElement)) return null
      return {
        key: element.getAttribute('data-message-key'),
        top: Math.round((element.getBoundingClientRect().top - messages.getBoundingClientRect().top) * 100) / 100,
      }
    })()`)
    const afterRequests = await evaluate(client, `performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/messages'))
      .map((entry) => ({ name: entry.name.split('/sessions/')[1] ?? '', durationMs: Math.round(entry.duration) }))`)
    const screenshot = await writePng(client, 'older-history-loaded')

    const results = {
      seededMessages: SEEDED_MESSAGES,
      firstPage,
      beforeLoad,
      afterLoad,
      settled,
      anchorAfterLoad,
      pageRequests,
      afterRequests,
      screenshot,
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    const drift = anchorAfterLoad ? Math.abs(Number(anchorAfterLoad.top) - Number(beforeLoad.anchorTop)) : Number.NaN

    expect(beforeLoad.renderedMessages >= 100 && beforeLoad.renderedMessages < SEEDED_MESSAGES,
      `the first page held ${beforeLoad.renderedMessages} messages, which is not one page of ${SEEDED_MESSAGES}`)
    expect(settled.renderedMessages === SEEDED_MESSAGES,
      `loading older history rendered ${settled.renderedMessages} messages instead of all ${SEEDED_MESSAGES}`)
    expect(anchorAfterLoad !== null, 'the message being read disappeared from the transcript after paging')
    expect(anchorAfterLoad?.key === beforeLoad.anchorKey, 'the older page replaced the message being read')
    expect(drift <= 1, `the older page moved the message being read by ${drift}px`)
    expect(settled.overflowX <= 1, `the transcript overflows horizontally by ${settled.overflowX}px after paging`)
    expect(settled.loadOlderPresent === false, 'the "load older" entry is still offered after the whole history is loaded')

    if (failures.length > 0) {
      throw new Error(`history paging failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'chat-history-paging', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'chat-history-paging',
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
