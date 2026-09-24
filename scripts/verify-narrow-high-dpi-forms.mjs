// Real-window acceptance for narrow windows and scaled displays (taskbook UX-15).
//
// Four surfaces have to stay usable when the window is at its minimum or the display
// is scaled: the model provider form (four model fields in one grid row), the
// settings sidebar, the runtime picker with its submenus, and an approval prompt
// carrying a long path. For every combination of logical window size and device
// scale factor this records the real geometry and asserts what the acceptance asks
// for: key buttons stay reachable, fields stay wide enough to type in, nothing
// overflows horizontally without need, and long paths can be read and copied.
//
// The device scale factor is emulated the way the OS scaling works: the physical
// window keeps its size while the renderer sees the matching CSS viewport and
// devicePixelRatio.
//
// Usage:
//   node scripts/verify-narrow-high-dpi-forms.mjs [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const PROVIDER_ID = 'acceptance-gw'
const PROVIDER_NAME = '验收网关'
const MODEL_ID = 'slow-a'
/** A workspace path long enough to need scrolling in an approval detail block. */
const DEEP_FOLDERS = ['projects', 'very-long-project-name-for-ux15', 'packages', 'renderer', 'workspace', 'nested', 'deeper']
const DEEP_FILE = 'long-path-approval-fixture.txt'
const DRAFT_MARKER = 'ux15 typed marker'
/** Budget the acceptance names: a field narrower than this cannot be typed in. */
const MIN_TYPABLE_FIELD_PX = 120

const COMBINATIONS = [
  { name: 'minimum-window-100', window: { width: 800, height: 600 }, scale: 1 },
  { name: 'common-window-100', window: { width: 1280, height: 840 }, scale: 1 },
  { name: 'common-window-125', window: { width: 1280, height: 840 }, scale: 1.25 },
  { name: 'common-window-150', window: { width: 1280, height: 840 }, scale: 1.5 },
  { name: 'minimum-logical-200', window: { width: 800, height: 600 }, scale: 2 },
]

