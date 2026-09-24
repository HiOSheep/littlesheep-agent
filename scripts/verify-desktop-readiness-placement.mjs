// Real-window acceptance for the startup stage text placement (taskbook CS-09).
//
// CS-09 exists because a normal start used to put a full-width status line under
// the titlebar, which reads as a global loading bar for a window that is already
// usable. The contract is now:
//
//   - a normal start states the Runtime's own stage sentence next to the send
//     control, inside the composer control row, and never raises the window-wide
//     strip;
//   - a failure keeps the window-wide strip, the reason and the bounded retry.
//
// This script drives the real window and checks the pixels and geometry, because
// only the DOM can prove *where* the sentence is painted:
//
//   1. normal launches: sample the readiness surfaces as early as the debugger can
//      attach and require that the strip is never observed;
//   2. a deliberately slowed launch (acceptance-only readiness delay, the same
//      Runtime, only the publish is late): measure the hint's box, its ratio to
//      the window, the disabled send entry, the draft, the focus and the right
//      workspace preview, then repeat at a narrow window width, then confirm both
//      surfaces clear once readiness arrives;
//   3. a failing launch: the strip, the Runtime reason and the retry stay visible.
//
// Boundary: the fast case's starting window is ~300 ms, so an attach that lands
// after readiness cannot observe the hint at all. That is recorded as an
// observation, not as a pass; the slowed case is what holds the same state open
// long enough to measure it.
//
// Usage:
//   node scripts/verify-desktop-readiness-placement.mjs [--launches=3] [--out=docs/reference/cold-start-baseline] [--keep]

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, CdpClient, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const screenshotDir = join(outRoot, 'screenshots')
const launches = Number.parseInt(readOption('launches', '3'), 10)
const keepRoots = process.argv.includes('--keep')
const NOT_READY_WINDOW_MS = 7_000
// 800 is the window's own minimum width (desktop-shell.ts minWidth), so this is
// the narrowest real window a user can produce, not an invented size.
const NARROW = { width: 800, height: 660 }
const DEFAULT_SIZE = { width: 1580, height: 900 }
const MISSING_MODEL = 'missing-provider/missing-model'
const PREVIEW_FILE = 'README.md'

const EVALUATE_TIMEOUT_MS = 5_000
const SCREENSHOT_TIMEOUT_MS = 10_000

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

async function capturePng(client, label, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send('Page.bringToFront').catch(() => undefined)
      const shot = await withTimeout(
        client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
        SCREENSHOT_TIMEOUT_MS,
        'Page.captureScreenshot',
      )
      if (shot?.data) return { ...shot, attempts: attempt }
      lastError = new Error('empty capture payload')
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : 'no frame'} (after ${attempts} attempts)`)
}

async function writePng(client, name) {
  const shot = await capturePng(client, name)
  const path = join(screenshotDir, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return { path, attempts: shot.attempts }
}

async function readReadiness(locator) {
  const response = await fetch(harness.apiUrl(locator, '/runtime/readiness')).catch(() => undefined)
  if (!response?.ok) return undefined
  return response.json().catch(() => undefined)
}

async function waitForReady(locator, timeoutMs = 90_000) {
  return harness.waitFor(async () => {
    const state = await readReadiness(locator)
    if (!state || typeof state.state !== 'string') return undefined
    return state.state === 'ready' ? state : undefined
  }, timeoutMs, 'execution readiness')
}

async function setAcceptanceWindowSize(locator, size) {
  const response = await fetch(harness.apiUrl(locator, '/application/acceptance'), {
    method: 'POST',
    headers: { ...harness.authHeaders(locator), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resize', width: size.width, height: size.height }),
  })
  if (!response.ok) throw new Error(`acceptance resize failed: ${response.status}`)
}

/**
 * The readiness surfaces as the user sees them: the local hint, the window-wide
 * strip, and the geometry that decides whether either one spans the window.
 */
async function readSurfaces(client) {
  const read = await evaluate(client, `(() => {
    const hint = document.querySelector('.composer-readiness-hint');
    const strip = document.querySelector('.runtime-readiness-notice');
    const composer = document.querySelector('.composer');
    const send = document.querySelector('.composer-run-actions .send-round');
    const input = document.querySelector('.composer textarea');
    const box = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const hintBox = box(hint);
    const sendBox = box(send);
    const composerBox = box(composer);
    return {
      hintText: hint ? hint.textContent.trim() : null,
      hintBox,
      hintInsideControlRow: hint ? Boolean(hint.closest('.composer-right')) : false,
      stripText: strip ? strip.textContent.trim() : null,
      stripBox: box(strip),
      sendDisabled: send ? send.disabled : null,
      sendLabel: send ? send.getAttribute('aria-label') : null,
      composerBox,
      draft: input ? input.value : null,
      focused: input ? document.activeElement === input : false,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      previewTextLength: (() => {
        const preview = document.querySelector('.workspace-preview-body, .preview-pane-body, .workspace-preview');
        return preview ? preview.textContent.trim().length : null;
      })(),
      hintOverlapsSend: hintBox && sendBox
        ? !(hintBox.right <= sendBox.left || hintBox.left >= sendBox.right || hintBox.bottom <= sendBox.top || hintBox.top >= sendBox.bottom)
        : null,
    };
  })()`)
  return read
}

/** Opens the right workspace panel and one real file inside the not-ready window. */
async function openWorkspacePreview(client) {
  const opened = await evaluate(client, `(() => {
    const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
    if (toggle && document.querySelector('.workspace-panel.collapsed')) toggle.click();
    return Boolean(toggle);
  })()`)
  await harness.waitFor(async () => {
    const rows = await evaluate(client, `document.querySelectorAll('.workspace-tree-row.file').length`)
    return rows > 0 ? rows : undefined
  }, harness.actionTimeoutMs, 'workspace rows')
  const clicked = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row.file')];
    const target = rows.find((row) => row.textContent.includes(${JSON.stringify(PREVIEW_FILE)})) ?? rows[0];
    if (!target) return null;
    target.click();
    return target.textContent.trim();
  })()`)
  await harness.waitFor(async () => {
    const length = await evaluate(client, `(() => {
      const preview = document.querySelector('.workspace-preview-body, .preview-pane-body, .workspace-preview');
      return preview ? preview.textContent.trim().length : 0;
    })()`)
    return length > 200 ? length : undefined
  }, harness.actionTimeoutMs, 'workspace preview body')
  return { opened, clicked }
}

