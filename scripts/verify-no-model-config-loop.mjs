// Real-window acceptance for the no-model → usable-model path (taskbook UX-11).
//
// The composer has to tell three states apart instead of showing one "no model"
// label: nothing configured yet (with a path to the provider settings), a
// configuration that could not be read (with a retry), and providers that are
// saved but still unusable (a saved key is not a verified callable model). The
// round trip also has to be lossless: opening the provider settings from the
// composer must keep the conversation, the typed text and the attachments.
//
// The fixture is a fresh data root with no provider at all, so the empty state is
// the real first-run state rather than a mocked one. The load-failure half injects
// HTTP 500 for GET /runtime through a page-level fetch probe.
//
// Usage:
//   node scripts/verify-no-model-config-loop.mjs [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const DRAFT_TEXT = '还没有模型，先把这段话留着。'
const ATTACHMENT_NAME = 'no-model-fixture.txt'
const PROVIDER_ID = 'acceptance-gw'
const PROVIDER_NAME = '验收网关'
const MODEL_ID = 'slow-a'
const API_KEY = 'acceptance-key'

/**
 * Fails GET /runtime while the flag is set, so the composer's own retry path can
 * be exercised without touching the rest of the Local App API.
 */
const PROBE_SOURCE = `(() => {
  if (window.__littlesheepRuntimeProbe) return true;
  const MODE_KEY = 'littlesheep.verify.runtimeConfigMode';
  const probe = { installed: true, runtimeRequests: 0, injectedFailures: 0, mode: null };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function probedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const mode = window.localStorage.getItem(MODE_KEY) || 'pass';
    probe.mode = mode;
    if (!/\\/runtime(?:\\?|$)/u.test(url)) return originalFetch(input, init);
    probe.runtimeRequests += 1;
    if (mode !== 'fail') return originalFetch(input, init);
    probe.injectedFailures += 1;
    return new Response(JSON.stringify({ error: '验收夹具注入的模型配置读取失败：HTTP 500' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  window.__littlesheepRuntimeProbe = probe;
  return true;
})()`

