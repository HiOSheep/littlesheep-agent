// Real-window acceptance for the shared async feedback contract (taskbook UX-09).
//
// Five surfaces each get one injected failure: saving a provider, saving the
// compression threshold, reloading the channel connections, toggling a plugin and
// saving a workspace file. Every one of them has to state the failure where the
// action was taken, keep the user's input, offer a next step, and use the shared
// structure (`data-tone` + role from the tone field) instead of parsing prose. The
// chat area must stay clean: the user should not have to look there for an error.
//
// Failures are injected per request path by a page-level fetch probe, and cleared
// again so the same action can be retried in the same window.
//
// Usage:
//   node scripts/verify-async-feedback.mjs [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const NOTES_NAME = 'NOTES.txt'
const NOTES_START = 'ux09 fixture line one\n'
const TYPED_MARKER = 'ux09 typed marker'
const PROVIDER_ID = 'acceptance-gw'
const PROVIDER_NAME = '验收网关'
const RENAMED_PROVIDER = '验收网关（改名）'
const MODEL_ID = 'slow-a'
const FAILURE_KEY = 'littlesheep.verify.feedbackFailurePaths'

/** Answers the listed requests with HTTP 500 until the entry is removed again. */
const PROBE_SOURCE = `(() => {
  if (window.__littlesheepFeedbackProbe) return true;
  const probe = { installed: true, requests: [], active: [] };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function probedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || 'GET').toUpperCase();
    let active = [];
    try { active = JSON.parse(window.localStorage.getItem('${FAILURE_KEY}') || '[]'); } catch (error) { active = []; }
    probe.active = active;
    const hit = active.find((entry) => url.includes(entry.path) && (!entry.method || entry.method === method));
    probe.requests.push({ tail: url.slice(-48), method, failed: Boolean(hit) });
    if (probe.requests.length > 400) probe.requests.shift();
    if (!hit) return originalFetch(input, init);
    return new Response(JSON.stringify({ error: '验收夹具注入的失败：HTTP 500' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  window.__littlesheepFeedbackProbe = probe;
  return true;
})()`

