// Workspace-availability measurement (taskbook CS-08).
//
// The complaint is that entering the right-hand workspace panel shows a shell
// while the real directory and file content are still missing, so this measures
// the moments a user can actually read something, from process start:
//
//   1. first directory row visible          (`renderer-workspace-entries`)
//   2. restored file content visible        (`renderer-workspace-preview`)
//   3. click a file -> its content visible  (measured in the renderer, per click)
//
// A skeleton or a "读取中" placeholder publishes neither mark: both are emitted
// after the frame that shows real content.
//
// The layout has to be persisted for the restore path to exist at all, and that
// lives in the Chromium profile (a `file://` document's localStorage), not in the
// data root. A warm-up launch therefore seeds the panel preferences and the open
// file tab, and every measured launch reuses both the profile and the data root -
// which is also the "same data root, next launch" case CS-08 asks for.
//
// Usage:
//   node scripts/measure-workspace-availability.mjs [--samples=3] [--label=workspace-before]
//                                                   [--out=docs/reference/cold-start-baseline] [--keep] [--dir-entries=60]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })

const WORKSPACE_PANEL_COLLAPSED_KEY = 'littlesheep.ui.workspacePanelCollapsed'
const WORKSPACE_PANEL_TAB_KEY = 'littlesheep.ui.workspacePanelTab'
const WORKSPACE_PANEL_OPEN_TABS_KEY = 'littlesheep.ui.workspacePanelOpenTabs'
const WORKSPACE_PANEL_OPEN_ROOT_KEY = 'littlesheep.ui.workspacePanelOpenRoot'
const WORKSPACE_PANEL_OPEN_PATH_KEY = 'littlesheep.ui.workspacePanelOpenPath'
const WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY = 'littlesheep.ui.workspaceFileNavigatorCollapsed'

/** The file the fixture restores into the preview pane. */
const PREVIEW_FILE = 'README.md'
/** A second file, for the click-to-preview measurement. */
const CLICK_FILE = 'docs/guide.md'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const samples = Math.max(1, Number.parseInt(readOption('samples', '3'), 10))
const label = readOption('label', 'workspace-unlabeled')
const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoots = process.argv.includes('--keep')
const directoryEntries = Math.max(4, Number.parseInt(readOption('dir-entries', '60'), 10))
const MARK_TIMEOUT_MS = 60_000

