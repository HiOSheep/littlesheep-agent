// Real-window benchmark for large workspace directories (taskbook UX-17).
//
// UX-17 says the large-directory cost has to be measured before deciding between hand-rolled
// windowing and a library, and that CS-08's cold-start numbers do not cover it: CS-08 measures
// "the file becomes previewable", not the per-row cost of a big listing.
//
// What the product actually does with a big directory is part of the measurement, not an
// assumption: `listWorkspaceDirectory` in Main reads the whole directory, sorts it, then keeps
// `MAX_WORKSPACE_DIR_ENTRIES` (320) before the renderer ever sees it. So the benchmark measures
// both halves separately:
//
//   1. the Main listing round trip for N entries (readdir + sort + one lstat per kept entry);
//   2. the renderer's cost for what it receives (first row, settled rows, DOM size, scroll
//      frame pacing) — bounded by the cap, which is the point;
//   3. the filter path, including whether a name beyond the cap can be found at all.
//
// Usage:
//   node scripts/verify-workspace-large-directory.mjs [--rows=1000,10000] [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 60_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-large-directory')))
const keepRoot = process.argv.includes('--keep')
const rowCounts = readOption('rows', '1000,10000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0)
const WINDOW = { width: 1280, height: 760 }
const EVALUATE_TIMEOUT_MS = 60_000

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

function buildConfig(workspaceDir) {
  return {
    version: 1,
    providers: [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: '',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
  }
}

/**
 * Seed one directory with `count` files. Two names are deliberate: `aaa-first.txt` sorts first
 * and `zzz-beyond-cap.txt` sorts last, so the fixture can ask whether a filter can reach a name
 * that the 320-entry cap drops.
 */
async function seedDirectory(dir, count) {
  await mkdir(dir, { recursive: true })
  const batchSize = 250
  for (let start = 0; start < count; start += batchSize) {
    const batch = []
    for (let index = start; index < Math.min(count, start + batchSize); index += 1) {
      batch.push(writeFile(join(dir, `file-${String(index).padStart(5, '0')}.txt`), `entry ${index}\n`, 'utf8'))
    }
    await Promise.all(batch)
  }
  await writeFile(join(dir, 'aaa-first.txt'), 'first\n', 'utf8')
  await writeFile(join(dir, 'zzz-beyond-cap.txt'), 'last\n', 'utf8')
}

/** Open the workspace panel on the files tab with the navigator expanded. */
async function seedPreferences(client, workspaceDir) {
  await evaluate(client, `(() => {
    const values = {
      'littlesheep.ui.workspacePanelCollapsed': 'false',
      'littlesheep.ui.workspacePanelFullscreen': 'true',
      'littlesheep.ui.workspacePanelTab': 'files',
      'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify(['files']),
      'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
      'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: {
        collapsed: false, fullscreen: true, activeTab: 'files', openTabs: ['files'],
        openRequest: null, fileNavigatorCollapsed: false, expandedPaths: [], drafts: {}, browserTabs: [],
      } }),
    }
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    return true
  })()`)
  await client.send('Page.reload', { ignoreCache: false }).catch(() => undefined)
  await harness.waitFor(
    () => evaluate(client, `document.querySelector('.workspace-files-navigator') instanceof HTMLElement || null`),
    harness.startTimeoutMs,
    'file navigator after reload',
  )
}

/** Expand one directory inside the navigator (by name) and measure what it costs. */
async function measureDirectoryEntry(client, name) {
  const before = await evaluate(client, `document.querySelectorAll('.workspace-tree-row').length`)
  const started = await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('.workspace-tree-row.directory')]
      .find((element) => element.textContent?.includes(${JSON.stringify(name)}))
    if (!(row instanceof HTMLElement)) return null
    window.__lsLargeDir = { startedAt: performance.now(), name: ${JSON.stringify(name)} }
    row.click()
    return performance.now()
  })()`)
  if (started === null) throw new Error(`directory row "${name}" was not present in the navigator`)

  const firstRow = await harness.waitFor(() => evaluate(client, `(() => {
    const rows = document.querySelectorAll('.workspace-tree-row')
    return rows.length > ${before} ? performance.now() : null
  })()`), 60_000, `${name} first child row`)

  // Settle: the row count must stop changing across timed polls. An off-screen Electron
  // window can throttle animation frames, so rAF is not a reliable wait clock here.
  const settled = await evaluate(client, `(async () => {
    const poll = () => new Promise((done) => setTimeout(done, 30))
    let last = -1
    let stableFrames = 0
    const startedAt = performance.now()
    while (performance.now() - startedAt < 60000) {
      const count = document.querySelectorAll('.workspace-tree-row').length
      if (count === last) stableFrames += 1
      else { stableFrames = 0; last = count }
      if (stableFrames >= 6) break
      await poll()
    }
    return { rows: document.querySelectorAll('.workspace-tree-row').length, settledAt: performance.now() }
  })()`)

  const details = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row')]
    return {
      navigatorRows: rows.length,
      fileRows: rows.filter((row) => row.classList.contains('file')).length,
      directoryRows: rows.filter((row) => row.classList.contains('directory')).length,
      documentNodes: document.querySelectorAll('*').length,
      notices: [...document.querySelectorAll('.workspace-tree-notice')].map((element) => element.textContent?.trim() ?? ''),
      startMs: window.__lsLargeDir?.startedAt ?? null,
      firstChildText: rows[${before}]?.textContent?.trim().slice(0, 40) ?? '',
    }
  })()`)

  return {
    name,
    rowsBefore: before,
    firstChildRowMs: Math.round(firstRow - started),
    settleMs: Math.round(settled.settledAt - started),
    rowsAfterSettle: settled.rows,
    addedRows: settled.rows - before,
    details,
  }
}

