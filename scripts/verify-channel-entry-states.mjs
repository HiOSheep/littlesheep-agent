// Real-window acceptance for the "not connected yet" entry states and the
// channel status summary (taskbook UX-08 and UX-10).
//
// UX-08: 已安排 has no Runtime behind it. The page therefore has to state that
// the capability is not connected, must not offer filter controls that do
// nothing, and must not use a data-empty message ("no tasks yet") as a stand-in
// for "not implemented". The same page is reachable from three entries (settings
// overview, settings sidebar, the direct module entry in the app sidebar) and
// all three have to say the same thing.
//
// UX-10: the overall channel badge must be derived from the per-item running
// facts and the failure list — a configured channel or a non-empty list is not
// connection health. The walkthrough rewrites the real config file and reloads
// the real page four times: nothing configured, everything configured but
// disabled, one running with one failure, and everything running. Each fixture
// compares the rendered label, counters, colours and per-row tags against the
// payload the main process actually returned.
//
// Usage:
//   node scripts/verify-channel-entry-states.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-channel-entry-states')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1280, height: 840 }
const EVALUATE_TIMEOUT_MS = 20_000

/** `#ef6868`, `#6fd08c`, `#d8b45c`, `#a0a0a0`, `#858585`, `#ffd2d2` as computed. */
const DANGER = 'rgb(239, 104, 104)'
const SUCCESS = 'rgb(111, 208, 140)'
const WARNING = 'rgb(216, 180, 92)'
const MUTED = 'rgb(160, 160, 160)'
const MUTED_2 = 'rgb(133, 133, 133)'
const DANGER_TEXT = 'rgb(255, 210, 210)'

const SCHEDULED_STATEMENT = '计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用。'
const SCHEDULED_EMPTY_TITLE = '功能尚未接入'
const SCHEDULED_EMPTY_BODY = '当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用。'
const SCHEDULED_NAV_DESC = '计划任务尚未接入'

const GHOST_CHANNEL_TYPE = 'littlesheep-channel-not-installed'
/** Runs locally on a loopback port the OS assigns, so the fixture needs no network. */
const WEBHOOK_CHANNEL = {
  id: 'webhook-home',
  type: 'webhook',
  name: '本机 Webhook',
  enabled: true,
  options: { port: 0 },
}
const GHOST_CHANNEL = {
  id: 'ghost-channel',
  type: GHOST_CHANNEL_TYPE,
  name: '未安装的渠道',
  enabled: true,
}

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

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

function createRecorder() {
  const observations = []
  const failures = []
  let checks = 0
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      checks += 1
      if (!condition) failures.push({ check, detail })
      return Boolean(condition)
    },
    failures,
    observations,
    count: () => checks,
  }
}

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

function buildConfig(workspaceDir, providerBaseURL, channels) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Channel Acceptance Provider',
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
    channels: { channels },
    desktop: { closePolicy: 'always-background' },
  }
}

const VISIBLE_HELPER = `
  const isVisible = (node) => {
    if (node.closest('[inert]')) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node ? (node.textContent || '').replace(/\\s+/gu, ' ').trim() : null);
`

/** The 已安排 page, whichever entry opened it. */
const SCHEDULED_EXPRESSION = `(() => {
${VISIBLE_HELPER}
  const roots = [...document.querySelectorAll('main.settings-workspace-body, main.direct-module-workspace')].filter(isVisible);
  const root = roots[0] ?? null;
  if (!root) return null;
  const page = [...root.querySelectorAll('.settings-module-page')].find(isVisible) ?? null;
  const interactiveSelector = 'button, a[href], input, select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [contenteditable="true"]';
  const interactive = page ? [...page.querySelectorAll(interactiveSelector)].filter(isVisible) : [];
  const toolbar = page
    ? [...page.querySelectorAll('.settings-module-toolbar, .settings-filter-pill, [role="toolbar"]')].filter(isVisible)
    : [];
  return {
    entry: root.classList.contains('direct-module-workspace') ? 'direct-module' : 'settings',
    ariaLabel: root.getAttribute('aria-label'),
    heading: text(page?.querySelector('h2')),
    kicker: text(page?.querySelector('.settings-module-kicker')),
    statement: text(page?.querySelector('.settings-module-heading p')),
    emptyTitle: text(page?.querySelector('.settings-module-empty strong')),
    emptyBody: text(page?.querySelector('.settings-module-empty span')),
    pageText: text(page)?.slice(0, 600) ?? null,
    interactiveCount: interactive.length,
    interactiveLabels: interactive.map((node) => text(node)?.slice(0, 30) ?? ''),
    toolbarCount: toolbar.length,
    noDataPhrase: /暂无|没有已安排|暂无数据/u.test(text(page) ?? ''),
    composerVisible: [...document.querySelectorAll('.composer textarea')].some(isVisible),
    activeNav: text(document.querySelector('.settings-nav-item.active')),
    overviewRow: (() => {
      const row = [...document.querySelectorAll('.settings-overview-row')]
        .find((item) => text(item)?.includes('已安排'));
      return row ? { title: text(row.querySelector('strong')), desc: text(row.querySelector('span')) } : null;
    })(),
  };
})()`

