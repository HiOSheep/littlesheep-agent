// Real-window acceptance for the review navigator's own width (taskbook UX-18).
//
// The review view's leading column used to borrow the file navigator's width, so
// widening a large diff also moved the file tree. The claim under test is that the
// two widths are independent values: each can be changed, each survives a restart,
// each survives the narrow window that clamps only the *rendered* width, and the
// single/two-column preference and the shared collapse state stay as they were.
//
// The fixture is a real Git workspace (one modified file, one untracked file) so
// the review navigator lists real changes instead of an empty state, and the whole
// window is driven through real pointer and keyboard input.
//
// Usage:
//   node scripts/verify-review-navigator-width.mjs [--keep]

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WIDE = { width: 1280, height: 840 }
const NARROW = { width: 800, height: 600 }
const DEFAULT_NAVIGATOR_WIDTH = 214
const REVIEW_WIDEN_PX = 120
const FILE_WIDEN_PX = 36
const MIN_WIDTH = 160
const MAX_WIDTH = 520
const CONTENT_MIN_WIDTH = 96
const README_NAME = 'README.md'

/** Counts the workspace traffic the review surface is allowed to cause. */
const PROBE_SOURCE = `(() => {
  if (window.__littlesheepReviewProbe) return true;
  const probe = { workspaceList: 0, workspaceReview: 0 };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function probedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/workspace/list')) probe.workspaceList += 1;
    if (url.includes('/workspace/review')) probe.workspaceReview += 1;
    return originalFetch(input, init);
  };
  window.__littlesheepReviewProbe = probe;
  return true;
})()`

/** Everything the acceptance reads, taken from the live window in one pass. */
const SURFACE_EXPRESSION = `(() => {
  const rect = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
      right: Math.round(box.right), bottom: Math.round(box.bottom),
    };
  };
  const aria = (node) => node ? {
    now: Number(node.getAttribute('aria-valuenow')),
    min: Number(node.getAttribute('aria-valuemin')),
    max: Number(node.getAttribute('aria-valuemax')),
  } : null;
  const reachable = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2));
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit) && (hit === node || node.contains(hit) || hit.contains(node));
  };
  /** Why a control is (not) reachable: its own box and what actually sits on top. */
  const hitReport = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2)),
      Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2)),
    );
    return {
      rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      hit: hit ? (hit.tagName.toLowerCase() + '.' + String(hit.className).split(' ').filter(Boolean).slice(0, 3).join('.')) : null,
      reachable: reachable(node),
    };
  };
  const visible = (node) => Boolean(node)
    && !node.closest('[inert]')
    && getComputedStyle(node).visibility !== 'hidden'
    && node.getBoundingClientRect().width > 0;
  const panel = document.querySelector('.workspace-panel');
  const review = document.querySelector('.workspace-review');
  const reviewNavigator = review?.querySelector('.workspace-files-navigator') ?? null;
  const reviewResizer = review?.querySelector('.workspace-files-navigator-resizer') ?? null;
  const sharedWrapper = document.querySelector('.workspace-shared-file-navigator');
  const fileNavigator = sharedWrapper?.querySelector('.workspace-files-navigator') ?? null;
  const fileResizer = sharedWrapper?.querySelector('.workspace-files-navigator-resizer') ?? null;
  const layoutStorage = (() => {
    try {
      const raw = localStorage.getItem('littlesheep.ui.workspaceSessionLayouts');
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return { parseError: String(error) };
    }
  })();
  return {
    activeTabLabel: document.querySelector('.workspace-active-item.active .workspace-active-label-text')?.textContent?.trim() ?? null,
    tabLabels: [...document.querySelectorAll('.workspace-active-item .workspace-active-label-text')].map((node) => (node.textContent || '').trim()),
    reviewVisible: visible(review),
    reviewRect: rect(review),
    fileNavigatorVisible: visible(fileNavigator) && !sharedWrapper?.classList.contains('inactive'),
    sideBySide: review ? review.classList.contains('is-side-by-side') : null,
    sideBySideToggle: (() => {
      const toggle = document.querySelector('.workspace-review-diff-actions button[aria-pressed]');
      return toggle ? { pressed: toggle.getAttribute('aria-pressed'), label: toggle.getAttribute('aria-label'), reachable: reachable(toggle) } : null;
    })(),
    refreshReachable: reachable(document.querySelector('[aria-label="刷新 Git 更改"]')),
    filterReachable: reachable(document.querySelector('[aria-label="筛选更改文件"]')),
    /** The diff surface must end where the navigator starts, not run under it. */
    diffHeaderEndsBeforeNavigator: (() => {
      const header = document.querySelector('.workspace-review-diff-header');
      const navigator = review?.querySelector('.workspace-files-navigator');
      if (!header || !navigator) return null;
      return Math.round(header.getBoundingClientRect().right)
        <= Math.round(navigator.getBoundingClientRect().left) + 1;
    })(),
    diffActionsReachable: [...document.querySelectorAll('.workspace-review-diff-actions button')].map((node) => reachable(node)),
    treeRows: review ? review.querySelectorAll('[role="treeitem"]').length : 0,
    reviewNavigator: {
      rect: rect(reviewNavigator),
      aria: aria(reviewResizer),
      collapsed: reviewNavigator?.classList.contains('navigator-collapsed') ?? null,
      resizerReachable: reachable(reviewResizer),
      resizerHit: hitReport(reviewResizer),
      scrollOverflow: reviewNavigator ? reviewNavigator.scrollWidth - reviewNavigator.clientWidth : null,
    },
    controlHits: {
      sideBySide: hitReport(document.querySelector('.workspace-review-diff-actions button[aria-pressed]')),
      refresh: hitReport(document.querySelector('[aria-label="刷新 Git 更改"]')),
      filter: hitReport(document.querySelector('[aria-label="筛选更改文件"]')),
    },
    fileNavigator: {
      rect: rect(fileNavigator),
      aria: aria(fileResizer),
      collapsed: fileNavigator?.classList.contains('navigator-collapsed') ?? null,
      inactiveWrapper: sharedWrapper?.classList.contains('inactive') ?? null,
      scrollOverflow: fileNavigator ? fileNavigator.scrollWidth - fileNavigator.clientWidth : null,
    },
    panel: {
      rect: rect(panel),
      fullscreen: panel?.classList.contains('fullscreen') ?? null,
      collapsed: panel?.classList.contains('collapsed') ?? null,
      scrollOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
    },
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    layoutStorage,
    sideBySidePreference: localStorage.getItem('littlesheep.ui.workspaceReviewSideBySide'),
    probe: window.__littlesheepReviewProbe
      ? { workspaceList: window.__littlesheepReviewProbe.workspaceList, workspaceReview: window.__littlesheepReviewProbe.workspaceReview }
      : null,
  };
})()`

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function createRecorder() {
  const observations = []
  const failures = []
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      if (!condition) failures.push({ check, detail })
      return Boolean(condition)
    },
    failures,
    observations,
  }
}

function runGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

/** A real workspace with one modified and one untracked file. */
async function writeWorkspace(workspaceDir) {
  await mkdir(join(workspaceDir, 'src'), { recursive: true })
  const original = [
    'export interface Sample {',
    '  id: number',
    '  label: string',
    '}',
    '',
    'export function describe(sample: Sample): string {',
    '  return `${sample.id}: ${sample.label}`',
    '}',
    '',
  ]
  await writeFile(join(workspaceDir, 'src', 'sample.ts'), `${original.join('\n')}`, 'utf8')
  await writeFile(join(workspaceDir, README_NAME), '# Review navigator fixture\n', 'utf8')
  runGit(workspaceDir, ['init', '--initial-branch=main'])
  runGit(workspaceDir, ['config', 'user.email', 'review-navigator@example.invalid'])
  runGit(workspaceDir, ['config', 'user.name', 'Review Navigator'])
  runGit(workspaceDir, ['add', '.'])
  runGit(workspaceDir, ['commit', '-m', 'fixture'])
  await writeFile(join(workspaceDir, 'src', 'sample.ts'), `${[
    'export interface Sample {',
    '  id: number',
    '  label: string',
    '  active: boolean',
    '}',
    '',
    'export function describe(sample: Sample): string {',
    '  const state = sample.active ? "active" : "idle"',
    '  return `${sample.id}: ${sample.label} (${state})`',
    '}',
    '',
  ].join('\n')}`, 'utf8')
  await writeFile(join(workspaceDir, 'src', 'untracked.ts'), 'export const untracked = true\n', 'utf8')
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Electron Acceptance',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 10,
      models: ['slow-a'],
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
    desktop: { closePolicy: 'always-background' },
  }
}