/** The element that actually scrolls the tree: the nearest scrollable ancestor of a row. */
const SCROLLER_EXPRESSION = `(() => {
  const row = document.querySelector('.workspace-tree-row')
  let node = row?.parentElement ?? null
  while (node) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight - node.clientHeight > 40) {
        return { className: typeof node.className === 'string' ? node.className : '', scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
      }
    }
    node = node.parentElement
  }
  return null
})()`

/** Synchronous layout cost while scrolling the tree from top to bottom. */
async function measureScrollPacing(client) {
  return evaluate(client, `(async () => {
    const row = document.querySelector('.workspace-tree-row')
    let scroller = null
    let node = row?.parentElement ?? null
    while (node) {
      if (node instanceof HTMLElement) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight - node.clientHeight > 40) { scroller = node; break }
      }
      node = node.parentElement
    }
    if (!(scroller instanceof HTMLElement)) return null
    scroller.scrollTop = 0
    const deltas = []
    const steps = 30
    for (let step = 1; step <= steps; step += 1) {
      const startedAt = performance.now()
      scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * (step / steps))
      void scroller.offsetHeight
      deltas.push(Math.round((performance.now() - startedAt) * 100) / 100)
    }
    const sorted = [...deltas].sort((left, right) => left - right)
    return {
      scroller: typeof scroller.className === 'string' ? scroller.className : '',
      mode: 'sync-layout',
      scrollRange: scroller.scrollHeight - scroller.clientHeight,
      frames: deltas.length,
      averageMs: Math.round((deltas.reduce((total, value) => total + value, 0) / deltas.length) * 100) / 100,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      worstMs: sorted.at(-1),
      longFrames: deltas.filter((value) => value > 50).length,
    }
  })()`)
}

/**
 * What an *uncapped* tree would cost, as a synthetic layout probe.
 *
 * This is deliberately not the product path: the product keeps `MAX_WORKSPACE_DIR_ENTRIES`
 * rows, which is why the decision "hand-rolled windowing or a library" needs to know what the
 * uncapped shape would have cost. Clones of a real row are appended to an off-screen container
 * with the tree's own class and measured with a forced layout, so the number describes this
 * renderer's DOM/layout cost per row rather than an invented component.
 */
