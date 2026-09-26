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
import { mkdir, mkdtemp, writeFile , rm } from 'node:fs/promises'
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
    failSnapshot: false, failDiff: false, conflictDiff: false, holdSnapshot: false, holdDiff: false,
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
      if (probe.conflictDiff) return Promise.resolve(new Response(JSON.stringify({ error: 'fixture diff conflict' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }));
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
    fileStats: [...(review?.querySelectorAll('[role="treeitem"]') ?? [])].map((node) => (node.textContent || '').replace(/\\s+/gu, ' ').trim()).join(' | '),
    selectedRow: (review?.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent || '').replace(/\\s+/gu, ' ').trim(),
    branch: (review?.querySelector('.workspace-files-root span')?.textContent || '').replace('Git 审阅', '').trim(),
    summary: (review?.querySelector('.workspace-review-tree-summary span')?.textContent || '').replace(/\s+/gu, ' ').trim(),
    diffMetadata: [...(review?.querySelectorAll('.workspace-review-diff-metadata li') ?? [])].map((node) => (node.textContent || '').replace(/\\s+/gu, ' ').trim()),
    // Real gutter numbers of the modified side, and whether a long line wrapped instead of
    // scrolling sideways (UX-28 item 4).
    diffDom: (() => {
      const wrapper = document.querySelector('.workspace-review-monaco-diff');
      const classes = new Set();
      wrapper?.querySelectorAll('*').forEach((node) => ('' + (node.getAttribute('class') || '')).split(/\\s+/u).forEach((name) => name && classes.add(name)));
      return {
        present: Boolean(wrapper),
        hasDiffEditor: Boolean(document.querySelector('.monaco-diff-editor')),
        lineNumberNodes: document.querySelectorAll('.line-numbers').length,
        classes: [...classes].slice(0, 24),
      };
    })(),
    monaco: {
      editors: document.querySelectorAll('.workspace-review-monaco-diff .monaco-editor').length,
      viewLines: document.querySelectorAll('.workspace-review-monaco-diff .view-line').length,
      modifiedViewLines: document.querySelectorAll('.workspace-review-monaco-diff [class*="modified-in-monaco-diff-editor"] .view-line').length,
      lineNumberTexts: [...document.querySelectorAll('.workspace-review-monaco-diff [class*="modified-in-monaco-diff-editor"] .line-numbers')]
        .map((node) => (node.textContent || '').trim()).slice(0, 12),
      containerHeight: (() => {
        const pane = document.querySelector('.workspace-review-diff-scroll');
        return pane instanceof HTMLElement ? Math.round(pane.getBoundingClientRect().height) : null;
      })(),
      // Every Monaco diff root in the document, not just the first: an orphan from an earlier
      // mount would make the measurement below describe the wrong editor.
      diffRoots: [...document.querySelectorAll('.monaco-diff-editor')].map((node) => ({
        height: Math.round(node.getBoundingClientRect().height),
        inlineHeight: node.style.height || null,
        viewLines: node.querySelectorAll('.view-line').length,
        connected: node.isConnected,
        insideReview: Boolean(node.closest('.workspace-review-monaco-diff')),
      })),
      // Every node from the pane down to Monaco's root: which one fails to receive the height?
      heightChain: (() => {
        const chain = [];
        let node = document.querySelector('.workspace-review-monaco-diff');
        for (let depth = 0; node instanceof HTMLElement && depth < 8; depth += 1) {
          const style = getComputedStyle(node);
          chain.push({
            depth,
            tag: node.tagName.toLowerCase(),
            class: (node.getAttribute('class') || '').slice(0, 60),
            height: Math.round(node.getBoundingClientRect().height),
            computedHeight: style.height,
            display: style.display,
            flex: style.flex,
            minHeight: style.minHeight,
            inlineHeight: node.style.height || null,
          });
          node = node.firstElementChild;
        }
        return chain;
      })(),
      windowHeight: window.innerHeight,
    },
    gutterNumbers: [...document.querySelectorAll('.workspace-review-monaco-diff [class*="modified-in-monaco-diff-editor"] .line-numbers')]
      .map((node) => (node.textContent || '').trim())
      .filter((value) => /^[0-9]+$/u.test(value)),
    wrap: (() => {
      const scrollable = document.querySelector('.workspace-review-monaco-diff [class*="modified-in-monaco"] .monaco-scrollable-element');
      const line = document.querySelector('.workspace-review-monaco-diff [class*="modified-in-monaco"] .view-line');
      return scrollable instanceof HTMLElement && line instanceof HTMLElement
        ? {
          horizontalOverflow: scrollable.scrollWidth - scrollable.clientWidth,
          lineWidth: Math.round(line.getBoundingClientRect().width),
          containerWidth: Math.round(scrollable.getBoundingClientRect().width),
        }
        : null;
    })(),
    placeholder: [...(review?.querySelectorAll('.workspace-placeholder') ?? [])].map((node) => (node.textContent || '').replace(/\\s+/gu, ' ').trim()).join(' | '),
    layers: review?.querySelectorAll('.workspace-review-diff-layer').length ?? 0,
    notices,
    refresh: refresh ? { disabled: refresh.disabled } : null,
    revision: (document.querySelector('.workspace-review-diff')?.textContent || '').length,
    // The diff *layers'* text, not the whole pane: the pane also hosts the built-in
    // editor placeholder, which has nothing to do with the diff's version.
    diffText: [...document.querySelectorAll('.workspace-review-diff-layer')]
      .map((node) => node.textContent || '').join(' ').replace(/\\s+/gu, ' ').trim().slice(0, 600),
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

async function selectReviewRow(client, fragment) {
  const clicked = await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.workspace-review [role="treeitem"]')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(fragment)}));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`review row ${fragment} is not listed`)
  await delay(500)
}

async function switchWorkspaceTab(client, label) {
  const clicked = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.workspace-active-item')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(label)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`)
  await delay(600)
  return clicked
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
    electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      // The window stays hidden (this gate never shows one), and a hidden window gets
      // backgrounded: Chromium stops producing frames, so `requestAnimationFrame` never
      // fires — and the editor lays itself out from a rAF callback. Measured with the
      // default flags: the diff DOM holds two line-number nodes, no `.view-line` at all,
      // and a degenerate scrollWidth. These switches keep the renderer unthrottled so the
      // same surface can actually be measured; they change the host, not the app.
      extraArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    })
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

    // A diff that keeps answering 409 cannot trigger an endless snapshot/diff cycle.
    const beforeConflict = await readSurface(client)
    await setProbe(client, { conflictDiff: true })
    await click(client, REFRESH_LABEL)
    const conflictStopped = await waitForSurface(
      client,
      (surface) => surface.notices.some((notice) => notice.text.includes('持续变化，已停止自动刷新')),
      25_000,
      'repeated diff conflicts stop with an actionable notice',
    ).catch(() => readSurface(client))
    const conflictDiffReads = conflictStopped.probe.diffs - beforeConflict.probe.diffs
    const conflictSnapshotReads = conflictStopped.probe.snapshots - beforeConflict.probe.snapshots
    recorder.note({ step: 'bounded-diff-conflict', notices: conflictStopped.notices, conflictDiffReads, conflictSnapshotReads })
    recorder.check(
      conflictStopped.notices.some((notice) => notice.text.includes('持续变化，已停止自动刷新'))
        && conflictDiffReads <= 3 && conflictSnapshotReads <= 3,
      'repeated 409 responses stop after bounded retries and explain the next action',
      { notices: conflictStopped.notices, conflictDiffReads, conflictSnapshotReads },
    )
    await setProbe(client, { conflictDiff: false })
    await click(client, REFRESH_LABEL)
    await waitForSurface(client, (surface) => surface.notices.length === 0, 20_000, 'diff recovers after conflict')

    // UX-27 item 4: a delayed older answer must not win. The renderer prevents two
    // overlapping snapshot reads (in-flight guard + one queued follow-up), so the property
    // is checked where it lives. The toolbar button is *disabled* while a read is in flight,
    // so the extra clicks below never reach the guard at all; the request that still reaches
    // it is the diff notice's retry, whose 409 asks for a fresh snapshot and is therefore the
    // queued follow-up. That is the shape asserted here: the clicks start no read, the held
    // (deliberately stale) answer lands, and the queued follow-up replaces it with the newest
    // list and leaves no notice behind.
    await setProbe(client, { failDiff: true, conflictDiff: false, holdSnapshotNext: 0, holdSnapshot: false, holdDiff: false })
    await click(client, REFRESH_LABEL)
    const diffRetryBefore = await waitForSurface(
      client,
      (surface) => retryButton(surface, '重试差异')?.disabled === false
        && surface.notices.some((notice) => notice.text.includes('差异更新失败')),
      25_000,
      'a retryable diff failure before the out-of-order read',
    ).catch(() => readSurface(client))
    await setProbe(client, { failDiff: false, conflictDiff: true, holdSnapshotNext: 1 })
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
    // The retry runs while the snapshot read is held, and its 409 makes the diff reader ask
    // for a new snapshot instead of starting one, which is exactly the queued follow-up.
    const queuedRetry = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.workspace-review button')]
        .find((node) => (node.textContent || '').trim() === '重试差异');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`)
    await delay(400)
    await setProbe(client, { conflictDiff: false })
    await client.evaluate(`(() => { window.__reviewHolds.craftStale = true; const next = window.__reviewHolds.queued.shift(); if (next) next(); return true; })()`)
    // The queued refresh starts once the queue drains; only then can the newest list be
    // on screen. Waiting for both in one predicate raced the queue in an earlier run.
    await waitForSurface(client, (surface) => surface.probe.queued === 0, 20_000, 'the queued refresh left the queue')
      .catch(() => undefined)
    const settledOutOfOrder = await waitForSurface(
      client,
      (surface) => surface.notices.length === 0 && surface.files >= 2,
      30_000,
      'newest read settles after the stale answer',
    ).catch(() => readSurface(client))
    const outOfOrderShot = await captureScreenshot(client, screenshotDir, 'review-out-of-order.png')
    recorder.note({
      step: 'out-of-order-snapshot',
      before: { snapshots: beforeOutOfOrder.probe.snapshots, files: beforeOutOfOrder.files },
      diffRetry: { available: retryButton(diffRetryBefore, '重试差异')?.disabled === false, diffs: diffRetryBefore.probe.diffs },
      held: { snapshots: heldCount, files: heldOlder.files },
      whileHeld: { snapshots: whileHeld.probe.snapshots, files: whileHeld.files, refreshDisabled: whileHeld.refresh?.disabled ?? null },
      queuedRetry,
      settled: { snapshots: settledOutOfOrder.probe.snapshots, files: settledOutOfOrder.files, notices: settledOutOfOrder.notices.length },
      screenshot: outOfOrderShot,
    })
    recorder.check(
      whileHeld.probe.snapshots === heldCount,
      'refreshes clicked while a read is in flight do not start more reads',
      { heldCount, whileHeld: whileHeld.probe.snapshots, refreshDisabled: whileHeld.refresh?.disabled ?? null },
    )
    recorder.check(
      settledOutOfOrder.files >= 2 && settledOutOfOrder.notices.length === 0
      && settledOutOfOrder.probe.snapshots > heldCount,
      'after a stale answer and the queued refresh, the list is the newest read with no notice left',
      {
        files: settledOutOfOrder.files,
        notices: settledOutOfOrder.notices,
        heldSnapshots: heldCount,
        settledSnapshots: settledOutOfOrder.probe.snapshots,
        queuedRetry,
      },
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
      // Names, count and totals all come from the same read. (An earlier version compared
      // only the counts because row labels *looked* ellipsized: that was this gate eating
      // the letter `s` through `/s+/` in a template literal, not the view.)
      uiNames.join(',') === apiNames.join(',')
      && afterVersion.files === (apiSnapshot.body?.files?.length ?? -1)
      && uiAdditions === (apiSnapshot.body?.additions ?? -1)
      && rereading === false,
      'the file list on screen matches the snapshot revision it came from, names and totals included',
      { uiFiles: afterVersion.files, apiFiles: apiSnapshot.body?.files?.length ?? null, uiNames, apiNames, uiAdditions, apiAdditions: apiSnapshot.body?.additions ?? null },
    )
    recorder.check(
      Boolean(apiRevision) && apiDiff?.status === 200 && apiDiffText.includes(versionMarker),
      'the diff read for the snapshot revision the list came from contains the new line',
      { revision: apiRevision ?? null, status: apiDiff?.status ?? null, hasMarker: apiDiffText.includes(versionMarker) },
    )

    // UX-27 item 3: the repository moving underneath the view must not mix data. Each of
    // these is a real Git change followed by a refresh, so the list and the diff have to
    // describe the *new* state only.
    const stageAndEdit = async () => {
      git(workspaceDir, ['add', 'sample.txt'])
      await writeFile(samplePath, `first\n${versionMarker}\n${versionMarker}-unstaged\n`, 'utf8')
      await click(client, REFRESH_LABEL)
      await waitForSurface(client, (surface) => surface.files >= 1, 25_000, 'the staged file is listed')
      // Diff layers belong to the *selected* file, and the selection follows the list
      // (newer.txt sorts first), so the staged file has to be selected explicitly.
      await client.evaluate(`(() => {
        const row = [...document.querySelectorAll('.workspace-review [role="treeitem"]')]
          .find((node) => (node.textContent || '').includes('ample.txt'));
        if (row instanceof HTMLElement) row.click();
        return true;
      })()`)
      return waitForSurface(
        client,
        (surface) => surface.layers >= 2,
        25_000,
        'staged and unstaged layers for the same file',
      ).catch(() => readSurface(client))
    }
    const stagedAndEdited = await stageAndEdit()
    recorder.note({
      step: 'staged-then-edited',
      files: stagedAndEdited.files,
      layers: stagedAndEdited.layers,
      fileStats: stagedAndEdited.fileStats,
    })
    recorder.check(
      stagedAndEdited.layers >= 2,
      'a file staged and then edited again shows both layers instead of one',
      { files: stagedAndEdited.files, layers: stagedAndEdited.layers, fileStats: stagedAndEdited.fileStats },
    )

    // Undo: the working tree goes back to HEAD, so the file must leave the list and its
    // diff must not stay on screen as if it were still changed.
    git(workspaceDir, ['restore', '--staged', 'sample.txt'])
    git(workspaceDir, ['restore', 'sample.txt'])
    await click(client, REFRESH_LABEL)
    const afterUndo = await waitForSurface(
      client,
      (surface) => surface.files === 1,
      25_000,
      'only the untracked file is left after the undo',
    ).catch(() => readSurface(client))
    const undoSnapshot = await harness.fetchJson(locator, `/workspace/review?root=${encodeURIComponent(workspaceDir)}`)
    recorder.note({
      step: 'undo-removes-the-change',
      files: afterUndo.files,
      fileStats: afterUndo.fileStats,
      apiFiles: (undoSnapshot.body?.files ?? []).map((file) => file.path),
    })
    recorder.check(
      afterUndo.files === 1
      && (undoSnapshot.body?.files ?? []).every((file) => !String(file.path).endsWith('sample.txt')),
      'undoing the edit removes the file from the list instead of leaving a stale diff',
      { files: afterUndo.files, apiFiles: (undoSnapshot.body?.files ?? []).map((file) => file.path) },
    )

    // Commit: a clean tree, and the branch label still names where we are.
    git(workspaceDir, ['add', 'newer.txt'])
    git(workspaceDir, ['commit', '-m', 'fixture commit during review'])
    await click(client, REFRESH_LABEL)
    const afterCommit = await waitForSurface(
      client,
      (surface) => surface.files === 0 && !surface.notices.some((notice) => notice.tone === 'error'),
      25_000,
      'clean tree after the commit',
    ).catch(() => readSurface(client))
    recorder.note({ step: 'commit-during-review', files: afterCommit.files, branch: afterCommit.branch, notices: afterCommit.notices })
    recorder.check(
      afterCommit.files === 0 && afterCommit.branch === 'main',
      'committing leaves an empty, correct list on the same branch',
      { files: afterCommit.files, branch: afterCommit.branch },
    )

    // Branch switch: the label follows, and switching back shows the same state again.
    git(workspaceDir, ['checkout', '-b', 'fixture-branch'])
    await writeFile(join(workspaceDir, 'on-branch.txt'), 'branch work\n', 'utf8')
    await click(client, REFRESH_LABEL)
    const onBranch = await waitForSurface(
      client,
      (surface) => surface.branch === 'fixture-branch' && surface.files === 1,
      25_000,
      'branch switch reflected in the label and list',
    ).catch(() => readSurface(client))
    git(workspaceDir, ['checkout', 'main'])
    await rm(join(workspaceDir, 'on-branch.txt'), { force: true }).catch(() => undefined)
    await click(client, REFRESH_LABEL)
    const backOnMain = await waitForSurface(
      client,
      (surface) => surface.branch === 'main' && surface.files === 0,
      25_000,
      'back on main with a clean tree',
    ).catch(() => readSurface(client))
    recorder.note({
      step: 'branch-switch',
      onBranch: { branch: onBranch.branch, files: onBranch.files },
      backOnMain: { branch: backOnMain.branch, files: backOnMain.files },
    })
    recorder.check(
      onBranch.branch === 'fixture-branch' && onBranch.files === 1
      && backOnMain.branch === 'main' && backOnMain.files === 0,
      'switching branches and back shows each branch state, never a mixture',
      { onBranch: { branch: onBranch.branch, files: onBranch.files }, backOnMain: { branch: backOnMain.branch, files: backOnMain.files } },
    )

    // A→B→A on the file list: the diff has to follow the selection, not lag behind it.
    await writeFile(join(workspaceDir, 'alpha.txt'), 'alpha\n', 'utf8')
    await writeFile(join(workspaceDir, 'beta.txt'), 'beta\n', 'utf8')
    await click(client, REFRESH_LABEL)
    await waitForSurface(client, (surface) => surface.files === 2, 25_000, 'two changed files')
    const selectRow = (fragment) => client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.workspace-review [role="treeitem"]')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(fragment)}));
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`)
    const alphaSelected = await selectRow('alpha.')
    const alphaShown = await waitForSurface(client, (surface) => surface.diffText.includes('alpha'), 20_000, 'alpha diff').catch(() => readSurface(client))
    const betaSelected = await selectRow('beta.')
    const betaShown = await waitForSurface(client, (surface) => surface.diffText.includes('beta'), 20_000, 'beta diff').catch(() => readSurface(client))
    const alphaAgain = await selectRow('alpha.')
    const alphaBack = await waitForSurface(
      client,
      (surface) => surface.diffText.includes('alpha') && !surface.diffText.includes('beta'),
      20_000,
      'alpha diff again',
    ).catch(() => readSurface(client))
    recorder.note({
      step: 'file-switch-a-b-a',
      selected: { alpha: alphaSelected, beta: betaSelected, alphaAgain },
      shown: {
        alpha: alphaShown.diffText.slice(0, 80),
        beta: betaShown.diffText.slice(0, 80),
        alphaBack: alphaBack.diffText.slice(0, 80),
      },
    })
    recorder.check(
      alphaSelected === true && betaSelected === true && alphaAgain === true
      && alphaShown.diffText.includes('alpha')
      && betaShown.diffText.includes('beta')
      && alphaBack.diffText.includes('alpha') && !alphaBack.diffText.includes('beta'),
      'switching files A → B → A shows each file\'s own diff and nothing from the other',
      { alpha: alphaShown.diffText.slice(0, 60), beta: betaShown.diffText.slice(0, 60), alphaBack: alphaBack.diffText.slice(0, 60) },
    )

    // Continuous change: the repository keeps being written to while the view refreshes.
    // The reads must stay bounded (no infinite refresh loop) and the view must settle.
    const beforeChurn = await readSurface(client)
    let churn = true
    let churnSequence = 0
    const churnTimer = setInterval(() => {
      if (!churn) return
      churnSequence += 1
      void writeFile(join(workspaceDir, `churn-${churnSequence}.txt`), `churn ${churnSequence}\n`, 'utf8')
    }, 25)
    try {
      for (let clickIndex = 0; clickIndex < 3; clickIndex += 1) {
        await click(client, REFRESH_LABEL)
        await delay(400)
      }
      const settledUnderChurn = await waitForSurface(
        client,
        (surface) => !surface.refresh?.disabled && surface.notices.every((notice) => notice.tone !== 'error'),
        25_000,
        'view settles while the repository keeps changing',
      ).catch(() => readSurface(client))
      recorder.note({
        step: 'churn-under-refresh',
        files: settledUnderChurn.files,
        snapshots: settledUnderChurn.probe?.snapshots ?? null,
        readsDuringChurn: (settledUnderChurn.probe?.snapshots ?? 0) - (beforeChurn.probe?.snapshots ?? 0),
        notices: settledUnderChurn.notices,
      })
      const churnReads = (settledUnderChurn.probe?.snapshots ?? 0) - (beforeChurn.probe?.snapshots ?? 0)
      recorder.check(
        settledUnderChurn.notices.every((notice) => notice.tone !== 'error') && churnReads <= 6,
        'continuous change keeps the refresh bounded and leaves no error behind',
        { churnReads, snapshots: settledUnderChurn.probe?.snapshots ?? null, notices: settledUnderChurn.notices },
      )
      recorder.check(
        settledUnderChurn.notices.some((notice) => notice.text.includes('仓库在读取期间仍在变化')),
        'continuous change is labelled unstable in the review surface',
        { churnSequence, notices: settledUnderChurn.notices },
      )
    } finally {
      churn = false
      clearInterval(churnTimer)
    }

    // UX-28 item 3 in the window: a pure rename has no text hunk, so it has to appear as
    // metadata (and never as "no line diff" or as an unparsed format).
    // UX-28 item 4: the diff interactions. A fixture file with a known deletion and a very
    // long added line gives real gutter numbers, a wrap measurement, a deleted line to
    // comment on, and a source file to return to.
    const longLine = `long-${'x'.repeat(400)}`
    await writeFile(join(workspaceDir, 'interactions.txt'), 'first\nsecond\nthird\n', 'utf8')
    git(workspaceDir, ['add', 'interactions.txt'])
    git(workspaceDir, ['commit', '-m', 'interactions fixture'])
    await writeFile(join(workspaceDir, 'interactions.txt'), `first\n${longLine}\nthird\n`, 'utf8')
    await click(client, REFRESH_LABEL)
    await waitForSurface(
      client,
      (surface) => surface.fileStats.includes('interactions.txt'),
      25_000,
      'the interaction fixture is listed',
    ).catch(() => readSurface(client))
    // Layout-dependent checks need a window that renders. This one is parked off every
    // display and shown inactively, so it renders without ever appearing on the desktop —
    // the hidden-window contract stays for every other step.
    await harness.desktopAction(locator, 'park-offscreen')
    await delay(1200)
    // Prove the parked window is actually outside the desktop: the whole point is that it
    // renders without ever appearing in front of the person using the machine.
    const parkedPosition = await client.evaluate(`({
      screenX: window.screenX, screenY: window.screenY,
      screenWidth: window.screen.width, screenHeight: window.screen.height,
      availWidth: window.screen.availWidth, availHeight: window.screen.availHeight,
      focused: document.hasFocus(),
    })`)
    recorder.note({ step: 'parked-window', parkedPosition })
    recorder.check(
      parkedPosition.screenX + parkedPosition.screenWidth < 0
      || parkedPosition.screenY + parkedPosition.screenHeight < 0,
      'the parked window sits outside every display',
      parkedPosition,
    )
    await selectReviewRow(client, 'interactions.txt')
    // Decisive probe: ask Monaco itself. If a live editor exists, whether `layout()` (measured)
    // or `layout({width, height})` (explicit) changes its box separates "the app never reaches
    // the live editor" from "the editor refuses to take a size".
    const monacoLayoutProbe = await client.evaluate(`(() => {
      const api = window.monaco;
      const editors = api?.editor?.getDiffEditors?.() ?? [];
      const read = () => editors.map((editor) => {
        const node = editor.getDomNode();
        return {
          inlineHeight: node ? node.style.height : null,
          height: node ? Math.round(node.getBoundingClientRect().height) : null,
        };
      });
      const pane = document.querySelector('.workspace-review-monaco-diff');
      const result = {
        hasMonaco: Boolean(api),
        diffEditors: editors.length,
        before: read(),
      };
      editors.forEach((editor) => editor.layout());
      result.afterMeasured = read();
      editors.forEach((editor) => editor.layout({
        width: pane ? pane.clientWidth : 800,
        height: pane ? pane.clientHeight : 600,
      }));
      result.afterExplicit = read();
      result.paneSize = pane ? { width: pane.clientWidth, height: pane.clientHeight } : null;
      return result;
    })()`)
    recorder.note({ step: 'diff-monaco-layout-probe', monacoLayoutProbe })
    await delay(500)

    // Measured here and recorded, not asserted: one `.monaco-diff-editor` exists, it is
    // connected and inside the review pane, its parent chain is a definite 716 px, and it
    // still carries an inline `height: 5px` with a single rendered line — in a window that is
    // rendering (this step parks it off screen). The app's own layout event does not change
    // it either. That is an app-side defect with its own follow-up, not a harness limit.
    // A hidden window never lays out until something forces a paint, and Monaco keeps its
    // view lines and gutter empty until then. One bounded capture is the warm-up the HTML
    // walkthrough already relies on; without it every rendered check below sees a stub.
    await captureScreenshot(client, screenshotDir, 'review-warmup.png')
    await delay(1200)
    await captureScreenshot(client, screenshotDir, 'review-warmup-2.png')
    await delay(600)
    const interactionDiff = await waitForSurface(
      client,
      (surface) => surface.diffText.includes('long-'),
      25_000,
      'the interaction diff is on screen',
    ).catch(() => readSurface(client))
    const interactionShot = await captureScreenshot(client, screenshotDir, 'review-diff-interactions.png')
    recorder.note({
      step: 'diff-interactions',
      gutterNumbers: interactionDiff.gutterNumbers,
      monaco: interactionDiff.monaco,
      diffRoots: interactionDiff.diffRoots,
      diffDom: interactionDiff.diffDom,
      wrap: interactionDiff.wrap,
      screenshot: interactionShot,
    })
    // A hidden window gives Monaco no viewport: only a stub of the gutter exists (measured:
    // one number, and no `.view-line` for the long line at all), so the *rendered* numbers
    // cannot be judged here. The numbering itself is proven where it is produced — the model
    // (`review-diff-model.test.ts` asserts source numbers and `...` gaps) — and this records
    // what the window did render.
    recorder.check(
      // One deletion on line 2 replaced by an addition, so the modified side is exactly 1..3.
      interactionDiff.gutterNumbers.join(',') === '1,2,3',
      'the diff gutter shows the real source line numbers',
      { gutterNumbers: interactionDiff.gutterNumbers },
    )
    // Wrapping cannot be judged from geometry here: a hidden window never lays the diff out,
    // and the measured scrollWidth is degenerate (recorded below, 16 million px). What can be
    // checked honestly is the configuration that decides it, and that the long line reached
    // the diff at all; the recorded numbers are evidence, not an assertion.
    const wrapConfigured = await client.evaluate(`(() => {
      const longLine = [...document.querySelectorAll('.workspace-review-monaco-diff .view-line')]
        .some((node) => (node.textContent || '').includes('long-'));
      return { longLineRendered: longLine };
    })()`)
    // The rendered text is empty here for the same reason (no viewport), so the long line is
    // checked where it certainly exists: the diff the API returns for that file.
    const longLineSnapshot = await harness.fetchJson(locator, `/workspace/review?root=${encodeURIComponent(workspaceDir)}`)
    const longLineDiff = longLineSnapshot.body?.revision
      ? await harness.fetchJson(
        locator,
        `/workspace/review/diff?root=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent('interactions.txt')}&revision=${encodeURIComponent(longLineSnapshot.body.revision)}`,
      )
      : null
    const longLineInApi = JSON.stringify(longLineDiff.body ?? {}).includes('long-')
    recorder.note({
      step: 'diff-long-line',
      wrap: interactionDiff.wrap,
      ...wrapConfigured,
      apiStatus: longLineDiff.status,
      apiCarriesLongLine: longLineInApi,
    })
    // Wrapping is checked on the rendered line box: with wrapping on it is clamped to the
    // editor's width, and the raw scrollWidth of Monaco's scrollable element is meaningless
    // here (measured 16,776,893 px even when everything renders).
    const wrapBox = await client.evaluate(`(() => {
      const editor = document.querySelector('.workspace-review-monaco-diff [class*="modified-in-monaco-diff-editor"]');
      const line = editor?.querySelector('.view-line');
      return editor instanceof HTMLElement && line instanceof HTMLElement
        ? { editor: Math.round(editor.getBoundingClientRect().width), line: Math.round(line.getBoundingClientRect().width) }
        : null;
    })()`)
    recorder.note({ step: 'diff-wrap-box', wrapBox, apiCarriesLongLine: longLineInApi })
    recorder.check(
      longLineInApi === true && wrapBox !== null && wrapBox.line <= wrapBox.editor + 1,
      'the very long line reaches the diff and its rendered line box stays inside the editor',
      { apiStatus: longLineDiff.status, apiCarriesLongLine: longLineInApi, wrapBox },
    )

    // Keyboard selection: focus another row and press Enter through the browser's own input
    // pipeline (a synthetic DOM event would not exercise the real focus/activation path).
    const keyboardMove = await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.workspace-review [role="treeitem"]')];
      const selected = rows.findIndex((node) => node.getAttribute('aria-selected') === 'true');
      const targetIndex = selected === 0 ? 1 : 0;
      const target = rows[targetIndex];
      if (!(target instanceof HTMLElement)) return { rows: rows.length, focused: false };
      target.focus();
      return {
        rows: rows.length,
        focused: document.activeElement === target,
        targetLabel: (target.textContent || '').trim(),
        targetIndex,
      };
    })()`)
    for (const type of ['keyDown', 'char', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined,
      })
    }
    await delay(800)
    const afterKeyboard = await readSurface(client)
    recorder.note({
      step: 'diff-keyboard-selection',
      keyboardMove,
      selectedRow: afterKeyboard.selectedRow,
      previousRow: interactionDiff.selectedRow,
    })
    recorder.check(
      keyboardMove.focused === true
      && afterKeyboard.selectedRow !== interactionDiff.selectedRow,
      'a focused review row selects its file when activated from the keyboard',
      { before: interactionDiff.selectedRow, after: afterKeyboard.selectedRow, focused: keyboardMove.focused },
    )

    // A deleted line can be commented on: the affordance opens the shared comment editor.
    // The add button on a deleted line appears on hover, and hovering needs a laid-out layer:
    // a hidden window has neither pointer position nor layout. What is checked is that the
    // layer exists for a file with a deletion and that the comment editor opens through the
    // layer's own state, so the clause is not simply assumed.
    // Deleted-line markers live in the inline (single column) view, so switch to it first; the
    // affordance itself appears on hover over the deleted zone, and hovering needs a laid-out
    // surface — which the parked window now provides. Both switches go through the real UI.
    const columnSwitch = await client.evaluate(`(() => {
      const toggle = document.querySelector('.workspace-review-diff-actions button[aria-pressed]');
      if (!(toggle instanceof HTMLElement)) return { found: false };
      const before = toggle.getAttribute('aria-pressed');
      if (before === 'true') toggle.click();
      return { found: true, before, label: toggle.getAttribute('aria-label') };
    })()`)
    await delay(1500)
    const inlineMode = await client.evaluate(`(() => {
      const review = document.querySelector('.workspace-review');
      const toggle = document.querySelector('.workspace-review-diff-actions button[aria-pressed]');
      return {
        sideBySide: review ? review.classList.contains('is-side-by-side') : null,
        pressed: toggle ? toggle.getAttribute('aria-pressed') : null,
      };
    })()`)
    recorder.note({ step: 'diff-inline-mode', columnSwitch, inlineMode })
    const deletedZone = await client.evaluate(`(() => {
      const marker = document.querySelector('.workspace-review-monaco-diff .gutter-delete')
        ?? document.querySelector('.workspace-review-monaco-diff [class*="delete"]');
      if (!(marker instanceof HTMLElement)) return null;
      const rect = marker.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`)
    if (deletedZone) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deletedZone.x, y: deletedZone.y, button: 'none' })
      await delay(400)
    }
    const deletedLineComment = await client.evaluate(`(() => {
      const layer = document.querySelector('.workspace-review-inline-deleted-comments');
      const zones = layer?.querySelectorAll('.workspace-review-inline-deleted-comment-state').length ?? 0;
      const add = document.querySelector('.workspace-line-comment-add, .workspace-line-comment-add-button');
      if (!(layer instanceof HTMLElement)) {
        return { found: false, zones: 0, addButton: Boolean(add), reason: 'layer-not-mounted' };
      }
      return {
        found: true,
        zones,
        addButton: Boolean(add),
        label: layer.getAttribute('aria-label'),
        edge: 'layer',
      };
    })()`)
    // The affordance is the shared add button; click it through the input pipeline and see
    // whether the comment editor opens on the deleted line.
    const addButtonRect = await client.evaluate(`(() => {
      const add = document.querySelector('.workspace-line-comment-add, .workspace-line-comment-add-button');
      if (!(add instanceof HTMLElement)) return null;
      const rect = add.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`)
    if (addButtonRect) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', {
          type,
          x: addButtonRect.x,
          y: addButtonRect.y,
          button: 'left',
          clickCount: 1,
        })
      }
      await delay(500)
    }
    await delay(700)
    const commentEditor = await client.evaluate(`(() => {
      const editor = document.querySelector('.workspace-line-comment-editor textarea, .workspace-line-comment-editor');
      return editor instanceof HTMLElement ? { open: true, tag: editor.tagName } : { open: false };
    })()`)
    const deletedShot = await captureScreenshot(client, screenshotDir, 'review-deleted-line-comment.png')
    recorder.note({ step: 'diff-deleted-line-comment', deletedLineComment, commentEditor, screenshot: deletedShot })
    recorder.check(
      inlineMode.sideBySide === false
      && addButtonRect !== null
      && commentEditor.open === true,
      'in the single-column view a comment can be started on a deleted line',
      { ...inlineMode, ...deletedLineComment, ...commentEditor },
    )
    // Back to the two-column view the rest of the walkthrough expects.
    await client.evaluate(`(() => {
      const toggle = document.querySelector('.workspace-review-diff-actions button[aria-pressed]');
      if (toggle instanceof HTMLElement && toggle.getAttribute('aria-pressed') === 'false') toggle.click();
      return true;
    })()`)
    await delay(600)
    await client.evaluate(`(() => {
      const cancel = [...document.querySelectorAll('.workspace-line-comment-editor button')]
        .find((node) => (node.textContent || '').trim() === '取消');
      if (cancel instanceof HTMLElement) cancel.click();
      return true;
    })()`)
    await delay(400)

    // Returning to the source file from the diff: the open action brings the real file up.
    const openedFromDiff = await client.evaluate(`(() => {
      const open = [...document.querySelectorAll('.workspace-review button')]
        .find((node) => (node.getAttribute('aria-label') || '').includes('在文件工作台中打开'));
      if (!(open instanceof HTMLElement)) return { clicked: false };
      open.click();
      return { clicked: true, disabled: open.hasAttribute('disabled') };
    })()`)
    await delay(1200)
    const sourceFileVisible = await client.evaluate(`(() => {
      const strip = document.querySelector('.workspace-tabs, .workspace-tab-strip');
      const text = (document.body.textContent || '');
      return {
        hasInteractionsTab: text.includes('interactions.txt'),
        stripFound: Boolean(strip),
      };
    })()`)
    const sourceShot = await captureScreenshot(client, screenshotDir, 'review-return-to-source.png')
    recorder.note({ step: 'diff-return-to-source', openedFromDiff, sourceFileVisible, screenshot: sourceShot })
    recorder.check(
      openedFromDiff.clicked === true && sourceFileVisible.hasInteractionsTab === true,
      'the diff can return to the source file in the file workspace',
      { ...openedFromDiff, ...sourceFileVisible },
    )
    // Back to the review tab so the steps below see the surface they expect.
    await switchWorkspaceTab(client, '审阅')

    git(workspaceDir, ['mv', 'sample.txt', 'renamed-sample.txt'])
    git(workspaceDir, ['add', '-A'])
    await click(client, REFRESH_LABEL)
    const renamedVisible = await waitForSurface(
      client,
      (surface) => surface.fileStats.includes('renamed-sample.txt'),
      25_000,
      'the rename appears in the list',
    ).catch(() => readSurface(client))
    await client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.workspace-review [role="treeitem"]')]
        .find((node) => (node.textContent || '').includes('renamed-sample.txt'));
      if (row instanceof HTMLElement) row.click();
      return true;
    })()`)
    const renameDiff = await waitForSurface(
      client,
      (surface) => surface.diffMetadata.length > 0,
      20_000,
      'rename metadata in the diff',
    ).catch(() => readSurface(client))
    const renameShot = await captureScreenshot(client, screenshotDir, 'review-rename-metadata.png')
    recorder.note({
      step: 'rename-metadata',
      fileStats: renamedVisible.fileStats,
      diffMetadata: renameDiff.diffMetadata,
      placeholder: renameDiff.placeholder,
      screenshot: renameShot,
    })
    recorder.check(
      renameDiff.diffMetadata.some((entry) => entry.includes('重命名自') && entry.includes('sample.txt'))
      && renameDiff.diffMetadata.some((entry) => entry.includes('重命名为') && entry.includes('renamed-sample.txt'))
      && !renameDiff.placeholder.includes('没有可显示的行差异'),
      'a pure rename is shown as rename metadata instead of as "no line diff"',
      { diffMetadata: renameDiff.diffMetadata, placeholder: renameDiff.placeholder },
    )

    // UX-28 item 5: the review limits have to stay visible. The fixture gains more than
    // the 2,000-file cap, the window narrows and the panel collapses — the truncation
    // sentence must still be on screen (inside the viewport, not clipped away).
    const manyFiles = 2_050
    await Promise.all(Array.from({ length: manyFiles }, (_unused, index) => (
      writeFile(join(workspaceDir, `bulk-${String(index).padStart(4, '0')}.txt`), 'x\n', 'utf8')
    )))
    await click(client, REFRESH_LABEL)
    const truncated = await waitForSurface(
      client,
      (surface) => surface.summary.includes('显示前') && surface.summary.includes('个文件'),
      60_000,
      'the capped list says what it is showing',
    ).catch(() => readSurface(client))
    const narrowShot = await captureScreenshot(client, screenshotDir, 'review-truncated-wide.png')
    // Narrow the window (the app clamps it to its own minimum, measured 800 px) and keep
    // the panel open: collapsing the panel hides the whole list *by design*, so the clause
    // "limits stay visible in a tight layout" is about the surface still being readable.
    await harness.desktopAction(locator, 'resize', { width: 620, height: 720 })
    await delay(800)
    const narrow = await readSurface(client)
    const narrowVisible = await client.evaluate(`(() => {
      const summary = document.querySelector('.workspace-review-tree-summary span');
      if (!(summary instanceof HTMLElement)) return null;
      const rect = summary.getBoundingClientRect();
      return {
        text: (summary.textContent || '').trim(),
        visible: rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1,
        viewport: window.innerWidth,
        clamped: window.innerWidth > 620,
      };
    })()`)
    const narrowNarrowShot = await captureScreenshot(client, screenshotDir, 'review-truncated-narrow.png')
    await harness.desktopAction(locator, 'resize', WINDOW)
    recorder.note({
      step: 'limits-visible',
      summary: truncated.summary,
      files: truncated.files,
      narrow: narrowVisible,
      narrowFiles: narrow.files,
      screenshots: [narrowShot, narrowNarrowShot],
    })
    recorder.check(
      truncated.summary.startsWith('显示前 2000 个，共')
      && truncated.files === 2_000,
      'a capped list says "showing the first 2000 of N" instead of a bare fraction',
      { summary: truncated.summary, files: truncated.files },
    )
    recorder.check(
      narrowVisible !== null && narrowVisible.visible === true && narrowVisible.text.startsWith('显示前'),
      'the truncation sentence stays inside a narrowed window',
      narrowVisible,
    )

    // UX-28 item 5, last clause: collapsing the navigator takes the list (and its cap
    // line) off screen, so the review body must state the limits instead.
    const collapsedToggle = await client.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('button')]
        .find((node) => (node.getAttribute('aria-label') || '').startsWith('折叠'));
      if (!(toggle instanceof HTMLElement)) return null;
      const label = toggle.getAttribute('aria-label');
      toggle.click();
      return label;
    })()`)
    // Reachability is measured after the layout settles: the collapse state flips first and
    // the geometry follows, and a hidden window has no animation frames to hurry it along.
    await delay(900)
    const collapsed = await client.evaluate(`(() => {
      const notice = document.querySelector('.workspace-review-limit-notice');
      const refresh = [...document.querySelectorAll('button')]
        .find((node) => node.getAttribute('aria-label') === '刷新 Git 更改');
      const reachable = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
      };
      // The navigator animates away rather than unmounting, so "collapsed" is measured as
      // "the list is no longer on screen", not as "the rows are gone from the DOM".
      // The navigator slides away with a transform, so a row keeps a rectangle inside a
      // collapsed container; checkVisibility answers whether it is really on screen.
      const tree = document.querySelector('.workspace-review-tree-scroll');
      const row = document.querySelector('.workspace-review [role="treeitem"]');
      const visible = (node) => Boolean(node instanceof HTMLElement
        && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      return {
        bodyLimit: (notice?.textContent || '').trim(),
        bodyLimitVisible: visible(notice),
        rows: document.querySelectorAll('.workspace-review [role="treeitem"]').length,
        listVisible: visible(tree) || visible(row),
        listWidth: tree instanceof HTMLElement ? Math.round(tree.getBoundingClientRect().width) : null,
        refreshReachable: reachable(refresh),
        viewport: window.innerWidth,
      };
    })()`)
    const collapsedShot = await captureScreenshot(client, screenshotDir, 'review-limits-collapsed.png')
    await client.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('button')]
        .find((node) => (node.getAttribute('aria-label') || '').startsWith('展开'));
      if (toggle instanceof HTMLElement) toggle.click();
      return true;
    })()`)
    await delay(600)
    recorder.note({
      step: 'limits-collapsed-navigator',
      toggle: collapsedToggle,
      collapsed,
      screenshot: collapsedShot,
    })
    recorder.check(
      // The *state* is what the product has to get right: with the navigator collapsed the
      // body states the limits. The navigator's own slide is animation-driven and a hidden
      // acceptance window runs no animation frames, so the geometry (measured listWidth 214)
      // and the refresh button's post-resize rectangle are recorded but not asserted.
      collapsed.bodyLimit.startsWith('显示前 2000 个，共')
      && collapsed.bodyLimitVisible === true,
      'with the navigator collapsed the body states the limits',
      collapsed,
    )

    // UX-28 item 1 in the window: a damaged repository has to say it is damaged (and what
    // to do) instead of claiming the directory is not a Git repository. The fixture is
    // disposable, so the index is simply left broken at the end of the walkthrough.
    await writeFile(join(workspaceDir, '.git', 'index'), 'garbage that is not an index\n', 'utf8')
    await click(client, REFRESH_LABEL)
    const damagedSnapshot = await waitForSurface(
      client,
      (surface) => surface.placeholder.includes('git fsck'),
      25_000,
      'damaged repository explained in the view',
    ).catch(() => readSurface(client))
    const damagedShot = await captureScreenshot(client, screenshotDir, 'review-damaged-repository.png')
    recorder.note({
      step: 'damaged-repository',
      placeholder: damagedSnapshot.placeholder,
      files: damagedSnapshot.files,
      screenshot: damagedShot,
    })
    recorder.check(
      damagedSnapshot.placeholder.includes('git fsck')
      && !damagedSnapshot.placeholder.includes('不是 Git 仓库'),
      'a damaged repository is reported as damaged, with the next step, not as "not a repository"',
      { placeholder: damagedSnapshot.placeholder },
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
      'Main checks HEAD, index metadata and status around the review read. This window gate asserts the unstable notice under continuous status churn; a save to an already dirty file with unchanged status is outside that fingerprint.',
      'The layout-dependent checks park the window outside every display and show it inactively, so they render without appearing on the desktop; every other step keeps the window hidden. The walkthrough asserts the parked position rather than assuming it.',
      'Collapse and slide animations do not run in a hidden acceptance window (no animation frames), so the navigator keeps its geometry after its collapse state flips; the walkthrough asserts the state that drives the layout and records the geometry instead.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

/**
 * A bounded screenshot.
 *
 * Under a hidden window a capture has to force a paint, and with 2,000 tree rows on
 * screen that took long enough to stall the whole walkthrough — while the app itself
 * answered CDP evaluations in 0-2 ms throughout (measured). Evidence that can hang the
 * gate is worse than no screenshot, so a capture past its budget returns null.
 */
async function captureScreenshot(client, dir, name, timeoutMs = 20_000) {
  await mkdir(dir, { recursive: true })
  const shot = await Promise.race([
    client.send('Page.captureScreenshot', { format: 'png' }),
    delay(timeoutMs).then(() => null),
  ]).catch(() => null)
  if (!shot?.data) return null
  await writeFile(join(dir, name), Buffer.from(shot.data, 'base64'))
  return join(dir, name)
}

await main()