/** One open file tab plus the review tab, with the review tab active. */
function seedPreferencesExpression(workspaceDir) {
  const filePath = join(workspaceDir, README_NAME)
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  const layout = {
    collapsed: false,
    fullscreen: true,
    activeTab: 'review',
    openTabs: [fileTab, 'review'],
    openRequest: { root: workspaceDir, path: filePath },
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: DEFAULT_NAVIGATOR_WIDTH,
    reviewNavigatorWidth: DEFAULT_NAVIGATOR_WIDTH,
    expandedPaths: [],
    drafts: {},
    browserTabs: [],
  }
  const preferences = {
    'littlesheep.ui.workspacePanelCollapsed': 'false',
    'littlesheep.ui.workspacePanelFullscreen': 'true',
    'littlesheep.ui.workspacePanelTab': 'review',
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([fileTab, 'review']),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspacePanelOpenPath': filePath,
    'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
    'littlesheep.ui.workspaceReviewSideBySide': 'true',
    'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: layout }),
  }
  return `(() => {
    const values = ${JSON.stringify(preferences)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    return true;
  })()`
}

async function startWindow({ dataDir, chromiumDir, logPath }) {
  const debuggingPort = await harness.reservePort()
  const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  const client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
    harness.startTimeoutMs,
    'composer textarea',
  )
  return { electron, locator, client }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

/**
 * Restart through the application's own quit path.
 *
 * Killing the process loses the last renderer preference writes: Chromium keeps
 * localStorage in memory and commits it in the background, so a SIGKILL right
 * after a toggle dropped the value this gate is about to check. The quit action
 * flushes the shell state first.
 */
async function restartWindow({ handle, dataDir, chromiumDir, logPath }) {
  await harness.desktopAction(handle.locator, 'quit')
  await harness.waitFor(
    () => (handle.electron.exitCode === null ? undefined : true),
    20_000,
    'application exit',
  )
  handle.client.close()
  await delay(1_500)
  return startWindow({ dataDir, chromiumDir, logPath })
}

/** Install the probe and the layout preferences, then reload once. */
async function seedAndReload(client, workspaceDir, label) {
  const source = `${PROBE_SOURCE};${seedPreferencesExpression(workspaceDir)}`
  const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source })
  try {
    await client.evaluate(seedPreferencesExpression(workspaceDir))
    const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
    await client.send('Page.reload', { ignoreCache: false })
    await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
        .catch(() => undefined)
      if (!state) return undefined
      return state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? state.timeOrigin : undefined
    }, harness.actionTimeoutMs, label)
    return identifier
  } finally {
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined)
  }
}

async function readSurface(client) {
  return client.evaluate(SURFACE_EXPRESSION)
}

async function waitForSurface(client, predicate, timeoutMs, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client)
    return predicate(surface) ? surface : undefined
  }, timeoutMs, label)
}

async function click(client, selector) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function switchTab(client, label) {
  const clicked = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.workspace-active-item')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(label)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`workspace tab ${label} is not open`)
  await delay(600)
}