async function typeDraft(client, text) {
  return evaluate(client, `(() => {
    const input = document.querySelector('.composer textarea');
    if (!(input instanceof HTMLTextAreaElement)) return null;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
    return { value: input.value, focused: document.activeElement === input };
  })()`)
}

async function main() {
  await harness.assertBuildFresh()
  await mkdir(screenshotDir, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-readiness-placement-'))
  const fixture = await prepareFixture(root)
  const observations = []
  const failures = []
  const screenshots = {}

  try {
    // 1. Normal launches: the strip must never appear. The starting window is
    //    short, so this also records whether the local hint was caught at all.
    const normal = []
    for (let index = 0; index < launches; index += 1) {
      const launch = await observeNormalStart({ root, fixture, index })
      normal.push(launch)
      if (launch.stripSeen) {
        failures.push({ check: 'a normal start never raises the window-wide strip', detail: launch })
      }
      if (launch.hintWhileStarting && launch.hintSpanRatio !== null && launch.hintSpanRatio > 0.5) {
        failures.push({ check: 'the normal-start stage text stays local', detail: launch })
      }
      if (launch.readinessAfterReady !== 'ready') {
        failures.push({ check: 'every normal launch reaches readiness', detail: launch })
      }
    }
    observations.push({ step: 'normal-launches', launches: normal })
    Object.assign(screenshots, normal[0]?.screenshot ? { normal: normal[0].screenshot } : {})

    // 2. Deliberately slowed start: the same Runtime state, held open long enough
    //    to measure placement, the draft, the focus, the right preview and a
    //    narrow window.
    const slowed = await observeSlowedStart({ root, fixture })
    observations.push({ step: 'slowed-start', ...slowed.observation })
    failures.push(...slowed.failures)
    Object.assign(screenshots, slowed.screenshots)

    // 3. Failing start: the strip, the reason and the retry must stay visible.
    const failing = await observeFailingStart({ root, fixture })
    observations.push({ step: 'failing-start', ...failing.observation })
    failures.push(...failing.failures)
    Object.assign(screenshots, failing.screenshots)

    await writeFile(join(outRoot, 'cold-start-readiness-placement.json'), `${JSON.stringify({
      check: 'desktop-readiness-placement',
      ok: failures.length === 0,
      launches,
      notReadyWindowMs: NOT_READY_WINDOW_MS,
      narrowWindow: NARROW,
      marks: {
        hint: '.composer-readiness-hint - the stage sentence next to the send control',
        strip: '.runtime-readiness-notice - the failure surface under the titlebar',
      },
      screenshots,
      observations,
      failures,
      gaps: [
        'Display scaling above 100% and dark/light wallpaper are not driven here; the',
        'taskbook keeps those as human checks (CS-02).',
      ],
    }, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ ok: failures.length === 0, failures, screenshots }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    if (!keepRoots) await rm(root, { recursive: true, force: true })
    else console.log(`[readiness-placement] kept ${root}`)
  }
}

/** Fixture: one conversation, one workspace with a real Markdown file to preview. */
async function prepareFixture(root) {
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const chromiumDir = join(root, 'chromium')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const paragraphs = Array.from({ length: 180 }, (_value, index) => `第 ${index} 段：右侧工作区在启动期间就应当可读。`).join('\n\n')
  await writeFile(join(workspaceDir, PREVIEW_FILE), `# 启动期间的工作区\n\n${paragraphs}\n`, 'utf8')
  await writeFile(join(workspaceDir, 'notes.md'), '# notes\n\nsecond file\n', 'utf8')
  const now = Date.now()
  const sessions = [{
    id: 'placement-session-0',
    title: '就绪提示摆放验证',
    createdAt: now,
    lastMessageAt: now,
    mode: 'research',
    scope: 'standalone',
  }]
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
  return { dataDir, workspaceDir, chromiumDir, logPath: join(root, 'electron.log') }
}

function buildConfig(workspaceDir, { withProvider }) {
  return {
    version: 1,
    providers: withProvider
      ? [{
          id: 'fixture',
          name: 'Fixture Provider',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKey: 'fixture-key-not-a-credential',
          models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }],
        }]
      : [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: withProvider ? 'fixture/fixture-model' : MISSING_MODEL,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 15,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function startWindow({ fixture, index, extraEnv, withProvider = true, tag }) {
  await writeFile(
    join(fixture.dataDir, 'config.json'),
    `${JSON.stringify(buildConfig(fixture.workspaceDir, { withProvider }), null, 2)}\n`,
    'utf8',
  )
  const debuggingPort = await harness.reservePort()
  const child = await harness.startElectron({
    dataDir: fixture.dataDir,
    chromiumDir: fixture.chromiumDir,
    debuggingPort,
    logPath: join(fixture.dataDir, '..', `electron-${tag}-${index}.log`),
    ...(extraEnv ? { extraEnv } : {}),
  })
  const locator = await harness.waitForLocator(fixture.dataDir, child.pid)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
  return { child, locator, client }
}

/**
 * Normal launch: attach, sample the surfaces tightly for a short window, and
 * record what was actually observable. `stripSeen` is the assertion; whether the
 * hint was caught is an observation, because attach latency is not the app's.
 */
async function observeNormalStart({ root, fixture, index }) {
  const { child, locator, client } = await startWindow({ fixture, index, tag: 'placement-normal' })
  const observedAtAttach = await readReadiness(locator)
  const samples = []
  const deadline = Date.now() + 4_000
  let sawStrip = false
  let hintSample = null
  let screenshot = null
  try {
    while (Date.now() < deadline) {
      const [surfaces, readiness] = await Promise.all([
        readSurfaces(client).catch(() => null),
        readReadiness(locator),
      ])
      if (surfaces) {
        if (surfaces.stripText) sawStrip = true
        if (surfaces.hintText && !hintSample) {
          hintSample = {
            text: surfaces.hintText,
            spanRatio: surfaces.viewport.width > 0 && surfaces.hintBox
              ? Number((surfaces.hintBox.width / surfaces.viewport.width).toFixed(3))
              : null,
            readiness: readiness?.state ?? null,
          }
        }
        samples.push({ readiness: readiness?.state ?? null, hint: surfaces.hintText, strip: surfaces.stripText })
      }
      // Sampling stops at readiness: the question is what the starting window
      // showed, and a post-ready frame cannot answer it.
      if (readiness?.state === 'ready') break
      await delay(25)
    }
    screenshot = await writePng(client, 'readiness-normal-start').catch(() => null)
    const readinessAfterReady = (await waitForReady(locator))?.state
    return {
      index,
      observedAtAttach: observedAtAttach?.state ?? null,
      stripSeen: sawStrip,
      hintWhileStarting: hintSample,
      samples: samples.slice(0, 12),
      readinessAfterReady,
      screenshot,
    }
  } finally {
    client.close()
    if (child.exitCode === null) await harness.forceTerminate(child)
    await delay(400)
  }
}

/**
 * Slowed start: the Runtime is the same, only readiness publication is held back
 * by the acceptance-only delay, so the not-ready window is real and long enough
 * to measure placement, focus, draft, the right preview and a narrow window.
 */
async function observeSlowedStart({ fixture }) {
  const failures = []
  const screenshots = {}
  const observation = { requiredWindowMs: NOT_READY_WINDOW_MS }
  const { child, locator, client } = await startWindow({
    fixture,
    index: 1,
    tag: 'placement-slowed',
    extraEnv: { LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS: String(NOT_READY_WINDOW_MS) },
  })
  try {
    await setAcceptanceWindowSize(locator, DEFAULT_SIZE)
    await delay(300)
    const draft = await typeDraft(client, '启动期间的草稿')
    const preview = await openWorkspacePreview(client)
    const atDefault = await readSurfaces(client)
    const readinessAtDefault = await readReadiness(locator)
    observation.atDefault = { surfaces: atDefault, readiness: readinessAtDefault?.state ?? null, draft, preview }
    screenshots.slowed = await writePng(client, 'readiness-slowed-start').catch(() => null)

    const reason = readinessAtDefault?.reason ?? null
    if (readinessAtDefault?.state !== 'starting') {
      failures.push({ check: 'the slowed window is still starting when the placement is read', detail: observation.atDefault })
    }
    if (!atDefault.hintText) {
      failures.push({ check: 'the startup stage text is on screen while starting', detail: observation.atDefault })
    }
    if (reason && atDefault.hintText !== reason) {
      failures.push({ check: 'the stage text is the Runtime reason, not renderer copy', detail: { reason, text: atDefault.hintText } })
    }
    if (atDefault.hintInsideControlRow !== true) {
      failures.push({ check: 'the stage text sits in the composer control row', detail: observation.atDefault })
    }
    if (atDefault.stripText !== null) {
      failures.push({ check: 'a normal start raises no window-wide strip', detail: observation.atDefault })
    }
    if (atDefault.hintBox && atDefault.composerBox && atDefault.hintBox.bottom > atDefault.composerBox.bottom) {
      failures.push({ check: 'the stage text stays inside the composer', detail: observation.atDefault })
    }
    if (atDefault.sendDisabled !== true) {
      failures.push({ check: 'the send entry is disabled while starting', detail: observation.atDefault })
    }
    if (reason && atDefault.sendLabel !== reason) {
      failures.push({ check: 'the disabled send entry states the Runtime reason', detail: { reason, label: atDefault.sendLabel } })
    }
    if (atDefault.draft !== '启动期间的草稿' || atDefault.focused !== true) {
      failures.push({ check: 'the draft and the focus survive while starting', detail: observation.atDefault })
    }
    if (!(atDefault.previewTextLength > 0)) {
      failures.push({ check: 'the right workspace preview is readable while starting', detail: observation.atDefault })
    }

    // Narrow window: the sentence must not push the control row or overlap it.
    await setAcceptanceWindowSize(locator, NARROW)
    await delay(400)
    const atNarrow = await readSurfaces(client)
    const readinessAtNarrow = await readReadiness(locator)
    observation.atNarrow = { surfaces: atNarrow, readiness: readinessAtNarrow?.state ?? null }
    screenshots.slowedNarrow = await writePng(client, 'readiness-slowed-narrow').catch(() => null)
    if (atNarrow.viewport.width > NARROW.width + 40) {
      failures.push({ check: 'the narrow window really narrowed', detail: observation.atNarrow })
    }
    // Being squeezed to zero width is the same as having no hint at all, which is
    // what CS-09 rejects; the floor in the stylesheet is what this asserts.
    if (!(atNarrow.hintBox?.width > 0) || !atNarrow.hintText) {
      failures.push({ check: 'the stage text survives the narrow window instead of collapsing', detail: observation.atNarrow })
    }
    if (atNarrow.overflowX > 1) {
      failures.push({ check: 'the stage text does not overflow the narrow window', detail: observation.atNarrow })
    }
    if (atNarrow.hintOverlapsSend === true) {
      failures.push({ check: 'the stage text does not overlap the send control', detail: observation.atNarrow })
    }
    if (atNarrow.stripText !== null) {
      failures.push({ check: 'the narrow window raises no window-wide strip either', detail: observation.atNarrow })
    }
    if (atNarrow.previewTextLength !== null && atNarrow.previewTextLength <= 0) {
      failures.push({ check: 'the right preview survives the narrow window', detail: observation.atNarrow })
    }

    // Display scaling proxy: a real 125/150/200% Windows scale factor changes the
    // device pixel ratio, which is what this emulates, while the CSS viewport
    // stays in CSS pixels. It cannot prove how the native caption buttons or the
    // acrylic surface behave at those scales - that stays a human check - but it
    // does prove the stage text keeps its geometry and does not overflow when
    // layout runs on fractional device pixels.
    observation.scaling = []
    for (const deviceScaleFactor of [1.25, 1.5, 2]) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: DEFAULT_SIZE.width,
        height: DEFAULT_SIZE.height,
        deviceScaleFactor,
        mobile: false,
      }).catch(() => undefined)
      await delay(300)
      const scaled = await readSurfaces(client)
      const scaleReadiness = await readReadiness(locator)
      const shot = await writePng(client, `readiness-slowed-scale-${String(deviceScaleFactor).replace('.', '_')}`).catch(() => null)
      observation.scaling.push({ deviceScaleFactor, surfaces: scaled, readiness: scaleReadiness?.state ?? null, screenshot: shot })
      if (scaled.overflowX > 1) {
        failures.push({ check: `the stage text does not overflow at device pixel ratio ${deviceScaleFactor}`, detail: scaled })
      }
      if (scaled.hintOverlapsSend === true) {
        failures.push({ check: `the stage text does not overlap the send control at device pixel ratio ${deviceScaleFactor}`, detail: scaled })
      }
      if (scaled.stripText !== null) {
        failures.push({ check: `no window-wide strip at device pixel ratio ${deviceScaleFactor}`, detail: scaled })
      }
    }
    screenshots.slowedScale = observation.scaling.map((entry) => entry.screenshot).filter(Boolean)
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
    await delay(200)

    // Handoff: both surfaces clear, the draft and the preview stay.
    const ready = await waitForReady(locator)
    await delay(300)
    const afterReady = await readSurfaces(client)
    observation.afterReady = { surfaces: afterReady, readiness: ready?.state ?? null }
    screenshots.slowedReady = await writePng(client, 'readiness-slowed-ready').catch(() => null)
    if (ready?.state !== 'ready') {
      failures.push({ check: 'the slowed launch reaches readiness', detail: observation.afterReady })
    }
    if (afterReady.hintText !== null || afterReady.stripText !== null) {
      failures.push({ check: 'the stage text clears once execution is ready', detail: observation.afterReady })
    }
    if (afterReady.sendDisabled !== false) {
      failures.push({ check: 'the send entry is enabled once execution is ready', detail: observation.afterReady })
    }
    if (afterReady.draft !== '启动期间的草稿' || afterReady.focused !== true) {
      failures.push({ check: 'the draft and the focus survive the handoff', detail: observation.afterReady })
    }
    if (!(afterReady.previewTextLength > 0)) {
      failures.push({ check: 'the right preview survives the handoff', detail: observation.afterReady })
    }
    return { observation, failures, screenshots }
  } catch (error) {
    failures.push({ check: 'the slowed-start case ran', detail: error instanceof Error ? error.message : String(error) })
    return { observation, failures, screenshots }
  } finally {
    client.close()
    if (child.exitCode === null) await harness.forceTerminate(child)
    await delay(400)
  }
}

/** Failing start: the strip and the retry must stay visible where the user reads them. */
async function observeFailingStart({ fixture }) {
  const failures = []
  const screenshots = {}
  const observation = {}
  const { child, locator, client } = await startWindow({
    fixture,
    index: 2,
    tag: 'placement-failing',
    withProvider: false,
  })
  try {
    const readiness = await harness.waitFor(async () => {
      const state = await readReadiness(locator)
      return state?.state === 'failed' ? state : undefined
    }, 60_000, 'failed readiness').catch(() => undefined)
    await delay(300)
    const surfaces = await readSurfaces(client)
    observation.readiness = readiness?.state ?? null
    observation.reason = readiness?.reason ?? null
    observation.surfaces = surfaces
    screenshots.failure = await writePng(client, 'readiness-failure-strip').catch(() => null)
    if (readiness?.state !== 'failed') {
      failures.push({ check: 'the failing launch reports failed readiness', detail: observation })
    }
    if (!surfaces.stripText) {
      failures.push({ check: 'a failure keeps the window-wide strip', detail: observation })
    }
    if (surfaces.hintText !== null) {
      failures.push({ check: 'a failure is not carried by the local hint alone', detail: observation })
    }
    if (readiness?.reason && surfaces.stripText && !surfaces.stripText.includes(readiness.reason)) {
      failures.push({ check: 'the strip states the Runtime reason', detail: { reason: readiness.reason, strip: surfaces.stripText } })
    }
    return { observation, failures, screenshots }
  } catch (error) {
    failures.push({ check: 'the failing-start case ran', detail: error instanceof Error ? error.message : String(error) })
    return { observation, failures, screenshots }
  } finally {
    client.close()
    if (child.exitCode === null) await harness.forceTerminate(child)
    await delay(400)
  }
}

await main()