/** The embedded external-channel page. */
const CHANNEL_EXPRESSION = `(() => {
${VISIBLE_HELPER}
  const badge = [...document.querySelectorAll('.channel-badge')].find(isVisible) ?? null;
  const badgeStyle = badge ? getComputedStyle(badge) : null;
  const counts = badge ? text(badge.querySelector('small')) ?? '' : '';
  const sections = [...document.querySelectorAll('.channel-section')].filter(isVisible).map((section) => ({
    title: text(section.querySelector('h3')),
    rows: [...section.querySelectorAll('.channel-row')].map((row) => {
      const dot = row.querySelector('.channel-dot');
      const failure = row.querySelector('.channel-name small');
      return {
        name: text(row.querySelector('.channel-name')),
        type: text(row.querySelector('.channel-type')),
        tag: text(row.querySelector('.channel-tag')),
        dotClass: dot ? dot.className : null,
        dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
        failure: row.classList.contains('failure'),
        failureColor: failure ? getComputedStyle(failure).color : null,
      };
    }),
  }));
  // The unconfigured hint is a plain dialog hint; the reload feedback notice
  // reuses the same class with a tone, so it must not be read as the empty state.
  const hint = [...document.querySelectorAll('.dialog-hint:not([data-tone])')].find(isVisible) ?? null;
  return {
    pageHeading: text(document.querySelector('.settings-workspace-body .dialog-header h2')),
    badge: badge ? {
      className: badge.className,
      label: text(badge)?.replace(counts, '').trim() ?? null,
      counts,
      color: badgeStyle.color,
      title: badge.getAttribute('title'),
    } : null,
    sections,
    hintText: hint ? text(hint)?.slice(0, 260) ?? null : null,
    hintOpensDetails: hint ? Boolean(hint.querySelector('details')) : false,
    loading: [...document.querySelectorAll('.dialog-hint')].some((node) => isVisible(node) && (node.textContent || '').includes('正在加载')),
    reloadDisabled: document.querySelector('.channel-overall .reload-btn')?.disabled ?? null,
  };
})()`

async function clickVisible(client, selector, { contains = null, index = 0 } = {}) {
  return evaluate(client, `(() => {
${VISIBLE_HELPER}
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(isVisible)
      .filter((node) => ${contains === null ? 'true' : `(node.textContent || '').includes(${JSON.stringify(contains)})`});
    const node = matches[${index}];
    if (!(node instanceof HTMLElement)) return { clicked: false, matches: matches.length };
    node.click();
    return { clicked: true, matches: matches.length, label: text(node)?.slice(0, 40) ?? null };
  })()`)
}

