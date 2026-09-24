// Real-window acceptance for the settings information architecture and wording
// (taskbook UX-12 and UX-13).
//
// The same feature is reachable from the chat composer, from the settings overview,
// from the settings sidebar and — for the work modules — from a direct sidebar entry.
// This walkthrough enters every one of those routes in a real window and checks that
// the page keeps one name, that leaving returns to where the user came from, and that
// the rendered wording matches the project's terminology table instead of the retired
// phrases (which a source scan cannot prove reach the screen).
//
// Usage:
//   node scripts/verify-settings-navigation-terminology.mjs [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const DRAFT_TEXT = '导航与文案验收草稿。'
const MODEL_ID = 'slow-a'
/** Retired provider wording; built from parts so this file is not its own offender. */
const RETIRED_PROVIDER_TERM = `${'提供'}${'方'}`

/** Direct module pages and the sidebar label that opens them. */
const DIRECT_MODULES = [
  { page: 'memoryTree', label: '记忆树' },
  { page: 'scheduled', label: '已安排' },
  { page: 'plugins', label: '插件' },
]

const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const visibleText = (selector) => {
    const node = document.querySelector(selector);
    if (!node || node.closest('[inert]')) return null;
    return (node.textContent || '').replace(/\\s+/gu, ' ').trim();
  };
  const firstVisibleHeading = () => {
    const nodes = [
      ...document.querySelectorAll('main.settings-workspace-body h2, main.direct-module-workspace h2, .settings-home h2'),
    ];
    for (const node of nodes) {
      if (node.closest('[inert]')) continue;
      if (node.getBoundingClientRect().width <= 0) continue;
      const text = (node.textContent || '').trim();
      if (text) return text;
    }
    return null;
  };
  const pageText = (() => {
    const node = document.querySelector('main.settings-workspace-body, main.direct-module-workspace, .settings-home');
    return node && !node.closest('[inert]')
      ? (node.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 6_000)
      : null;
  })();
  const channelDisclosure = document.querySelector('.feedback-detail, details');
  return {
    composerPresent: Boolean(document.querySelector('.composer textarea')),
    composerDraft: document.querySelector('.composer textarea')?.value ?? null,
    settingsOpen: Boolean(document.querySelector('.settings-workspace'))
      && !document.querySelector('.settings-presence.presence-hidden'),
    activeNav: text('.settings-nav-item.active'),
    heading: firstVisibleHeading(),
    settingsHeading: visibleText('.settings-home > .settings-home-heading > h2'),
    overviewRows: [...document.querySelectorAll('.settings-overview-row')].map((row) => ({
      title: (row.querySelector('strong')?.textContent || '').trim(),
      desc: (row.querySelector('span')?.textContent || '').trim(),
    })),
    navItems: [...document.querySelectorAll('.settings-nav-item')].map((item) => (item.textContent || '').trim()),
    directModule: (() => {
      const main = document.querySelector('main.direct-module-workspace');
      return main ? { label: main.getAttribute('aria-label'), heading: (main.querySelector('h2')?.textContent || '').trim() } : null;
    })(),
    activeSidebarNav: [...document.querySelectorAll('.sidebar-nav-button')]
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.getAttribute('aria-label')),
    settingsPageText: visibleText('main.settings-workspace-body'),
    pageText,
    advancedDetails: (() => {
      const details = document.querySelector('details.settings-advanced');
      return details ? { open: details.open === true, text: (details.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 200) } : null;
    })(),
    thresholdInsideDetails: Boolean(document.querySelector('details.settings-advanced input[type="range"][aria-label="上下文压缩触发阈值"]')),
    displayModeChoices: [...document.querySelectorAll('[aria-label="对话显示模式"] button')].map((button) => ({
      label: (button.querySelector('strong')?.textContent || '').trim(),
      checked: button.getAttribute('aria-checked'),
    })),
    permissionControlOnPage: Boolean(document.querySelector('.settings-module-page .mode-picker, .settings-module-page [aria-label*="权限模式"]')),
    channelDisclosurePresent: Boolean(document.querySelector('.channel-section, .feedback-detail')),
    channelEmptyText: visibleText('.dialog-hint, .channel-empty, .settings-module-page'),
    channelKeyMentioned: (document.body.textContent || '').includes('channels.channels'),
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

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    // No provider configured: this is the state in which the composer itself offers
    // the route into the model settings, which is the chat-side entry under test.
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
    desktop: { closePolicy: 'always-background' },
    // No channels configured, so the empty state the wording rules talk about is the
    // real one instead of a mocked branch.
    channels: { channels: [] },
    // The acceptance Provider is only used to keep the URL in the fixture honest for
    // later steps; nothing in this walkthrough calls a model.
    providersNote: providerBaseURL ? undefined : undefined,
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