/** Geometry for every surface the acceptance names, read in one pass. */
const SURFACE_EXPRESSION = `(() => {
  const rect = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    return {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
      right: Math.round(box.right), bottom: Math.round(box.bottom),
    };
  };
  const text = (node) => node ? (node.textContent || '').trim() : null;
  const visible = (node) => Boolean(node)
    && !node.closest('[inert]')
    && getComputedStyle(node).visibility !== 'hidden'
    && node.getBoundingClientRect().width > 0;
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
  /**
   * Reachable either without scrolling or by scrolling the page/its own scroller.
   * A control below the fold of a scrollable settings page is reachable; one clipped
   * by an overflow-hidden ancestor without a scroller is not.
   */
  const reachableWithScroll = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    if (reachable(node)) return true;
    node.scrollIntoView({ block: 'center', inline: 'nearest' });
    return reachable(node);
  };
  const overflowX = (node) => (node instanceof HTMLElement ? node.scrollWidth - node.clientWidth : null);

  const trigger = document.querySelector('.runtime-picker-trigger');
  const menu = document.querySelector('.runtime-menu-shell.open');
  const modelRow = document.querySelector('.provider-model-row');
  const modelInputs = modelRow ? [...modelRow.querySelectorAll('input')] : [];
  const modelInputBoxes = modelInputs.map((input) => rect(input));
  const stacked = modelInputBoxes.length > 1
    ? modelInputBoxes.some((box) => box && modelInputBoxes[0] && Math.abs(box.y - modelInputBoxes[0].y) > 4)
    : null;
  const fieldLabels = modelInputs.map((input) => {
    const explicit = input.getAttribute('aria-label');
    if (explicit && explicit.trim()) return explicit.trim();
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const node = document.getElementById(labelledBy);
      if (node && visible(node)) return text(node);
    }
    const wrapper = input.closest('.provider-model-field');
    const label = wrapper?.querySelector('.provider-model-field-label') ?? null;
    return label instanceof HTMLElement && visible(label) ? text(label) : null;
  });
  const columnsHeader = document.querySelector('.provider-model-columns');
  const approval = document.querySelector('.approval-prompt');
  const approvalDetail = approval?.querySelector('pre') ?? null;

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    workspaceFileTab: (() => {
      const label = document.querySelector('.workspace-active-item.active .workspace-active-label-text');
      return label ? (label.textContent || '').trim() : null;
    })(),
    editorRow: (() => {
      const line = document.querySelector('.workspace-editor-monaco .view-line');
      return line ? (line.textContent || '').replace(/\u00a0/gu, ' ').slice(0, 80) : null;
    })(),
    editorText: [...document.querySelectorAll('.workspace-editor-monaco .view-line')]
      .map((line) => (line.textContent || ''))
      .join(' ')
      // Monaco's DOM carries non-breaking and zero-width characters between words,
      // so both sides are compared after dropping everything that is not a letter
      // or a digit.
      .replace(/[^0-9a-z]+/giu, '')
      .toLowerCase()
      .slice(0, 200),
    editorReadOnly: (() => {
      const editor = document.querySelector('.workspace-editor-monaco .monaco-editor');
      return editor ? editor.classList.contains('workspace-monaco-readonly') : null;
    })(),
    picker: {
      triggerRect: rect(trigger),
      triggerReachable: reachable(trigger),
      menuOpen: Boolean(menu),
      menuRect: rect(menu),
      menuInsideViewport: menu ? (() => {
        const box = menu.getBoundingClientRect();
        return box.left >= -1 && box.top >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1;
      })() : null,
      submenuRects: [...document.querySelectorAll('.runtime-submenu.visible')].map((node) => rect(node)),
      modelOptions: [...document.querySelectorAll('.runtime-menu-shell.open .runtime-model-option')].map((node) => ({
        text: text(node), rect: rect(node), reachable: reachable(node),
      })),
    },
    settings: {
      present: Boolean(document.querySelector('.settings-workspace'))
        && !document.querySelector('.settings-presence.presence-hidden'),
      sidebarRect: rect(document.querySelector('.settings-sidebar')),
      sidebarOverflow: overflowX(document.querySelector('.settings-sidebar')),
      navActiveReachable: reachable(document.querySelector('.settings-nav-item.active')),
      pageRect: rect(document.querySelector('.settings-module-page')),
      pageOverflow: overflowX(document.querySelector('.settings-module-page')),
      editorRect: rect(document.querySelector('.provider-editor')),
      editorOverflowX: overflowX(document.querySelector('.provider-editor')),
      editorOverflowY: overflowX(document.querySelector('.provider-editor-body')),
      editorBodyScrollable: (() => {
        const body = document.querySelector('.provider-editor-body');
        return body ? { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null;
      })(),
      baseUrlInputRect: rect(document.querySelector('.provider-editor .settings-inline-field:nth-of-type(3) input')),
      /** Auxiliary text sizes, so "hard to read" is a measurement and not a guess. */
      auxFontSizes: {
        fieldLabel: document.querySelector('.provider-model-field-label')
          ? getComputedStyle(document.querySelector('.provider-model-field-label')).fontSize
          : null,
        columnsHeader: columnsHeader ? getComputedStyle(columnsHeader).fontSize : null,
        keyNote: document.querySelector('.provider-editor-key-note')
          ? getComputedStyle(document.querySelector('.provider-editor-key-note')).fontSize
          : null,
        statusLine: document.querySelector('.workspace-editor-status')
          ? getComputedStyle(document.querySelector('.workspace-editor-status')).fontSize
          : null,
      },
      modelRowColumns: modelRow ? getComputedStyle(modelRow).gridTemplateColumns : null,
      modelRowRect: rect(modelRow),
      modelRowOverflow: overflowX(modelRow),
      modelInputRects: modelInputBoxes,
      modelInputMinWidth: modelInputBoxes.length > 0
        ? Math.min(...modelInputBoxes.map((box) => box?.width ?? 0))
        : null,
      modelStacked: stacked,
      modelColumnsHeaderVisible: columnsHeader ? visible(columnsHeader) : null,
      modelFieldLabels: fieldLabels,
      modelFieldLabelsVisible: modelInputs.map((input) => {
        const wrapper = input.closest('.provider-model-field');
        const label = wrapper?.querySelector('.provider-model-field-label') ?? null;
        return label instanceof HTMLElement && visible(label) ? text(label) : null;
      }),
      removeButtonReachable: reachable(modelRow?.querySelector('.provider-model-remove') ?? null),
      saveReachable: reachableWithScroll(document.querySelector('.provider-editor .save-btn')),
      closeReachable: reachableWithScroll(document.querySelector('.provider-editor .dialog-close')),
    },
    approval: {
      present: Boolean(approval),
      title: text(approval?.querySelector('h2')),
      rect: rect(approval),
      insideViewport: approval ? (() => {
        const box = approval.getBoundingClientRect();
        return box.left >= -1 && box.top >= -1 && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1;
      })() : null,
      overflowX: overflowX(approval),
      detail: approvalDetail ? {
        text: (approvalDetail.textContent || '').trim(),
        scrollWidth: approvalDetail.scrollWidth,
        clientWidth: approvalDetail.clientWidth,
        overflowX: getComputedStyle(approvalDetail).overflowX,
        userSelect: getComputedStyle(approvalDetail).userSelect,
      } : null,
      buttons: [...(approval?.querySelectorAll('.approval-action') ?? [])].map((node) => ({
        label: text(node), reachable: reachable(node), rect: rect(node),
      })),
    },
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
      },
    },
    desktop: { closePolicy: 'always-background' },
  }
}

function seedPreferencesExpression(workspaceDir, filePath) {
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  const layout = {
    collapsed: false,
    fullscreen: false,
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
    'littlesheep.ui.workspacePanelFullscreen': 'false',
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
    window.localStorage.setItem('littlesheep.verify.ux15.seeded', '1');
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

/** Apply one window size + device scale factor, exactly as a scaled display would. */
async function applyCombination(client, locator, combination) {
  // Clearing first matters: an active override pins window.innerWidth, so measuring
  // the window while one is still set would re-apply the previous size.
  await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  await harness.desktopAction(locator, 'resize', combination.window)
  await delay(500)
  const measured = await client.evaluate(`(() => ({ width: window.innerWidth, height: window.innerHeight }))()`)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: measured.width,
    height: measured.height,
    deviceScaleFactor: combination.scale,
    mobile: false,
  })
  await delay(400)
  return measured
}

async function clearCombination(client) {
  await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
}

async function captureScreenshot(client, dir, name) {
  await mkdir(dir, { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, name), Buffer.from(shot.data, 'base64'))
  return join(dir, name)
}

async function clickEditor(client) {
  const input = await harness.waitFor(async () => {
    const value = await client.evaluate(`(() => {
      const line = document.querySelector('.workspace-editor-monaco .monaco-editor .view-line');
      if (!(line instanceof HTMLElement)) return undefined;
      const box = line.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`)
    return value ?? undefined
  }, 30_000, 'the Monaco text area')
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: 'left', buttons: 0, clickCount: 1 })
  await delay(300)
}

async function pressSaveShortcut(client) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83,
  })
  await delay(600)
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-ux15-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshotDir = join(root, 'screenshots')
  const deepDir = join(workspaceDir, ...DEEP_FOLDERS)
  const deepFile = join(deepDir, DEEP_FILE)
  let handle
  try {
    await Promise.all([mkdir(deepDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(deepFile, 'ux15 fixture line one\n', 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', { width: 1280, height: 840 })
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    handle = { electron, locator, client }
    const { identifier } = await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: seedPreferencesExpression(workspaceDir, deepFile),
    })
    handle.layoutIdentifier = identifier
    await client.evaluate(seedPreferencesExpression(workspaceDir, deepFile))
    const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
    await client.send('Page.reload', { ignoreCache: false })
    await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
        .catch(() => undefined)
      return state && state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? true : undefined
    }, harness.actionTimeoutMs, 'renderer reload with the long-path layout')
    await waitForSurface(
      client,
      (surface) => (surface.picker.triggerRect ? surface : undefined),
      30_000,
      'the runtime picker',
    )

    // --- the model provider form, the settings sidebar and the picker ----------
    const formMeasurements = []
    for (const combination of COMBINATIONS) {
      await applyCombination(client, locator, combination)
      // The trigger is measured with the menu closed: while a menu is open a
      // full-window layer owns the pointer and would report it as covered.
      const pickerClosed = await waitForSurface(
        client,
        (surface) => (surface.picker.menuOpen === false ? surface : undefined),
        10_000,
        `the picker menu to be closed at ${combination.name}`,
      )
      await click(client, '.runtime-picker-trigger')
      await waitForSurface(client, (surface) => (surface.picker.menuOpen ? surface : undefined), 20_000, `the picker menu at ${combination.name}`)
      // The model list lives in a submenu; it is only laid out for pointer use once
      // its trigger is activated.
      await clickByText(client, '.runtime-menu-shell.open .runtime-submenu-trigger', '模型')
      const pickerOpen = await waitForSurface(
        client,
        (surface) => (surface.picker.modelOptions.length > 0 && surface.picker.submenuRects.length > 0 ? surface : undefined),
        20_000,
        `the model submenu at ${combination.name}`,
      )
      await client.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await delay(200)
      await openSettingsPage(client, '模型供应商')
      const onCard = await readSurface(client)
      if (onCard.settings.editorRect === null) await click(client, '.provider-card .save-btn')
      const inEditor = await waitForSurface(
        client,
        (surface) => (surface.settings.editorRect ? surface : undefined),
        20_000,
        `the provider editor at ${combination.name}`,
      )
      const shot = await captureScreenshot(client, screenshotDir, `${combination.name}-provider-editor.png`)
      const entry = {
        step: `combination-${combination.name}`,
        requested: { window: combination.window, scale: combination.scale },
        viewport: inEditor.viewport,
        documentOverflow: inEditor.documentOverflow,
        picker: {
          triggerReachable: pickerClosed.picker.triggerReachable,
          menuInsideViewport: pickerOpen.picker.menuInsideViewport,
          modelOptions: pickerOpen.picker.modelOptions,
          submenuRects: pickerOpen.picker.submenuRects,
        },
        settings: inEditor.settings,
        screenshot: shot,
      }
      formMeasurements.push(entry)
      recorder.note(entry)

      recorder.check(
        pickerClosed.picker.triggerReachable === true,
        `${combination.name}: the runtime picker trigger stays reachable`,
        pickerClosed.picker,
      )
      recorder.check(
        pickerOpen.picker.menuInsideViewport === true,
        `${combination.name}: the runtime picker menu stays inside the window`,
        pickerOpen.picker.menuRect,
      )
      recorder.check(
        pickerOpen.picker.modelOptions.every((option) => option.reachable === true),
        `${combination.name}: the model entries stay reachable`,
        pickerOpen.picker.modelOptions,
      )
      recorder.check(
        inEditor.documentOverflow <= 1,
        `${combination.name}: the page has no horizontal scroll`,
        { overflow: inEditor.documentOverflow },
      )
      recorder.check(
        (inEditor.settings.sidebarOverflow ?? 0) <= 1,
        `${combination.name}: the settings sidebar does not overflow`,
        { overflow: inEditor.settings.sidebarOverflow },
      )
      recorder.check(
        inEditor.settings.navActiveReachable === true,
        `${combination.name}: the active settings entry stays reachable`,
        { reachable: inEditor.settings.navActiveReachable },
      )
      recorder.check(
        inEditor.settings.removeButtonReachable === true && inEditor.settings.saveReachable === true,
        `${combination.name}: the model row delete button and the save button stay reachable`,
        { remove: inEditor.settings.removeButtonReachable, save: inEditor.settings.saveReachable, close: inEditor.settings.closeReachable },
      )
      const minField = inEditor.settings.modelInputMinWidth ?? 0
      if (inEditor.settings.modelStacked === true) {
        recorder.check(
          minField >= MIN_TYPABLE_FIELD_PX,
          `${combination.name}: the stacked model fields stay wide enough to type in`,
          { minField, rects: inEditor.settings.modelInputRects },
        )
        recorder.check(
          inEditor.settings.modelFieldLabels.every((label) => typeof label === 'string' && label.trim().length > 0),
          `${combination.name}: every stacked model field keeps its own label`,
          { labels: inEditor.settings.modelFieldLabels },
        )
      } else {
        recorder.check(
          minField >= MIN_TYPABLE_FIELD_PX,
          `${combination.name}: the row layout keeps every model field wide enough to type in`,
          { minField, columns: inEditor.settings.modelRowColumns, rects: inEditor.settings.modelInputRects },
        )
        recorder.check(
          inEditor.settings.modelColumnsHeaderVisible === true,
          `${combination.name}: the row layout shows the column labels`,
          { visible: inEditor.settings.modelColumnsHeaderVisible },
        )
      }

      // Leave the settings page open for the next combination.
      await click(client, '.settings-sidebar-exit')
      await waitForSurface(client, (surface) => (!surface.settings.present ? surface : undefined), 20_000, 'settings to close')
      await clearCombination(client)
    }

    // --- the approval prompt carrying a long path ------------------------------
    // The panel keeps the deep file tab open from the seed, so the prompt is produced
    // once and then measured at every scale factor while it stays on screen. The setup
    // runs at a comfortable size: a 296px panel at the minimum window clips the edit
    // toggle, which is a separate measurement from the approval prompt itself.
    await applyCombination(client, locator, { window: { width: 1280, height: 840 }, scale: 1 })
    await waitForSurface(
      client,
      (surface) => (surface.picker.triggerRect && !surface.settings.present ? surface : undefined),
      20_000,
      'the composer after leaving the settings',
    )
    const fileTab = await waitForSurface(
      client,
      (surface) => (surface.workspaceFileTab ? surface : undefined),
      20_000,
      'the long-path file tab',
    )
    recorder.note({ step: 'approval-setup', fileTab: fileTab.workspaceFileTab, editorRow: fileTab.editorRow, editorReadOnly: fileTab.editorReadOnly })
    if (fileTab.editorReadOnly === true) {
      await clickByText(client, '.workspace-files-text-btn', '编辑')
      await waitForSurface(client, (surface) => (surface.editorReadOnly === false ? surface : undefined), 10_000, 'the editor to switch to edit mode')
    }
    await clickEditor(client)
    await client.send('Input.insertText', { text: DRAFT_MARKER })
    await delay(400)
    const typedRow = await readSurface(client)
    const typedNeedle = DRAFT_MARKER.replace(/[^0-9a-z]+/giu, '').toLowerCase()
    recorder.note({ step: 'approval-setup-typed', editorText: typedRow.editorText, needle: typedNeedle })
    recorder.check(
      (typedRow.editorText ?? '').includes(typedNeedle),
      'the fixture typed into the file before asking for the save approval',
      { editorText: typedRow.editorText, needle: typedNeedle },
    )
    await clickEditor(client)
    await pressSaveShortcut(client)
    const approvals = []
    for (const combination of COMBINATIONS) {
      await applyCombination(client, locator, combination)
      let prompt = await readSurface(client)
      if (!prompt.approval.present) {
        // A resize can dismiss the prompt; ask for it again in this combination.
        await clickEditor(client)
        await pressSaveShortcut(client)
        prompt = await waitForSurface(client, (surface) => (surface.approval.present ? surface : undefined), 20_000, `the approval prompt at ${combination.name}`)
      }
      const shot = await captureScreenshot(client, screenshotDir, `${combination.name}-approval.png`)
      const entry = {
        step: `approval-${combination.name}`,
        viewport: prompt.viewport,
        approval: prompt.approval,
        screenshot: shot,
      }
      approvals.push(entry)
      recorder.note(entry)
      recorder.check(prompt.approval.present === true, `${combination.name}: the approval prompt is shown`, prompt.approval)
      recorder.check(
        prompt.approval.insideViewport === true,
        `${combination.name}: the approval prompt fits the window`,
        prompt.approval.rect,
      )
      recorder.check(
        prompt.approval.buttons.length === 3 && prompt.approval.buttons.every((button) => button.reachable === true),
        `${combination.name}: every approval action stays reachable`,
        prompt.approval.buttons,
      )
      recorder.check(
        (prompt.approval.detail?.text ?? '').includes(DEEP_FILE) && (prompt.approval.detail?.text ?? '').includes('very-long-project-name-for-ux15'),
        `${combination.name}: the approval shows the full long path`,
        { detail: (prompt.approval.detail?.text ?? '').slice(0, 240) },
      )
      recorder.check(
        prompt.approval.detail?.userSelect === 'text' || prompt.approval.detail?.userSelect === 'auto',
        `${combination.name}: the long path can be selected and copied`,
        { userSelect: prompt.approval.detail?.userSelect },
      )
      recorder.check(
        // A path longer than the block has to stay reachable: the block scrolls
        // instead of clipping.
        prompt.approval.detail?.overflowX === 'auto' || prompt.approval.detail?.overflowX === 'scroll',
        `${combination.name}: a path longer than the block can be scrolled instead of being clipped`,
        { overflowX: prompt.approval.detail?.overflowX },
      )
      recorder.check(
        prompt.approval.overflowX !== null && prompt.approval.overflowX <= 1,
        `${combination.name}: the approval dialog does not overflow horizontally`,
        { overflow: prompt.approval.overflowX },
      )
      await clearCombination(client)
    }
    await click(client, '.approval-action.primary')
    await delay(400)
    const evidence = {
      check: 'narrow-high-dpi-forms',
      capturedAt: new Date().toISOString(),
      fixtureRoot: keep ? root : '<temporary root removed>',
      combinations: COMBINATIONS,
      minTypableFieldPx: MIN_TYPABLE_FIELD_PX,
      ok: recorder.failures.length === 0,
      observations: recorder.observations,
      failures: recorder.failures,
      limits: [
        'Device scale factors are emulated with Emulation.setDeviceMetricsOverride, which is what the renderer sees as devicePixelRatio; no physical display at 125/150/200% was used.',
        'The 200% case uses the minimum logical window (800x600) because the application refuses to go smaller in logical units.',
        'The approval prompt is one real prompt measured at every scale factor; each measurement re-requests it if a resize dismissed it.',
      ],
    }
    console.log(JSON.stringify(evidence, null, 2))
    if (!evidence.ok) process.exitCode = 1
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
    })
    console.log(JSON.stringify({
      check: 'narrow-high-dpi-forms',
      ok: false,
      observations: recorder.observations,
      failures: recorder.failures,
    }, null, 2))
    process.exitCode = 1
  } finally {
    handle?.client?.close()
    if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }
}

await main()
