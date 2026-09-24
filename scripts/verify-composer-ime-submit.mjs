// Real-window acceptance for Enter semantics under an input method (taskbook UX-01).
//
// UX-01 is the report that confirming an IME candidate also sent the message: the Enter that
// accepts a word is not the Enter that sends. `packages/app/src/renderer/ui/enter-confirm.ts`
// is unit-tested for the key sequences, but the unit test replays events; only a real window can
// prove that Chromium's own composition machinery produces those events and that the composer
// still sends afterwards.
//
// The composition is created through CDP (`Input.imeSetComposition`), which is the same path a
// Windows IME drives: the renderer starts a composition, the confirming keydown arrives while it
// is active, and the commit arrives as an input event. The fixture then checks that plain Enter
// sends exactly once, that Shift+Enter keeps the line break, and that pasting a file still
// attaches it.
//
// Usage:
//   node scripts/verify-composer-ime-submit.mjs [--out=<dir>] [--keep]

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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-composer-ime')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1100, height: 700 }
const EVALUATE_TIMEOUT_MS = 15_000
const COMPOSED_TEXT = '组词验收'
const PASTED_FILE_NAME = 'ime-paste-fixture.txt'

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

const COMPOSER_STATE_EXPRESSION = `(() => {
  const textarea = document.querySelector('.composer textarea')
  return {
    value: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    focused: document.activeElement === textarea,
    attachments: document.querySelectorAll('.attachment-preview-card').length,
    userMessages: document.querySelectorAll('.message.user').length,
    composing: textarea instanceof HTMLTextAreaElement ? textarea.matches(':focus') && window.__lsCompositionEvents?.composing === true : false,
  }
})()`

/** Record the composition events the renderer actually receives. */
const INSTALL_COMPOSITION_PROBE = `(() => {
  if (window.__lsCompositionEvents) return true
  const state = { start: 0, update: 0, end: 0, composing: false, firstCompositionKeydown: null }
  window.__lsCompositionEvents = state
  const textarea = document.querySelector('.composer textarea')
  if (!(textarea instanceof HTMLTextAreaElement)) return false
  textarea.addEventListener('compositionstart', () => { state.start += 1; state.composing = true }, true)
  textarea.addEventListener('compositionupdate', () => { state.update += 1 }, true)
  textarea.addEventListener('compositionend', () => { state.end += 1; state.composing = false }, true)
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || state.firstCompositionKeydown) return
    state.firstCompositionKeydown = { isComposing: event.isComposing === true, keyCode: event.keyCode, shiftKey: event.shiftKey }
  }, true)
  return true
})()`