async function main() {
  await harness.assertBuildFresh()
  const startedAt = new Date()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-workspace-availability-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const chromiumDir = join(root, 'chromium')
  const runs = []

  try {
    const fixture = await prepareFixture({ dataDir, workspaceDir, directoryEntries })
    // 1. Warm-up: seed the persisted layout in the Chromium profile.
    const warmup = await launch({ dataDir, workspaceDir, chromiumDir, index: 0, measure: false })
    runs.push(warmup.run)
    if (!warmup.ok) {
      console.log(JSON.stringify({ ok: false, stage: 'warmup', run: warmup.run }, null, 2))
      process.exitCode = 1
      return
    }

    // 2. Measured cold starts on the same data root and profile.
    for (let index = 1; index <= samples; index += 1) {
      const measured = await launch({ dataDir, workspaceDir, chromiumDir, index, measure: true })
      runs.push(measured.run)
    }

    // 3. Click-to-preview on a live window (uses the last measured run's window).
    const click = await measureClickToPreview({ dataDir, workspaceDir, chromiumDir, index: samples + 1 })
    runs.push(click.run)

    // 4. The same two things while execution is deliberately unavailable: the
    //    taskbook's claim is that the right side does not wait for the Runner.
    const notReady = await measureWhileNotReady({ dataDir, workspaceDir, chromiumDir, index: samples + 2 })
    runs.push(notReady.run)

    const summary = summarize(runs)
    await mkdir(outDir, { recursive: true })
    const ledger = {
      check: 'desktop-workspace-availability',
      label,
      startedAt: startedAt.toISOString(),
      samples,
      fixture,
      options: { directoryEntries, previewFile: PREVIEW_FILE, clickFile: CLICK_FILE },
      marks: {
        entries: 'renderer-workspace-entries: process start -> first directory row painted',
        preview: 'renderer-workspace-preview: process start -> restored file body painted',
        click: 'click -> that file body painted (renderer timeline, not process start)',
      },
      runs,
      summary,
      note: [
        'Cold starts reuse one data root and one Chromium profile, so the persisted',
        'workspace layout is restored exactly as a returning user would see it.',
        'The marks are only emitted when LITTLESHEEP_BOOTSTRAP_TIMING=1, and only',
        'after the frame that shows real content - a placeholder cannot publish them.',
      ],
    }
    const jsonPath = join(outDir, `desktop-workspace-availability-${label}.json`)
    await writeFile(jsonPath, `${JSON.stringify(scrub(ledger), null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ ok: true, jsonPath, summary, runs }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    if (!keepRoots) await harness.removeTemporaryRoot(root)
    else console.log(`[workspace] kept ${root}`)
  }
}

/** Fixture: a realistic workspace tree plus the config that points at it. */
async function prepareFixture({ dataDir, workspaceDir, directoryEntries }) {
  await mkdir(join(workspaceDir, 'docs'), { recursive: true })
  await mkdir(join(workspaceDir, 'src', 'renderer'), { recursive: true })
  await mkdir(join(workspaceDir, 'src', 'main'), { recursive: true })
  await mkdir(join(workspaceDir, 'fixtures'), { recursive: true })

  const previewBody = buildMarkdownDocument(220)
  await writeFile(join(workspaceDir, PREVIEW_FILE), previewBody, 'utf8')
  await writeFile(join(workspaceDir, CLICK_FILE), buildMarkdownDocument(160), 'utf8')
  await writeFile(join(workspaceDir, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
  await writeFile(join(workspaceDir, 'src', 'renderer', 'view.tsx'), 'export function View() { return null }\n', 'utf8')
  await writeFile(join(workspaceDir, 'src', 'main', 'entry.ts'), 'console.log("entry")\n', 'utf8')
  for (let index = 0; index < directoryEntries; index += 1) {
    const name = `fixtures/sample-${String(index).padStart(3, '0')}.md`
    await writeFile(join(workspaceDir, name), `# Sample ${index}\n\n${'line\n'.repeat(20)}`, 'utf8')
  }

  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')
  return {
    workspaceDir,
    dataDir,
    previewFile: PREVIEW_FILE,
    previewBytes: Buffer.byteLength(previewBody, 'utf8'),
    clickFile: CLICK_FILE,
    directoryEntries,
    totalFiles: directoryEntries + 5,
  }
}

function buildMarkdownDocument(paragraphs) {
  const lines = ['# Workspace availability fixture', '']
  for (let index = 0; index < paragraphs; index += 1) {
    lines.push(`## Section ${index}`, '', `Paragraph ${index} with enough text to be a real preview body.`, '')
  }
  return lines.join('\n')
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    providers: [{
      id: 'fixture',
      name: 'Fixture Provider',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-key-not-a-credential',
      models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'fixture/fixture-model',
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

async function launch({ dataDir, workspaceDir, chromiumDir, index, measure }) {
  const logPath = join(dataDir, '..', `electron-${measure ? 'measured' : 'warmup'}-${index}.log`)
  const debuggingPort = await harness.reservePort()
  const run = { index, kind: measure ? 'measured' : 'warmup', ok: false, marks: {}, dom: {}, timings: {} }
  let client
  let child
  try {
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')

    if (!measure) {
      // Warm-up: the panel starts collapsed, so there is nothing to restore until
      // the app has saved a layout with a file tab. Drive it the way a user would
      // (open the panel, open a file) and let the app persist its own state -
      // writing localStorage from here loses to the app's own first write.
      await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
      const opened = await client.evaluate(`(() => {
        const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
        if (!toggle) return { opened: false, reason: 'no panel toggle' };
        toggle.click();
        return { opened: true, label: toggle.getAttribute('aria-label') ?? toggle.textContent.trim() };
      })()`)
      run.dom = { opened }
      await waitForDom(client, 'entries')
      const fileOpened = await client.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.workspace-tree-row.file')];
        const target = rows.find((row) => row.textContent.includes(${JSON.stringify(PREVIEW_FILE)})) ?? rows[0];
        if (!target) return { opened: false, rows: rows.length };
        target.click();
        return { opened: true, label: target.textContent.trim(), rows: rows.length };
      })()`)
      const previewVisible = fileOpened.opened === true
        ? await waitForDom(client, 'preview').then(() => true).catch(() => false)
        : false
      // Persistence is debounced; give it time before the process is taken away,
      // otherwise the measured launches have nothing to restore.
      await delay(2500)
      const persisted = await client.evaluate(`(() => {
        const raw = localStorage.getItem('littlesheep.ui.workspaceSessionLayouts');
        const parsed = raw ? JSON.parse(raw) : null;
        const entries = parsed ? Object.entries(parsed) : [];
        const withFileTab = entries.find(([, layout]) => Array.isArray(layout?.openTabs)
          && layout.openTabs.some((tab) => typeof tab === 'string' && tab.startsWith('file:')));
        // Derived facts only: tab ids are percent-encoded absolute paths and the
        // ledger is published, so it records shapes rather than identifiers.
        return {
          layoutCount: entries.length,
          openTabCounts: entries.map(([, layout]) => layout?.openTabs?.length ?? 0),
          hasFileTab: Boolean(withFileTab),
          panelCollapsed: withFileTab?.[1]?.collapsed ?? null,
          activeTabKind: typeof withFileTab?.[1]?.activeTab === 'string'
            ? withFileTab[1].activeTab.split(':')[0]
            : null,
        };
      })()`)
      run.dom = { opened, fileOpened, previewVisible, persisted, mirror: await readLayoutMirror(dataDir) }
      run.ok = previewVisible === true && persisted.hasFileTab === true
      if (!run.ok) run.note = 'the warm-up did not persist a file tab to restore'
      // A user closes the app; that quit path is what flushes the durable layout
      // mirror. Killing the process here would leave the mirror at its earlier
      // (review-only) snapshot and the measured launches would restore that.
      await harness.desktopAction(locator, 'quit').catch(() => undefined)
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await delay(100)
      return { ok: run.ok, run }
    }

    const bootstrapTimings = await harness.readBootstrapTimings(logPath)
    const markAt = (stage) => bootstrapTimings.find((entry) => entry.stage === stage)
    // A missing mark is a result too: collect whatever exists instead of losing
    // the run to a timeout, so the ledger says what actually happened.
    const entries = await waitForMark(logPath, 'renderer-workspace-entries').catch(() => undefined)
    const preview = await waitForMark(logPath, 'renderer-workspace-preview').catch(() => undefined)
    const frame = markAt('renderer-first-frame')
    const ready = markAt('execution-ready')
    run.marks = {
      firstFrameProcessUptimeMs: frame?.processUptimeMs,
      entriesProcessUptimeMs: entries?.processUptimeMs,
      entriesRendererMs: entries?.durationMs,
      previewProcessUptimeMs: preview?.processUptimeMs,
      previewRendererMs: preview?.durationMs,
      executionReadyProcessUptimeMs: ready?.processUptimeMs,
    }
    run.timings = {
      processCreateToFirstFrameMs: frame?.processUptimeMs,
      processCreateToEntriesMs: entries?.processUptimeMs,
      processCreateToPreviewMs: preview?.processUptimeMs,
      processCreateToExecutionReadyMs: ready?.processUptimeMs,
    }
    run.dom = await readWorkspaceDom(client)
    run.readinessAtAttach = await readReadiness(locator)
    run.ok = run.dom.entryRows > 0 && run.dom.previewTextLength > 0
    if (entries === undefined) run.note = 'the navigator never published visible entries'
    else if (preview === undefined) run.note = 'the restored file never published visible content'
    return { ok: run.ok, run }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
    return { ok: false, run }
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
  }
}

/**
 * Directory and preview while execution is still starting (CS-08).
 *
 * The acceptance-only readiness delay widens that window so the assertions can
 * run inside it: the panel must show real rows and a real file body while
 * `/runtime/readiness` still says `starting`, and readiness must still arrive
 * afterwards without the content being reset.
 */
async function measureWhileNotReady({ dataDir, workspaceDir, chromiumDir, index }) {
  const logPath = join(dataDir, '..', `electron-not-ready-${index}.log`)
  const debuggingPort = await harness.reservePort()
  const run = { index, kind: 'while-not-ready', ok: false, requiredWindowMs: 6_000 }
  let client
  let child
  try {
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: {
        LITTLESHEEP_BOOTSTRAP_TIMING: '1',
        LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS: String(run.requiredWindowMs),
      },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)

    await client.evaluate(`(() => {
      const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
      if (toggle && document.querySelector('.workspace-panel.collapsed')) toggle.click();
      return true;
    })()`)
    await waitForDom(client, 'entries')
    const readinessAtEntries = await readReadiness(locator)
    const domAtEntries = await readWorkspaceDom(client)

    await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.workspace-tree-row.file')];
      const target = rows.find((row) => row.textContent.includes(${JSON.stringify(CLICK_FILE.split('/').at(-1))})) ?? rows[0];
      target?.click();
      return Boolean(target);
    })()`)
    await waitForDom(client, 'preview')
    const readinessAtPreview = await readReadiness(locator)
    const domAtPreview = await readWorkspaceDom(client)

    run.marks = {
      entriesProcessUptimeMs: (await waitForMark(logPath, 'renderer-workspace-entries').catch(() => undefined))?.processUptimeMs,
      previewProcessUptimeMs: (await waitForMark(logPath, 'renderer-workspace-preview').catch(() => undefined))?.processUptimeMs,
    }
    const ready = await waitForReadiness(locator, 'ready')
    const domAfterReady = await readWorkspaceDom(client)
    run.observations = {
      readinessAtEntries: readinessAtEntries?.state,
      readinessAtPreview: readinessAtPreview?.state,
      rowsAtEntries: domAtEntries.entryRows,
      previewTextAtPreview: domAtPreview.previewTextLength,
      readinessAfterWait: ready?.state,
      previewTextAfterReady: domAfterReady.previewTextLength,
    }
    run.ok = readinessAtEntries?.state === 'starting'
      && readinessAtPreview?.state === 'starting'
      && domAtEntries.entryRows > 0
      && domAtPreview.previewTextLength > 0
      && ready?.state === 'ready'
      && domAfterReady.previewTextLength > 0
    if (!run.ok) run.note = 'directory or preview content was not readable inside the not-ready window'
    return { ok: run.ok, run }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
    return { ok: false, run }
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
  }
}

/** Click a file row in the live panel and time it to painted content. */
async function measureClickToPreview({ dataDir, workspaceDir, chromiumDir, index }) {
  const logPath = join(dataDir, '..', `electron-click-${index}.log`)
  const debuggingPort = await harness.reservePort()
  const run = { index, kind: 'click-to-preview', ok: false }
  let client
  let child
  try {
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
    })
    await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    // The panel may start collapsed in a fresh profile, and the preview pane only
    // exists on a file tab, so open the panel and a file the way a user would.
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
    await client.evaluate(`(() => {
      const toggle = document.querySelector('.workspace-panel-corner-toggle, .workspace-panel-reopen-target');
      if (toggle && document.querySelector('.workspace-panel.collapsed')) toggle.click();
      return true;
    })()`)
    await waitForDom(client, 'entries').catch(() => undefined)
    const clicked = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.workspace-tree-row.file')];
      const target = rows.find((row) => row.textContent.includes('README.md')) ?? rows[0];
      if (!target) return { clicked: false, rows: rows.length };
      target.click();
      return { clicked: true, label: target.textContent.trim(), at: performance.now() };
    })()`)
    run.clicked = clicked
    if (clicked.clicked === true) {
      const settled = await harness.waitFor(async () => {
        const state = await client.evaluate(`(() => {
          const body = document.querySelector('.workspace-preview-body');
          const text = body ? body.textContent.trim() : '';
          return { textLength: text.length, at: performance.now() };
        })()`).catch(() => undefined)
        return state?.textLength > 0 ? state : undefined
      }, 30_000, 'preview content after click')
      run.clickToPreviewMs = Math.round((settled.at - clicked.at) * 10) / 10
      run.previewTextLength = settled.textLength
      // The mark must exist when content was really painted; this is the same
      // emitter the cold-start metric uses, so it fails loudly if it drifts.
      const previewMark = await waitForMark(logPath, 'renderer-workspace-preview').catch(() => undefined)
      run.previewMarkProcessUptimeMs = previewMark?.processUptimeMs
      run.previewMarkEmitted = previewMark !== undefined
      run.ok = run.previewMarkEmitted === true
      if (!run.ok) run.note = 'the preview was visible but the mark was not published'
    } else {
      run.note = 'the click target row was not present'
    }
    return { ok: run.ok === true, run }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error)
    return { ok: false, run }
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
  }
}

/**
 * Persists the panel layout that makes the restore path exist.
 *
 * Panel state lives in the per-session layout mirror
 * (`littlesheep.ui.workspaceSessionLayouts`), not in the older flat preference
 * keys: seeding those alone leaves the panel collapsed and the tree unrendered.
 * The draft scope is the one a window without a selected conversation uses, and
 * the app adopts it into the real session when one appears.
 */
async function seedWorkspaceLayout(client, { workspaceDir, file }) {
  const path = `${workspaceDir}\\${file.split('/').join('\\')}`
  const tabId = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(path)}`
  const layout = {
    collapsed: false,
    fullscreen: false,
    activeTab: tabId,
    openTabs: [tabId],
    openRequest: null,
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: 320,
    expandedPaths: [workspaceDir],
    drafts: {},
    browserTabs: [],
  }
  await client.evaluate(`(() => {
    localStorage.setItem('littlesheep.ui.workspaceSessionLayouts', JSON.stringify({
      __draft__: ${JSON.stringify(layout)},
    }));
    // Kept for older readers of the flat keys; the layout mirror is what counts.
    localStorage.setItem(${JSON.stringify(WORKSPACE_PANEL_COLLAPSED_KEY)}, 'false');
    localStorage.setItem(${JSON.stringify(WORKSPACE_FILE_NAVIGATOR_COLLAPSED_KEY)}, 'false');
    localStorage.setItem(${JSON.stringify(WORKSPACE_PANEL_TAB_KEY)}, ${JSON.stringify(tabId)});
    localStorage.setItem(${JSON.stringify(WORKSPACE_PANEL_OPEN_TABS_KEY)}, JSON.stringify([${JSON.stringify(tabId)}]));
    localStorage.setItem(${JSON.stringify(WORKSPACE_PANEL_OPEN_ROOT_KEY)}, ${JSON.stringify(workspaceDir)});
    localStorage.setItem(${JSON.stringify(WORKSPACE_PANEL_OPEN_PATH_KEY)}, ${JSON.stringify(path)});
    return true;
  })()`)
  await delay(600)
}