/** Composer, picker and settings state in one read. */
const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const trigger = document.querySelector('.runtime-picker-trigger');
  const textarea = document.querySelector('.composer textarea');
  return {
    pickerTrigger: trigger ? {
      label: (trigger.textContent || '').trim(),
      ariaLabel: trigger.getAttribute('aria-label'),
      disabled: trigger.disabled === true,
      title: trigger.getAttribute('title'),
    } : null,
    menuOpen: Boolean(document.querySelector('.runtime-menu-shell.open')),
    menuEmpty: (() => {
      const empty = document.querySelector('.runtime-empty');
      if (!empty) return null;
      return {
        label: empty.querySelector('span')?.textContent?.trim() ?? null,
        detail: empty.querySelector('small')?.textContent?.trim() ?? null,
        action: empty.querySelector('.runtime-configure-action')?.textContent?.trim() ?? null,
      };
    })(),
    menuSections: [...document.querySelectorAll('.runtime-menu-shell.open .runtime-submenu-trigger span')].map((node) => (node.textContent || '').trim()),
    modelOptions: [...document.querySelectorAll('.runtime-menu-shell.open .runtime-model-option')].map((node) => (node.textContent || '').trim()),
    draft: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    attachments: document.querySelectorAll('.attachment-preview-card').length,
    composerError: text('.composer-error'),
    readinessHint: text('.composer-readiness-hint'),
    // The settings shell keeps its node mounted behind a presence layer, so the
    // hidden phase is the authoritative "closed" signal (same contract the
    // continuity gate reads).
    settingsOpen: Boolean(document.querySelector('.settings-workspace'))
      && !document.querySelector('.settings-presence.presence-hidden'),
    settingsPresenceHidden: Boolean(document.querySelector('.settings-presence.presence-hidden')),
    activeNav: text('.settings-nav-item.active'),
    providerEmpty: text('.provider-empty'),
    providerCards: [...document.querySelectorAll('.provider-card')].map((card) => ({
      title: card.querySelector('.provider-card-title')?.textContent?.trim() ?? null,
      url: card.querySelector('.provider-url')?.textContent?.trim() ?? null,
      models: [...card.querySelectorAll('.provider-model-chip')].map((chip) => (chip.textContent || '').trim()),
      meta: card.querySelector('.provider-meta')?.textContent?.trim() ?? null,
    })),
    editor: (() => {
      const editor = document.querySelector('.provider-editor');
      if (!editor) return null;
      const inputs = [...editor.querySelectorAll('.settings-inline-field input')];
      const keyInput = inputs.find((input) => input.type === 'password');
      return {
        label: editor.getAttribute('aria-label'),
        id: inputs[0]?.value ?? null,
        idDisabled: inputs[0]?.disabled === true,
        name: inputs[1]?.value ?? null,
        baseURL: inputs[2]?.value ?? null,
        keyFilled: Boolean(keyInput && keyInput.value),
        modelRows: editor.querySelectorAll('.provider-model-row').length,
        modelIds: [...editor.querySelectorAll('.provider-model-row .provider-model-id')].map((input) => input.value),
        status: editor.querySelector('.provider-editor-status')?.textContent?.trim() ?? null,
        validationError: editor.querySelector('.dialog-error')?.textContent?.trim() ?? null,
      };
    })(),
    notice: text('.feedback-notice'),
    probe: window.__littlesheepRuntimeProbe
      ? {
        runtimeRequests: window.__littlesheepRuntimeProbe.runtimeRequests,
        injectedFailures: window.__littlesheepRuntimeProbe.injectedFailures,
      }
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

function buildConfig(workspaceDir) {
  return {
    version: 1,
    // A fresh install: no provider, no model. The readiness gate therefore reports
    // a failure, and the composer is the surface that has to explain what to do.
    providers: [],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: '',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 8,
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
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
    () => client.evaluate(`document.querySelector('.runtime-picker-trigger') instanceof HTMLElement || null`),
    harness.startTimeoutMs,
    'the composer runtime picker',
  )
  return { electron, locator, client }
}

async function stopWindow(handle) {
  handle?.client?.close()
  if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
}

/**
 * Install the runtime probe for every document of this window.
 *
 * The registration stays in place: the load-failure half reloads the renderer a
 * second time and reads the same probe through the mode flag in localStorage.
 */
async function installProbe(client, label) {
  const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE })
  client.__runtimeProbeIdentifier = identifier
  await reloadWithMode(client, 'pass', label)
  return identifier
}