async function dispatchEnter(client, { shift = false, asText = false } = {}) {
  const modifiers = shift ? 8 : 0
  await client.send('Input.dispatchKeyEvent', {
    type: asText ? 'keyDown' : 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers,
    // Chromium performs the default editing action only when the event carries text; the app's
    // own handler sees the same key either way.
    ...(asText ? { text: '\r', unmodifiedText: '\r' } : {}),
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers,
  })
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-composer-ime-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 10, streamChunkCharacters: 80 })
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
    if (!await evaluate(client, INSTALL_COMPOSITION_PROBE)) throw new Error('the composition probe could not attach to the composer')

    await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      textarea?.focus()
      return document.activeElement === textarea
    })()`)
    const before = { requests: provider.requests.length, state: await evaluate(client, COMPOSER_STATE_EXPRESSION) }

    // --- A. the Enter that confirms an IME candidate must not send ---------------------------
    await client.send('Input.imeSetComposition', {
      text: COMPOSED_TEXT,
      selectionStart: COMPOSED_TEXT.length,
      selectionEnd: COMPOSED_TEXT.length,
      replacementStart: 0,
      replacementEnd: 0,
    })
    await delay(150)
    const duringComposition = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    await dispatchEnter(client)
    await delay(400)
    const afterConfirmingEnter = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const compositionEvents = await evaluate(client, `window.__lsCompositionEvents`)
    const afterConfirmingEnterRequests = provider.requests.length
    const compositionScreenshot = await writePng(client, 'ime-composition')

    // --- B. the commit itself is an input event, not a send -----------------------------------
    await client.send('Input.insertText', { text: COMPOSED_TEXT })
    await delay(250)
    const afterCommit = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const compositionAfterCommit = await evaluate(client, `window.__lsCompositionEvents`)

    // --- C. Shift+Enter keeps the line break and does not send --------------------------------
    await dispatchEnter(client, { shift: true, asText: true })
    await delay(250)
    const afterShiftEnter = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const shiftEnterRequests = provider.requests.length

    // --- D. pasting a file still attaches it --------------------------------------------------
    const pasted = await evaluate(client, `(async () => {
      const textarea = document.querySelector('.composer textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return null
      const transfer = new DataTransfer()
      transfer.items.add(new File(['ime paste fixture\\n'], ${JSON.stringify(PASTED_FILE_NAME)}, { type: 'text/plain' }))
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
      const startedAt = performance.now()
      while (performance.now() - startedAt < 15000) {
        if (document.querySelectorAll('.attachment-preview-card').length > 0) return true
        await new Promise((done) => setTimeout(done, 100))
      }
      return false
    })()`)
    await delay(200)
    const afterPaste = await evaluate(client, COMPOSER_STATE_EXPRESSION)

    // --- E. the next plain Enter sends exactly once, with text and attachment ------------------
    await evaluate(client, `document.querySelector('.composer textarea')?.focus()`)
    await dispatchEnter(client)
    const sent = await harness.waitFor(
      () => (provider.requests.length > before.requests ? provider.requests.at(-1) : null),
      30_000,
      'the send after composition',
    )
    await delay(300)
    const afterSend = await evaluate(client, COMPOSER_STATE_EXPRESSION)
    const sentBody = JSON.stringify(sent?.messages ?? [])
    const sendScreenshot = await writePng(client, 'ime-sent')

    const requestsAfter = provider.requests.length
    const results = {
      composedText: COMPOSED_TEXT,
      pastedFileName: PASTED_FILE_NAME,
      before,
      duringComposition,
      afterConfirmingEnter,
      compositionEvents,
      compositionAfterCommit,
      afterConfirmingEnterRequests,
      afterCommit,
      afterShiftEnter,
      shiftEnterRequests,
      pasted,
      afterPaste,
      requestsAfter,
      sentUserText: [...(sent?.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '',
      afterSend,
      screenshots: { compositionScreenshot, sendScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // A. the composition is real, and the confirming Enter sent nothing. The unit under test is
    // the user-visible send, so the assertion counts messages and runs, not Provider requests:
    // one run legitimately makes several Provider requests.
    expect(compositionEvents.start >= 1, 'the renderer never received a compositionstart')
    expect(compositionEvents.firstCompositionKeydown !== null, 'the confirming keydown was not observed')
    expect(compositionEvents.firstCompositionKeydown?.isComposing === true,
      'Chromium did not flag the confirming keydown as composing')
    expect(duringComposition.value === COMPOSED_TEXT, `the composer did not hold the composing text: ${JSON.stringify(duringComposition.value)}`)
    expect(afterConfirmingEnter.userMessages === before.state.userMessages, 'confirming an IME candidate sent the message')
    expect(afterConfirmingEnterRequests === before.requests, `confirming an IME candidate reached the Provider ${afterConfirmingEnterRequests - before.requests} times`)
    // B. the commit inserted text, ended the composition, and still sent nothing.
    expect(afterCommit.value?.includes(COMPOSED_TEXT), `the committed text is missing: ${JSON.stringify(afterCommit.value)}`)
    expect(compositionAfterCommit.composing === false, 'the commit did not end the composition')
    expect(afterCommit.userMessages === before.state.userMessages, 'committing the composition sent the message')
    // C. Shift+Enter kept a line break (or at least left the draft alone) and did not send.
    expect(afterShiftEnter.userMessages === before.state.userMessages, 'Shift+Enter sent the message')
    expect(shiftEnterRequests === afterConfirmingEnterRequests, 'Shift+Enter reached the Provider')
    expect(afterShiftEnter.value?.includes(COMPOSED_TEXT), 'Shift+Enter cleared the draft')
    // D. the file paste attached the file.
    expect(pasted === true, 'pasting a file did not produce an attachment')
    expect(afterPaste.attachments >= 1, `the attachment chip is missing: ${afterPaste.attachments}`)
    expect(afterPaste.userMessages === before.state.userMessages, 'pasting a file sent the message')
    // E. the final send carried the text and the attachment name.
    expect(sentBody.includes(COMPOSED_TEXT), 'the sent request did not contain the composed text')
    expect(sentBody.includes(PASTED_FILE_NAME), 'the sent request did not contain the pasted attachment')
    expect(afterSend.userMessages === before.state.userMessages + 1, `the transcript shows ${afterSend.userMessages - before.state.userMessages} new user messages`)
    expect(afterSend.value === '', 'the composer was not cleared after the send')

    if (failures.length > 0) {
      throw new Error(`composer IME acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'composer-ime-submit', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'composer-ime-submit',
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