async function dragResizer(client, selector, deltaX) {
  const start = await client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    if (box.width <= 0) return null;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`)
  if (!start) throw new Error(`resizer not found: ${selector}`)
  const target = { x: start.x + deltaX, y: start.y }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
  })
  for (const fraction of [0.34, 0.67, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + (target.x - start.x) * fraction,
      y: target.y,
      button: 'left',
      buttons: 1,
    })
    await delay(30)
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await delay(400)
}

function persistedWidths(surface) {
  const layout = surface.layoutStorage?.__draft__
  return {
    file: layout?.fileNavigatorWidth ?? null,
    review: layout?.reviewNavigatorWidth ?? null,
    fullscreen: layout?.fullscreen ?? null,
    activeTab: layout?.activeTab ?? null,
    fileNavigatorCollapsed: layout?.fileNavigatorCollapsed ?? null,
  }
}

async function captureScreenshot(client, dir, name) {
  await mkdir(dir, { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, name), Buffer.from(shot.data, 'base64'))
  return join(dir, name)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-review-navigator-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshotDir = join(root, 'screenshots')
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeWorkspace(workspaceDir)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    // 1. Wide window, review tab active: the review navigator has its own width.
    handle = await startWindow({ dataDir, chromiumDir, logPath })
    await harness.desktopAction(handle.locator, 'resize', WIDE)
    await seedAndReload(handle.client, workspaceDir, 'renderer reload with the review fixture')
    const opened = await waitForSurface(
      handle.client,
      (surface) => surface.reviewVisible && surface.reviewNavigator.aria && surface.treeRows > 0,
      30_000,
      'review surface with changed files',
    )
    recorder.note({
      step: 'review-opened',
      activeTab: opened.activeTabLabel,
      tabLabels: opened.tabLabels,
      treeRows: opened.treeRows,
      reviewNavigator: opened.reviewNavigator,
      panel: opened.panel,
      persisted: persistedWidths(opened),
    })
    recorder.check(opened.activeTabLabel === '审阅', 'the fixture opens on the review tab', { activeTab: opened.activeTabLabel })
    recorder.check(opened.reviewNavigator.aria.now === DEFAULT_NAVIGATOR_WIDTH, 'the review navigator starts at the shared default width', opened.reviewNavigator.aria)
    recorder.check(opened.reviewNavigator.aria.min === MIN_WIDTH && opened.reviewNavigator.aria.max === MAX_WIDTH, 'the review navigator keeps the documented bounds', opened.reviewNavigator.aria)
    recorder.check(opened.treeRows >= 2, 'the review navigator lists the real changed files', { treeRows: opened.treeRows })
    recorder.check(opened.panel.fullscreen === true, 'the fixture opens the workspace panel fullscreen for room to resize', opened.panel)
    recorder.check(
      opened.diffHeaderEndsBeforeNavigator === true,
      'the diff surface reserves the navigator width instead of running under it',
      { endsBefore: opened.diffHeaderEndsBeforeNavigator, header: opened.diffHeaderRect, navigator: opened.reviewNavigator.rect },
    )
    recorder.check(
      opened.diffActionsReachable.every(Boolean),
      'the diff action buttons are reachable beside the navigator',
      { reachable: opened.diffActionsReachable },
    )

    // 2. Give the file navigator a width of its own, in its own tab.
    await switchTab(handle.client, README_NAME)
    const filesBefore = await waitForSurface(
      handle.client,
      (surface) => surface.fileNavigatorVisible && surface.fileNavigator.aria,
      20_000,
      'file navigator in the files tab',
    )
    await dragResizer(handle.client, '.workspace-shared-file-navigator .workspace-files-navigator-resizer', -FILE_WIDEN_PX)
    const filesWidened = await waitForSurface(
      handle.client,
      (surface) => surface.fileNavigator.aria && surface.fileNavigator.aria.now > filesBefore.fileNavigator.aria.now,
      20_000,
      'file navigator to widen',
    )
    const fileWidth = filesWidened.fileNavigator.aria.now
    recorder.note({
      step: 'file-navigator-width',
      before: filesBefore.fileNavigator.aria,
      after: filesWidened.fileNavigator.aria,
      persisted: persistedWidths(filesWidened),
    })
    recorder.check(
      fileWidth >= filesBefore.fileNavigator.aria.now + FILE_WIDEN_PX - 8,
      'dragging the file navigator changes its width',
      { before: filesBefore.fileNavigator.aria.now, after: fileWidth },
    )

    // 3. Widen the review navigator; the file navigator must not move.
    await switchTab(handle.client, '审阅')
    const reviewBefore = await waitForSurface(
      handle.client,
      (surface) => surface.reviewVisible && surface.reviewNavigator.aria,
      20_000,
      'review tab again',
    )
    await dragResizer(handle.client, '.workspace-review .workspace-files-navigator-resizer', -REVIEW_WIDEN_PX)
    const reviewWidened = await waitForSurface(
      handle.client,
      (surface) => surface.reviewNavigator.aria && surface.reviewNavigator.aria.now > reviewBefore.reviewNavigator.aria.now,
      20_000,
      'review navigator to widen',
    )
    const reviewWidth = reviewWidened.reviewNavigator.aria.now
    const afterReviewDrag = persistedWidths(reviewWidened)
    recorder.note({
      step: 'review-navigator-width',
      before: reviewBefore.reviewNavigator.aria,
      after: reviewWidened.reviewNavigator.aria,
      persisted: afterReviewDrag,
      fileWidth,
    })
    recorder.check(
      reviewWidth >= reviewBefore.reviewNavigator.aria.now + REVIEW_WIDEN_PX - 8,
      'dragging the review navigator changes its width',
      { before: reviewBefore.reviewNavigator.aria.now, after: reviewWidth },
    )
    recorder.check(
      afterReviewDrag.file === fileWidth,
      'widening the review navigator leaves the file navigator width alone',
      { fileWidth, persisted: afterReviewDrag },
    )
    recorder.check(
      afterReviewDrag.review === reviewWidth,
      'the review width is the one that was persisted',
      { reviewWidth, persisted: afterReviewDrag },
    )

    // 4. Back in the files tab the rendered navigator is unchanged.
    await switchTab(handle.client, README_NAME)
    const filesAfter = await waitForSurface(
      handle.client,
      (surface) => surface.fileNavigatorVisible && surface.fileNavigator.aria,
      20_000,
      'file navigator after the review drag',
    )
    recorder.note({
      step: 'file-navigator-unchanged',
      aria: filesAfter.fileNavigator.aria,
      rect: filesAfter.fileNavigator.rect,
      persisted: persistedWidths(filesAfter),
    })
    recorder.check(
      filesAfter.fileNavigator.aria.now === fileWidth,
      'the file navigator renders the width it had before the review drag',
      { expected: fileWidth, actual: filesAfter.fileNavigator.aria.now },
    )
    recorder.check(
      persistedWidths(filesAfter).review === reviewWidth,
      'the review width survives switching back to the files tab',
      persistedWidths(filesAfter),
    )

    // 5. Side-by-side preference is untouched by the width work.
    await switchTab(handle.client, '审阅')
    const reviewTab = await waitForSurface(handle.client, (surface) => surface.reviewVisible && surface.sideBySideToggle, 20_000, 'review tab with the layout toggle')
    recorder.note({
      step: 'side-by-side-initial',
      sideBySide: reviewTab.sideBySide,
      toggle: reviewTab.sideBySideToggle,
      preference: reviewTab.sideBySidePreference,
    })
    recorder.check(reviewTab.sideBySide === true, 'the review view starts in two-column mode by default', { sideBySide: reviewTab.sideBySide })
    await click(handle.client, '.workspace-review-diff-actions button[aria-pressed]')
    const toggled = await waitForSurface(
      handle.client,
      (surface) => surface.sideBySide === false,
      10_000,
      'single-column review',
    )
    recorder.note({
      step: 'side-by-side-toggled',
      sideBySide: toggled.sideBySide,
      preference: toggled.sideBySidePreference,
      reviewWidth: toggled.reviewNavigator.aria,
      persisted: persistedWidths(toggled),
    })
    recorder.check(toggled.sideBySidePreference === 'false', 'the layout preference records single-column mode', { preference: toggled.sideBySidePreference })
    recorder.check(
      toggled.reviewNavigator.aria.now === reviewWidth && persistedWidths(toggled).file === fileWidth,
      'changing the diff layout leaves both navigator widths alone',
      { review: toggled.reviewNavigator.aria.now, file: persistedWidths(toggled).file },
    )

    // 6. Collapse is still shared between files and review, and never rewrites widths.
    await click(handle.client, '.workspace-review .workspace-files-navigator-rail')
    const collapsedReview = await waitForSurface(
      handle.client,
      (surface) => surface.reviewNavigator.collapsed === true,
      10_000,
      'collapsed review navigator',
    )
    await switchTab(handle.client, README_NAME)
    const collapsedFiles = await waitForSurface(
      handle.client,
      (surface) => surface.fileNavigator.collapsed === true,
      10_000,
      'shared collapse state in the files tab',
    )
    await click(handle.client, '.workspace-shared-file-navigator .workspace-files-navigator-rail')
    await switchTab(handle.client, '审阅')
    const reopened = await waitForSurface(
      handle.client,
      (surface) => surface.reviewVisible && surface.reviewNavigator.collapsed === false && surface.reviewNavigator.aria,
      10_000,
      'reopened review navigator',
    )
    recorder.note({
      step: 'shared-collapse',
      collapsedReview: collapsedReview.reviewNavigator.collapsed,
      collapsedFiles: collapsedFiles.fileNavigator.collapsed,
      reopened: reopened.reviewNavigator.aria,
      persisted: persistedWidths(reopened),
    })
    recorder.check(collapsedFiles.fileNavigator.collapsed === true, 'one collapse state is shared by both navigators', collapsedFiles.fileNavigator)
    recorder.check(
      reopened.reviewNavigator.aria.now === reviewWidth,
      'reopening the review navigator restores its own width',
      { expected: reviewWidth, actual: reopened.reviewNavigator.aria.now },
    )
    recorder.check(
      persistedWidths(reopened).file === fileWidth,
      'the shared collapse never rewrites the file navigator width',
      persistedWidths(reopened),
    )
    // Put the layout back into two-column mode for the restart comparison.
    await click(handle.client, '.workspace-review-diff-actions button[aria-pressed]')
    const restoredLayout = await waitForSurface(handle.client, (surface) => surface.sideBySide === true, 10_000, 'two-column review restored')
    recorder.note({
      step: 'side-by-side-restored',
      sideBySide: restoredLayout.sideBySide,
      preference: restoredLayout.sideBySidePreference,
      reviewWidth: restoredLayout.reviewNavigator.aria,
    })
    recorder.check(
      restoredLayout.sideBySidePreference === 'true',
      'turning two-column mode back on is written to the preference',
      { preference: restoredLayout.sideBySidePreference },
    )

    // 7. The review surface runs no directory scan of its own.
    await delay(2_000)
    const idle = await readSurface(handle.client)
    const probeBefore = idle.probe
    await delay(2_500)
    const idleAfter = await readSurface(handle.client)
    recorder.note({ step: 'review-traffic', probeBefore, probeAfter: idleAfter.probe })
    recorder.check(
      probeBefore.workspaceReview > 0,
      'the review surface really reads Git state',
      probeBefore,
    )
    recorder.check(
      idleAfter.probe.workspaceList === probeBefore.workspaceList,
      'an idle review tab performs no directory scan',
      { before: probeBefore, after: idleAfter.probe },
    )

    // 8. Restart: both widths come back as their own values.
    handle = await restartWindow({ handle, dataDir, chromiumDir, logPath })
    await harness.desktopAction(handle.locator, 'resize', WIDE)
    const restoredReview = await waitForSurface(
      handle.client,
      (surface) => surface.reviewVisible && surface.reviewNavigator.aria,
      30_000,
      'restored review navigator after restart',
    )
    await switchTab(handle.client, README_NAME)
    const restoredFiles = await waitForSurface(
      handle.client,
      (surface) => surface.fileNavigatorVisible && surface.fileNavigator.aria,
      20_000,
      'restored file navigator after restart',
    )
    recorder.note({
      step: 'restart',
      review: restoredReview.reviewNavigator.aria,
      file: restoredFiles.fileNavigator.aria,
      sideBySide: restoredReview.sideBySide,
      fullscreen: restoredReview.panel.fullscreen,
      persisted: persistedWidths(restoredFiles),
    })
    recorder.check(
      restoredReview.reviewNavigator.aria.now === reviewWidth,
      'the review navigator comes back at its own width after a restart',
      { expected: reviewWidth, actual: restoredReview.reviewNavigator.aria.now },
    )
    recorder.check(
      restoredFiles.fileNavigator.aria.now === fileWidth,
      'the file navigator comes back at its own width after a restart',
      { expected: fileWidth, actual: restoredFiles.fileNavigator.aria.now },
    )
    recorder.check(
      restoredReview.sideBySide === true && restoredReview.sideBySidePreference === 'true',
      'the two-column preference survives the restart',
      { sideBySide: restoredReview.sideBySide, preference: restoredReview.sideBySidePreference },
    )

    // 9. Narrow window: the rendered width is clamped, the stored one is not.
    // The review tab has to be the visible one: the clamp this step observes is the
    // review navigator's, and an inactive tab keeps its last measured layout.
    await switchTab(handle.client, '审阅')
    await waitForSurface(handle.client, (surface) => surface.reviewVisible && surface.reviewNavigator.aria, 20_000, 'review tab before the narrow window')
    await click(handle.client, '.workspace-panel-collapse-action')
    await waitForSurface(handle.client, (surface) => surface.panel.fullscreen === false, 10_000, 'split workspace panel')
    await harness.desktopAction(handle.locator, 'resize', NARROW)
    await delay(700)
    const narrow = await waitForSurface(
      handle.client,
      (surface) => surface.viewport.width <= NARROW.width,
      20_000,
      'narrow window layout',
    )
    const narrowShot = await captureScreenshot(handle.client, screenshotDir, 'review-navigator-narrow.png')
    recorder.note({
      step: 'narrow-window',
      viewport: narrow.viewport,
      panel: narrow.panel,
      reviewNavigator: narrow.reviewNavigator,
      controlHits: narrow.controlHits,
      documentOverflow: narrow.documentOverflow,
      persisted: persistedWidths(narrow),
      screenshot: narrowShot,
      sideBySideToggle: narrow.sideBySideToggle,
      refreshReachable: narrow.refreshReachable,
      filterReachable: narrow.filterReachable,
    })
    recorder.check(
      narrow.documentOverflow <= 1,
      'the narrow window has no page-level horizontal scroll',
      { overflow: narrow.documentOverflow },
    )
    recorder.check(
      narrow.panel.scrollOverflow <= 1,
      'the workspace panel does not overflow horizontally',
      { overflow: narrow.panel.scrollOverflow, panel: narrow.panel.rect },
    )
    recorder.check(
      narrow.reviewNavigator.aria.now <= narrow.reviewNavigator.aria.max
      && narrow.reviewNavigator.aria.now >= narrow.reviewNavigator.aria.min,
      'the rendered review width stays inside its bounds',
      narrow.reviewNavigator.aria,
    )
    recorder.check(
      (narrow.reviewRect?.width ?? 0) >= CONTENT_MIN_WIDTH,
      'the diff surface keeps its readable minimum width',
      { reviewWidth: narrow.reviewRect?.width ?? null },
    )
    recorder.check(
      narrow.reviewNavigator.resizerReachable === true,
      'the review resizer stays reachable in the narrow window',
      { reachable: narrow.reviewNavigator.resizerReachable, rect: narrow.reviewNavigator.rect },
    )
    recorder.check(
      narrow.sideBySideToggle?.reachable === true && narrow.refreshReachable === true && narrow.filterReachable === true,
      'the review controls stay reachable in the narrow window',
      { toggle: narrow.sideBySideToggle, refresh: narrow.refreshReachable, filter: narrow.filterReachable, hits: narrow.controlHits },
    )
    recorder.check(
      narrow.diffHeaderEndsBeforeNavigator === true && narrow.diffActionsReachable.every(Boolean),
      'the diff surface and its actions stay clear of the navigator in the narrow window',
      { endsBefore: narrow.diffHeaderEndsBeforeNavigator, reachable: narrow.diffActionsReachable },
    )
    recorder.check(
      persistedWidths(narrow).review === reviewWidth && persistedWidths(narrow).file === fileWidth,
      'the narrow clamp never rewrites the stored widths',
      persistedWidths(narrow),
    )

    // 10. Back to the wide fullscreen panel: the stored width renders again.
    // Widening needs the room the fullscreen panel gives; a split panel at the same
    // window width legitimately clamps the rendered width, so the panel is restored
    // to the layout the width was chosen in before expecting it back.
    await harness.desktopAction(handle.locator, 'resize', WIDE)
    await waitForSurface(handle.client, (surface) => surface.viewport.width >= WIDE.width - 24, 20_000, 'wide window again')
    await click(handle.client, '.workspace-panel-collapse-action')
    const widened = await waitForSurface(
      handle.client,
      (surface) => surface.panel.fullscreen === true && surface.reviewNavigator.aria.now === reviewWidth,
      20_000,
      'review width restored after the window grows back',
    )
    const wideShot = await captureScreenshot(handle.client, screenshotDir, 'review-navigator-wide.png')
    recorder.note({
      step: 'wide-window-again',
      viewport: widened.viewport,
      panel: widened.panel,
      reviewNavigator: widened.reviewNavigator.aria,
      diffHeaderEndsBeforeNavigator: widened.diffHeaderEndsBeforeNavigator,
      persisted: persistedWidths(widened),
      screenshot: wideShot,
    })
    recorder.check(
      widened.reviewNavigator.aria.now === reviewWidth,
      'growing the window back restores the stored review width',
      { expected: reviewWidth, actual: widened.reviewNavigator.aria.now },
    )
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await stopWindow(handle)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'review-navigator-width',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    widths: { default: DEFAULT_NAVIGATOR_WIDTH, min: MIN_WIDTH, max: MAX_WIDTH, contentMin: CONTENT_MIN_WIDTH },
    windows: { wide: WIDE, narrow: NARROW },
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The fixture drives a temporary Git workspace with one modified and one untracked file; it proves the review navigator renders and resizes with real changes, not any particular repository.',
      'The narrow window is the application minimum (800x600); the check is about reachability and overflow, not about readability at other zooms (that belongs to UX-15).',
      'The "no directory scan" check reads the page fetch probe for /workspace/list while the review tab is idle for a few seconds; a scan triggered by another surface in that window would be reported as a failure.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