/** The durable layout mirror Main owns, reduced to shapes (no paths, no ids). */
async function readLayoutMirror(dataDir) {
  const raw = await readFile(join(dataDir, 'workspace', 'layout.json'), 'utf8').catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Object.values(parsed?.snapshots ?? {}).map((snapshot) => ({
      collapsed: snapshot?.collapsed ?? null,
      activeTabKind: typeof snapshot?.activeTab === 'string' ? snapshot.activeTab.split(':')[0] : null,
      openTabKinds: (snapshot?.openTabs ?? []).map((tab) => String(tab).split(':')[0]),
    }))
  } catch {
    return 'unreadable'
  }
}

async function waitForDom(client, expect) {
  return harness.waitFor(async () => {
    const state = await readWorkspaceDom(client).catch(() => undefined)
    if (!state) return undefined
    if (expect === 'entries' && state.entryRows === 0) return undefined
    if (expect === 'preview' && state.previewTextLength === 0) return undefined
    return state
  }, MARK_TIMEOUT_MS, `workspace ${expect} in the DOM`)
}

async function readWorkspaceDom(client) {
  return client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.workspace-tree-row')];
    const body = document.querySelector('.workspace-preview-body');
    return {
      panelPresent: Boolean(document.querySelector('.workspace-panel')),
      navigatorPresent: Boolean(document.querySelector('.workspace-files-navigator')),
      entryRows: rows.length,
      fileRows: rows.filter((row) => row.classList.contains('file')).length,
      previewPanePresent: Boolean(document.querySelector('.workspace-preview-pane')),
      previewTextLength: body ? body.textContent.trim().length : 0,
      placeholderText: document.querySelector('.workspace-preview-body .workspace-placeholder')?.textContent?.trim() ?? null,
      treeNotice: document.querySelector('.workspace-tree-notice')?.textContent?.trim() ?? null,
    };
  })()`)
}

async function readReadiness(locator) {
  const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
  return response?.body?.readiness ?? response?.body
}

async function waitForMark(logPath, stage, timeoutMs = MARK_TIMEOUT_MS) {
  return harness.waitFor(async () => {
    const marks = await harness.readBootstrapTimings(logPath).catch(() => [])
    return marks.find((entry) => entry.stage === stage)
  }, timeoutMs, stage)
}

/** Poll readiness until it reaches `state` (used to bracket the not-ready case). */
async function waitForReadiness(locator, state, timeoutMs = 60_000) {
  return harness.waitFor(async () => {
    const readiness = await readReadiness(locator)
    return readiness?.state === state ? readiness : undefined
  }, timeoutMs, `readiness ${state}`)
}

function summarize(runs) {
  const measured = runs.filter((run) => run.kind === 'measured' && run.ok)
  const clicks = runs.filter((run) => run.kind === 'click-to-preview' && run.ok)
  const metric = (values) => {
    const sorted = values.filter((value) => typeof value === 'number').sort((left, right) => left - right)
    if (sorted.length === 0) return null
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    return { samples: sorted.length, min: sorted[0], median: Math.round(median * 10) / 10, max: sorted[sorted.length - 1] }
  }
  return {
    measuredRuns: measured.length,
    failedRuns: runs.filter((run) => run.kind !== 'warmup' && !run.ok).length,
    processCreateToFirstFrameMs: metric(measured.map((run) => run.timings.processCreateToFirstFrameMs)),
    processCreateToEntriesMs: metric(measured.map((run) => run.timings.processCreateToEntriesMs)),
    processCreateToPreviewMs: metric(measured.map((run) => run.timings.processCreateToPreviewMs)),
    processCreateToExecutionReadyMs: metric(measured.map((run) => run.timings.processCreateToExecutionReadyMs)),
    clickToPreviewMs: metric(clicks.map((run) => run.clickToPreviewMs)),
  }
}

/**
 * Public evidence keeps no machine-local path or account name: the fixture lives
 * under the temporary directory, and the repository rule is that published docs
 * and scripts carry neither (AGENTS.md, "不把 API key、会话、记忆、执行日志或工作区产物复制进源码仓库").
 */
function scrub(value) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const scrubText = (text) => {
    let result = String(text)
    for (const [from, to] of [[repoRoot, '<repo>'], [home, '<user-home>']]) {
      if (!from) continue
      result = result.split(from).join(to).split(from.replace(/\\/gu, '/')).join(to)
    }
    return result
      .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, '<user-home>')
      .replace(/[A-Za-z]:\\Temp\\[^\\\s"']+/gu, '<temp>')
      .replace(/AppData\\Local\\Temp\\[^\\\s"']+/gu, '<temp>')
      .replace(/[A-Za-z]%3A(?:%5C|\\){1,2}Users(?:%5C|\\){1,2}[^%\\\s"']+/giu, '<user-home>')
      .replace(/[A-Za-z]%3A(?:%5C|\\){1,2}Temp(?:%5C|\\){1,2}[^%\\\s"']+/giu, '<temp>')
  }
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
  }
  return value
}

await main()
