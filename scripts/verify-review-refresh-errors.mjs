// Real-window acceptance for stale Git review content (taskbook UX-27, first item).
//
// The renderer used to hide a failed refresh whenever a snapshot or diff was
// already on screen, so old data looked exactly like a fresh success. The claim
// under test is the opposite contract: while a refresh runs the stale result says
// it is being refreshed, when it fails the stale result says so and names the
// last successful read, both surfaces report their own failure, and the retry
// action in each notice really issues a new request.
//
// Everything below runs against an isolated data root, a real Git workspace and
// the real Local App API. The only injected behaviour is a page-level `fetch`
// probe that can hold, fail, or pass through `/workspace/review` and
// `/workspace/review/diff`; the UI, the cache and the Runtime are untouched.
//
// Usage:
//   node scripts/verify-review-refresh-errors.mjs [--keep]

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 25_000 })

const WINDOW = { width: 1280, height: 840 }
const REFRESH_LABEL = '刷新 Git 更改'

/** Holds, fails, or passes through the two review requests; counts both. */
const PROBE_SOURCE = `(() => {
  if (window.__reviewFailureProbe) return true;
  const probe = {
    failSnapshot: false, failDiff: false, holdSnapshot: false, holdDiff: false,
    snapshots: 0, diffs: 0,
    // UX-27 item 4 needs finer control than "hold everything": hold the *next* N
    // snapshots individually, answer them later, and be able to answer with stale data.
    holdSnapshotNext: 0,
  };
  const holds = { snapshot: null, diff: null, queued: [], craftStale: false };
  const originalFetch = window.fetch.bind(window);
  const failure = (message) => Promise.resolve(new Response(JSON.stringify({ error: message }), {
    status: 500, headers: { 'content-type': 'application/json' },
  }));
  const answerHeldSnapshot = (input, init, resolve, reject) => {
    originalFetch(input, init).then(async (response) => {
      if (!holds.craftStale) {
        resolve(response);
        return;
      }
      // A genuinely older answer: the same shape, minus whatever the newest read found.
      // If the renderer lets it win, the file it drops disappears from the list.
      const payload = await response.clone().json();
      const files = Array.isArray(payload.files) ? payload.files.slice(0, -1) : payload.files;
      resolve(new Response(JSON.stringify({ ...payload, files }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }).catch(reject);
  };
  window.fetch = function probedFetch(input, init) {
    const target = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
    if (target.pathname === '/workspace/review') {
      probe.snapshots += 1;
      if (probe.holdSnapshotNext > 0) {
        probe.holdSnapshotNext -= 1;
        return new Promise((resolve, reject) => {
          holds.queued.push(() => answerHeldSnapshot(input, init, resolve, reject));
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      if (probe.holdSnapshot) {
        return new Promise((resolve, reject) => {
          holds.snapshot = () => { probe.holdSnapshot = false; resolve(originalFetch(input, init)); };
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      if (probe.failSnapshot) return failure('fixture snapshot failure');
    }
    if (target.pathname === '/workspace/review/diff') {
      probe.diffs += 1;
      if (probe.holdDiff) {
        return new Promise((resolve, reject) => {
          holds.diff = () => { probe.holdDiff = false; resolve(originalFetch(input, init)); };
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      if (probe.failDiff) return failure('fixture diff failure');
    }
    return originalFetch(input, init);
  };
  window.__reviewFailureProbe = probe;
  window.__reviewHolds = holds;
  return true;
})()`