async function openSettings(client, label = null) {
  await evaluate(client, `(() => {
    if (!document.querySelector('.settings-workspace')
      || document.querySelector('.settings-presence.presence-hidden')) {
      document.querySelector('.settings-entry-btn')?.click()
    }
    return true
  })()`)
  await harness.waitFor(
    () => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`),
    harness.startTimeoutMs,
    'settings navigation',
  )
  if (label === null) return
  const clicked = await clickVisible(client, '.settings-nav-item', { contains: label })
  if (!clicked.clicked) throw new Error(`the ${label} navigation entry is missing`)
  await delay(400)
}

async function readSurface(client, expression) {
  return evaluate(client, expression)
}

async function waitForScheduled(client, predicate, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client, SCHEDULED_EXPRESSION)
    return surface && predicate(surface) ? surface : undefined
  }, harness.startTimeoutMs, label)
}

async function waitForChannels(client, predicate, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client, CHANNEL_EXPRESSION)
    return surface && predicate(surface) ? surface : undefined
  }, harness.startTimeoutMs, label)
}

function sectionByTitle(surface, prefix) {
  return surface.sections.find((section) => (section.title ?? '').startsWith(prefix)) ?? null
}

function expectProps(recorder, actual, expected, label, extra = {}) {
  const mismatches = Object.entries(expected)
    .filter(([name, value]) => actual?.[name] !== value)
    .map(([name, value]) => ({ name, expected: value, actual: actual?.[name] ?? null }))
  recorder.check(mismatches.length === 0, label, { mismatches, ...extra })
}

/**
 * Applies a fixture through the page's own 重新加载 control. The control is
 * disabled while a reload is in flight and a click on a disabled button does
 * nothing, so the gate waits for it to accept input first — otherwise a fixture
 * write is silently never applied.
 */
async function clickChannelReload(client) {
  const enabled = await harness.waitFor(
    () => evaluate(client, `(() => {
      const button = document.querySelector('.channel-overall .reload-btn');
      if (!(button instanceof HTMLButtonElement)) return null;
      return button.disabled === false ? true : null;
    })()`),
    harness.startTimeoutMs,
    'the channel reload control to be enabled',
  )
  const clicked = await clickVisible(client, '.channel-overall .reload-btn')
  if (!clicked.clicked) throw new Error('the channel reload control is missing')
  return { ...clicked, wasEnabled: enabled === true }
}

async function main() {
  await harness.assertBuildFresh()
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-channel-entry-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const configPath = join(dataDir, 'config.json')
  const screenshots = {}
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    const writeConfig = async (channels) => {
      await writeFile(configPath, `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL, channels), null, 2)}\n`, 'utf8')
    }
    await writeConfig([])

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    handle = { electron, locator, client }
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'the composer textarea',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // ---------------------------------------------------------------------
    // UX-08: one unavailable page, three entries, no dead controls
    // ---------------------------------------------------------------------
    await openSettings(client)
    await clickVisible(client, '.settings-nav-item', { contains: '总览' })
    const overview = await harness.waitFor(async () => {
      const surface = await readSurface(client, SCHEDULED_EXPRESSION)
      return surface && surface.overviewRow ? surface : undefined
    }, harness.startTimeoutMs, 'the settings overview')
    recorder.note({ step: 'scheduled-overview-row', row: overview.overviewRow })
    recorder.check(
      overview.overviewRow?.desc === SCHEDULED_NAV_DESC,
      'the overview entry states that the capability is not connected',
      { row: overview.overviewRow },
    )

    // Entry 1: the settings overview row.
    await clickVisible(client, '.settings-overview-row', { contains: '已安排' })
    const fromOverview = await waitForScheduled(
      client,
      (surface) => (surface.heading === '已安排' ? surface : undefined),
      'the scheduled page from the overview',
    )
    screenshots['scheduled-overview'] = await writePng(client, 'scheduled-overview')
    recorder.note({ step: 'scheduled-from-overview', surface: fromOverview })
    recorder.check(fromOverview.entry === 'settings', 'the overview entry opens the settings page', { entry: fromOverview.entry })
    recorder.check(fromOverview.activeNav === '已安排', 'the settings page is the 已安排 page', { activeNav: fromOverview.activeNav })
    recorder.check(
      fromOverview.composerVisible === false,
      'opening the page has a visible result: the chat is replaced',
      { composerVisible: fromOverview.composerVisible },
    )

    // Entry 2: the settings sidebar entry.
    await openSettings(client, '已安排')
    const fromSidebar = await waitForScheduled(
      client,
      (surface) => (surface.heading === '已安排' ? surface : undefined),
      'the scheduled page from the settings sidebar',
    )
    recorder.note({ step: 'scheduled-from-sidebar', surface: fromSidebar })

    // Entry 3: the app sidebar's direct module entry.
    await evaluate(client, `(() => { document.querySelector('.settings-sidebar-exit')?.click(); return true })()`)
    await delay(400)
    const directClick = await clickVisible(client, '.sidebar-nav-button[aria-label="已安排"]')
    const fromDirect = await waitForScheduled(
      client,
      (surface) => (surface.entry === 'direct-module' ? surface : undefined),
      'the scheduled direct module page',
    )
    screenshots['scheduled-direct'] = await writePng(client, 'scheduled-direct')
    recorder.note({ step: 'scheduled-from-direct', clicked: directClick, surface: fromDirect })
    recorder.check(directClick.clicked, 'the direct module entry is reachable', directClick)
    recorder.check(fromDirect.ariaLabel === '已安排', 'the direct module page names the same feature', { ariaLabel: fromDirect.ariaLabel })

    // Three entries, one page.
    const entries = { overview: fromOverview, sidebar: fromSidebar, direct: fromDirect }
    const bodies = Object.entries(entries).map(([key, surface]) => ({ key, text: surface.pageText }))
    const firstText = bodies[0].text
    const differing = bodies.filter((entry) => entry.text !== firstText)
    recorder.check(
      differing.length === 0 && firstText !== null,
      'all three entries render the same page',
      { bodies: bodies.map((entry) => ({ key: entry.key, text: entry.text?.slice(0, 80) })) },
    )
    for (const [key, surface] of Object.entries(entries)) {
      recorder.check(
        surface.statement === SCHEDULED_STATEMENT
        && surface.emptyTitle === SCHEDULED_EMPTY_TITLE
        && surface.emptyBody === SCHEDULED_EMPTY_BODY,
        `the ${key} entry states that the capability is not connected`,
        { statement: surface.statement, emptyTitle: surface.emptyTitle, emptyBody: surface.emptyBody },
      )
      recorder.check(
        surface.interactiveCount === 0 && surface.toolbarCount === 0,
        `the ${key} entry offers no control that cannot do anything`,
        { interactiveCount: surface.interactiveCount, labels: surface.interactiveLabels, toolbarCount: surface.toolbarCount },
      )
      recorder.check(
        surface.noDataPhrase === false,
        `the ${key} entry does not use a data-empty message for a missing capability`,
        { noData: surface.noDataPhrase, text: surface.pageText?.slice(0, 200) },
      )
      recorder.check(
        (surface.pageText ?? '').includes('没有可显示的数据'),
        `the ${key} entry says why there is nothing to show`,
        { text: surface.pageText?.slice(0, 200) },
      )
    }

    // ---------------------------------------------------------------------
    // UX-10: four channel fixtures measured against the real payload
    // ---------------------------------------------------------------------
    await openSettings(client, '外部渠道')
    await waitForChannels(client, (surface) => (surface.badge ? surface : undefined), 'the channel status')
    recorder.check(
      (await readSurface(client, CHANNEL_EXPRESSION)).pageHeading === '外部渠道',
      'the channel page is reachable under its own name',
      {},
    )

    const fixtures = [
      {
        key: 'unconfigured',
        channels: [],
        payload: { channels: 0, running: 0, configured: 0, failures: 0 },
        ui: {
          kind: 'unconfigured',
          label: '未配置外部渠道',
          counts: '',
          color: MUTED,
          loadedSection: null,
          configuredSection: null,
          failureSection: null,
        },
      },
      {
        key: 'all-disabled',
        channels: [{ ...WEBHOOK_CHANNEL, enabled: false }],
        payload: { channels: 0, running: 0, configured: 1, failures: 0 },
        ui: {
          kind: 'stopped',
          label: '外部渠道未运行',
          counts: '运行 0/0 · 已配置 1',
          color: MUTED,
          loadedSection: null,
          configuredSection: { title: '已配置渠道 (1)', row: { tag: '已禁用', dotClass: 'channel-dot disabled', dotColor: MUTED_2 } },
          failureSection: null,
        },
      },
      {
        key: 'running-with-failure',
        channels: [WEBHOOK_CHANNEL, GHOST_CHANNEL],
        payload: { channels: 1, running: 1, configured: 2, failures: 1 },
        ui: {
          kind: 'partial',
          label: '部分渠道运行中',
          counts: '运行 1/1 · 已配置 2 · 失败 1',
          color: WARNING,
          loadedSection: { title: '已加载渠道 (1)', row: { tag: '运行中', dotClass: 'channel-dot on', dotColor: SUCCESS } },
          configuredSection: { title: '已配置渠道 (2)' },
          failureSection: { title: '需要处理 (1)', row: { dotClass: 'channel-dot off', dotColor: DANGER, failureColor: DANGER_TEXT } },
        },
      },
      {
        key: 'all-running',
        channels: [WEBHOOK_CHANNEL],
        payload: { channels: 1, running: 1, configured: 1, failures: 0 },
        ui: {
          kind: 'running',
          label: '外部渠道运行中',
          counts: '运行 1/1 · 已配置 1',
          color: SUCCESS,
          loadedSection: { title: '已加载渠道 (1)', row: { tag: '运行中', dotClass: 'channel-dot on', dotColor: SUCCESS } },
          configuredSection: { title: '已配置渠道 (1)' },
          failureSection: null,
        },
      },
    ]

    const fixtureResults = []
    for (const fixture of fixtures) {
      await writeConfig(fixture.channels)
      const writtenConfig = JSON.parse(await readFile(configPath, 'utf8'))
      recorder.note({
        step: `fixture-${fixture.key}-config`,
        channels: writtenConfig.channels?.channels ?? null,
      })
      const reload = await clickChannelReload(client)
      recorder.note({ step: `fixture-${fixture.key}-reload`, clicked: reload })

      // Wait for the main process to report the payload this fixture asks for...
      let lastCounts = null
      let payload
      try {
        payload = await harness.waitFor(async () => {
          const response = await harness.fetchJson(locator, '/channels/status').catch(() => undefined)
          const body = response?.body
          if (!body) return undefined
          const counts = {
            channels: (body.channels ?? []).length,
            running: (body.channels ?? []).filter((channel) => channel.running).length,
            configured: (body.configured ?? []).length,
            failures: (body.failures ?? []).length,
          }
          lastCounts = counts
          const matches = Object.entries(fixture.payload).every(([name, value]) => counts[name] === value)
          return matches ? { counts, body } : undefined
        }, harness.startTimeoutMs, `the ${fixture.key} channel payload`)
      } catch (error) {
        const logTail = await readFile(logPath, 'utf8').catch(() => '')
        throw new Error(`${error instanceof Error ? error.message : String(error)}; last counts ${JSON.stringify(lastCounts)};`
          + ` expected ${JSON.stringify(fixture.payload)}; electron log tail: ${logTail.slice(-1200)}`)
      }

      // ...and for the page to render that same state.
      const surface = await waitForChannels(
        client,
        (candidate) => (candidate.badge?.label === fixture.ui.label && candidate.loading === false ? candidate : undefined),
        `the ${fixture.key} channel badge`,
      )
      await delay(200)
      const measured = await readSurface(client, CHANNEL_EXPRESSION)
      screenshots[`channels-${fixture.key}`] = await writePng(client, `channels-${fixture.key}`)
      const result = { key: fixture.key, payloadCounts: payload.counts, badge: measured.badge, sections: measured.sections, hint: measured.hintText }
      fixtureResults.push(result)
      recorder.note({ step: `channels-${fixture.key}`, ...result })

      expectProps(recorder, measured.badge, {
        label: fixture.ui.label,
        counts: fixture.ui.counts,
        color: fixture.ui.color,
      }, `the ${fixture.key} fixture renders the derived label, counters and colour`, { badge: measured.badge })
      recorder.check(
        (measured.badge?.className ?? '').includes(fixture.ui.kind),
        `the ${fixture.key} fixture uses the ${fixture.ui.kind} badge kind`,
        { className: measured.badge?.className },
      )
      recorder.check(
        payload.counts.running === payload.counts.channels,
        `the ${fixture.key} payload lists running instances only (contract)`,
        { counts: payload.counts },
      )

      const loadedSection = sectionByTitle(measured, '已加载渠道')
      const configuredSection = sectionByTitle(measured, '已配置渠道')
      const failureSection = sectionByTitle(measured, '需要处理')
      if (fixture.ui.loadedSection === null) {
        recorder.check(loadedSection === null, `the ${fixture.key} fixture shows no loaded channel list`, { loadedSection })
      } else {
        recorder.check(
          loadedSection?.title === fixture.ui.loadedSection.title,
          `the ${fixture.key} fixture counts the loaded channels`,
          { title: loadedSection?.title ?? null },
        )
        expectProps(recorder, loadedSection?.rows?.[0], {
          tag: fixture.ui.loadedSection.row.tag,
          dotClass: fixture.ui.loadedSection.row.dotClass,
          dotColor: fixture.ui.loadedSection.row.dotColor,
        }, `the ${fixture.key} fixture marks a loaded channel running`, { row: loadedSection?.rows?.[0] ?? null })
      }
      if (fixture.ui.configuredSection === null) {
        recorder.check(configuredSection === null, `the ${fixture.key} fixture shows no configured list`, { configuredSection })
      } else {
        recorder.check(
          configuredSection?.title === fixture.ui.configuredSection.title,
          `the ${fixture.key} fixture counts the configured channels`,
          { title: configuredSection?.title ?? null },
        )
        if (fixture.ui.configuredSection.row) {
          expectProps(recorder, configuredSection?.rows?.[0], fixture.ui.configuredSection.row,
            `the ${fixture.key} fixture marks the disabled channel as disabled`, { row: configuredSection?.rows?.[0] ?? null })
        }
      }
      if (fixture.ui.failureSection === null) {
        recorder.check(failureSection === null, `the ${fixture.key} fixture shows no failure list`, { failureSection })
      } else {
        recorder.check(
          failureSection?.title === fixture.ui.failureSection.title,
          `the ${fixture.key} fixture counts the failures`,
          { title: failureSection?.title ?? null },
        )
        expectProps(recorder, failureSection?.rows?.[0], {
          dotClass: fixture.ui.failureSection.row.dotClass,
          dotColor: fixture.ui.failureSection.row.dotColor,
          failureColor: fixture.ui.failureSection.row.failureColor,
        }, `the ${fixture.key} fixture keeps the failure visible with the danger tone`, { row: failureSection?.rows?.[0] ?? null })
      }

      // The bug this row is about: a non-empty or configured list reported as healthy.
      if (fixture.payload.running === 0) {
        recorder.check(
          !(measured.badge?.label ?? '').includes('运行中'),
          `the ${fixture.key} fixture does not call a non-running set healthy`,
          { label: measured.badge?.label },
        )
      }
      if (fixture.key === 'unconfigured') {
        recorder.check(
          (measured.hintText ?? '').includes('还没有配置外部渠道') && measured.hintOpensDetails === true,
          'the unconfigured fixture explains where channels are configured',
          { hint: measured.hintText, opensDetails: measured.hintOpensDetails },
        )
      } else {
        recorder.check(measured.hintText === null, `the ${fixture.key} fixture does not show the unconfigured hint`, { hint: measured.hintText })
      }
    }

    const colours = Object.fromEntries(fixtureResults.map((result) => [result.key, result.badge?.color ?? null]))
    recorder.check(
      colours['all-running'] === SUCCESS && colours['running-with-failure'] === WARNING && colours['all-disabled'] === MUTED,
      'the four fixtures use the success / warning / muted tones for their own state',
      { colours },
    )
    recorder.check(
      (fixtureResults.find((result) => result.key === 'unconfigured')?.badge?.label ?? '') !==
        (fixtureResults.find((result) => result.key === 'all-disabled')?.badge?.label ?? ''),
      'not configured and configured-but-not-running stay different statements',
      { labels: fixtureResults.map((result) => result.badge?.label) },
    )

    screenshots['final'] = await writePng(client, 'channels-final')
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    })
  } finally {
    handle?.client?.close()
    if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
    await provider.close().catch(() => undefined)
    if (!keepRoot) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'channel-entry-states',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keepRoot ? root : '<temporary root removed>',
    screenshots,
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The channel fixtures are written to the real config file and applied with the page\'s own 重新加载 control; the running channel is the builtin webhook plugin listening on an OS-assigned loopback port, so no external service is involved.',
      'The "all stopped" fixture is a configured but disabled channel: the host only starts enabled channels, and the status payload lists running instances only, so a loaded-but-stopped entry cannot be produced by the current backend (contract noted in shared/channel-control-contracts.ts).',
      'The 已安排 walkthrough covers the three entries a user can take and the page they render; it does not cover other settings pages.',
      'Screenshots stay in the temporary output directory.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
