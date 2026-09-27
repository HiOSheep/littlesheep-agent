import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Process launch/exit, port reservation, the polling helper and the CDP client
// come from the shared real-window harness; the motion assertions below are
// this gate's own.
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'

const START_TIMEOUT_MS = 60_000
const MOTION_SAMPLE_MS = 40
const harness = createElectronHarness({ startTimeoutMs: START_TIMEOUT_MS })
const { CdpClient, delay, waitFor, reservePort, removeTemporaryRoot, waitForExit } = harness

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-panel-collapse-release-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  await mkdir(workplaceDir, { recursive: true })
  await mkdir(chromiumDir, { recursive: true })
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir), null, 2)}\n`, 'utf8')

  const debuggingPort = await reservePort()
  const child = await harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath: join(root, 'electron.log'),
  })
  let client
  let preserve = false
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).catch(() => undefined)
      if (!response?.ok) return undefined
      return (await response.json()).find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl)
    }, START_TIMEOUT_MS, 'renderer debug target')
    client = new CdpClient(target.webSocketDebuggerUrl)
    await waitFor(async () => client.evaluate("Boolean(document.querySelector('.sidebar-resizer'))"), START_TIMEOUT_MS, 'renderer controls')

    const sidebar = await verifySidebar(client)
    const workspace = await verifyWorkspace(client)
    console.log(JSON.stringify({ check: 'panel-collapse-release', ok: true, sidebar, workspace }, null, 2))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({ check: 'panel-collapse-release', ok: false, root, error: error instanceof Error ? error.message : String(error) }, null, 2))
    throw error
  } finally {
    client?.close()
    if (child.exitCode === null) {
      child.kill()
      await waitForExit(child, 10_000).catch(() => undefined)
    }
    if (!preserve) await removeTemporaryRoot(root)
  }
}

async function verifySidebar(client) {
  const initial = await client.evaluate(`(() => {
    const resizer = document.querySelector('.sidebar-resizer')
    const shell = document.querySelector('.window-shell')
    const surface = document.querySelector('.sidebar-surface')
    if (!(resizer instanceof HTMLElement) || !(shell instanceof HTMLElement) || !(surface instanceof HTMLElement)) return null
    const rect = resizer.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: Number(resizer.getAttribute('aria-valuenow')) }
  })()`)
  if (!initial || !Number.isFinite(initial.width)) throw new Error('sidebar resize control was unavailable')

  const samples = await traceDrag(client, initial.x, initial.y, initial.x - initial.width, initial.y, '.sidebar-surface', '.sidebar')
  const final = samples.at(-1)
  if (!final?.shellClasses.includes('sidebar-collapsed')) throw new Error(`sidebar did not collapse: ${JSON.stringify(samples)}`)
  assertReleaseMovesOutward(samples, 'sidebar', 'right')

  await client.evaluate("document.querySelector('.sidebar-toggle-btn')?.click()")
  await waitFor(async () => client.evaluate("!document.querySelector('.window-shell')?.classList.contains('sidebar-collapsed') || null"), START_TIMEOUT_MS, 'sidebar reopen')
  await delay(500)
  return { trace: summarizeTrace(samples, 'sidebar'), reopened: true }
}

async function verifyWorkspace(client) {
  await client.evaluate("(() => { if (document.querySelector('.window-shell')?.classList.contains('workspace-panel-collapsed')) document.querySelector('.workspace-panel-corner-toggle')?.click() })()")
  await waitFor(async () => client.evaluate("document.querySelector('.workspace-panel')?.getBoundingClientRect().width > 0 || null"), START_TIMEOUT_MS, 'workspace open')
  await delay(500)
  const tabRowAlignment = await measureWorkspaceTabRowAlignment(client)
  const initial = await client.evaluate(`(() => {
    const resizer = document.querySelector('.workspace-panel-resizer')
    if (!(resizer instanceof HTMLElement)) return null
    const rect = resizer.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: Number(resizer.getAttribute('aria-valuenow')) }
  })()`)
  if (!initial || !Number.isFinite(initial.width)) throw new Error('workspace resize control was unavailable')

  const samples = await traceDrag(client, initial.x, initial.y, initial.x + initial.width, initial.y, '.workspace-panel-surface', '.workspace-panel')
  const final = samples.at(-1)
  if (!final?.shellClasses.includes('workspace-panel-collapsed')) throw new Error(`workspace did not collapse (initial=${JSON.stringify(initial)}): ${JSON.stringify(samples)}`)
  assertReleaseMovesOutward(samples, 'workspace', 'left')

  await client.evaluate("document.querySelector('.workspace-panel-corner-toggle')?.click()")
  await waitFor(async () => client.evaluate("!document.querySelector('.window-shell')?.classList.contains('workspace-panel-collapsed') || null"), START_TIMEOUT_MS, 'workspace reopen')
  return { tabRowAlignment, trace: summarizeTrace(samples, 'workspace'), reopened: true }
}

async function measureWorkspaceTabRowAlignment(client) {
  const alignment = await client.evaluate(`(() => {
    const toggle = document.querySelector('.workspace-panel-corner-toggle')
    const tabRow = document.querySelector('.workspace-panel-header')
    if (!(toggle instanceof HTMLElement) || !(tabRow instanceof HTMLElement)) return null
    const toggleRect = toggle.getBoundingClientRect()
    const tabRowRect = tabRow.getBoundingClientRect()
    const surface = document.querySelector('.workspace-panel-surface')
    const surfaceRect = surface instanceof HTMLElement ? surface.getBoundingClientRect() : null
    const contents = document.querySelector('.workspace-panel-contents')
    const contentsRect = contents instanceof HTMLElement ? contents.getBoundingClientRect() : null
    const coreRect = document.querySelector('.core-workspace')?.getBoundingClientRect()
    const surfaceStyle = surface instanceof HTMLElement ? getComputedStyle(surface) : null
    const contentsStyle = contents instanceof HTMLElement ? getComputedStyle(contents) : null
    return {
      toggleCenterY: toggleRect.top + toggleRect.height / 2,
      tabRowCenterY: tabRowRect.top + tabRowRect.height / 2,
      deltaY: (toggleRect.top + toggleRect.height / 2) - (tabRowRect.top + tabRowRect.height / 2),
      toggle: { top: toggleRect.top, height: toggleRect.height },
      tabRow: { top: tabRowRect.top, height: tabRowRect.height },
      surface: surfaceRect ? { top: surfaceRect.top, height: surfaceRect.height } : null,
      contents: contentsRect ? { top: contentsRect.top, height: contentsRect.height } : null,
      core: coreRect ? { top: coreRect.top, height: coreRect.height } : null,
      computedTop: getComputedStyle(toggle).top,
      surfaceBorderTop: surfaceStyle?.borderTopWidth,
      contentsPaddingTop: contentsStyle?.paddingTop,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportScale: window.visualViewport?.scale,
    }
  })()`)
  if (!alignment) throw new Error('workspace corner toggle or tab row was unavailable')
  if (Math.abs(alignment.deltaY) > 0.25) {
    throw new Error(`workspace corner toggle is not centered with the tab row: ${JSON.stringify(alignment)}`)
  }
  return Object.fromEntries(Object.entries(alignment).map(([key, value]) => [
    key,
    typeof value === 'number' ? Math.round(value * 100) / 100 : value,
  ]))
}

function assertReleaseMovesOutward(samples, kind, edge) {
  const releaseAt = samples.find((sample) => sample.events?.length)?.events?.[0]?.at ?? Number.POSITIVE_INFINITY
  const afterRelease = samples
    .filter((sample) => sample.at >= releaseAt)
    .filter((sample) => Number.isFinite(sample.surfaceRect?.[edge]))
  if (afterRelease.length === 0) throw new Error(`${kind} has no post-release samples`)

  for (let index = 1; index < afterRelease.length; index += 1) {
    const previous = afterRelease[index - 1].surfaceRect[edge]
    const current = afterRelease[index].surfaceRect[edge]
    const movedBackIntoViewport = kind === 'sidebar'
      ? current > previous + 2
      : current < previous - 2
    if (movedBackIntoViewport) {
      throw new Error(`${kind} surface reversed into the viewport after release: ${JSON.stringify(afterRelease.slice(Math.max(0, index - 3), index + 3).map(compactSample))}`)
    }
  }
}

async function traceDrag(client, fromX, fromY, toX, toY, surfaceSelector, panelSelector) {
  await client.evaluate(`(() => {
    const samples = []
    const events = []
    const rect = (element) => element instanceof HTMLElement
      ? (() => { const value = element.getBoundingClientRect(); return { left: value.left, right: value.right, width: value.width } })()
      : null
    const read = () => {
      const shell = document.querySelector('.window-shell')
      const surface = document.querySelector(${JSON.stringify(surfaceSelector)})
      const panel = document.querySelector(${JSON.stringify(panelSelector)})
      samples.push({
        at: performance.now(),
        shellClasses: shell?.className ?? '',
        surfaceRect: rect(surface),
        panelRect: rect(panel),
        surfaceTransition: surface instanceof HTMLElement ? getComputedStyle(surface).transition : '',
      })
    }
    document.addEventListener('pointerup', (event) => events.push({ type: 'up', at: performance.now(), x: event.clientX }), { once: true, capture: true })
    document.addEventListener('pointercancel', (event) => events.push({ type: 'cancel', at: performance.now(), x: event.clientX }), { once: true, capture: true })
    read()
    window.__panelCollapseTrace = { samples, events, timer: window.setInterval(read, 8) }
  })()`)
  await dragAt(client, fromX, fromY, toX, toY)
  await delay(700)
  return client.evaluate(`(() => {
    const trace = window.__panelCollapseTrace
    if (!trace) return []
    window.clearInterval(trace.timer)
    return trace.samples.map((sample) => ({ ...sample, events: trace.events }))
  })()`)
}

function compactSample(sample) {
  return {
    at: Math.round(sample.at),
    shellClasses: sample.shellClasses,
    surfaceRect: sample.surfaceRect ? {
      left: Math.round(sample.surfaceRect.left * 10) / 10,
      right: Math.round(sample.surfaceRect.right * 10) / 10,
      width: Math.round(sample.surfaceRect.width * 10) / 10,
    } : null,
    panelRect: sample.panelRect ? {
      left: Math.round(sample.panelRect.left * 10) / 10,
      right: Math.round(sample.panelRect.right * 10) / 10,
      width: Math.round(sample.panelRect.width * 10) / 10,
    } : null,
    surfaceTransition: sample.surfaceTransition,
  }
}

function summarizeTrace(samples, kind) {
  const releaseAt = samples[0]?.events?.[0]?.at ?? 0
  const nearRelease = samples
    .filter((sample) => sample.at >= releaseAt - 80 && sample.at <= releaseAt + 420)
    .map(compactSample)
  return {
    kind,
    releaseAt: Math.round(releaseAt),
    samples: nearRelease,
  }
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    providers: [],
    agents: { defaults: { workspace: workspaceDir, model: '', reasoning: 'auto', profile: 'general', timeoutSeconds: 120, maxRecoveryAttempts: 1, timeFormat: 'auto', bootstrapMaxChars: 20_000, bootstrapTotalMaxChars: 60_000, contextCompressionThresholdRatio: 0.8, maxModelCallsPerRun: 8, harness: 'core-flow' } },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function dragAt(client, fromX, fromY, toX, toY) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 })
  const steps = 8
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + (toX - fromX) * ratio,
      y: fromY + (toY - fromY) * ratio,
      button: 'left',
      buttons: 1,
    })
    await delay(8)
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 })
}

await main()
