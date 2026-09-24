// Does a generated game artifact actually run?
//
// The acceptance gate can prove a lot statically: the inline scripts parse, there
// are no remote scripts, and the source mentions a canvas, a loop, keyboard input,
// a score and a restart. None of that proves the page *runs* — a game that throws
// on its first frame parses perfectly. Measured on eight real artifacts: one threw
// `TypeError: Cannot read properties of undefined (reading 'length')` from its
// first `draw()`, and the static check had passed it.
//
// This module runs the artifact in the Electron engine the desktop app ships,
// drives it through CDP (start key or start button, arrow keys, restart), and
// reports what a machine can honestly observe: load-time and runtime exceptions,
// the canvas size, whether frames advance, whether input changes the rendering, a
// score readout if one can be located, and whether a restart affordance exists and
// does something. Whether the game is *fun* stays a human judgement.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CdpClient, delay } from './electron-cdp-harness.mjs'
import { resolveVerifiedElectronExecutable } from './electron-runtime.mjs'

const harnessDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(harnessDir, '..', '..')

const KEY_CODES = {
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  ArrowDown: 40,
  Space: 32,
  Enter: 13,
  KeyR: 82,
}

const PAGE_STATE = `(() => {
  const text = (document.body?.innerText ?? '').slice(0, 2_000)
  const scoreMatch = text.match(/(?:score|得分|分数|points?)\\D{0,12}(\\d{1,7})/iu)
  const canvas = document.querySelector('canvas')
  return {
    text,
    score: scoreMatch ? Number(scoreMatch[1]) : null,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    buttons: [...document.querySelectorAll('button, [role="button"], a')]
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean)
      .slice(0, 12),
  }
})()`

const START_LABEL = /start|play|begin|开始|玩|继续|再来/iu
const RESTART_LABEL = /restart|reset|replay|重新开始|再来一局|重开/iu

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One Electron host, many artifacts. `probe(files)` returns one report per file;
 * `close()` kills the host.
 */