async function clickByText(client, selector, text) {
  return client.evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => (item.textContent || '').includes(${JSON.stringify(text)}));
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function setDraft(client, value) {
  return client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
    return true;
  })()`)
}

async function openSettingsFromEntry(client) {
  await click(client, '.settings-entry-btn')
  return waitForSurface(
    client,
    (surface) => (surface.settingsOpen && surface.navItems.length > 0 ? surface : undefined),
    30_000,
    'the settings shell',
  )
}

async function openSettingsPage(client, label) {
  const opened = await clickByText(client, '.settings-nav-item', label)
  if (!opened) throw new Error(`the ${label} navigation entry is missing`)
  return waitForSurface(
    client,
    (surface) => (surface.activeNav === label ? surface : undefined),
    20_000,
    `the ${label} settings page`,
  )
}

async function closeSettings(client) {
  await click(client, '.settings-sidebar-exit')
  return waitForSurface(
    client,
    (surface) => (!surface.settingsOpen ? surface : undefined),
    20_000,
    'the settings shell to close',
  )
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-nav-terminology-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

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
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    await setDraft(client, DRAFT_TEXT)
    await waitForSurface(client, (surface) => (surface.composerDraft === DRAFT_TEXT ? surface : undefined), 10_000, 'the typed draft')

    // --- 1. from the chat: the composer's own configuration path ----------------
    await click(client, '.runtime-picker-trigger')
    await waitForSurface(client, (surface) => (surface.settingsOpen === false ? surface : undefined), 10_000, 'the picker menu')
    await click(client, '.runtime-picker-action, .runtime-configure-action')
    const fromChat = await waitForSurface(
      client,
      (surface) => (surface.settingsOpen && surface.activeNav ? surface : undefined),
      30_000,
      'the settings page opened from the composer',
    )
    recorder.note({
      step: 'from-chat',
      activeNav: fromChat.activeNav,
      heading: fromChat.heading,
      composerDraft: fromChat.composerDraft,
    })
    recorder.check(fromChat.activeNav === '模型供应商', 'the composer path lands on the model provider page', { activeNav: fromChat.activeNav })
    recorder.check(fromChat.heading === fromChat.activeNav, 'the page heading equals the entry name', { heading: fromChat.heading, activeNav: fromChat.activeNav })
    const backToChat = await closeSettings(client)
    recorder.note({ step: 'chat-return', composerVisible: backToChat.composerPresent, draft: backToChat.composerDraft })
    recorder.check(backToChat.composerPresent === true, 'closing the settings returns to the chat', backToChat)
    recorder.check(backToChat.composerDraft === DRAFT_TEXT, 'the chat draft survives the settings round trip', { draft: backToChat.composerDraft })

    // --- 2. settings overview: one list, one naming ----------------------------
    const overview = await openSettingsFromEntry(client)
    await clickByText(client, '.settings-nav-item', '总览')
    const home = await waitForSurface(client, (surface) => (surface.settingsHeading === '设置' ? surface : undefined), 20_000, 'the settings overview')
    const missingInNav = home.overviewRows
      .map((row) => row.title)
      .filter((title) => !home.navItems.includes(title))
    recorder.note({
      step: 'overview',
      heading: home.settingsHeading,
      rows: home.overviewRows.map((row) => row.title),
      navItems: home.navItems,
      missingInNav,
    })
    recorder.check(home.overviewRows.length > 0, 'the settings overview lists the pages', home.overviewRows)
    recorder.check(
      missingInNav.length === 0,
      'every overview entry has the same name in the sidebar',
      { missingInNav, rows: home.overviewRows.map((row) => row.title) },
    )

    // --- 3. overview entry -> page -> return to the origin ---------------------
    await clickByText(client, '.settings-overview-row', '外部渠道')
    const channelsPage = await waitForSurface(
      client,
      (surface) => (surface.activeNav === '外部渠道' && (surface.settingsPageText ?? '').includes('还没有配置外部渠道')
        ? surface
        : undefined),
      30_000,
      'the loaded channels page from the overview',
    )
    recorder.note({
      step: 'channels-page',
      activeNav: channelsPage.activeNav,
      heading: channelsPage.heading,
      pageText: (channelsPage.settingsPageText ?? '').slice(0, 240),
      channelKeyMentioned: channelsPage.channelKeyMentioned,
    })
    recorder.check(
      channelsPage.heading === channelsPage.activeNav,
      'the channels page keeps one name everywhere it is entered from',
      { heading: channelsPage.heading, activeNav: channelsPage.activeNav },
    )
    recorder.check(
      (channelsPage.settingsPageText ?? '').includes('还没有配置外部渠道')
      && (channelsPage.settingsPageText ?? '').includes('这个版本还没有渠道配置界面'),
      'the empty channel state states the current limitation',
      { text: (channelsPage.settingsPageText ?? '').slice(0, 240) },
    )
    recorder.check(
      channelsPage.channelKeyMentioned === true,
      'the exact configuration key stays available on the page',
      { mentioned: channelsPage.channelKeyMentioned },
    )
    const afterChannels = await closeSettings(client)
    recorder.check(afterChannels.composerPresent === true, 'closing the channels page returns to the chat it was opened from', afterChannels)

    // --- 4. the work modules: direct entry and settings entry agree ------------
    const moduleResults = []
    for (const module of DIRECT_MODULES) {
      const openedDirect = await click(client, `.sidebar-nav-button[aria-label="${module.label}"]`)
      const direct = await waitForSurface(
        client,
        (surface) => (surface.directModule && surface.directModule.label === module.label ? surface : undefined),
        20_000,
        `the ${module.label} direct module page`,
      )
      // The settings shell has to be open before a sidebar entry can be clicked: the
      // keep-mounted layer stays in the DOM while hidden.
      await openSettingsFromEntry(client)
      await openSettingsPage(client, module.label)
      const settingsView = await waitForSurface(
        client,
        (surface) => (surface.activeNav === module.label && surface.heading === module.label ? surface : undefined),
        20_000,
        `the ${module.label} settings page`,
      )
      const returned = await closeSettings(client)
      const backOnModule = await waitForSurface(
        client,
        (surface) => (surface.directModule && surface.directModule.label === module.label ? surface : undefined),
        20_000,
        `the ${module.label} direct module page after closing the settings`,
      )
      const entry = {
        step: `module-${module.page}`,
        directOpened: openedDirect,
        directHeading: direct.directModule,
        settingsHeading: settingsView.heading,
        settingsNav: settingsView.activeNav,
        returnedTo: backOnModule.directModule,
        returnedComposer: returned.composerPresent,
      }
      moduleResults.push(entry)
      recorder.note(entry)

      recorder.check(
        direct.directModule.heading === module.label,
        `${module.label}: the direct module page uses the same name as its entry`,
        direct.directModule,
      )
      recorder.check(
        settingsView.heading === module.label && settingsView.activeNav === module.label,
        `${module.label}: the settings page uses the same name`,
        { heading: settingsView.heading, activeNav: settingsView.activeNav },
      )
      recorder.check(
        backOnModule.directModule.label === module.label,
        `${module.label}: closing the settings returns to the module page it was opened from`,
        backOnModule.directModule,
      )
    }

    // --- 5. rendered terminology and the re-arranged settings pages ------------
    await openSettingsFromEntry(client)
    const appearance = await openSettingsPage(client, '界面')
    await waitForSurface(client, (surface) => (surface.heading === '界面' ? surface : undefined), 20_000, 'the appearance page')
    const appearanceSurface = await readSurface(client)
    const appearanceText = appearanceSurface.pageText ?? ''
    const agentPage = await openSettingsPage(client, 'Agent 行为')
    await delay(300)
    const agent = await readSurface(client)
    await clickByText(client, '.settings-nav-item', '技能')
    const skills = await waitForSurface(client, (surface) => (surface.activeNav === '技能' ? surface : undefined), 20_000, 'the skills page')
    await clickByText(client, '.settings-nav-item', '已安排')
    const scheduled = await waitForSurface(client, (surface) => (surface.activeNav === '已安排' ? surface : undefined), 20_000, 'the scheduled page')
    const scheduledText = (await readSurface(client)).pageText ?? ''
    const wholePageText = [appearanceText, agent.pageText, skills.pageText, scheduledText].join(' ')
    recorder.note({
      step: 'terminology',
      appearanceModes: appearanceSurface.displayModeChoices,
      agentAdvanced: agent.advancedDetails,
      agentThresholdInsideDetails: agent.thresholdInsideDetails,
      agentPermissionControl: agent.permissionControlOnPage,
      skillsText: (skills.pageText ?? '').slice(0, 240),
      scheduledText: scheduledText.slice(0, 240),
      retiredTermPresent: wholePageText.includes(RETIRED_PROVIDER_TERM),
    })
    recorder.check(
      appearanceSurface.displayModeChoices.map((choice) => choice.label).join('|') === '普通|紧凑'
      && appearanceSurface.displayModeChoices.filter((choice) => choice.checked === 'true').length === 1,
      'the appearance page offers the display modes under their Chinese names',
      { choices: appearanceSurface.displayModeChoices, text: appearanceText.slice(0, 200) },
    )
    recorder.check(
      !appearanceText.includes('Normal') && !appearanceText.includes('Compact'),
      'the appearance page does not fall back to the stored identifiers',
      { text: appearanceText.slice(0, 200) },
    )
    recorder.check(
      !wholePageText.includes(RETIRED_PROVIDER_TERM),
      'no visited page renders the retired provider wording',
      { term: RETIRED_PROVIDER_TERM },
    )
    recorder.check(
      agent.advancedDetails !== null && agent.advancedDetails.open === false && agent.thresholdInsideDetails === true,
      'the compression threshold stays behind a collapsed advanced section',
      { details: agent.advancedDetails, inside: agent.thresholdInsideDetails },
    )
    recorder.check(
      agent.permissionControlOnPage === false,
      'the agent page does not own the permission mode',
      { control: agent.permissionControlOnPage },
    )
    recorder.check(
      (skills.pageText ?? '').includes('当前版本只能查看内容'),
      'the skills page states what the current version can do',
      { text: (skills.pageText ?? '').slice(0, 240) },
    )
    recorder.check(
      scheduledText.includes('尚未接入'),
      'the scheduled page says the capability is not connected yet',
      { text: scheduledText.slice(0, 200) },
    )
    await closeSettings(client)
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    handle?.client?.close()
    if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'settings-navigation-terminology',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The walkthrough covers the routes a user can take from the chat, the settings sidebar, the settings overview and the three direct module entries; it does not enumerate every settings page.',
      'The terminology check reads the rendered text of the visited pages, so it complements (not replaces) the source scan in terminology.test.ts.',
      'No channel is configured in the fixture, which is what makes the channel empty state the real one.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
