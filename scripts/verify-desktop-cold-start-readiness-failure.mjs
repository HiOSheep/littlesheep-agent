// Real-window acceptance for genuine startup failures (taskbook CS-06).
//
// The failure page was previously only reachable through the acceptance action
// that renders it on purpose, and "readiness failed" had never been observed in a
// real window at all. Both failure stages are staged here for real:
//
//   A. execution failure  — the config names a model whose provider does not
//      exist, so bootstrap stage 3 throws after the window is already usable;
//   B. bootstrap failure  — `config.json` is invalid JSON, so the failure happens
//      before the renderer is ever loaded.
//
// The two produce different user-visible states, which is the point of measuring
// them instead of assuming: A keeps the live shell and states the failure in the
// readiness notice (the settings needed to fix it stay reachable), B lands on the
// standalone failure page because no renderer exists yet.
//
// It runs without `LITTLESHEEP_ELECTRON_ACCEPTANCE`, so nothing here depends on
// the isolated acceptance surface.
//
// Usage:
//   node scripts/verify-desktop-cold-start-readiness-failure.mjs [--out=docs/reference/cold-start-baseline] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'
import { columnColors, decodePng, hexAt } from './lib/png-pixels.mjs'

const harness = createElectronHarness({ startTimeoutMs: 45_000, actionTimeoutMs: 20_000 })

/** Must equal DESKTOP_STARTUP_SURFACE in `packages/app/src/main/desktop-startup-page.ts`. */
const EXPECTED_SURFACE = '#101010'

/** The model reference case A points at; no provider declares it. */
const MISSING_MODEL = 'missing-provider/missing-model'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoots = process.argv.includes('--keep')