export async function createGameArtifactProbe({
  repoRoot: root = repoRoot,
  hostPath = join(harnessDir, 'game-artifact-host.cjs'),
  startTimeoutMs = 30_000,
  probeTimeoutMs = 60_000,
} = {}) {
  const executable = resolveVerifiedElectronExecutable(root, { requireAppBuildManifest: false })
  const chromiumDir = mkdtempSync(join(tmpdir(), 'ls-game-probe-'))
  const port = 9200 + Math.floor(Math.random() * 300)
  const env = { ...process.env, LITTLESHEEP_ELECTRON_ACCEPTANCE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    executable,
    [hostPath, `--remote-debugging-port=${port}`, `--user-data-dir=${chromiumDir}`],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  // The host writes nothing of its own; drain so a full pipe cannot block it.
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  let cdp

  async function waitFor(description, check, timeoutMs = startTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await check().catch(() => undefined)
      if (value) return value
      await delay(120)
    }
    throw new Error(`timed out waiting for ${description}`)
  }

  async function connect() {
    const targetInfo = await waitFor('the Electron page target', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (!response.ok) return undefined
      const targets = await response.json()
      return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
    })
    cdp = new CdpClient(targetInfo.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
  }

  async function screenshot() {
    const result = await withTimeout(cdp.send('Page.captureScreenshot', { format: 'png' }), 8_000, 'Page.captureScreenshot')
    return createHash('sha256').update(result.data).digest('hex').slice(0, 12)
  }

  async function pressKey(key) {
    const code = KEY_CODES[key]
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: key === 'Space' ? ' ' : key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      })
    }
    await delay(90)
  }

  async function clickByLabel(label) {
    return cdp.evaluate(`(() => {
      const node = [...document.querySelectorAll('button, [role="button"], a')]
        .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(label)})
      if (node) node.click()
      return Boolean(node)
    })()`)
  }

  async function probe(file) {
    const exceptions = { load: [], runtime: [] }
    const consoleErrors = []
    let loaded = false
    const drain = () => {
      for (const message of cdp.events.splice(0)) {
        const bucket = loaded ? exceptions.runtime : exceptions.load
        if (message.method === 'Runtime.exceptionThrown') {
          bucket.push((message.params?.exceptionDetails?.exception?.description ?? 'exception').split('\n')[0].slice(0, 200))
        }
        if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
          consoleErrors.push(String(message.params.entry.text).slice(0, 200))
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
          consoleErrors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 200))
        }
      }
    }

    cdp.events.length = 0
    await cdp.send('Page.navigate', { url: pathToFileURL(file).href })
    await waitFor(`${basename(file)} to load`, async () => (await cdp.evaluate('document.readyState')) === 'complete')
    drain()
    loaded = true

    // A game that starts on input is not broken for not animating first; a game
    // that starts on its own is not broken for doing so.
    await delay(500)
    const idleFirst = await screenshot()
    await delay(600)
    const idleSecond = await screenshot()
    const idleAnimating = idleFirst !== idleSecond
    const beforeStart = await cdp.evaluate(PAGE_STATE)

    if (!idleAnimating) {
      const startButton = (beforeStart.buttons ?? []).find((label) => START_LABEL.test(label))
      if (startButton) await clickByLabel(startButton)
      await pressKey('Space')
      await pressKey('Enter')
      await delay(900)
    }
    const startedFirst = await screenshot()
    await delay(600)
    const startedSecond = await screenshot()
    const animatingAfterStart = idleAnimating || startedFirst !== startedSecond

    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowRight', 'Space']) {
      await pressKey(key)
    }
    await delay(2_200)
    const afterPlay = await cdp.evaluate(PAGE_STATE)
    const playing = await screenshot()
    const responding = playing !== startedSecond || afterPlay.score !== beforeStart.score
    drain()

    const restartButton = (afterPlay.buttons ?? []).find((label) => RESTART_LABEL.test(label))
    if (restartButton) await clickByLabel(restartButton)
    else await pressKey('KeyR')
    await delay(1_000)
    const afterRestart = await cdp.evaluate(PAGE_STATE)
    drain()

    const problems = []
    if (exceptions.runtime.length > 0) problems.push(`threw while running: ${exceptions.runtime[0]}`)
    if (!beforeStart.canvas) problems.push('no canvas element')
    // Which of the three phases animates is a *fact about the game*, not a defect:
    // measured here, breakout-style games animate immediately, one snake animates
    // from its menu, and three wait for the first direction key after "start".
    // Only a game that never draws at all is broken.
    const everAnimated = idleAnimating || animatingAfterStart || responding
    if (!everAnimated) problems.push('frames never advanced in any phase (menu, start, input)')
    const verdict = exceptions.runtime.length > 0 || !beforeStart.canvas || !everAnimated
      ? 'broken'
      : (exceptions.load.length > 0 || consoleErrors.length > 0 ? 'needs-a-look' : 'runs')

    return {
      file: basename(file),
      path: file,
      bytes: existsSync(file) ? statSync(file).size : undefined,
      verdict,
      canvas: beforeStart.canvas,
      idleAnimating,
      animatingAfterStart,
      responding,
      animates: idleAnimating ? 'immediately' : animatingAfterStart ? 'after start' : 'on first input',
      scoreBefore: beforeStart.score,
      scoreAfter: afterPlay.score,
      restartAffordance: restartButton ? `button:${restartButton}` : 'key:R',
      restartChanged: afterRestart.text !== afterPlay.text || afterRestart.score !== afterPlay.score,
      loadExceptions: exceptions.load,
      runtimeExceptions: exceptions.runtime,
      consoleErrors,
      visibleTextBeforeStart: (beforeStart.text ?? '').replace(/\s+/gu, ' ').slice(0, 200),
      problems,
    }
  }

  return {
    async probeAll(files) {
      await connect()
      const reports = []
      for (const file of files) {
        try {
          reports.push(await withTimeout(probe(file), probeTimeoutMs, `probing ${basename(file)}`))
        } catch (error) {
          reports.push({
            file: basename(file),
            path: file,
            verdict: 'broken',
            problems: [error.message],
            loadExceptions: [],
            runtimeExceptions: [],
            consoleErrors: [],
          })
        }
      }
      return reports
    },
    async close() {
      cdp?.close()
      child.kill()
      // Chromium helpers can hold the profile briefly; the probe's own temp root
      // is not worth retrying for.
    },
  }
}

/** Convenience wrapper for one directory of artifacts. */
export async function probeGameDirectory(directory, options = {}) {
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(directory)
    .filter((name) => /\.html?$/iu.test(name))
    .sort()
    .map((name) => join(directory, name))
  if (files.length === 0) throw new Error(`no HTML artifacts in ${directory}`)
  const probe = await createGameArtifactProbe(options)
  try {
    return await probe.probeAll(files)
  } finally {
    await probe.close()
  }
}