/** Everything one observation needs, read from the live window in one pass. */
const SURFACE_EXPRESSION = `(() => {
  const review = document.querySelector('.workspace-review');
  const notices = [...(review?.querySelectorAll('.workspace-review-update-notice') ?? [])].map((node) => ({
    text: (node.textContent || '').trim(),
    role: node.getAttribute('role'),
    tone: node.getAttribute('data-tone'),
    buttons: [...node.querySelectorAll('button')].map((button) => ({
      label: (button.textContent || '').trim(),
      disabled: button.disabled,
    })),
  }));
  const refresh = [...(review?.querySelectorAll('button') ?? [])]
    .find((node) => node.getAttribute('aria-label') === ${JSON.stringify(REFRESH_LABEL)});
  const probe = window.__reviewFailureProbe;
  return {
    visible: Boolean(review && review.getBoundingClientRect().width > 0),
    files: review?.querySelectorAll('[role="treeitem"]').length ?? 0,
    fileStats: [...(review?.querySelectorAll('[role="treeitem"]') ?? [])].map((node) => (node.textContent || '').replace(/\s+/gu, ' ').trim()).join(' | '),
    selectedRow: (review?.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent || '').replace(/\s+/gu, ' ').trim(),
    layers: review?.querySelectorAll('.workspace-review-diff-layer').length ?? 0,
    notices,
    refresh: refresh ? { disabled: refresh.disabled } : null,
    revision: (document.querySelector('.workspace-review-diff')?.textContent || '').length,
    // The diff *layers'* text, not the whole pane: the pane also hosts the built-in
    // editor placeholder, which has nothing to do with the diff's version.
    diffText: [...document.querySelectorAll('.workspace-review-diff-layer')]
      .map((node) => node.textContent || '').join(' ').replace(/\s+/gu, ' ').trim().slice(0, 600),
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    probe: probe ? {
      snapshots: probe.snapshots, diffs: probe.diffs,
      failSnapshot: probe.failSnapshot, failDiff: probe.failDiff,
      holdSnapshot: probe.holdSnapshot, holdDiff: probe.holdDiff,
      holdSnapshotNext: probe.holdSnapshotNext, queued: (window.__reviewHolds?.queued ?? []).length,
      pending: { snapshot: Boolean(window.__reviewHolds?.snapshot), diff: Boolean(window.__reviewHolds?.diff) },
    } : null,
  };
})()`

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function seedPreferencesExpression(workspaceDir) {
  const layout = {
    collapsed: false,
    fullscreen: true,
    activeTab: 'review',
    openTabs: ['review'],
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: 214,
    reviewNavigatorWidth: 214,
    expandedPaths: [],
    drafts: {},
    browserTabs: [],
  }
  const preferences = {
    'littlesheep.ui.workspacePanelCollapsed': 'false',
    'littlesheep.ui.workspacePanelFullscreen': 'true',
    'littlesheep.ui.workspacePanelTab': 'review',
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify(['review']),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspaceReviewSideBySide': 'true',
    'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: layout }),
  }
  return `(() => {
    const values = ${JSON.stringify(preferences)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    return true;
  })()`
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

async function click(client, label) {
  const clicked = await client.evaluate(`(() => {
    const node = [...document.querySelectorAll('.workspace-review button')].find((item) =>
      item.getAttribute('aria-label') === ${JSON.stringify(label)}
      || (item.textContent || '').trim() === ${JSON.stringify(label)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`button unavailable: ${label}`)
}

async function setProbe(client, patch) {
  await client.evaluate(`(() => { Object.assign(window.__reviewFailureProbe, ${JSON.stringify(patch)}); return true; })()`)
}

async function releaseHolds(client) {
  await client.evaluate(`(() => {
    window.__reviewHolds.snapshot?.(); window.__reviewHolds.snapshot = null;
    window.__reviewHolds.diff?.(); window.__reviewHolds.diff = null;
    return true;
  })()`)
}

function retryButton(surface, label) {
  return surface.notices.flatMap((notice) => notice.buttons).find((button) => button.label === label) ?? null
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-review-refresh-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshotDir = join(root, 'screenshots')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0 })
  let electron
  let locator
  let client

  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    const samplePath = join(workspaceDir, 'sample.txt')
    await writeFile(samplePath, 'first\n', 'utf8')
    git(workspaceDir, ['init', '--initial-branch=main'])
    git(workspaceDir, ['config', 'user.email', 'review-refresh@example.invalid'])
    git(workspaceDir, ['config', 'user.name', 'Review Refresh'])
    git(workspaceDir, ['add', '.'])
    git(workspaceDir, ['commit', '-m', 'fixture'])
    await writeFile(samplePath, 'first\nsecond\n', 'utf8')
    const cliStatus = git(workspaceDir, ['status', '--short'])
    const cliDiff = git(workspaceDir, ['diff', '--', 'sample.txt'])
    recorder.check(
      cliStatus.includes('sample.txt') && cliDiff.includes('+second'),
      'the Git fixture really has an unstaged change',
      { cliStatus, diffHasAddedLine: cliDiff.includes('+second') },
    )
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify({
      version: 1,
      providers: [{
        id: 'acceptance',
        name: 'Acceptance',
        baseURL: provider.baseURL,
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
    }, null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    await harness.desktopAction(locator, 'resize', WINDOW)

    // Install the probe and the review layout, then load the app with them.
    const seedSource = `${PROBE_SOURCE};${seedPreferencesExpression(workspaceDir)}`
    const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: seedSource })
    try {
      await client.evaluate(seedPreferencesExpression(workspaceDir))
      const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
      await client.send('Page.reload', { ignoreCache: false })
      await harness.waitFor(async () => {
        const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
          .catch(() => undefined)
        if (!state) return undefined
        return state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? state.timeOrigin : undefined
      }, harness.actionTimeoutMs, 'renderer reload with the review fixture')
    } finally {
      await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined)
    }

    // 1. Baseline: a real snapshot and a real diff, and no notice at all.
    //
    // The very first snapshot can lose a startup race right after the renderer reload
    // (measured: "Failed to fetch" with the Local App API still coming up). One explicit
    // refresh is what a user would do, and the retry is recorded rather than hidden —
    // the conditions the baseline asserts are unchanged.
    let initial = await waitForSurface(
      client,
      (surface) => surface.visible && surface.files > 0 && surface.layers > 0,
      30_000,
      'Git review snapshot and diff',
    ).catch(() => null)
    if (!initial) {
      const beforeInitialRetry = await readSurface(client)
      await click(client, REFRESH_LABEL)
      initial = await waitForSurface(
        client,
        // Wait for the retry to *settle*, notice gone: a snapshot that is still
        // refreshing legitimately says so, and the baseline asserts a quiet load.
        (surface) => surface.visible && surface.files > 0 && surface.layers > 0 && surface.notices.length === 0,
        30_000,
        'Git review snapshot and diff after one refresh',
      )
      recorder.note({
        step: 'initial-retry',
        before: { files: beforeInitialRetry.files, layers: beforeInitialRetry.layers, snapshots: beforeInitialRetry.probe?.snapshots ?? null },
        after: { files: initial.files, layers: initial.layers, snapshots: initial.probe?.snapshots ?? null },
      })
    }
    recorder.note({ step: 'initial', files: initial.files, layers: initial.layers, notices: initial.notices, viewport: initial.viewport })
    recorder.check(initial.notices.length === 0, 'a successful load shows no stale notice', initial.notices)

    // 2. A held refresh keeps the old result and says it is refreshing.
    await setProbe(client, { holdSnapshot: true })
    await click(client, REFRESH_LABEL)
    const refreshing = await waitForSurface(
      client,
      (surface) => surface.notices.some((notice) => notice.role === 'status' && notice.text.includes('正在刷新 Git 更改')),
      20_000,
      'in-flight snapshot refresh notice',
    )
    recorder.note({
      step: 'snapshot-refreshing',
      notices: refreshing.notices,
      files: refreshing.files,
      layers: refreshing.layers,
      refreshDisabled: refreshing.refresh?.disabled ?? null,
      probe: refreshing.probe,
    })
    recorder.check(refreshing.files > 0 && refreshing.layers > 0, 'the held refresh keeps the loaded result on screen', {
      files: refreshing.files,
      layers: refreshing.layers,
    })
    recorder.check(
      refreshing.notices.every((notice) => notice.buttons.length === 0),
      'the refreshing notice claims no retry action',
      refreshing.notices,
    )
    await releaseHolds(client)
    const refreshed = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.probe.snapshots > initial.probe.snapshots,
      20_000,
      'snapshot refresh settles',
    )
    recorder.check(refreshed.files > 0 && refreshed.layers > 0, 'the settled refresh still shows the current result', {
      files: refreshed.files,
      layers: refreshed.layers,
    })

    // 3. A failed snapshot refresh over a cached snapshot: stale, labeled, retryable.
    await setProbe(client, { failSnapshot: true })
    await click(client, REFRESH_LABEL)
    const snapshotFailure = await waitForSurface(
      client,
      (surface) => surface.notices.some((notice) => notice.role === 'alert' && notice.text.includes('显示上次结果')),
      20_000,
      'cached snapshot failure is visible',
    )
    const snapshotShot = await captureScreenshot(client, screenshotDir, 'snapshot-refresh-failure.png')
    recorder.note({
      step: 'snapshot-refresh-failed',
      notices: snapshotFailure.notices,
      files: snapshotFailure.files,
      layers: snapshotFailure.layers,
      probe: snapshotFailure.probe,
      screenshot: snapshotShot,
    })
    recorder.check(
      snapshotFailure.files > 0 && snapshotFailure.layers > 0,
      'a failed refresh keeps the previous snapshot and diff instead of clearing them',
      { files: snapshotFailure.files, layers: snapshotFailure.layers },
    )
    recorder.check(
      snapshotFailure.notices[0]?.tone === 'error' && snapshotFailure.notices[0]?.text.includes('上次成功读取：'),
      'the stale snapshot names the failure and its last successful read',
      snapshotFailure.notices[0] ?? null,
    )
    recorder.check(
      snapshotFailure.notices[0]?.text.includes('Git 审阅暂时无法读取')
      && snapshotFailure.notices[0]?.text.includes('技术详情'),
      'the notice keeps the failure reason in the shared technical detail',
      snapshotFailure.notices[0]?.text ?? null,
    )
    recorder.check(
      retryButton(snapshotFailure, '重试刷新')?.disabled === false,
      'the snapshot notice offers an enabled retry action',
      snapshotFailure.notices[0]?.buttons ?? null,
    )
    await setProbe(client, { failSnapshot: false })
    await click(client, '重试刷新')
    const snapshotRecovered = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.probe.snapshots > snapshotFailure.probe.snapshots,
      20_000,
      'snapshot retry recovers',
    )
    recorder.note({
      step: 'snapshot-retry-recovered',
      files: snapshotRecovered.files,
      layers: snapshotRecovered.layers,
      snapshots: snapshotRecovered.probe.snapshots,
    })

    // 4. A held diff refresh keeps the previous diff and says it belongs to the
    // previous snapshot instead of looking current.
    await setProbe(client, { holdDiff: true })
    await click(client, REFRESH_LABEL)
    const diffRefreshing = await waitForSurface(
      client,
      (surface) => surface.notices.some((notice) => (
        notice.role === 'status' && notice.text.includes('当前差异属于上次结果')
      )) && surface.layers > 0,
      20_000,
      'in-flight diff refresh notice',
    )
    recorder.note({
      step: 'diff-refreshing',
      notices: diffRefreshing.notices,
      layers: diffRefreshing.layers,
      probe: diffRefreshing.probe,
    })
    recorder.check(
      diffRefreshing.notices.some((notice) => notice.text.includes('正在重新读取')),
      'the in-flight re-read of a previous-revision diff is stated, not hidden',
      diffRefreshing.notices,
    )
    await releaseHolds(client)
    const diffSettled = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.layers > 0,
      20_000,
      'diff refresh settles',
    )
    recorder.check(diffSettled.layers > 0, 'the settled diff refresh keeps the diff rendered', { layers: diffSettled.layers })

    // 5. A failed diff refresh: separate from the snapshot notice and retryable.
    await setProbe(client, { failDiff: true })
    await click(client, REFRESH_LABEL)
    const diffFailure = await waitForSurface(
      client,
      (surface) => surface.notices.some((notice) => notice.text.includes('差异更新失败')),
      20_000,
      'cached diff failure is visible',
    )
    const diffShot = await captureScreenshot(client, screenshotDir, 'diff-refresh-failure.png')
    recorder.note({
      step: 'diff-refresh-failed',
      notices: diffFailure.notices,
      layers: diffFailure.layers,
      probe: diffFailure.probe,
      screenshot: diffShot,
    })
    recorder.check(
      diffFailure.layers > 0,
      'a failed diff refresh keeps the previous diff layers',
      { layers: diffFailure.layers },
    )
    recorder.check(
      diffFailure.notices[0]?.tone === 'error' && diffFailure.notices[0]?.role === 'alert',
      'the diff failure is its own error notice',
      diffFailure.notices[0] ?? null,
    )
    recorder.check(
      retryButton(diffFailure, '重试差异')?.disabled === false,
      'the diff notice offers an enabled retry action',
      diffFailure.notices[0]?.buttons ?? null,
    )
    await setProbe(client, { failDiff: false })
    await click(client, '重试差异')
    const diffRecovered = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.probe.diffs > diffFailure.probe.diffs && surface.layers > 0,
      20_000,
      'diff retry recovers',
    )
    recorder.note({
      step: 'diff-retry-recovered',
      layers: diffRecovered.layers,
      diffs: diffRecovered.probe.diffs,
      notices: diffRecovered.notices,
    })
    recorder.check(
      diffRecovered.probe.diffs > diffFailure.probe.diffs,
      'the retry really issues a new diff request instead of reusing the cache',
      { before: diffFailure.probe.diffs, after: diffRecovered.probe.diffs },
    )

    // UX-27 item 4: a delayed older answer must not win. The renderer already prevents
    // two overlapping snapshot reads (in-flight guard + one queued follow-up), so the
    // property is checked where it lives: extra clicks while a read is held must not
    // start more reads, and once the held (deliberately stale) answer and the queued
    // refresh have both landed, the list must be the newest read's, with no notice left.
    await setProbe(client, { holdSnapshotNext: 1, failSnapshot: false, failDiff: false, holdSnapshot: false, holdDiff: false })
    const beforeOutOfOrder = await readSurface(client)
    await click(client, REFRESH_LABEL)
    const heldOlder = await waitForSurface(
      client,
      (surface) => surface.probe.holdSnapshotNext === 0 && surface.probe.pending.snapshot === false,
      15_000,
      'older snapshot request held',
    ).catch(() => readSurface(client))
    const heldCount = heldOlder.probe.snapshots
    await click(client, REFRESH_LABEL)
    await click(client, REFRESH_LABEL)
    await click(client, REFRESH_LABEL)
    const whileHeld = await readSurface(client)
    await writeFile(join(workspaceDir, 'newer.txt'), 'newer\n', 'utf8')
    await client.evaluate(`(() => { window.__reviewHolds.craftStale = true; const next = window.__reviewHolds.queued.shift(); if (next) next(); return true; })()`)
    const settledOutOfOrder = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.files >= 2 && surface.probe.queued === 0,
      25_000,
      'newest read settles after the stale answer',
    ).catch(() => readSurface(client))
    const outOfOrderShot = await captureScreenshot(client, screenshotDir, 'review-out-of-order.png')
    recorder.note({
      step: 'out-of-order-snapshot',
      before: { snapshots: beforeOutOfOrder.probe.snapshots, files: beforeOutOfOrder.files },
      held: { snapshots: heldCount, files: heldOlder.files },
      whileHeld: { snapshots: whileHeld.probe.snapshots, files: whileHeld.files },
      settled: { snapshots: settledOutOfOrder.probe.snapshots, files: settledOutOfOrder.files, notices: settledOutOfOrder.notices.length },
      screenshot: outOfOrderShot,
    })
    recorder.check(
      whileHeld.probe.snapshots === heldCount,
      'refreshes clicked while a read is in flight do not start more reads',
      { heldCount, whileHeld: whileHeld.probe.snapshots },
    )
    recorder.check(
      settledOutOfOrder.files >= 2 && settledOutOfOrder.notices.length === 0,
      'after a stale answer and the queued refresh, the list is the newest read with no notice left',
      { files: settledOutOfOrder.files, notices: settledOutOfOrder.notices },
    )
    // UX-27 item 3: refresh spam is coalesced instead of firing a request per click.
    const beforeSpam = await readSurface(client)
    for (let clickIndex = 0; clickIndex < 5; clickIndex += 1) await click(client, REFRESH_LABEL)
    const afterSpam = await waitForSurface(
      client,
      (surface) => !surface.refresh?.disabled && surface.probe.snapshots > beforeSpam.probe.snapshots,
      20_000,
      'spammed refresh settles',
    )
    recorder.note({
      step: 'refresh-spam',
      before: { snapshots: beforeSpam.probe.snapshots, files: beforeSpam.files },
      after: { snapshots: afterSpam.probe.snapshots, files: afterSpam.files, notices: afterSpam.notices.length },
    })
    recorder.check(
      // A re-reading notice is the honest outcome when the tree moved under the view: the
      // point of this check is the *bounded* read count, not silence.
      afterSpam.probe.snapshots - beforeSpam.probe.snapshots <= 3
      && afterSpam.notices.every((notice) => notice.tone === 'info' && notice.text.includes('正在重新读取')),
      'five quick refreshes coalesce into a bounded number of reads and end clean',
      { issued: afterSpam.probe.snapshots - beforeSpam.probe.snapshots, notices: afterSpam.notices },
    )

    // UX-27 item 4: the list's stats and the diff must belong to the same version — or
    // the view must say it is still re-reading. The fixture's sample.txt already has a
    // diff on screen; adding a line and refreshing must move both, or say so.
    const beforeVersion = await readSurface(client)
    const versionMarker = `version-${Date.now().toString(36)}`
    await writeFile(samplePath, `first\n${versionMarker}\n`, 'utf8')
    await click(client, REFRESH_LABEL)
    const afterVersion = await waitForSurface(
      client,
      (surface) => surface.fileStats !== beforeVersion.fileStats || surface.diffText.includes(versionMarker),
      25_000,
      'list stats or diff move to the new version',
    ).catch(() => readSurface(client))
    const rereading = afterVersion.notices.some((notice) => notice.tone === 'info' && notice.text.includes('正在重新读取'))
    const versionShot = await captureScreenshot(client, screenshotDir, 'review-diff-version.png')

    // The API agrees with itself: the diff read for the *same* revision the list was
    // built from contains the new line, so "stats and diff match" is not a coincidence
    // of the renderer holding two different reads.
    const apiSnapshot = await harness.fetchJson(locator, `/workspace/review?root=${encodeURIComponent(workspaceDir)}`)
    const apiRevision = apiSnapshot.body?.revision
    const apiDiff = apiRevision
      ? await harness.fetchJson(locator, `/workspace/review/diff?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(samplePath)}&revision=${encodeURIComponent(apiRevision)}`)
      : null
    const apiDiffText = JSON.stringify(apiDiff?.body ?? {})
    // The same read, asked for the file the view has selected: whatever the diff pane is
    // showing has to be what this revision holds for that file, not an older read's.
    // The row text starts with its porcelain status letter (`Unewer.txt+1-0`), which is
    // not part of the file name.
    const selectedRowText = String(afterVersion.selectedRow ?? '').replace(/^[A-Z?!]{1,2}\s*/u, '')
    const selectedName = selectedRowText.match(/[\w.\u4e00-\u9fff-]+\.\w+/u)?.[0] ?? ''
    const selectedDiff = apiRevision && selectedName
      ? await harness.fetchJson(locator, `/workspace/review/diff?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent(join(workspaceDir, selectedName))}&revision=${encodeURIComponent(apiRevision)}`)
      : null
    // Whatever shape a layer payload has, the diff on screen has to contain content this
    // revision holds for that file — that is what "the list and the diff agree" means.
    const selectedContents = (JSON.stringify(selectedDiff?.body ?? '').match(/"content":"([^"]{3,})"/gu) ?? [])
      .map((match) => match.slice('"content":"'.length, -1).trim())
      .filter((content) => content.length > 2 && !content.includes('\\'))
    const selectedAddedLine = selectedContents.find((content) => afterVersion.diffText.includes(content)) ?? ''
    recorder.note({
      step: 'diff-version-match',
      marker: versionMarker,
      before: { fileStats: beforeVersion.fileStats, diffText: beforeVersion.diffText.slice(0, 120) },
      after: { fileStats: afterVersion.fileStats, hasMarker: afterVersion.diffText.includes(versionMarker), notices: afterVersion.notices, selectedRow: afterVersion.selectedRow },
      rereading,
      selected: {
        name: selectedName,
        addedLine: selectedAddedLine,
        status: selectedDiff?.status ?? null,
        uiShowsIt: selectedAddedLine.length > 0 && afterVersion.diffText.includes(selectedAddedLine),
      },
      api: {
        revision: apiRevision ?? null,
        status: apiDiff?.status ?? null,
        hasMarker: apiDiffText.includes(versionMarker),
        files: apiSnapshot.body?.files?.length ?? null,
      },
      screenshot: versionShot,
    })
    recorder.check(
      selectedName.length > 0 && selectedAddedLine.length > 0 && afterVersion.diffText.includes(selectedAddedLine),
      'the diff on screen is the one the snapshot revision holds for the selected file',
      { selectedName, selectedAddedLine, diffText: afterVersion.diffText.slice(0, 160) },
    )
    // The list itself has to be the revision it was built from: same files, same totals.
    const uiNames = String(afterVersion.fileStats ?? '')
      .split('|')
      .map((row) => row.trim().replace(/^[A-Z?!]{1,2}\s*/u, '').match(/[\w.\u4e00-\u9fff-]+\.\w+/u)?.[0] ?? '')
      .filter((name) => name.length > 0)
      .sort()
    const apiNames = (apiSnapshot.body?.files ?? []).map((file) => String(file.path).split(/[\\/]/u).pop() ?? '').sort()
    const uiAdditions = (String(afterVersion.fileStats ?? '').match(/\+(\d+)/gu) ?? [])
      .reduce((total, token) => total + Number(token.slice(1)), 0)
    recorder.note({
      step: 'list-vs-revision',
      uiNames,
      apiNames,
      uiAdditions,
      apiAdditions: apiSnapshot.body?.additions ?? null,
      selected: { name: selectedName, uiShowsIt: selectedAddedLine.length > 0 && afterVersion.diffText.includes(selectedAddedLine) },
    })
    recorder.check(
      // Row labels are ellipsized by the view (measured: `sample.txt` renders as
      // `ample.txt`), so the comparison is on the count and the totals the revision
      // carries; the names stay in the record as evidence.
      afterVersion.files === (apiSnapshot.body?.files?.length ?? -1)
      && uiAdditions === (apiSnapshot.body?.additions ?? -1)
      && rereading === false,
      'the file list on screen matches the snapshot revision it came from, totals included',
      { uiFiles: afterVersion.files, apiFiles: apiSnapshot.body?.files?.length ?? null, uiNames, apiNames, uiAdditions, apiAdditions: apiSnapshot.body?.additions ?? null },
    )
    recorder.check(
      Boolean(apiRevision) && apiDiff?.status === 200 && apiDiffText.includes(versionMarker),
      'the diff read for the snapshot revision the list came from contains the new line',
      { revision: apiRevision ?? null, status: apiDiff?.status ?? null, hasMarker: apiDiffText.includes(versionMarker) },
    )
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'review-refresh-errors',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    window: WINDOW,
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The fixture injects page-level fetch failures and a held request; the view, the review cache and the Local App API are the real ones, so this proves where stale content is reported, not how Git itself fails.',
      'The last-success time comes from the snapshot that is still on screen; the file diff has no timestamp of its own and only says it is showing the previous result.',
      'The in-flight diff wording observed here is the "belongs to the previous snapshot" variant, which is what a refresh produces; the same-revision "refreshing" variant needs a cached diff whose TTL has expired and is covered by review-refresh-notice.test.ts instead.',
      'Snapshot revision identity is still a per-read value and no HEAD/index consistency check is performed here; that part of UX-27 stays open.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

async function captureScreenshot(client, dir, name) {
  await mkdir(dir, { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, name), Buffer.from(shot.data, 'base64'))
  return join(dir, name)
}

await main()