async function measureUncappedRowCost(client, counts) {
  return evaluate(client, `(async () => {
    const sample = document.querySelector('.workspace-tree-row')
    const host = sample?.parentElement
    if (!(sample instanceof HTMLElement) || !(host instanceof HTMLElement)) return null
    const container = document.createElement('div')
    container.className = host.className
    container.style.position = 'fixed'
    container.style.left = '-20000px'
    container.style.top = '0'
    container.style.width = '320px'
    document.body.append(container)
    const results = []
    for (const count of ${JSON.stringify(counts)}) {
      const startedAt = performance.now()
      const fragment = document.createDocumentFragment()
      for (let index = 0; index < count; index += 1) {
        const clone = sample.cloneNode(true)
        clone.textContent = 'file-' + String(index).padStart(5, '0') + '.txt'
        fragment.append(clone)
      }
      container.append(fragment)
      const laidOutAt = performance.now()
      void container.offsetHeight
      results.push({ rows: count, createMs: Math.round(laidOutAt - startedAt), layoutMs: Math.round((performance.now() - laidOutAt) * 10) / 10 })
      container.replaceChildren()
    }
    container.remove()
    return results
  })()`)
}

/** Type a query into the navigator filter and report what the tree shows. */
async function measureFilter(client, query) {
  const before = await evaluate(client, `document.querySelectorAll('.workspace-tree-row').length`)
  const focusProbe = await evaluate(client, `(() => {
    const input = document.querySelector('.workspace-shared-file-navigator .workspace-file-filter input')
    if (!(input instanceof HTMLInputElement)) return null
    input.focus()
    return { focused: document.activeElement === input, navigatorClass: input.closest('.workspace-shared-file-navigator')?.className,
      rect: input.getBoundingClientRect().toJSON(), activeTab: document.querySelector('.workspace-tab-view.active')?.className,
      tabs: [...document.querySelectorAll('.workspace-tab-strip [role="tab"]')].map((tab) => ({ text: tab.textContent?.trim(), active: tab.getAttribute('aria-selected'), kind: tab.getAttribute('data-workspace-tab-kind') })) }
  })()`)
  if (!focusProbe?.focused) return { query, supported: false, focusProbe }
  const started = await evaluate(client, `(() => {
    const input = document.querySelector('.workspace-shared-file-navigator .workspace-file-filter input')
    if (!(input instanceof HTMLInputElement)) return null
    input.focus()
    input.select()
    return performance.now()
  })()`)
  if (started === null) return { query, supported: false }
  if (query) {
    await client.send('Input.insertText', { text: query })
  } else {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  const result = await evaluate(client, `(async () => {
    const poll = () => new Promise((done) => setTimeout(done, 30))
    const startedAt = performance.now()
    while (performance.now() - startedAt < 2000) {
      const tree = document.querySelector('.workspace-shared-file-navigator .workspace-tree')
      if (tree?.getAttribute('data-filter-ready') === ${JSON.stringify(query.toLowerCase())}) break
      await poll()
    }
    const rows = [...document.querySelectorAll('.workspace-tree-row')]
    return {
      rows: rows.length,
      matched: rows.some((row) => row.textContent?.includes(${JSON.stringify(query)})),
      ready: document.querySelector('.workspace-shared-file-navigator .workspace-tree')?.getAttribute('data-filter-ready'),
      inputValue: document.querySelector('.workspace-shared-file-navigator .workspace-file-filter input')?.value ?? null,
      sample: rows.slice(0, 3).map((row) => row.textContent?.trim().slice(0, 30) ?? ''),
      settledAt: performance.now(),
    }
  })()`)
  return { query, supported: true, ms: Math.round(result.settledAt - started), rowsBefore: before, addedRows: result.rows - before, ...result }
}

async function measureFilterKeystrokes(client, query) {
  const steps = []
  for (let length = 1; length <= query.length; length += 1) {
    const result = await measureFilter(client, query.slice(0, length))
    steps.push({ length, ms: result.ms, rows: result.rows, ready: result.ready })
  }
  return steps
}

async function measureKeyboardNavigation(client) {
  const setup = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row')]
    const firstFile = rows.findIndex((row) => row.classList.contains('file'))
    const lastFile = rows.findLastIndex((row) => row.classList.contains('file'))
    rows[firstFile]?.focus()
    return { count: rows.filter((row) => row.classList.contains('file')).length, steps: lastFile - firstFile }
  })()`)
  if (setup.count < 320) return { ...setup, reachedLast: false, ms: null }
  const started = Date.now()
  for (let index = 0; index < setup.steps; index += 1) {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  }
  const reachedLast = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row.file')]
    return document.activeElement === rows.at(-1)
  })()`)
  return { ...setup, reachedLast, ms: Date.now() - started }
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-large-directory-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  let electron
  let client
  let preserve = false

  try {
    await mkdir(outRoot, { recursive: true })
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    const fixtures = []
    for (const count of rowCounts) {
      const name = `large-${count}`
      const seededAt = Date.now()
      await seedDirectory(join(workplaceDir, name), count)
      fixtures.push({ name, count, seedMs: Date.now() - seededAt })
    }
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
    await harness.desktopAction(locator, 'show')
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.bringToFront')
    await seedPreferences(client, workplaceDir)

    const results = []
    for (const fixture of fixtures) {
      // Main-side listing cost, measured over the real route the renderer uses.
      const listingSamples = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const startedAt = Date.now()
        const response = await harness.fetchJson(
          locator,
          `/workspace/list?root=${encodeURIComponent(workplaceDir)}&path=${encodeURIComponent(join(workplaceDir, fixture.name))}`,
        )
        listingSamples.push({
          ms: Date.now() - startedAt,
          status: response.status,
          entries: response.body?.entries?.length ?? 0,
          truncated: response.body?.truncated ?? null,
          hiddenCount: response.body?.hiddenCount ?? null,
        })
        await delay(120)
      }
      const entry = await measureDirectoryEntry(client, fixture.name)
      await evaluate(client, `document.querySelector('.workspace-tree-row.file')?.click()`)
      await harness.waitFor(
        () => evaluate(client, `document.querySelector('.workspace-shared-file-navigator:not(.inactive) .workspace-file-filter input') ? true : null`),
        20_000,
        'file tab and active navigator',
      )
      const scroller = await evaluate(client, SCROLLER_EXPRESSION)
      const pacing = await measureScrollPacing(client)
      const filterBeyondCap = await measureFilter(client, 'zzz-beyond-cap')
      const filterFirst = await measureFilter(client, 'aaa-first')
      await measureFilter(client, '')
      const keystrokes = await measureFilterKeystrokes(client, 'zzz')
      await measureFilter(client, '')
      const keyboard = await measureKeyboardNavigation(client)
      results.push({ ...fixture, listing: listingSamples, entry, scroller, scrollPacing: pacing, filterBeyondCap, filterFirst, keystrokes, keyboard })
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    for (const result of results) {
      expect(result.listing.every((sample) => sample.status === 200), `${result.name}: the listing route did not answer 200`)
      expect(result.listing.every((sample) => sample.entries <= 320), `${result.name}: the renderer received more than the cap allows`)
      expect(result.entry.addedRows <= 321, `${result.name}: the tree rendered ${result.entry.addedRows} child rows for a capped listing`)
      expect(result.filterBeyondCap.matched === true, `${result.name}: a file beyond the initial cap cannot be reached by filtering`)
      expect(result.keystrokes.every((step) => step.ready === 'zzz'.slice(0, step.length)), `${result.name}: a filter keystroke did not settle`)
      expect(result.keyboard.reachedLast === true, `${result.name}: keyboard Tab did not reach the last file row`)
      expect(result.scrollPacing === null || result.scrollPacing.longFrames === 0,
        `${result.name}: ${result.scrollPacing?.longFrames} long frames while scrolling the navigator`)
    }
    // The synthetic probe must grow monotonically; a flat result would mean it measured nothing.
    const uncappedRowCost = await measureUncappedRowCost(client, [320, 2_000, 10_000])
    expect(Array.isArray(uncappedRowCost) && uncappedRowCost.length === 3, 'the uncapped row-cost probe did not run')
    if (Array.isArray(uncappedRowCost) && uncappedRowCost.length === 3) {
      expect(uncappedRowCost[2].createMs > uncappedRowCost[0].createMs,
        'the uncapped row-cost probe did not grow with the row count')
    }

    const evidence = { window: WINDOW, uncappedRowCost: uncappedRowCost, results, failures }
    if (failures.length > 0) {
      throw new Error(`large-directory benchmark left the recorded envelope: ${JSON.stringify(evidence)}`)
    }
    console.log(JSON.stringify({ check: 'workspace-large-directory', ok: true, evidence }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'workspace-large-directory',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    if (!preserve && !keepRoot) await harness.removeTemporaryRoot(root)
  }
}

await main()
