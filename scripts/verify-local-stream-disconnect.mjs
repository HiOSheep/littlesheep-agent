// Real-window acceptance for a local stream disconnect (taskbook UX-21, last injection class).
//
// The gap this covers is the one between the two transports: the Provider stream (already
// injected in `verify:retry-feedback`) and the *local* stream between the Renderer and the Local
// App API. When that one breaks mid-answer:
//
//   - the run must keep going in Main (the local observer disconnecting is not a cancellation);
//   - the UI must say so and return to idle instead of hanging on a half-finished turn;
//   - reconnecting must not duplicate the answer, and must not replay anything.
//
// The break is injected in the page: `fetch` is wrapped so the `/run/stream` body errors after a
// short budget, which is what a dropped local connection looks like to `consumeRunStream`.
//
// Usage:
//   node scripts/verify-local-stream-disconnect.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-local-stream-disconnect')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1024, height: 640 }
const EVALUATE_TIMEOUT_MS = 15_000
/** How long the injected local stream survives before it errors. */
const CUT_AFTER_MS = 1_200
const EXPECTED = longMarkdownAnswer()

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

/**
 * Wrap fetch so the run stream's body errors after `CUT_AFTER_MS`, once. Everything else passes
 * through untouched, and the wrapper records what it did so the fixture can prove it fired.
 */
const INSTALL_CUT_EXPRESSION = `(() => {
  if (window.__lsCutInstalled) return true
  const originalFetch = window.fetch.bind(window)
  window.__lsCutInstalled = true
  window.__lsStreamCut = null
  window.__lsCutBudgetMs = ${CUT_AFTER_MS}
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const response = await originalFetch(input, init)
    const isRunStream = url.includes('/run/stream')
    if (!isRunStream || !response.body || window.__lsStreamCut) return response
    const reader = response.body.getReader()
    const startedAt = performance.now()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { controller.close(); return }
            controller.enqueue(value)
            if (performance.now() - startedAt > window.__lsCutBudgetMs) {
              window.__lsStreamCut = {
                at: Math.round(performance.now()),
                afterMs: Math.round(performance.now() - startedAt),
                url,
              }
              controller.error(new Error('local app API stream disconnected (acceptance fixture)'))
              return
            }
          }
        } catch (error) {
          controller.error(error)
        }
      },
      cancel(reason) { void reader.cancel(reason).catch(() => undefined) },
    })
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  return true
})()`