const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const notices = [...document.querySelectorAll('.feedback-notice')].map((notice) => ({
    className: String(notice.className),
    tone: notice.getAttribute('data-tone'),
    role: notice.getAttribute('role'),
    message: notice.querySelector('.feedback-message')?.textContent?.trim() ?? null,
    retry: notice.querySelector('.feedback-action')?.textContent?.trim() ?? null,
    retryDisabled: notice.querySelector('.feedback-action')?.disabled ?? null,
    detail: notice.querySelector('.feedback-detail pre')?.textContent?.trim() ?? null,
    hasDetail: Boolean(notice.querySelector('.feedback-detail')),
  }));
  const editor = document.querySelector('.provider-editor');
  const editorInputs = editor ? [...editor.querySelectorAll('.settings-inline-field input')] : [];
  const range = document.querySelector('input[type="range"][aria-label="上下文压缩触发阈值"]');
  return {
    settingsOpen: Boolean(document.querySelector('.settings-workspace'))
      && !document.querySelector('.settings-presence.presence-hidden'),
    activeNav: text('.settings-nav-item.active'),
    notices,
    composerError: text('.composer-error'),
    editor: editor ? {
      label: editor.getAttribute('aria-label'),
      name: editorInputs[1]?.value ?? null,
      saveDisabled: editor.querySelector('.save-btn')?.disabled ?? null,
      detailOpen: Boolean(editor.querySelector('.feedback-detail[open]')),
    } : null,
    providerCards: [...document.querySelectorAll('.provider-card')].map((card) => ({
      title: card.querySelector('.provider-card-title')?.textContent?.trim() ?? null,
      models: [...card.querySelectorAll('.provider-model-chip')].map((chip) => (chip.textContent || '').trim()),
    })),
    threshold: range ? {
      value: range.value,
      saveDisabled: document.querySelector('.settings-policy-row button')?.disabled ?? null,
    } : null,
    thresholdOutput: text('.settings-policy-row output'),
    advancedOpen: document.querySelector('details.settings-advanced')?.open ?? null,
    channelRows: document.querySelectorAll('.channel-row').length,
    reloadLabel: text('.reload-btn'),
    pluginSwitches: [...document.querySelectorAll('.plugin-switch')].map((node) => ({
      label: node.getAttribute('aria-label'),
      checked: node.getAttribute('aria-checked'),
      disabled: node.disabled === true,
    })),
    pluginCount: document.querySelectorAll('.plugin-list-item').length,
    editorStatus: text('.workspace-editor-status'),
    editorStatusError: document.querySelector('.workspace-editor-status')?.classList.contains('error') ?? null,
    approvalTitle: text('.approval-prompt h2'),
    approvalOpen: Boolean(document.querySelector('.approval-prompt')),
    editorVisible: Boolean(document.querySelector('.workspace-editor-monaco')),
    editorReadOnly: document.querySelector('.workspace-editor-monaco .monaco-editor')?.classList.contains('workspace-monaco-readonly')
      ?? document.querySelector('textarea.inputarea')?.readOnly
      ?? null,
    editButton: [...document.querySelectorAll('.workspace-files-text-btn')].map((node) => (node.textContent || '').trim()),
    editorText: (document.querySelector('.workspace-editor-monaco .view-lines')?.textContent ?? '').replace(/\u00a0/gu, ' ').slice(0, 240),
    activeTab: text('.workspace-active-item.active .workspace-active-label-text'),
    probe: window.__littlesheepFeedbackProbe
      ? { requests: window.__littlesheepFeedbackProbe.requests.slice(-12), active: window.__littlesheepFeedbackProbe.active }
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

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 10,
      models: [{ id: MODEL_ID }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `${PROVIDER_ID}/${MODEL_ID}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
        contextCompressionThresholdRatio: 0.8,
      },
    },
    desktop: { closePolicy: 'always-background' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
  }
}

/** One file tab open on a plain text file, so the editor is reachable directly. */
function seedPreferencesExpression(workspaceDir) {
  const filePath = join(workspaceDir, NOTES_NAME)
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  const layout = {
    collapsed: false,
    fullscreen: true,
    activeTab: fileTab,
    openTabs: [fileTab],
    openRequest: { root: workspaceDir, path: filePath },
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
    'littlesheep.ui.workspacePanelTab': fileTab,
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([fileTab]),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspacePanelOpenPath': filePath,
    'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
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

async function clickIndex(client, selector, index) {
  return client.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes[${index}];
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function setInput(client, selector, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

async function setRange(client, selector, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
}

/** Fail every request matching one path (+ optional method) from now on. */
async function failPath(client, path, method) {
  await client.evaluate(`(() => {
    const key = ${JSON.stringify(FAILURE_KEY)};
    const current = JSON.parse(localStorage.getItem(key) || '[]');
    const next = current.filter((entry) => entry.path !== ${JSON.stringify(path)});
    next.push({ path: ${JSON.stringify(path)}, method: ${JSON.stringify(method)} });
    localStorage.setItem(key, JSON.stringify(next));
    return true;
  })()`)
}

async function clearFailures(client) {
  await client.evaluate(`window.localStorage.setItem(${JSON.stringify(FAILURE_KEY)}, '[]')`)
}

async function openSettingsPage(client, label) {
  await client.evaluate(`(() => {
    if (!document.querySelector('.settings-workspace')) document.querySelector('.settings-entry-btn')?.click();
    return true;
  })()`)
  await harness.waitFor(
    () => client.evaluate(`document.querySelector('.settings-nav-item') ? true : null`),
    harness.startTimeoutMs,
    'settings navigation',
  )
  const clicked = await clickByText(client, '.settings-nav-item', label)
  if (!clicked) throw new Error(`the ${label} navigation item is missing`)
  await delay(400)
}

async function closeSettings(client) {
  await click(client, '.settings-sidebar-exit')
  await waitForSurface(client, (surface) => !surface.settingsOpen, 20_000, 'settings to close')
}

/**
 * Type into the real Monaco editor.
 *
 * Monaco owns a hidden textarea; clicking `.view-lines` near the left edge lands on
 * the line-number gutter and never focuses it, so the textarea is focused directly
 * and the text is inserted through CDP. The marker is verified afterwards, and a
 * per-character key-event path covers the case where text insertion is ignored.
 */
async function clickEditor(client) {
  const input = await harness.waitFor(async () => {
    const value = await client.evaluate(`(() => {
      const line = document.querySelector('.workspace-editor-monaco .monaco-editor .view-line');
      if (!(line instanceof HTMLElement)) return undefined;
      const box = line.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, hasEditContext: Boolean(document.querySelector('.native-edit-context')) };
    })()`)
    return value ?? undefined
  }, 30_000, 'the Monaco text area')
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: input.x, y: input.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: input.x, y: input.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await delay(300)
  return input
}

/**
 * Type into the real Monaco editor.
 *
 * Monaco 0.5x takes input through an `EditContext` bound to a
 * `div.native-edit-context` inside the editor, so focusing its hidden textarea does
 * nothing. The gesture that works — and the one a user performs — is a real click
 * into the text area followed by key events carrying text; the marker is verified
 * against the rendered lines afterwards.
 */
async function typeIntoEditor(client, text) {
  await clickEditor(client)
  await client.send('Input.insertText', { text })
  await delay(400)
  if (await editorHasText(client, text)) return 'insertText'
  for (const character of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: character,
      unmodifiedText: character,
      key: character,
    })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    await delay(30)
  }
  await delay(400)
  return (await editorHasText(client, text)) ? 'keyEvents' : 'failed'
}

async function editorHasText(client, text) {
  const needle = text.replace(/\s+/gu, ' ').trim()
  // Monaco renders indentation and spaces as non-breaking spaces.
  return client.evaluate(`(() => {
    const content = (document.querySelector('.workspace-editor-monaco .view-lines')?.textContent ?? '')
      .replace(/\\u00a0/gu, ' ');
    return content.includes(${JSON.stringify(needle)});
  })()`)
}

async function pressSaveShortcut(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2,
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    key: 's',
    code: 'KeyS',
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
  })
  await delay(600)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-async-feedback-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    const notesPath = join(workspaceDir, NOTES_NAME)
    await writeFile(notesPath, NOTES_START, 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    handle = { electron, locator, client }
    // The layout seed belongs in the pre-document script: a seed applied to the
    // running document can be overwritten by the app's own persistence flush while
    // the page unloads, which left the panel on its default review tab.
    const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `${PROBE_SOURCE};${seedPreferencesExpression(workspaceDir)}`,
    })
    handle.probeIdentifier = identifier
    await client.evaluate(seedPreferencesExpression(workspaceDir))
    const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
    await client.send('Page.reload', { ignoreCache: false })
    await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
        .catch(() => undefined)
      return state && state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? true : undefined
    }, harness.actionTimeoutMs, 'renderer reload with the fixture layout')
    await waitForSurface(client, (surface) => (surface.probe ? surface : undefined), 20_000, 'the feedback probe to be installed')

    // --- 1. provider save ------------------------------------------------------
    await openSettingsPage(client, '模型供应商')
    const providerPage = await waitForSurface(client, (surface) => (surface.providerCards.length > 0 ? surface : undefined), 20_000, 'the provider card')
    recorder.check(providerPage.providerCards.length === 1, 'the fixture provider is on the page', providerPage.providerCards)
    await click(client, '.provider-card .save-btn')
    await waitForSurface(client, (surface) => (surface.editor ? surface : undefined), 20_000, 'the provider editor')
    await setInput(client, '.provider-editor .settings-inline-field:nth-of-type(2) input', RENAMED_PROVIDER)
    await failPath(client, '/config/providers', 'POST')
    await click(client, '.provider-editor .save-btn')
    const providerFailure = await waitForSurface(
      client,
      (surface) => (surface.notices.some((notice) => notice.tone === 'error' && (notice.message ?? '').includes('保存失败')) ? surface : undefined),
      20_000,
      'the provider save failure',
    )
    const providerFailureNotice = providerFailure.notices.find((notice) => notice.tone === 'error') ?? null
    recorder.note({ step: 'provider-save-failure', notice: providerFailureNotice, editor: providerFailure.editor, composerError: providerFailure.composerError })
    recorder.check(providerFailureNotice?.role === 'alert', 'a failed provider save is an alert', providerFailureNotice)
    recorder.check(providerFailureNotice?.message === '保存失败，内容仍保留在编辑器里', 'the failure names what happened and that the content is kept', providerFailureNotice)
    recorder.check(
      (providerFailureNotice?.detail ?? '').includes('500'),
      'the technical detail keeps the real reason',
      providerFailureNotice,
    )
    recorder.check(providerFailure.editor?.name === RENAMED_PROVIDER, 'the failed save keeps the typed content', providerFailure.editor)
    recorder.check(providerFailure.composerError === null, 'the provider failure stays on the settings page, not in the chat area', { composerError: providerFailure.composerError })
    await clearFailures(client)
    await click(client, '.provider-editor .save-btn')
    const providerSaved = await waitForSurface(
      client,
      (surface) => (!surface.editor && surface.providerCards.some((card) => (card.title ?? '').includes(RENAMED_PROVIDER)) ? surface : undefined),
      20_000,
      'the provider to be saved after the retry',
    )
    recorder.note({ step: 'provider-save-retry', cards: providerSaved.providerCards, notices: providerSaved.notices })
    recorder.check(
      providerSaved.notices.some((notice) => notice.tone === 'success' && (notice.message ?? '').includes('已保存供应商')),
      'the retry reports success with the shared light-weight notice',
      providerSaved.notices,
    )
    recorder.check(
      providerSaved.notices.every((notice) => notice.tone !== 'error'),
      'the old failure is replaced by the success notice',
      providerSaved.notices,
    )

    // --- 2. compression threshold save ----------------------------------------
    await openSettingsPage(client, 'Agent 行为')
    await click(client, 'details.settings-advanced > summary')
    const thresholdBefore = await waitForSurface(client, (surface) => (surface.threshold ? surface : undefined), 20_000, 'the threshold control')
    const nextThreshold = thresholdBefore.threshold.value === '0.8' ? '0.75' : '0.8'
    await setRange(client, 'input[type="range"][aria-label="上下文压缩触发阈值"]', nextThreshold)
    const thresholdReady = await waitForSurface(
      client,
      (surface) => (surface.threshold?.value === nextThreshold && surface.threshold.saveDisabled === false ? surface : undefined),
      10_000,
      'the threshold save to become available',
    )
    recorder.note({ step: 'threshold-ready', threshold: thresholdReady.threshold, output: thresholdReady.thresholdOutput })
    // The Runtime patch is a POST to /runtime (not PATCH), which is why the
    // injected failure has to name the same method the renderer uses.
    await failPath(client, '/runtime', 'POST')
    await clickByText(client, '.settings-policy-row button', '保存')
    const thresholdFailure = await waitForSurface(
      client,
      (surface) => (surface.notices.some((notice) => (notice.message ?? '').includes('压缩阈值未保存')) ? surface : undefined),
      20_000,
      'the threshold save failure',
    )
    const thresholdNotice = thresholdFailure.notices.find((notice) => (notice.message ?? '').includes('压缩阈值未保存')) ?? null
    const runtimeAfterFailure = await harness.fetchJson(locator, '/runtime')
    recorder.note({
      step: 'threshold-save-failure',
      notice: thresholdNotice,
      runtimeRatio: runtimeAfterFailure?.body?.contextCompressionThresholdRatio ?? null,
      expectedUntouched: Number(thresholdBefore.threshold.value),
      composerError: thresholdFailure.composerError,
    })
    recorder.check(thresholdNotice?.role === 'alert', 'a failed threshold save is an alert', thresholdNotice)
    recorder.check(thresholdNotice?.retry === '重试保存', 'the failure offers the retry that fits the action', thresholdNotice)
    recorder.check(
      runtimeAfterFailure?.body?.contextCompressionThresholdRatio === Number(thresholdBefore.threshold.value),
      'a failed save leaves the runtime value untouched',
      { before: thresholdBefore.threshold.value, after: runtimeAfterFailure?.body?.contextCompressionThresholdRatio },
    )
    recorder.check(thresholdFailure.composerError === null, 'the threshold failure stays on its own page', { composerError: thresholdFailure.composerError })
    await clearFailures(client)
    await clickByText(client, '.settings-policy-row button', '保存')
    const thresholdSaved = await waitForSurface(
      client,
      (surface) => (surface.notices.some((notice) => notice.tone === 'success' && (notice.message ?? '').includes('压缩阈值已保存')) ? surface : undefined),
      20_000,
      'the threshold to be saved after the retry',
    )
    const runtimeAfterSave = await harness.fetchJson(locator, '/runtime')
    recorder.note({ step: 'threshold-save-retry', notices: thresholdSaved.notices, runtimeRatio: runtimeAfterSave?.body?.contextCompressionThresholdRatio ?? null })
    recorder.check(
      runtimeAfterSave?.body?.contextCompressionThresholdRatio === Number(nextThreshold),
      'the retry really writes the new ratio',
      { expected: nextThreshold, actual: runtimeAfterSave?.body?.contextCompressionThresholdRatio },
    )

    // --- 3. channel reload -----------------------------------------------------
    await openSettingsPage(client, '外部渠道')
    await waitForSurface(client, (surface) => (surface.reloadLabel ? surface : undefined), 20_000, 'the channel reload control')
    await click(client, '.reload-btn')
    const reloaded = await waitForSurface(
      client,
      (surface) => (surface.notices.some((notice) => notice.tone === 'success' && (notice.message ?? '').includes('外部渠道已重新加载')) ? surface : undefined),
      30_000,
      'a successful channel reload',
    )
    recorder.note({ step: 'channel-reload-success', notices: reloaded.notices })
    await failPath(client, '/channels/reload', 'POST')
    await click(client, '.reload-btn')
    const reloadFailure = await waitForSurface(
      client,
      (surface) => (surface.notices.some((notice) => notice.tone === 'error') ? surface : undefined),
      30_000,
      'the channel reload failure',
    )
    const reloadFailureNotice = reloadFailure.notices.find((notice) => notice.tone === 'error') ?? null
    recorder.note({ step: 'channel-reload-failure', notices: reloadFailure.notices, composerError: reloadFailure.composerError })
    recorder.check(reloadFailureNotice?.role === 'alert', 'a failed reload is an alert', reloadFailureNotice)
    recorder.check((reloadFailureNotice?.message ?? '').includes('重新加载外部渠道失败'), 'the failure names the action', reloadFailureNotice)
    recorder.check(reloadFailureNotice?.retry === '重试', 'the failure offers a retry', reloadFailureNotice)
    recorder.check(
      reloadFailure.notices.every((notice) => !(notice.tone === 'success' && (notice.message ?? '').includes('外部渠道已重新加载'))),
      'a failed reload does not leave the previous success line standing',
      reloadFailure.notices,
    )
    await clearFailures(client)

    // --- 4. plugin toggle ------------------------------------------------------
    await openSettingsPage(client, '插件')
    const pluginsPage = await waitForSurface(client, (surface) => (surface.pluginSwitches.length > 0 ? surface : undefined), 30_000, 'the plugin list')
    // The first switch on the page is the local-code permission, which posts to a
    // different route; the plugin switches are labelled 启用/停用 + plugin name.
    const targetIndex = pluginsPage.pluginSwitches.findIndex((item) => /^(停用|启用)/u.test(item.label ?? ''))
    if (targetIndex < 0) throw new Error('no plugin enable switch was found')
    const targetSwitch = pluginsPage.pluginSwitches[targetIndex]
    await failPath(client, '/enabled', 'POST')
    await clickIndex(client, '.plugin-switch', targetIndex)
    let pluginFailure
    try {
      pluginFailure = await waitForSurface(
        client,
        (surface) => (surface.notices.some((notice) => notice.tone === 'error') ? surface : undefined),
        20_000,
        'the plugin toggle failure',
      )
    } catch (error) {
      recorder.note({ step: 'plugin-timeout', surface: await readSurface(client) })
      throw error
    }
    const pluginNotice = pluginFailure.notices.find((notice) => notice.tone === 'error') ?? null
    const switchAfter = pluginFailure.pluginSwitches[targetIndex] ?? null
    recorder.note({ step: 'plugin-toggle-failure', notice: pluginNotice, before: targetSwitch, after: switchAfter, composerError: pluginFailure.composerError })
    recorder.check(pluginNotice?.role === 'alert', 'a failed plugin toggle is an alert', pluginNotice)
    recorder.check((pluginNotice?.message ?? '').includes('插件操作未完成'), 'the failure names the operation', pluginNotice)
    recorder.check(pluginNotice?.retry === '重试', 'the failure offers a next step', pluginNotice)
    recorder.check(
      (switchAfter?.checked ?? null) === (targetSwitch.checked ?? null),
      'a failed toggle does not move the switch',
      { before: targetSwitch.checked, after: switchAfter?.checked ?? null },
    )
    recorder.check(pluginFailure.composerError === null, 'the plugin failure stays on the plugin page', { composerError: pluginFailure.composerError })
    await clearFailures(client)

    // --- 5. workspace file save ------------------------------------------------
    await closeSettings(client)
    const fileOpen = await waitForSurface(
      client,
      (surface) => (surface.editorVisible && (surface.activeTab ?? '').includes(NOTES_NAME) ? surface : undefined),
      30_000,
      'the text file open in the editor',
    )
    recorder.check((fileOpen.editorStatus ?? '') === '', 'a freshly opened file has no save status yet', { status: fileOpen.editorStatus })
    // The pane opens read-only; typing is only accepted after switching to edit mode.
    await clickByText(client, '.workspace-files-text-btn', '编辑')
    await waitForSurface(
      client,
      (surface) => (surface.editorReadOnly === false ? surface : undefined),
      10_000,
      'the editor to switch to edit mode',
    )
    const typingMode = await typeIntoEditor(client, TYPED_MARKER)
    const typed = await readSurface(client)
    recorder.note({ step: 'file-typed', typingMode, editorText: typed.editorText, readOnly: typed.editorReadOnly })
    recorder.check(
      typed.editorText.includes(TYPED_MARKER),
      'the typed text reached the editor',
      { editorText: typed.editorText },
    )
    await failPath(client, '/workspace/save', 'POST')
    await pressSaveShortcut(client)
    // Saving a workspace file is an approved write: the prompt is part of the
    // designed flow, and only approving it sends the request the probe fails.
    const approval = await waitForSurface(
      client,
      (surface) => (surface.approvalOpen ? surface : undefined),
      20_000,
      'the workspace save approval prompt',
    )
    recorder.note({ step: 'file-save-approval', title: approval.approvalTitle })
    recorder.check(
      approval.approvalTitle === '允许保存工作区文件？',
      'the save asks for the write approval it needs',
      { title: approval.approvalTitle },
    )
    await click(client, '.approval-action.primary')
    const saveFailure = await waitForSurface(
      client,
      (surface) => (surface.editorStatusError === true ? surface : undefined),
      20_000,
      'the file save failure',
    )
    const diskAfterFailure = await readFile(notesPath, 'utf8')
    recorder.note({
      step: 'file-save-failure',
      status: saveFailure.editorStatus,
      editorText: saveFailure.editorText,
      disk: diskAfterFailure.slice(0, 120),
      composerError: saveFailure.composerError,
    })
    recorder.check(
      saveFailure.editorStatus === '文件保存失败，请稍后重试。',
      'the failed file save states the failure where the save was made',
      { status: saveFailure.editorStatus },
    )
    recorder.check(
      saveFailure.editorText.includes(TYPED_MARKER),
      'the failed save keeps the typed content in the editor',
      { editorText: saveFailure.editorText },
    )
    recorder.check(diskAfterFailure === NOTES_START, 'the failed save wrote nothing to disk', { disk: diskAfterFailure })
    recorder.check(saveFailure.composerError === null, 'the file failure stays in the workspace, not in the chat area', { composerError: saveFailure.composerError })
    await clearFailures(client)
    // The approval prompt took the focus; the save shortcut only reaches the pane
    // while the editor owns it again.
    await clickEditor(client)
    await pressSaveShortcut(client)
    const saveApproval = await waitForSurface(
      client,
      (surface) => (surface.approvalOpen ? surface : undefined),
      20_000,
      'the retried save approval prompt',
    )
    await click(client, '.approval-action.primary')
    void saveApproval
    // A successful save refreshes the preview (its modifiedAt changes), which clears
    // the pane's transient status line. The durable fact of a successful retry is the
    // file on disk, so that is what this waits for.
    const savedDisk = await harness.waitFor(async () => {
      const content = await readFile(notesPath, 'utf8').catch(() => '')
      return content.includes(TYPED_MARKER) ? content : undefined
    }, 20_000, 'the retried save to reach the disk')
    const afterSave = await readSurface(client)
    // The confirmation has to outlive the preview refresh the save triggers.
    await delay(1_500)
    const settled = await readSurface(client)
    recorder.note({
      step: 'file-save-retry',
      disk: savedDisk.slice(0, 160),
      status: afterSave.editorStatus,
      statusError: afterSave.editorStatusError,
      statusAfterSettle: settled.editorStatus,
      editorText: afterSave.editorText,
    })
    recorder.check(savedDisk.includes(TYPED_MARKER), 'the retried save writes the typed text', { disk: savedDisk.slice(0, 160) })
    recorder.check(
      settled.editorStatus === '已保存' && settled.editorStatusError === false,
      'the confirmation survives the refresh the save itself caused',
      { status: afterSave.editorStatus, statusAfterSettle: settled.editorStatus, statusError: settled.editorStatusError },
    )
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
    check: 'async-feedback',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    injectedResponses: ['HTTP 500 for POST /config/providers, PATCH /runtime, POST /channels/reload, POST /plugins/<id>/enabled and POST /workspace/save, one at a time'],
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'Each failure is injected by the page fetch probe for one path at a time; the gate proves where the failure surfaces and what the next step is, not that a real backend outage looks identical.',
      'The plugin toggle uses the first discovered plugin; the gate does not assert which plugin that is.',
      'The file-save half types through CDP into the real Monaco editor and presses Ctrl+S, so it would fail loudly if the editor were not editable.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