async function main() {
  await harness.assertBuildFresh()
  await mkdir(outDir, { recursive: true })
  const cases = []
  const failures = []

  const executionFailure = await runExecutionFailureCase()
  cases.push(executionFailure.case)
  failures.push(...executionFailure.failures)

  const bootstrapFailure = await runBootstrapFailureCase()
  cases.push(bootstrapFailure.case)
  failures.push(...bootstrapFailure.failures)

  await writeEvidence(outDir, {
    ok: failures.length === 0,
    acceptanceSurfaceMounted: false,
    cases,
    failures,
    limits: [
      'Two failure causes are staged (an unknown model reference and an unparseable config). Other causes share these code paths but are not sampled.',
      'Retrying is not exercised: the bounded retry entry is a known open gap for CS-06, so only what the failure states show is asserted.',
      'The screenshots prove the painted pixels; the timing of the document swap is not measured.',
    ],
  })
  console.log(JSON.stringify({ ok: failures.length === 0, cases, failures }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

/**
 * Stage 3 fails: the window is already showing the shell, so the failure has to be
 * visible *inside* it - send stays disabled and the notice carries the reason.
 */
async function runExecutionFailureCase() {
  const failures = []
  const { root, dataDir, workspaceDir, chromiumDir, logPath, debuggingPort } = await createRoot('execution')
  let client
  let child
  try {
    await writeFile(join(workspaceDir, 'README.md'), '# Failure probe workspace\n', 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_ELECTRON_ACCEPTANCE: '' },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)

    const readiness = await waitForReadiness(locator, 'failed')
    const metadata = await harness.fetchJson(locator, '/sessions')
    const runnerBacked = await harness.fetchJson(locator, '/run-checkpoints')
    if (readiness?.state !== 'failed') {
      failures.push({ check: 'a missing provider makes execution fail loudly', detail: readiness })
    }
    if (!readiness?.reason) {
      failures.push({ check: 'the failed readiness carries the Runtime\'s own reason', detail: readiness })
    }
    if (readiness?.retryable !== true) {
      failures.push({ check: 'the failure is marked retryable', detail: readiness })
    }
    if (metadata?.status !== 200) {
      failures.push({ check: 'metadata routes still answer after an execution failure', detail: metadata })
    }
    if (runnerBacked?.status !== 503) {
      failures.push({ check: 'Runner-backed routes fail closed after an execution failure', detail: runnerBacked })
    }

    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    // The notice is published after readiness flips, so give the renderer a beat
    // and then read the settled state.
    const dom = await harness.waitFor(async () => {
      const state = await readFailureState(client).catch(() => undefined)
      return state?.noticeText ? state : undefined
    }, 20_000, 'failed readiness notice')

    const noticeStates = {
      noticeText: dom.noticeText,
      noticeClasses: dom.noticeClasses,
      noticeLive: dom.noticeLive,
      sendDisabled: dom.sendDisabled,
      hasComposer: dom.hasComposer,
      errorBanners: dom.errorBanners,
      startupErrorPage: dom.startupErrorPage,
      activeRunCount: dom.activeRunCount,
    }
    if (noticeStates.noticeClasses?.includes('failed') !== true) {
      failures.push({ check: 'the shell marks the failure as a failed state', detail: noticeStates })
    }
    if (noticeStates.noticeLive !== 'assertive') {
      failures.push({ check: 'the failure is announced assertively', detail: noticeStates })
    }
    if (typeof readiness?.reason === 'string' && !noticeStates.noticeText?.includes(readiness.reason.replace(/^runner:\s*/u, ''))) {
      failures.push({
        check: 'the notice repeats the Runtime reason verbatim',
        detail: { reason: readiness.reason, notice: noticeStates.noticeText },
      })
    }
    if (noticeStates.sendDisabled !== true) {
      failures.push({ check: 'sending stays disabled after an execution failure', detail: noticeStates })
    }
    if (noticeStates.hasComposer !== true) {
      failures.push({ check: 'the shell stays usable for the settings that fix the failure', detail: noticeStates })
    }
    if (noticeStates.errorBanners.length > 0) {
      failures.push({ check: 'the failure is not duplicated as an error banner', detail: noticeStates })
    }
    if (noticeStates.activeRunCount !== 0) {
      failures.push({ check: 'a failed execution starts no run', detail: noticeStates })
    }
    if (noticeStates.startupErrorPage !== false) {
      failures.push({
        check: 'stage 3 keeps the live shell instead of swapping the document',
        detail: { measured: 'document stayed on the renderer', startupErrorPage: noticeStates.startupErrorPage },
      })
    }

    const capture = await captureWindow(client, join(outDir, 'readiness-failure-execution.png'))
    if (capture.imageSize.width === 0 || capture.imageSize.height === 0) {
      failures.push({ check: 'the failed shell could be captured', detail: capture })
    }

    return {
      case: {
        id: 'execution-failure',
        staged: `config names ${MISSING_MODEL} while no provider declares it`,
        readiness,
        metadataStatus: metadata?.status,
        runnerBackedStatus: runnerBacked?.status,
        runnerBackedError: runnerBacked?.body?.error ?? runnerBacked?.body?.code,
        userVisibleState: 'live shell + failed readiness notice',
        notice: noticeStates,
        screenshot: capture.file,
      },
      failures,
    }
  } catch (error) {
    failures.push({ check: 'the execution-failure case ran', detail: error instanceof Error ? error.message : String(error) })
    return { case: { id: 'execution-failure', error: String(error) }, failures }
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!keepRoots) await harness.removeTemporaryRoot(root)
  }
}

/** Bootstrap fails before any renderer exists, so the standalone page owns the state. */
async function runBootstrapFailureCase() {
  const failures = []
  const { root, dataDir, chromiumDir, logPath, debuggingPort } = await createRoot('bootstrap')
  let client
  let child
  try {
    // Invalid JSON: the config load happens in stage 1, before the renderer loads.
    await writeFile(join(dataDir, 'config.json'), '{ "version": 1, ', 'utf8')
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_ELECTRON_ACCEPTANCE: '' },
    })
    // The locator is written in stage 2, so this case must attach by target rather
    // than by the renderer document that will never load.
    client = await harness.connectDebugger(debuggingPort, 'startup failure page')
    await client.send('Runtime.enable')
    await client.send('Page.enable')

    const page = await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => {
        const error = document.querySelector('.startup-error');
        return {
          url: location.href,
          isFailureDocument: location.href.startsWith('data:text/html'),
          errorText: error ? error.textContent.trim() : null,
          hasIcon: Boolean(document.querySelector('.startup-icon')),
          hasRendererRoot: Boolean(document.querySelector('#root')),
        };
      })()`).catch(() => undefined)
      return state?.isFailureDocument === true && state.errorText !== null ? state : undefined
    }, 45_000, 'bootstrap failure page')

    if (page.hasRendererRoot !== false) {
      failures.push({ check: 'the renderer never loads when stage 1 fails', detail: page })
    }
    if (!/config/iu.test(page.errorText ?? '')) {
      failures.push({ check: 'the failure page names the configuration problem', detail: page })
    }

    const capture = await captureWindow(client, join(outDir, 'readiness-failure-bootstrap.png'))
    if (capture.titlebar !== EXPECTED_SURFACE || capture.leftGutter !== EXPECTED_SURFACE || !capture.gutterFlat) {
      failures.push({ check: 'the failure page paints the declared surface', detail: capture })
    }
    if (capture.cardPainted !== true) {
      failures.push({ check: 'the failure page shows the error card', detail: capture })
    }

    return {
      case: {
        id: 'bootstrap-failure',
        staged: 'config.json holds invalid JSON',
        userVisibleState: 'standalone startup failure page',
        page: { isFailureDocument: page.isFailureDocument, errorText: page.errorText, hasIcon: page.hasIcon },
        surface: { titlebar: capture.titlebar, leftGutter: capture.leftGutter, gutterFlat: capture.gutterFlat },
        cardPainted: capture.cardPainted,
        screenshot: capture.file,
      },
      failures,
    }
  } catch (error) {
    failures.push({ check: 'the bootstrap-failure case ran', detail: error instanceof Error ? error.message : String(error) })
    return { case: { id: 'bootstrap-failure', error: String(error) }, failures }
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!keepRoots) await harness.removeTemporaryRoot(root)
  }
}

async function createRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `littlesheep-readiness-failure-${label}-`))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  return {
    root,
    dataDir,
    workspaceDir,
    chromiumDir: join(root, 'chromium'),
    logPath: join(root, 'electron.log'),
    debuggingPort: await harness.reservePort(),
  }
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    // Deliberately empty: the model below can never be resolved, so building the
    // Runner throws exactly where a misconfigured installation would.
    providers: [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: MISSING_MODEL,
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

async function readFailureState(client) {
  return client.evaluate(`(() => {
    const notice = document.querySelector('.runtime-readiness-notice');
    const send = document.querySelector('.composer-run-actions .send-round');
    return {
      noticeText: notice ? notice.textContent.trim() : null,
      noticeClasses: notice ? notice.className : null,
      noticeLive: notice ? notice.getAttribute('aria-live') : null,
      sendDisabled: send ? send.disabled : null,
      hasComposer: Boolean(document.querySelector('.composer textarea')),
      errorBanners: [...document.querySelectorAll('.composer-error, .runtime-notice-error')].map((node) => node.textContent.trim()),
      startupErrorPage: Boolean(document.querySelector('.startup-error')),
      activeRunCount: document.querySelector('.run-activity-indicator, .composer-stop') ? 1 : 0,
    };
  })()`)
}

async function readReadiness(locator) {
  const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
  return response?.body?.readiness ?? response?.body
}

async function waitForReadiness(locator, state, timeoutMs = 60_000) {
  return harness.waitFor(async () => {
    const readiness = await readReadiness(locator)
    return readiness?.state === state || readiness?.state === 'ready' ? readiness : undefined
  }, timeoutMs, `readiness ${state}`)
}

async function captureWindow(client, file) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const buffer = Buffer.from(shot.data, 'base64')
  await writeFile(file, buffer)
  const image = decodePng(buffer)
  const gutterX = Math.max(1, Math.round(12 * (image.width > 0 ? 1 : 1)))
  const column = columnColors(image, gutterX, 0, Math.max(0, image.height - 1), 1)
  const pixels = [...new Set(column)]
  const cardSurface = hexAt(image, Math.round(image.width / 2), Math.max(0, image.height - 40))
  return {
    file,
    imageSize: { width: image.width, height: image.height },
    titlebar: hexAt(image, Math.round(image.width * 0.45), 16),
    leftGutter: hexAt(image, gutterX, 72),
    gutterFlat: pixels.length === 1,
    gutterColors: pixels.slice(0, 4),
    cardSurface,
    cardPainted: cardSurface !== EXPECTED_SURFACE,
  }
}

/**
 * Evidence keeps no user-profile or repository path: the standalone page quotes
 * the config path it failed on, and the repository does not record machine-local
 * paths (see AGENTS.md, "不把 API key、会话、记忆、执行日志或工作区产物复制进源码仓库").
 */
function scrub(value) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const replacements = [[repoRoot, '<repo>'], [home, '<user-home>']]
  const scrubText = (text) => {
    let result = String(text)
    for (const [from, to] of replacements) {
      if (!from) continue
      result = result.split(from).join(to).split(from.replace(/\\/gu, '/')).join(to)
    }
    return result
      .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, '<user-home>')
      .replace(/[A-Za-z]:\\Temp\\[^\\\s"']+/gu, '<temp>')
  }
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
  }
  return value
}

async function writeEvidence(dir, payload) {
  const path = join(dir, 'cold-start-readiness-failure.json')
  await writeFile(path, `${JSON.stringify(scrub({
    check: 'desktop-cold-start-readiness-failure',
    capturedAt: new Date().toISOString(),
    redaction: 'user-profile and repository path prefixes are replaced with <user-home> / <repo> / <temp>',
    ...payload,
  }), null, 2)}\n`, 'utf8')
}

await main()