/** What the user can see right after the local stream broke. */
const OBSERVE_EXPRESSION = `(() => {
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
  const response = turn?.querySelector('.assistant-response-stream')
  const failureRow = turn?.querySelector('.run-status-error')
  const textarea = document.querySelector('.composer textarea')
  return {
    streamState: response?.getAttribute('data-stream-state') ?? null,
    previewCharacters: (response?.textContent ?? '').length,
    failure: failureRow?.textContent?.trim() ?? null,
    stopping: Boolean(document.querySelector('.composer-run-actions .send-round.stop')),
    draftRestored: textarea instanceof HTMLTextAreaElement ? textarea.value.slice(0, 40) : null,
    cut: window.__lsStreamCut ?? null,
  }
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

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-local-stream-disconnect-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 60, streamChunkCharacters: 24 })
  let electron
  let client
  let locator
  let preserve = false

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await harness.waitForLocator(dataDir, electron.pid)
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
    if (!await evaluate(client, INSTALL_CUT_EXPRESSION)) throw new Error('the stream-cut wrapper could not be installed')

    await submitPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)

    const cut = await harness.waitFor(() => evaluate(client, `window.__lsStreamCut || null`), 60_000, 'injected local stream cut')
    await delay(600)
    const afterCut = await evaluate(client, OBSERVE_EXPRESSION)
    const afterCutScreenshot = await writePng(client, 'after-local-disconnect')

    // The Main-side run must finish on its own: wait for the persisted settlement the fixture's
    // Provider produced while nobody was watching. The session is resolved through the API (by
    // the title the app derived from the prompt) rather than from `localStorage`, because a
    // locally interrupted run never reaches the "run finished" bookkeeping that writes it.
    const settledAt = Date.now()
    const promptTitle = '请输出这份验收文档'
    const sessionId = await harness.waitFor(async () => {
      const sessions = await harness.fetchJson(locator, '/sessions').catch(() => undefined)
      const match = (sessions?.body?.sessions ?? []).find((session) => String(session?.title ?? '').includes(promptTitle))
      return match?.id ?? undefined
    }, 30_000, 'the interrupted run\'s session').catch(() => undefined)
    const persisted = await harness.waitFor(async () => {
      if (!sessionId) return undefined
      const response = await harness.fetchJson(locator, `/sessions/${encodeURIComponent(String(sessionId))}/messages?limit=20`)
      const assistant = (response.body?.messages ?? [])
        .filter((message) => message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim())
        .at(-1)
      return assistant?.text?.includes(LONG_MARKDOWN_END) ? assistant.text : undefined
    }, 90_000, 'the run settling in Main').catch((error) => ({ error: error.message }))
    const settledAfterMs = Date.now() - settledAt
    const localStorageSessionBeforeReload = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)

    // Reconnect: a reload shows the app on its draft view (recorded, not asserted), so the
    // fixture opens the interrupted conversation the way a user would — from the sidebar.
    await client.send('Page.reload', { ignoreCache: false }).catch(() => undefined)
    await delay(1_500)
    client.close()
    client = await harness.connectRenderer(debuggingPort)
    const activeSessionAfterReload = await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`)
    const reopened = await harness.waitFor(() => evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.session-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(promptTitle)}))
      if (!(item instanceof HTMLElement)) return null
      item.click()
      return true
    })()`), harness.startTimeoutMs, 'interrupted session row')
    if (!reopened) throw new Error('the interrupted conversation was not listed after the reload')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.assistant-response-stream')?.textContent?.includes(${JSON.stringify(LONG_MARKDOWN_END)}) || null`),
      harness.startTimeoutMs,
      'restored transcript',
    ).catch(async (error) => {
      const diagnostics = {
        activeSession: await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`).catch(() => null),
        sessions: await evaluate(client, `[...document.querySelectorAll('.session-item')].map((element) => element.textContent?.trim() ?? '')`).catch(() => null),
        messages: await evaluate(client, `document.querySelectorAll('.message').length`).catch(() => null),
        turns: await evaluate(client, `document.querySelectorAll('.assistant-turn').length`).catch(() => null),
        responseText: await evaluate(client, `(document.querySelector('.assistant-response-stream')?.textContent ?? '').slice(0, 200)`).catch(() => null),
        emptyHint: await evaluate(client, `Boolean(document.querySelector('.empty-hint'))`).catch(() => null),
        historyLoading: await evaluate(client, `Boolean(document.querySelector('.history-loading'))`).catch(() => null),
        runtimeError: await evaluate(client, `document.querySelector('.run-status-error')?.textContent?.trim() ?? null`).catch(() => null),
        bodyText: await evaluate(client, `(document.body.innerText ?? '').slice(0, 400)`).catch(() => null),
      }
      const path = await writePng(client, 'reload-diagnostic').catch(() => null)
      throw new Error(`${error.message}: ${JSON.stringify({ ...diagnostics, screenshot: path })}`)
    })
    const afterReload = await evaluate(client, `(() => {
      const stream = document.querySelector('.assistant-response-stream')
      const text = stream?.textContent ?? ''
      return {
        characters: text.length,
        startOccurrences: text.split(${JSON.stringify(LONG_MARKDOWN_START)}).length - 1,
        endOccurrences: text.split(${JSON.stringify(LONG_MARKDOWN_END)}).length - 1,
        normalize: text.replace(/\\s+/gu, ' ').trim(),
      }
    })()`)
    const afterReloadScreenshot = await writePng(client, 'after-reload')

    const normalize = (value) => value.replace(/\s+/gu, ' ').trim()
    const persistedText = typeof persisted === 'string' ? persisted : ''
    const results = {
      cut,
      afterCut,
      settledAfterMs,
      sessionId: sessionId ?? null,
      localStorageSessionBeforeReload,
      activeSessionAfterReload,
      reopenedFromSidebar: reopened,
      persistedCharacters: persistedText.length,
      persistedStartOccurrences: persistedText.split(LONG_MARKDOWN_START).length - 1,
      persistedEndOccurrences: persistedText.split(LONG_MARKDOWN_END).length - 1,
      persistedMatchesFixture: normalize(persistedText) === normalize(EXPECTED),
      providerRequests: provider.requests.length,
      afterReload,
      afterReloadMatchesFixtureProjection: afterReload.normalize === normalize(projectMarkdownToText(EXPECTED)),
      screenshots: { afterCut: afterCutScreenshot, afterReload: afterReloadScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    expect(results.cut !== null, 'the local stream cut was never injected')
    expect(afterCut.failure !== null && afterCut.failure.length > 0, 'the disconnected stream produced no visible failure')
    expect(afterCut.stopping === false, 'the composer stayed in the running state after the local stream broke')
    expect(typeof afterCut.draftRestored === 'string' && afterCut.draftRestored.length > 0,
      'the user input was not returned to the composer after the local stream broke')
    expect(results.providerRequests === 1, `the disconnect caused ${results.providerRequests} Provider requests instead of 1`)
    expect(persistedText.length > 0, 'the run did not finish in Main after the local stream broke')
    expect(results.persistedStartOccurrences === 1 && results.persistedEndOccurrences === 1,
      'the persisted settlement is missing a sentinel or contains the answer twice')
    expect(results.persistedMatchesFixture, 'the settlement persisted in Main differs from the fixture')
    expect(results.afterReload.startOccurrences === 1 && results.afterReload.endOccurrences === 1,
      'the reconnected transcript shows the answer more than once')
    expect(results.afterReloadMatchesFixtureProjection, 'the reconnected transcript differs from the fixture projection')

    if (failures.length > 0) {
      throw new Error(`local stream disconnect acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'local-stream-disconnect', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'local-stream-disconnect',
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