async function reloadWithMode(client, mode, label) {
  await client.evaluate(`window.localStorage.setItem('littlesheep.verify.runtimeConfigMode', ${JSON.stringify(mode)})`)
  const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
  await client.send('Page.reload', { ignoreCache: false })
  await harness.waitFor(async () => {
    const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
      .catch(() => undefined)
    return state && state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? true : undefined
  }, harness.actionTimeoutMs, label)
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

/** Click the n-th element matching a selector (settings pages use repeated buttons). */
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

/** Paste a synthetic file into the composer, the same way UX-03's gate does. */
async function attachFile(client, name) {
  return client.evaluate(`(async () => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File(['no model fixture\\n'], ${JSON.stringify(name)}, { type: 'text/plain' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    const startedAt = performance.now();
    while (performance.now() - startedAt < 15000) {
      if (document.querySelectorAll('.attachment-preview-card').length > 0) return true;
      await new Promise((done) => setTimeout(done, 100));
    }
    return false;
  })()`)
}

async function openPickerMenu(client) {
  const alreadyOpen = await client.evaluate(`Boolean(document.querySelector('.runtime-menu-shell.open'))`)
  if (!alreadyOpen) await click(client, '.runtime-picker-trigger')
  return waitForSurface(client, (surface) => (surface.menuOpen ? surface : undefined), 20_000, 'the runtime picker menu')
}

async function closePickerMenu(client) {
  await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await delay(250)
}

/** Pick one model from the open picker menu. */
async function client_clickModelOption(client, modelId) {
  const clicked = await client.evaluate(`(() => {
    const option = [...document.querySelectorAll('.runtime-menu-shell.open .runtime-model-option')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(modelId)}));
    if (!(option instanceof HTMLElement)) return false;
    option.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`the model option for ${modelId} is not in the open menu`)
  await delay(500)
  return clicked
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-no-model-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshotDir = join(root, 'screenshots')
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir), null, 2)}\n`, 'utf8')

    // --- 1. first run: nothing is configured, and the composer says so ----------
    handle = await startWindow({ dataDir, chromiumDir, logPath })
    await harness.desktopAction(handle.locator, 'resize', WINDOW_SIZE)
    // The probe is installed before the first assertions so every /runtime read of
    // this window is counted, both for "the selector refreshed after the save" and
    // for the injected load failure later.
    await installProbe(handle.client, 'renderer reload with the runtime probe')
    const initial = await waitForSurface(
      handle.client,
      (surface) => (surface.pickerTrigger && surface.pickerTrigger.label.includes('还没有配置模型') ? surface : undefined),
      30_000,
      'the unconfigured model picker',
    )
    await setDraft(handle.client, DRAFT_TEXT)
    const attached = await attachFile(handle.client, ATTACHMENT_NAME)
    const prepared = await readSurface(handle.client)
    recorder.note({
      step: 'unconfigured',
      trigger: initial.pickerTrigger,
      readinessHint: initial.readinessHint,
      composerError: initial.composerError,
      draft: prepared.draft,
      attachments: prepared.attachments,
      attached,
    })
    recorder.check(initial.pickerTrigger.label.includes('还没有配置模型'), 'a fresh install says no model is configured', initial.pickerTrigger)
    recorder.check(initial.pickerTrigger.disabled === false, 'the picker stays clickable while nothing is configured', initial.pickerTrigger)
    recorder.check(prepared.draft === DRAFT_TEXT, 'the draft is typed before the configuration trip', { draft: prepared.draft })
    recorder.check(attached === true && prepared.attachments === 1, 'the attachment is added before the configuration trip', { attached, attachments: prepared.attachments })

    const emptyMenu = await openPickerMenu(handle.client)
    recorder.note({ step: 'unconfigured-menu', menuEmpty: emptyMenu.menuEmpty, menuSections: emptyMenu.menuSections })
    recorder.check(emptyMenu.menuEmpty !== null, 'the empty picker menu states the fact instead of staying blank', emptyMenu)
    recorder.check(
      (emptyMenu.menuEmpty?.detail ?? '').includes('设置 → 模型供应商'),
      'the empty state names where a model is configured',
      emptyMenu.menuEmpty,
    )
    recorder.check(emptyMenu.menuEmpty?.action === '配置模型', 'the empty state offers the configuration action', emptyMenu.menuEmpty)

    // --- 2. the action opens the provider page without dropping the draft -------
    await click(handle.client, '.runtime-configure-action')
    const settings = await waitForSurface(
      handle.client,
      (surface) => (surface.settingsOpen && surface.activeNav === '模型供应商' ? surface : undefined),
      30_000,
      'the model provider settings page',
    )
    recorder.note({
      step: 'configure-action',
      activeNav: settings.activeNav,
      providerEmpty: settings.providerEmpty,
      draft: settings.draft,
      attachments: settings.attachments,
      menuOpen: settings.menuOpen,
    })
    recorder.check(settings.activeNav === '模型供应商', 'the configuration action lands on the model provider page', { activeNav: settings.activeNav })
    recorder.check(settings.menuOpen === false, 'opening the settings closes the picker menu', { menuOpen: settings.menuOpen })
    recorder.check(
      (settings.providerEmpty ?? '').includes('保存成功后它才会出现在输入栏的模型选择器里'),
      'the empty provider page states when a provider becomes selectable',
      { providerEmpty: settings.providerEmpty },
    )
    recorder.check(
      (settings.providerEmpty ?? '').includes('不代表 LS 已经验证过它真的可以调用'),
      'the empty provider page does not imply a verified connection',
      { providerEmpty: settings.providerEmpty },
    )
    recorder.check(settings.draft === DRAFT_TEXT, 'the typed text survives opening the settings', { draft: settings.draft })
    recorder.check(settings.attachments === 1, 'the attachment survives opening the settings', { attachments: settings.attachments })

    // --- 3. save an endpoint without a key or a model: saved, still unusable ----
    await clickIndex(handle.client, '.provider-add', 1)
    const editor = await waitForSurface(
      handle.client,
      (surface) => (surface.editor ? surface : undefined),
      20_000,
      'the custom provider editor',
    )
    recorder.check(editor.editor?.label === '添加自定义供应商', 'the custom provider editor opens for a new provider', editor.editor)
    await setInput(handle.client, '.provider-editor .settings-inline-field input', PROVIDER_ID)
    await setInput(handle.client, '.provider-editor .settings-inline-field:nth-of-type(2) input', PROVIDER_NAME)
    await setInput(handle.client, '.provider-editor .settings-inline-field:nth-of-type(3) input', provider.baseURL)
    const filledEditor = await readSurface(handle.client)
    recorder.note({ step: 'editor-filled', editor: filledEditor.editor })
    recorder.check(filledEditor.editor?.id === PROVIDER_ID, 'the provider id can be typed', filledEditor.editor)
    recorder.check(filledEditor.editor?.name === PROVIDER_NAME, 'the provider name can be typed', filledEditor.editor)
    recorder.check(filledEditor.editor?.baseURL === provider.baseURL, 'the endpoint can be typed', filledEditor.editor)
    recorder.check(filledEditor.editor?.validationError === null, 'an endpoint without a model is a valid draft', filledEditor.editor)
    await click(handle.client, '.provider-editor .save-btn')
    let savedIncomplete
    try {
      savedIncomplete = await waitForSurface(
        handle.client,
        // The card title carries badges ("自定义", "无需密钥") next to the name.
        (surface) => (!surface.editor && surface.providerCards.some((card) => (card.title ?? '').includes(PROVIDER_NAME)) ? surface : undefined),
        30_000,
        'the saved provider card without models',
      )
    } catch (error) {
      recorder.note({ step: 'save-timeout', surface: await readSurface(handle.client) })
      throw error
    }
    recorder.note({
      step: 'saved-without-model',
      cards: savedIncomplete.providerCards,
      notice: savedIncomplete.notice,
    })
    recorder.check(
      savedIncomplete.providerCards.some((card) => card.url === provider.baseURL),
      'the saved endpoint appears as a provider card',
      savedIncomplete.providerCards,
    )
    recorder.check(
      savedIncomplete.providerCards.some((card) => (card.meta ?? '').includes('尚未添加模型')),
      'a provider without models is shown as such',
      savedIncomplete.providerCards,
    )
    recorder.check(
      (savedIncomplete.notice ?? '').includes(`已保存供应商 "${PROVIDER_ID}"`),
      'saving reports what was written',
      { notice: savedIncomplete.notice },
    )

    // --- 4. back in the composer: saved but not verified as callable ------------
    const beforeExitRequests = (await readSurface(handle.client)).probe?.runtimeRequests ?? 0
    await click(handle.client, '.settings-sidebar-exit')
    let unusable
    try {
      unusable = await waitForSurface(
        handle.client,
        (surface) => (!surface.settingsOpen && surface.pickerTrigger?.label.includes('已配置的供应商还不可用') ? surface : undefined),
        30_000,
        'the saved-but-unusable picker state',
      )
    } catch (error) {
      recorder.note({ step: 'unusable-timeout', surface: await readSurface(handle.client) })
      throw error
    }
    const unusableMenu = await openPickerMenu(handle.client)
    recorder.note({
      step: 'saved-but-unusable',
      trigger: unusable.pickerTrigger,
      menuEmpty: unusableMenu.menuEmpty,
      runtimeRequests: unusableMenu.probe?.runtimeRequests ?? null,
      requestsBeforeExit: beforeExitRequests,
      draft: unusable.draft,
      attachments: unusable.attachments,
    })
    recorder.check(
      (unusableMenu.probe?.runtimeRequests ?? 0) > beforeExitRequests,
      'leaving the settings re-reads the model configuration from the Runtime',
      { before: beforeExitRequests, after: unusableMenu.probe?.runtimeRequests ?? null },
    )
    recorder.check(
      (unusableMenu.menuEmpty?.detail ?? '').includes('保存配置不等于已经验证可以调用'),
      'a saved endpoint without a model is not presented as a verified connection',
      unusableMenu.menuEmpty,
    )
    recorder.check(unusableMenu.menuEmpty?.action === '检查供应商配置', 'that state points at the provider page, not at a retry', unusableMenu.menuEmpty)
    recorder.check(unusable.draft === DRAFT_TEXT && unusable.attachments === 1, 'the draft and attachment survive the round trip', {
      draft: unusable.draft,
      attachments: unusable.attachments,
    })
    recorder.check(unusable.composerError === null, 'the configuration read itself did not fail', { composerError: unusable.composerError })

    // --- 5. add the key and the model: the picker becomes ready -----------------
    await click(handle.client, '.runtime-configure-action')
    await waitForSurface(handle.client, (surface) => (surface.settingsOpen ? surface : undefined), 30_000, 'provider settings again')
    await click(handle.client, '.provider-card .save-btn')
    await waitForSurface(handle.client, (surface) => (surface.editor ? surface : undefined), 20_000, 'the provider editor for an existing provider')
    const reopened = await readSurface(handle.client)
    recorder.check(reopened.editor?.idDisabled === true, 'an existing provider keeps its id fixed', reopened.editor)
    await click(handle.client, '.provider-model-list .provider-chip')
    await setInput(handle.client, '.provider-model-row .provider-model-id', MODEL_ID)
    await setInput(handle.client, '.provider-editor .settings-inline-field input[type="password"]', API_KEY)
    const filledAgain = await readSurface(handle.client)
    recorder.note({ step: 'editor-filled-again', editor: filledAgain.editor })
    recorder.check(filledAgain.editor?.modelIds.includes(MODEL_ID), 'the model id can be typed', filledAgain.editor)
    recorder.check(filledAgain.editor?.keyFilled === true, 'the API key can be typed', filledAgain.editor)
    recorder.check(filledAgain.editor?.validationError === null, 'the completed provider draft is valid', filledAgain.editor)
    await click(handle.client, '.provider-editor .save-btn')
    let configured
    try {
      configured = await waitForSurface(
        handle.client,
        // The chip carries a "未声明" badge next to the id.
        (surface) => (!surface.editor && surface.providerCards.some((card) => card.models.some((model) => model.includes(MODEL_ID))) ? surface : undefined),
        30_000,
        'the provider card with its model',
      )
    } catch (error) {
      recorder.note({ step: 'configure-timeout', surface: await readSurface(handle.client) })
      throw error
    }
    recorder.note({ step: 'configured', cards: configured.providerCards, notice: configured.notice })
    recorder.check(
      configured.providerCards.some((card) => card.models.some((model) => model.includes(MODEL_ID))),
      'the saved model appears on the provider card',
      configured.providerCards,
    )

    const beforeReadyRequests = (await readSurface(handle.client)).probe?.runtimeRequests ?? 0
    await click(handle.client, '.settings-sidebar-exit')
    // Saved and usable, but nothing is selected yet: that state has its own wording
    // and must not be reported as "a key or a model entry may be missing".
    const unselected = await waitForSurface(
      handle.client,
      (surface) => (!surface.settingsOpen && surface.pickerTrigger?.label.includes('还没有选择模型') ? surface : undefined),
      30_000,
      'the picker to report that no model is selected yet',
    )
    const selectionMenu = await openPickerMenu(handle.client)
    recorder.note({
      step: 'unselected',
      trigger: unselected.pickerTrigger,
      menuSections: selectionMenu.menuSections,
      menuEmpty: selectionMenu.menuEmpty,
      modelOptions: selectionMenu.modelOptions,
      runtimeRequests: selectionMenu.probe?.runtimeRequests ?? null,
      requestsBeforeExit: beforeReadyRequests,
      draft: unselected.draft,
      attachments: unselected.attachments,
    })
    recorder.check(
      (selectionMenu.probe?.runtimeRequests ?? 0) > beforeReadyRequests,
      'leaving the settings re-reads the model configuration from the Runtime',
      { before: beforeReadyRequests, after: selectionMenu.probe?.runtimeRequests ?? null },
    )
    recorder.check(
      (unselected.pickerTrigger.title ?? '').includes('供应商已经可以使用'),
      'a usable provider without a selection says what is actually missing',
      { title: unselected.pickerTrigger.title, label: unselected.pickerTrigger.label },
    )
    recorder.check(selectionMenu.menuEmpty === null, 'the menu offers the saved provider instead of an empty state', { menuEmpty: selectionMenu.menuEmpty })
    recorder.check(selectionMenu.menuSections.includes('模型'), 'the picker offers the model list', { sections: selectionMenu.menuSections })
    recorder.check(
      selectionMenu.modelOptions.some((option) => option.includes(MODEL_ID)),
      'the saved model is listed in the picker without a reload',
      { options: selectionMenu.modelOptions },
    )

    // --- 6. choosing the model makes the composer ready ------------------------
    const clickedModel = await client_clickModelOption(handle.client, MODEL_ID)
    const afterClick = await readSurface(handle.client)
    const runtimeAfterClick = await harness.fetchJson(handle.locator, '/runtime').catch(() => undefined)
    recorder.note({
      step: 'model-clicked',
      clickedModel,
      trigger: afterClick.pickerTrigger,
      composerError: afterClick.composerError,
      runtimeStatus: runtimeAfterClick?.status ?? null,
      runtimeModel: runtimeAfterClick?.body?.model ?? null,
      probe: afterClick.probe,
    })
    let ready
    try {
      ready = await waitForSurface(
        handle.client,
        (surface) => (surface.pickerTrigger?.ariaLabel?.includes(MODEL_ID) ? surface : undefined),
        30_000,
        'the picker to show the selected model',
      )
    } catch (error) {
      recorder.note({ step: 'ready-timeout', surface: await readSurface(handle.client) })
      throw error
    }
    const runtime = await harness.fetchJson(handle.locator, '/runtime')
    recorder.note({
      step: 'ready',
      clickedModel,
      trigger: ready.pickerTrigger,
      runtimeModel: runtime?.body?.model ?? null,
      draft: ready.draft,
      attachments: ready.attachments,
      pickerMenuOpen: ready.menuOpen,
    })
    recorder.check(ready.pickerTrigger.disabled === false, 'a ready picker stays clickable', ready.pickerTrigger)
    recorder.check(
      runtime?.body?.model === `${PROVIDER_ID}/${MODEL_ID}`,
      'the selection is written to the Runtime configuration',
      { model: runtime?.body?.model ?? null },
    )
    recorder.check(
      ready.draft === DRAFT_TEXT && ready.attachments === 1,
      'the whole trip kept the draft and the attachment',
      { draft: ready.draft, attachments: ready.attachments },
    )
    await closePickerMenu(handle.client)

    // --- 6. a configuration that cannot be read offers a retry ------------------
    await reloadWithMode(handle.client, 'fail', 'renderer reload with the failing runtime probe')
    const loadFailed = await waitForSurface(
      handle.client,
      (surface) => (surface.pickerTrigger?.label.includes('模型配置读取失败') ? surface : undefined),
      30_000,
      'the failed configuration load state',
    )
    const loadFailedMenu = await openPickerMenu(handle.client)
    recorder.note({
      step: 'load-failed',
      trigger: loadFailed.pickerTrigger,
      menuEmpty: loadFailedMenu.menuEmpty,
      probe: loadFailedMenu.probe,
      composerError: loadFailedMenu.composerError,
    })
    recorder.check(
      (loadFailedMenu.menuEmpty?.detail ?? '').includes('500'),
      'the failure state carries the real reason instead of a generic empty state',
      loadFailedMenu.menuEmpty,
    )
    recorder.check(loadFailedMenu.menuEmpty?.action === '重试读取', 'a failed read offers a retry', loadFailedMenu.menuEmpty)
    recorder.check(
      (loadFailedMenu.probe?.injectedFailures ?? 0) >= 1,
      'the failure came from the injected response, not from an empty result',
      loadFailedMenu.probe,
    )

    const failuresBeforeRetry = loadFailedMenu.probe?.injectedFailures ?? 0
    const requestsBeforeRetry = loadFailedMenu.probe?.runtimeRequests ?? 0
    await click(handle.client, '.runtime-configure-action')
    const retried = await waitForSurface(
      handle.client,
      (surface) => ((surface.probe?.runtimeRequests ?? 0) > requestsBeforeRetry ? surface : undefined),
      20_000,
      'the retry to re-read the configuration',
    )
    const retriedMenu = await openPickerMenu(handle.client)
    recorder.note({ step: 'retry-failed-again', probe: retriedMenu.probe, menuEmpty: retriedMenu.menuEmpty, trigger: retried.pickerTrigger })
    recorder.check(
      (retriedMenu.probe?.injectedFailures ?? 0) > failuresBeforeRetry,
      'the retry asks the Local App API again',
      { before: failuresBeforeRetry, after: retriedMenu.probe?.injectedFailures ?? null },
    )
    recorder.check(
      retriedMenu.menuEmpty?.action === '重试读取',
      'a retry that fails again keeps the failure state instead of pretending readiness',
      retriedMenu.menuEmpty,
    )

    await handle.client.evaluate(`window.localStorage.setItem('littlesheep.verify.runtimeConfigMode', 'pass')`)
    await click(handle.client, '.runtime-configure-action')
    const recovered = await waitForSurface(
      handle.client,
      (surface) => (surface.pickerTrigger?.ariaLabel?.includes(MODEL_ID) ? surface : undefined),
      30_000,
      'the retry to publish the saved model',
    )
    recorder.note({ step: 'retry-recovered', trigger: recovered.pickerTrigger, probe: recovered.probe, composerError: recovered.composerError })
    recorder.check(
      recovered.composerError === null,
      'a successful retry clears the composer error',
      { composerError: recovered.composerError },
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
    check: 'no-model-config-loop',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    injectedResponses: ['GET /runtime answered with HTTP 500 by the page fetch probe (load-failure state only)'],
    ok: recorder.failures.length === 0,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The fixture saves a custom OpenAI-compatible endpoint pointing at the acceptance Provider stub; the gate proves the configuration round trip, not that any real provider is reachable.',
      'No connection check exists in this path, so "saved but unusable" is judged from the Runtime payload (key presence and model entries), exactly as the taskbook allows; adding a real check would need its own network-cost decision.',
      'The attachment is a synthetic paste into the composer, not an OS file-dialog pick; the gate covers that the composer keeps its attachment across the settings trip.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
