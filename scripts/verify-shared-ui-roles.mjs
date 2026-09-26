// Real-window acceptance for the shared UI state roles (taskbook UX-14).
//
// UX-14 asked for measured convergence instead of class-name guessing: build a
// small state sample (primary/secondary/danger controls, inline notices, error
// surfaces), reuse the existing tokens, and prove that controls of one role
// agree on height, type scale, focus, disabled, waiting and danger treatment
// while the black-grey theme, the compact layout, reduced-motion and the radius
// exceptions stay intact.
//
// The walkthrough drives real settings pages and real dialogs, and reads the
// computed style of what the app actually rendered:
//   - error surfaces and inline notices appear through their real failure paths
//     (a failing settings action, a failing plugin reload, a ghost channel);
//   - disabled / waiting states are caught while an operation is really in
//     flight, which is why the fixture holds one request open per state;
//   - the surfaces that this fixture cannot reach are measured by mounting the
//     real classes inside the live settings page — that only proves the shipped
//     stylesheet resolves them to the same token, and it is labelled as such.
//
// Usage:
//   node scripts/verify-shared-ui-roles.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-shared-ui-roles')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1280, height: 840 }
const EVALUATE_TIMEOUT_MS = 20_000
const GHOST_CHANNEL_TYPE = 'littlesheep-channel-role-fixture'

/** Resolved token values, as the browser computes them. */
const DANGER_TEXT = 'rgb(255, 210, 210)'
const DANGER_CONTROL_TEXT = 'rgb(255, 216, 216)'
const DISABLED_OPACITY = '0.42'
const NOTICE_GEOMETRY = {
  'padding-top': '8px',
  'padding-bottom': '8px',
  'padding-left': '10px',
  'padding-right': '10px',
  'font-size': '12px',
}
const CONTROL_PROPS = [
  'min-height',
  'height',
  'font-size',
  'font-weight',
  'color',
  'background-color',
  'border-top-left-radius',
  'opacity',
  'transition-duration',
  'animation-duration',
  'animation-name',
  'outline-width',
  'outline-style',
  'outline-offset',
]

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

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Role Acceptance Provider',
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
    // One configured channel whose type no active plugin provides: the channel
    // list renders its real failure row instead of a mocked one.
    channels: {
      channels: [{
        id: 'ghost-channel',
        type: GHOST_CHANNEL_TYPE,
        name: '验收幽灵渠道',
        enabled: true,
      }],
    },
    desktop: { closePolicy: 'always-background' },
  }
}

/**
 * Hold or fail one local-app-api request so the real views reach their waiting
 * and failure branches. This is an injected transport fault (no product code is
 * patched), and the evidence labels it as such.
 */
const INSTALL_PROBE = `(() => {
  if (window.__lsRoleProbe) return true
  const probe = { rules: [], hits: {}, failures: 0 }
  window.__lsRoleProbe = probe
  probe.holdNext = (match, ms, method) => probe.rules.push({ match, ms, mode: 'hold', once: true, method })
  probe.failNext = (match, method) => probe.rules.push({ match, mode: 'fail', once: true, method })
  probe.pending = () => probe.rules.length
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    const index = probe.rules.findIndex((rule) => url.includes(rule.match)
      && (!rule.method || rule.method === method))
    if (index >= 0) {
      const rule = probe.rules[index]
      if (rule.once) probe.rules.splice(index, 1)
      probe.hits[rule.mode + ':' + rule.match] = (probe.hits[rule.mode + ':' + rule.match] || 0) + 1
      if (rule.mode === 'hold' && rule.ms > 0) await new Promise((done) => setTimeout(done, rule.ms))
      if (rule.mode === 'fail') {
        probe.failures += 1
        return new Response(JSON.stringify({ error: 'acceptance fixture: injected transport fault' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return originalFetch(input, init)
  }
  return true
})()`

/** Reads computed style for the first *visible* match of each sample selector. */
function measureExpression(samples) {
  return `(() => {
    const samples = ${JSON.stringify(samples)};
    const isVisible = (node) => {
      if (node.closest('[inert]')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    return samples.map((sample) => {
      const all = [...document.querySelectorAll(sample.selector)];
      const visibleMatches = all.filter(isVisible);
      const node = visibleMatches[sample.index ?? 0];
      if (!node) {
        return { key: sample.key, selector: sample.selector, present: all.length, visibleCount: visibleMatches.length, visible: false };
      }
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const props = {};
      for (const name of sample.props) props[name] = style.getPropertyValue(name);
      return {
        key: sample.key,
        selector: sample.selector,
        present: all.length,
        visibleCount: visibleMatches.length,
        visible: true,
        tag: node.tagName,
        disabled: node.disabled === true,
        text: (node.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 90),
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        props,
      };
    });
  })()`
}

async function measure(client, samples) {
  const rows = await evaluate(client, measureExpression(samples))
  const byKey = new Map(rows.map((row) => [row.key, row]))
  return { rows, get: (key) => byKey.get(key) ?? null }
}

async function openSettingsPage(client, label) {
  await evaluate(client, `(() => {
    if (!document.querySelector('.settings-workspace')
      || document.querySelector('.settings-presence.presence-hidden')) {
      document.querySelector('.settings-entry-btn')?.click()
    }
    return true
  })()`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`), harness.startTimeoutMs, 'settings navigation')
  const index = await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.settings-nav-item')]
    return items.findIndex((item) => item.textContent?.includes(${JSON.stringify(label)}))
  })()`)
  if (index < 0) throw new Error(`the ${label} navigation item is missing`)
  await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.settings-nav-item')]
    items[${index}]?.click()
    return true
  })()`)
  await delay(400)
}

async function clickVisible(client, selector, { index = 0, contains = null } = {}) {
  return evaluate(client, `(() => {
    const isVisible = (node) => {
      if (node.closest('[inert]')) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(isVisible)
      .filter((node) => ${contains === null ? 'true' : `(node.textContent || '').includes(${JSON.stringify(contains)})`});
    const node = matches[${index}];
    if (!(node instanceof HTMLElement)) return { clicked: false, matches: matches.length };
    node.click();
    return { clicked: true, matches: matches.length, label: (node.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 40) };
  })()`)
}

async function setInputValue(client, selector, index, value) {
  return evaluate(client, `(() => {
    const input = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

async function waitForVisible(client, selector, timeoutMs, label) {
  return harness.waitFor(
    () => evaluate(client, `(() => {
      const isVisible = (node) => {
        if (node.closest('[inert]')) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(isVisible);
      return node ? (node.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 120) : null;
    })()`),
    timeoutMs,
    label,
  )
}

async function pressTab(client) {
  const event = {
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  }
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  await delay(120)
}

/**
 * Reads the focused element twice: once while it has focus and once after
 * blurring it. Some settings controls replace the global outline with a surface
 * change, so "focus is visible" means the focused rendering differs from the
 * resting rendering in a way a user can see.
 */
async function readFocusTransition(client) {
  return evaluate(client, `(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement) || node === document.body) return null;
    const read = (element) => {
      const style = getComputedStyle(element);
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        outlineOffset: style.outlineOffset,
        outlineColor: style.outlineColor,
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        color: style.color,
        boxShadow: style.boxShadow,
      };
    };
    const marker = {
      tag: node.tagName,
      className: typeof node.className === 'string' ? node.className : String(node.className?.baseVal ?? ''),
      label: (node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 40),
      insideEditor: node.closest('.provider-editor') !== null,
    };
    const focused = read(node);
    node.blur();
    const resting = read(node);
    const changed = ['outlineWidth', 'outlineStyle', 'background', 'borderColor', 'color', 'boxShadow']
      .filter((name) => focused[name] !== resting[name]);
    return { marker, focused, resting, changed };
  })()`)
}

async function focusFirstEditorField(client) {
  return evaluate(client, `(() => {
    // The provider id field is disabled while editing, so pick the first field a
    // user can really put focus on.
    const input = [...document.querySelectorAll('.provider-editor .settings-inline-field input')]
      .find((candidate) => !candidate.disabled);
    if (!(input instanceof HTMLElement)) return false;
    input.focus();
    return document.activeElement === input;
  })()`)
}

function numericParts(value) {
  return String(value ?? '').match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? []
}

function expectProps(recorder, row, expected, label) {
  if (!row || row.visible !== true) {
    recorder.check(false, label, { reason: 'the element was not visible', row })
    return
  }
  const mismatches = []
  for (const [name, value] of Object.entries(expected)) {
    const actual = row.props?.[name]
    // Compare numbers when both sides are pixel values, otherwise strings.
    const same = numericParts(actual).length > 0 && numericParts(value).length > 0
      ? Math.abs(numericParts(actual)[0] - numericParts(value)[0]) < 0.05
      : actual === value
    if (!same) mismatches.push({ name, expected: value, actual })
  }
  recorder.check(mismatches.length === 0, label, { mismatches, text: row.text, selector: row.selector })
}

/** Error surfaces the walkthrough cannot reach, mounted to measure the cascade. */
const SYNTHETIC_SURFACES = [
  { key: 'web-source-errors', lookup: '.web-source-errors', html: '<div class="web-source-errors">来源读取失败</div>' },
  { key: 'plugin-list-error', lookup: '.plugin-list-error', html: '<span class="plugin-list-error">清单无效</span>' },
  { key: 'plugin-runtime-state-failed', lookup: '.plugin-runtime-state.failed', html: '<span class="plugin-runtime-state failed">启动失败</span>' },
  { key: 'runtime-event-notice-error', lookup: '.runtime-event-notice.error', html: '<div class="runtime-event-notice error">运行时事件失败</div>' },
  { key: 'composer-error', lookup: '.composer-error', html: '<div class="composer-error">运行时就绪检查失败</div>' },
  { key: 'activity-tool-error', lookup: '.activity-tool-error', html: '<span class="activity-tool-error">工具调用失败</span>' },
  { key: 'tool-live-err', lookup: '.tool-live-err', html: '<span class="tool-live-err">工具失败</span>' },
  { key: 'agent-transcript-attention', lookup: '.agent-transcript-attention', html: '<span class="agent-transcript-attention">需要处理</span>' },
  { key: 'project-creator-error', lookup: '.project-creator-error', html: '<div class="project-creator-error">创建失败</div>' },
]

/** Non-error role kept in the same sample so a muted surface cannot pass as danger. */
const SYNTHETIC_NEUTRAL = {
  key: 'dialog-hint',
  lookup: '.dialog-hint',
  html: '<div class="dialog-hint">空态样本</div>',
}

const SYNTHETIC_GEOMETRY = ['color', 'font-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']

function syntheticExpression() {
  const surfaces = [SYNTHETIC_NEUTRAL, ...SYNTHETIC_SURFACES]
  return `(() => {
    const surfaces = ${JSON.stringify(surfaces)};
    const host = document.querySelector('main.settings-workspace-body') || document.body;
    const container = document.createElement('div');
    container.id = 'ls-role-sample';
    container.setAttribute('data-acceptance-sample', 'synthetic');
    for (const surface of surfaces) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = surface.html;
      container.append(wrapper.firstElementChild);
    }
    host.append(container);
    const rows = surfaces.map((surface) => {
      const node = container.querySelector(surface.lookup);
      if (!node) return { key: surface.key, found: false };
      const style = getComputedStyle(node);
      const props = {};
      for (const name of ${JSON.stringify(SYNTHETIC_GEOMETRY)}) props[name] = style.getPropertyValue(name);
      return { key: surface.key, found: true, props };
    });
    container.remove();
    return rows;
  })()`
}

async function main() {
  await harness.assertBuildFresh()
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-shared-ui-roles-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshots = {}
  let handle
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    // Park the window outside every display and show it inactively. A hidden window never
    // advances CSS transitions, and some tones in this gate ARE transitions: measured, the
    // disabled plugin-reload control read opacity 1 (the from-frame) while `:disabled` matched and
    // the rule was in the stylesheet, with the transition still "running" and frozen at its start.
    await harness.desktopAction(locator, 'park-offscreen')
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
    if (!await evaluate(client, INSTALL_PROBE)) throw new Error('the role probe could not be installed')

    // --- 1. the role tokens and the theme the row has to preserve --------------
    const tokens = await evaluate(client, `(() => {
      const style = getComputedStyle(document.documentElement);
      const names = [
        '--feedback-danger-text', '--feedback-danger-border', '--danger-control-text',
        '--notice-padding-block', '--notice-padding-inline', '--notice-font-size',
        '--control-height-md', '--control-height-sm', '--control-font-size', '--control-font-size-strong',
        '--control-disabled-opacity', '--choice-disabled-opacity',
        '--radius-ui', '--radius-icon', '--motion-base',
        '--bg', '--bg-elevated', '--surface', '--surface-2', '--control', '--control-hover',
        '--border', '--border-strong', '--text', '--text-strong', '--muted', '--accent',
      ];
      const values = {};
      for (const name of names) values[name] = style.getPropertyValue(name).trim();
      return values;
    })()`)
    const expectedTokens = {
      '--feedback-danger-text': '#ffd2d2',
      '--danger-control-text': '#ffd8d8',
      '--notice-padding-block': '8px',
      '--notice-padding-inline': '10px',
      '--notice-font-size': '12px',
      '--control-height-md': '32px',
      '--control-height-sm': '26px',
      '--control-font-size': '12px',
      '--control-font-size-strong': '13px',
      '--control-disabled-opacity': DISABLED_OPACITY,
      '--choice-disabled-opacity': '0.58',
      '--radius-ui': '10px',
      '--radius-icon': '3px',
      '--motion-base': '180ms',
    }
    const tokenMismatches = Object.entries(expectedTokens)
      .filter(([name, value]) => tokens[name] !== value)
      .map(([name, value]) => ({ name, expected: value, actual: tokens[name] }))
    recorder.note({ step: 'role-tokens', tokens, tokenMismatches })
    recorder.check(tokenMismatches.length === 0, 'the role tokens carry the shared values', { tokenMismatches })
    const nonGrey = ['--bg', '--bg-elevated', '--surface', '--surface-2', '--control', '--control-hover', '--border', '--border-strong', '--text', '--text-strong', '--muted', '--accent']
      .filter((name) => {
        const hex = String(tokens[name] ?? '').replace('#', '')
        if (hex.length !== 6) return true
        const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
        return !(r === g && g === b)
      })
    recorder.check(nonGrey.length === 0, 'the surfaces and text keep the black-grey theme', { nonGrey })

    // --- 2. the provider dialog: one danger colour, one control scale ----------
    await openSettingsPage(client, '模型供应商')
    const openEditor = await clickVisible(client, '.provider-card .save-btn')
    recorder.check(openEditor.clicked, 'the provider edit entry is reachable', openEditor)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.provider-editor') ? true : null`),
      harness.startTimeoutMs,
      'the provider editor',
    )
    await delay(250)
    const editorControls = await measure(client, [
      { key: 'save', selector: '.provider-editor .save-btn', props: CONTROL_PROPS },
      { key: 'cancel', selector: '.provider-editor .dialog-footer .close-btn', props: CONTROL_PROPS },
      { key: 'dialog-close', selector: '.provider-editor .dialog-close', props: CONTROL_PROPS },
      { key: 'chip', selector: '.provider-editor .provider-chip', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'provider-editor-controls', rows: editorControls.rows })
    expectProps(recorder, editorControls.get('save'), {
      'min-height': '32px',
      'font-size': '13px',
      'border-top-left-radius': '10px',
    }, 'the dialog submit control uses the shared height, strong type scale and radius')
    expectProps(recorder, editorControls.get('cancel'), {
      'min-height': '32px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the dialog regular control uses the shared height, type scale and radius')
    expectProps(recorder, editorControls.get('dialog-close'), {
      height: '30px',
      'border-top-left-radius': '10px',
    }, 'the dialog close control keeps its documented 30px exception and the shared radius')

    // validation error: the real error path of the dialog
    await setInputValue(client, '.provider-editor .settings-inline-field input', 2, 'not-a-url')
    const dialogErrorText = await waitForVisible(client, '.provider-editor .dialog-error', 10_000, 'the dialog validation error')
    const dialogError = await measure(client, [
      { key: 'dialog-error', selector: '.provider-editor .dialog-error', props: ['color', 'font-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-top-color', 'border-left-width'] },
    ])
    recorder.note({ step: 'dialog-error', text: dialogErrorText, row: dialogError.get('dialog-error') })
    expectProps(recorder, dialogError.get('dialog-error'), { color: DANGER_TEXT }, 'the dialog error text uses the one danger colour')
    await setInputValue(client, '.provider-editor .settings-inline-field input', 2, provider.baseURL)

    // the danger control of the discard prompt
    await setInputValue(client, '.provider-editor .settings-inline-field input', 1, '角色验收草稿')
    await clickVisible(client, '.provider-editor .dialog-footer .close-btn')
    const discardText = await waitForVisible(client, '.provider-editor-discard', 10_000, 'the discard prompt')
    const discard = await measure(client, [
      { key: 'discard-danger', selector: '.provider-editor-discard .danger-btn', props: CONTROL_PROPS },
      { key: 'discard-keep', selector: '.provider-editor-discard .close-btn', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'discard-prompt', text: discardText, rows: discard.rows })
    expectProps(recorder, discard.get('discard-danger'), {
      'min-height': '32px',
      'font-size': '13px',
      color: DANGER_CONTROL_TEXT,
    }, 'the danger control keeps its brighter tone on the shared submit scale')
    expectProps(recorder, discard.get('discard-keep'), {
      'min-height': '32px',
      'font-size': '12px',
    }, 'the danger prompt pairs the danger control with a regular control of the same height')
    await clickVisible(client, '.provider-editor-discard .close-btn', { contains: '继续编辑' })
    await delay(200)

    // keyboard focus: one visible focus treatment for the shared controls
    const focusSamples = []
    const focusedField = await focusFirstEditorField(client)
    if (focusedField) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await pressTab(client)
        const probe = await readFocusTransition(client)
        if (!probe) break
        const duplicate = focusSamples.some((sample) => sample.marker.tag === probe.marker.tag
          && sample.marker.className === probe.marker.className
          && sample.marker.label === probe.marker.label)
        if (!duplicate) focusSamples.push(probe)
        if (focusSamples.filter((sample) => sample.marker.insideEditor && sample.changed.length > 0).length >= 2) break
      }
    }
    const insideSamples = focusSamples.filter((sample) => sample.marker.insideEditor)
    const visibleInside = insideSamples.filter((sample) => sample.changed.length > 0)
    const invisibleInside = insideSamples.filter((sample) => sample.changed.length === 0)
    screenshots['keyboard-focus'] = await writePng(client, 'keyboard-focus')
    recorder.note({
      step: 'keyboard-focus',
      startedFrom: focusedField,
      samples: focusSamples.map((sample) => ({
        marker: sample.marker,
        changed: sample.changed,
        outline: `${sample.focused.outlineWidth} ${sample.focused.outlineStyle} ${sample.focused.outlineColor}`,
        outlineOffset: sample.focused.outlineOffset,
      })),
    })
    recorder.check(
      visibleInside.length > 0,
      'keyboard focus inside the dialog is visible (outline or surface change)',
      { insideSamples },
    )
    recorder.check(
      invisibleInside.length === 0,
      'no sampled dialog control focuses without a visible change',
      { invisibleInside },
    )
    for (const sample of visibleInside) {
      const outlineVisible = sample.focused.outlineStyle === 'solid' && (numericParts(sample.focused.outlineWidth)[0] ?? 0) > 0
      const surfaceChange = sample.changed.some((name) => ['background', 'borderColor', 'color', 'boxShadow'].includes(name))
      recorder.check(
        outlineVisible || surfaceChange,
        `the focused ${sample.marker.label || sample.marker.className || sample.marker.tag} control states focus visibly`,
        { focused: sample.focused, changed: sample.changed, outlineVisible, surfaceChange },
      )
    }

    // disabled + waiting while the save is really in flight
    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/config/providers', 1800, 'POST'); return true })()`)
    await clickVisible(client, '.provider-editor .save-btn')
    await delay(400)
    const saving = await measure(client, [
      { key: 'save', selector: '.provider-editor .save-btn', props: CONTROL_PROPS },
      { key: 'cancel', selector: '.provider-editor .dialog-footer .close-btn', props: CONTROL_PROPS },
      { key: 'dialog-close', selector: '.provider-editor .dialog-close', props: CONTROL_PROPS },
      { key: 'status', selector: '.provider-editor-status', props: ['font-size', 'color'] },
    ])
    screenshots['provider-saving'] = await writePng(client, 'provider-saving')
    recorder.note({ step: 'provider-saving', rows: saving.rows })
    for (const key of ['save', 'cancel', 'dialog-close']) {
      const row = saving.get(key)
      recorder.check(
        row?.visible === true && row.disabled === true && row.props?.opacity === DISABLED_OPACITY,
        `the ${key} control dims with the shared disabled tone while saving`,
        { row },
      )
    }
    const statusText = saving.get('status')?.text ?? ''
    recorder.check(statusText.length > 0, 'the saving state is stated in text, not only in colour', { statusText })
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.provider-editor') ? null : true`),
      harness.startTimeoutMs,
      'the editor to close after the held save',
    )

    // --- 3. the plugin page: notice geometry, waiting, and the error surface ---
    await openSettingsPage(client, '插件')
    await waitForVisible(client, '.plugin-reload-button', 15_000, 'the plugin reload control')
    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/plugins/reload', 1800, 'POST'); return true })()`)
    const reloadStart = await clickVisible(client, '.plugin-reload-button')
    await delay(350)
    const pluginWaiting = await measure(client, [
      { key: 'reload', selector: '.plugin-reload-button', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'plugin-reload-waiting', clicked: reloadStart, row: pluginWaiting.get('reload') })
    expectProps(recorder, pluginWaiting.get('reload'), {
      opacity: DISABLED_OPACITY,
      'min-height': '32px',
      'font-size': '12px',
    }, 'the plugin reload control dims with the shared disabled tone on the shared regular control role')
    recorder.check(
      pluginWaiting.get('reload')?.disabled === true && (pluginWaiting.get('reload')?.text ?? '').includes('加载中'),
      'the plugin reload states the waiting result on the control',
      { row: pluginWaiting.get('reload') },
    )
    const pluginNoticeText = await waitForVisible(client, '.plugin-page-notice', harness.startTimeoutMs, 'the plugin success notice')
    const pluginNotice = await measure(client, [
      { key: 'notice', selector: '.plugin-page-notice', props: [...Object.keys(NOTICE_GEOMETRY), 'color', 'border-left-width', 'border-left-color', 'animation-name', 'animation-duration'] },
    ])
    screenshots['plugin-notice'] = await writePng(client, 'plugin-notice')
    recorder.note({ step: 'plugin-notice', text: pluginNoticeText, row: pluginNotice.get('notice') })
    expectProps(recorder, pluginNotice.get('notice'), NOTICE_GEOMETRY, 'the plugin notice uses the shared inline notice geometry (7px 9px / 11px before UX-14)')

    await evaluate(client, `(() => { window.__lsRoleProbe.failNext('/plugins/reload', 'POST'); return true })()`)
    await clickVisible(client, '.plugin-reload-button')
    const pluginErrorText = await waitForVisible(client, '.plugin-page-error', harness.startTimeoutMs, 'the plugin error notice')
    const pluginError = await measure(client, [
      { key: 'error', selector: '.plugin-page-error', props: [...Object.keys(NOTICE_GEOMETRY), 'color', 'border-left-width', 'border-left-color'] },
      { key: 'action', selector: '.plugin-page-error .feedback-action', props: CONTROL_PROPS },
    ])
    screenshots['plugin-error'] = await writePng(client, 'plugin-error')
    recorder.note({ step: 'plugin-error', text: pluginErrorText, rows: pluginError.rows })
    expectProps(recorder, pluginError.get('error'), { ...NOTICE_GEOMETRY, color: DANGER_TEXT }, 'the plugin error notice uses the shared notice geometry and danger colour')
    expectProps(recorder, pluginError.get('action'), {
      'min-height': '26px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the inline notice action uses the shared small control role')

    // While an operation is in flight the notice stays, and its action plus the
    // row controls answer the shared disabled tone.
    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/enabled', 1800, 'POST'); return true })()`)
    const toggle = await clickVisible(client, '.plugin-list-item .plugin-switch')
    await delay(350)
    const pluginBusy = await measure(client, [
      { key: 'action', selector: '.plugin-page-error .feedback-action', props: CONTROL_PROPS },
      { key: 'switch', selector: '.plugin-list-item .plugin-switch', props: CONTROL_PROPS },
      { key: 'reload', selector: '.plugin-reload-button', props: CONTROL_PROPS },
    ])
    screenshots['plugin-busy'] = await writePng(client, 'plugin-busy')
    recorder.note({ step: 'plugin-busy', toggle, rows: pluginBusy.rows })
    for (const key of ['action', 'switch', 'reload']) {
      const row = pluginBusy.get(key)
      recorder.check(
        row?.visible === true && row.disabled === true && row.props?.opacity === DISABLED_OPACITY,
        `the plugin ${key} control dims with the shared disabled tone while the operation is in flight`,
        { row },
      )
    }
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.plugin-list-item .plugin-switch')?.disabled === false ? true : null`),
      harness.startTimeoutMs,
      'the plugin operation to settle',
    )

    // --- 4. the channels page: failure detail, waiting, retry action -----------
    await openSettingsPage(client, '外部渠道')
    const failureText = await waitForVisible(client, '.channel-row.failure .channel-name small', harness.startTimeoutMs, 'the channel failure detail')
    const channels = await measure(client, [
      { key: 'failure', selector: '.channel-row.failure .channel-name small', props: ['color', 'font-size'] },
      { key: 'refresh', selector: '.channel-overall .refresh-btn', props: CONTROL_PROPS },
      { key: 'reload', selector: '.channel-overall .reload-btn', props: CONTROL_PROPS },
    ])
    screenshots['channels'] = await writePng(client, 'channels')
    recorder.note({ step: 'channels-roles', failureText, rows: channels.rows })
    expectProps(recorder, channels.get('failure'), { color: DANGER_TEXT }, 'the channel failure detail uses the one danger colour')
    expectProps(recorder, channels.get('refresh'), {
      'min-height': '32px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the refresh control uses the shared regular control role')
    expectProps(recorder, channels.get('reload'), {
      'min-height': '32px',
      'font-size': '13px',
      'border-top-left-radius': '10px',
    }, 'the reload control uses the shared submit control role')

    await evaluate(client, `(() => { window.__lsRoleProbe.failNext('/channels/reload', 'POST'); return true })()`)
    await clickVisible(client, '.channel-overall .reload-btn')
    const channelErrorText = await waitForVisible(client, '.dialog .feedback-notice[data-tone="error"]', harness.startTimeoutMs, 'the channel reload failure')
    const channelError = await measure(client, [
      { key: 'notice', selector: '.dialog .feedback-notice[data-tone="error"]', props: [...Object.keys(NOTICE_GEOMETRY), 'color'] },
      { key: 'action', selector: '.dialog .feedback-notice[data-tone="error"] .feedback-action', props: CONTROL_PROPS },
    ])
    screenshots['channel-error'] = await writePng(client, 'channel-error')
    recorder.note({ step: 'channel-error', text: channelErrorText, rows: channelError.rows })
    expectProps(recorder, channelError.get('notice'), { color: DANGER_TEXT }, 'the channel failure notice uses the one danger colour')
    expectProps(recorder, channelError.get('action'), {
      'min-height': '26px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the channel failure offers its retry through the shared small control role')

    // A reload that is really in flight blocks the row instead of leaving it clickable.
    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/channels/reload', 1800, 'POST'); return true })()`)
    const retry = await clickVisible(client, '.dialog .feedback-notice[data-tone="error"] .feedback-action')
    await delay(350)
    const channelBusy = await measure(client, [
      { key: 'refresh', selector: '.channel-overall .refresh-btn', props: CONTROL_PROPS },
      { key: 'reload', selector: '.channel-overall .reload-btn', props: CONTROL_PROPS },
    ])
    screenshots['channels-busy'] = await writePng(client, 'channels-busy')
    recorder.note({ step: 'channels-busy', retry, rows: channelBusy.rows })
    for (const key of ['refresh', 'reload']) {
      const row = channelBusy.get(key)
      recorder.check(
        row?.visible === true && row.disabled === true && row.props?.opacity === DISABLED_OPACITY,
        `the ${key} control dims with the shared disabled tone while the reload is in flight`,
        { row },
      )
    }
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.channel-overall .reload-btn')?.disabled === false ? true : null`),
      harness.startTimeoutMs,
      'the channel reload to settle',
    )

    // --- 5. the browser storage page: real success and failure notices ---------
    await openSettingsPage(client, '内置浏览器')
    await waitForVisible(client, '.storage-settings-row button', 15_000, 'the storage action buttons')
    const storageControls = await measure(client, [
      { key: 'row-button', selector: '.storage-settings-row button', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'storage-controls', rows: storageControls.rows })
    expectProps(recorder, storageControls.get('row-button'), {
      'min-height': '30px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the storage row action uses the shared compact row role')
    await clickVisible(client, '.storage-settings-row button', { contains: '清除缓存' })
    const storageNoticeText = await waitForVisible(client, '.storage-settings-notice:not([data-tone])', harness.startTimeoutMs, 'the storage success notice')
    const storageNotice = await measure(client, [
      { key: 'notice', selector: '.storage-settings-notice:not([data-tone])', props: [...Object.keys(NOTICE_GEOMETRY), 'color'] },
    ])
    recorder.note({ step: 'storage-notice', text: storageNoticeText, row: storageNotice.get('notice') })
    expectProps(recorder, storageNotice.get('notice'), NOTICE_GEOMETRY, 'the storage notice uses the shared inline notice geometry')

    await evaluate(client, `(() => { window.__lsRoleProbe.failNext('/browser/clear-cache', 'POST'); return true })()`)
    await clickVisible(client, '.storage-settings-row button', { contains: '清除缓存' })
    const storageErrorText = await waitForVisible(client, '.storage-settings-notice[data-tone="error"]', harness.startTimeoutMs, 'the storage error notice')
    const storageError = await measure(client, [
      { key: 'error', selector: '.storage-settings-notice[data-tone="error"]', props: [...Object.keys(NOTICE_GEOMETRY), 'color', 'border-left-width'] },
    ])
    screenshots['storage-error'] = await writePng(client, 'storage-error')
    recorder.note({ step: 'storage-error', text: storageErrorText, row: storageError.get('error') })
    expectProps(recorder, storageError.get('error'), { ...NOTICE_GEOMETRY, color: DANGER_TEXT }, 'the storage error notice uses the shared geometry and danger colour (#e8c5bd before UX-14)')

    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/browser/clear-data', 1800, 'POST'); return true })()`)
    await clickVisible(client, '.storage-settings-row button', { contains: '清除网站数据' })
    await delay(350)
    const storageBusy = await measure(client, [
      { key: 'busy', selector: '.storage-settings-row button', props: CONTROL_PROPS, index: 1 },
    ])
    recorder.note({ step: 'storage-busy', row: storageBusy.get('busy') })
    recorder.check(
      storageBusy.get('busy')?.disabled === true && storageBusy.get('busy')?.props?.opacity === DISABLED_OPACITY,
      'the storage action dims with the shared disabled tone while it is working',
      { row: storageBusy.get('busy') },
    )
    await delay(2000)

    // --- 6. the web retrieval page: the error notice colour --------------------
    await openSettingsPage(client, '网络检索')
    await waitForVisible(client, '.web-cache-clear', 15_000, 'the web cache control')
    await evaluate(client, `(() => { window.__lsRoleProbe.failNext('/runtime/web/cache', 'DELETE'); return true })()`)
    await clickVisible(client, '.web-cache-clear')
    const webErrorText = await waitForVisible(client, '.web-settings-notice.error', harness.startTimeoutMs, 'the web settings error notice')
    const webError = await measure(client, [
      { key: 'error', selector: '.web-settings-notice.error', props: ['color', 'font-size'] },
    ])
    recorder.note({ step: 'web-error', text: webErrorText, row: webError.get('error') })
    expectProps(recorder, webError.get('error'), { color: DANGER_TEXT }, 'the web settings error notice uses the one danger colour (#f2b6b6 before UX-14)')

    // --- 7. the archive page: loading state and error surface ------------------
    await evaluate(client, `(() => { window.__lsRoleProbe.holdNext('/archive', 1800, 'GET'); return true })()`)
    await openSettingsPage(client, '归档')
    await delay(300)
    const archiveLoading = await measure(client, [
      { key: 'refresh', selector: '.archive-refresh', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'archive-loading', row: archiveLoading.get('refresh') })
    expectProps(recorder, archiveLoading.get('refresh'), {
      opacity: DISABLED_OPACITY,
      'min-height': '32px',
    }, 'the archive refresh control dims with the shared disabled tone on the shared regular control role')
    await waitForVisible(client, '.archive-refresh', harness.startTimeoutMs, 'the archive page to settle')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.archive-refresh')?.disabled === false ? true : null`),
      harness.startTimeoutMs,
      'the archive load to finish',
    )
    await delay(400)
    await evaluate(client, `(() => { window.__lsRoleProbe.failNext('/archive', 'GET'); return true })()`)
    await clickVisible(client, '.archive-refresh')
    const archiveErrorText = await waitForVisible(client, '.archive-error', harness.startTimeoutMs, 'the archive error surface')
    const archiveError = await measure(client, [
      { key: 'error', selector: '.archive-error', props: [...Object.keys(NOTICE_GEOMETRY), 'color'] },
    ])
    screenshots['archive-error'] = await writePng(client, 'archive-error')
    recorder.note({ step: 'archive-error', text: archiveErrorText, row: archiveError.get('error') })
    expectProps(recorder, archiveError.get('error'), { ...NOTICE_GEOMETRY, color: DANGER_TEXT }, 'the archive error surface uses the shared notice geometry and danger colour')

    // --- 8. reduced motion still wins over the shared transitions --------------
    const motionSamples = [
      { key: 'archive-refresh', selector: '.archive-refresh', props: ['transition-duration', 'animation-duration', 'animation-name'] },
      { key: 'archive-empty', selector: '.archive-empty-state', props: ['transition-duration', 'animation-duration', 'animation-name'] },
      { key: 'settings-nav', selector: '.settings-nav-item.active', props: ['transition-duration', 'animation-duration', 'animation-name'] },
      { key: 'archive-error', selector: '.archive-error', props: ['transition-duration', 'animation-duration', 'animation-name'] },
    ]
    const motionBefore = await measure(client, motionSamples)
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await delay(200)
    const motionAfter = await measure(client, motionSamples)
    await client.send('Emulation.setEmulatedMedia', { features: [] })
    const motionRows = motionAfter.rows.filter((row) => row.visible === true)
    const motionViolations = motionRows.filter((row) => {
      const durations = [row.props?.['transition-duration'], row.props?.['animation-duration']]
        .flatMap((value) => String(value ?? '').split(','))
        .map((value) => numericParts(value)[0] ?? 0)
      return durations.some((value) => value > 0.002)
    })
    recorder.note({ step: 'reduced-motion', before: motionBefore.rows, after: motionAfter.rows })
    recorder.check(
      motionRows.length > 0 && motionViolations.length === 0,
      'reduced motion collapses the shared transitions and animations to the 1ms floor',
      { motionViolations, after: motionAfter.rows },
    )
    const declaredMotion = motionBefore.rows.some((row) => (numericParts(row.props?.['transition-duration'])[0] ?? 0) > 0.05)
    recorder.check(declaredMotion, 'at least one sampled surface declares a real transition before the reduction', { before: motionBefore.rows })

    // --- 9. the remaining settings action roles -------------------------------
    await openSettingsPage(client, '开发环境')
    await waitForVisible(client, '.development-environments-refresh', 15_000, 'the development environment refresh control')
    const otherRoles = await measure(client, [
      { key: 'development-refresh', selector: '.development-environments-refresh', props: CONTROL_PROPS },
    ])
    recorder.note({ step: 'development-refresh', rows: otherRoles.rows })
    expectProps(recorder, otherRoles.get('development-refresh'), {
      'min-height': '32px',
      'font-size': '12px',
    }, 'the development environment refresh control uses the shared page header action role')

    await openSettingsPage(client, 'Agent 行为')
    await clickVisible(client, 'details.settings-advanced > summary')
    await delay(250)
    const policyRows = await measure(client, [
      { key: 'policy-button', selector: '.settings-policy-row button', props: CONTROL_PROPS },
    ])
    screenshots['policy-row'] = await writePng(client, 'policy-row')
    recorder.note({ step: 'policy-row', rows: policyRows.rows })
    expectProps(recorder, policyRows.get('policy-button'), {
      'min-height': '30px',
      'font-size': '12px',
      'border-top-left-radius': '10px',
    }, 'the policy row action uses the shared compact row role (29px before UX-14)')
    const policyRow = policyRows.get('policy-button')
    if (policyRow?.disabled === true) {
      recorder.check(
        policyRow.props?.opacity === DISABLED_OPACITY,
        'the disabled policy row action uses the shared disabled tone',
        { row: policyRow },
      )
    } else {
      recorder.note({ step: 'policy-row-note', note: 'the policy row action was enabled in this fixture, so its disabled tone is only covered by the source test' })
    }
    await clickVisible(client, 'details.settings-advanced > summary')

    // --- 10. the surfaces this fixture cannot reach (synthetic mount) ----------
    const syntheticRows = await evaluate(client, syntheticExpression())
    const errorRows = syntheticRows.filter((row) => row.key !== SYNTHETIC_NEUTRAL.key)
    const neutralRow = syntheticRows.find((row) => row.key === SYNTHETIC_NEUTRAL.key) ?? null
    const syntheticMismatches = errorRows
      .filter((row) => row.found !== true || row.props?.color !== DANGER_TEXT)
      .map((row) => ({ key: row.key, color: row.props?.color ?? null }))
    recorder.note({
      step: 'synthetic-error-surfaces',
      rows: syntheticRows,
      note: 'mounted inside the live settings page to measure the shipped cascade; not a product walkthrough',
    })
    recorder.check(
      syntheticMismatches.length === 0,
      'every declared error surface resolves to the one danger colour through the live stylesheet',
      { syntheticMismatches, rows: errorRows.map((row) => ({ key: row.key, color: row.props?.color ?? null })) },
    )
    recorder.check(
      neutralRow !== null && neutralRow.props?.color !== DANGER_TEXT,
      'the neutral sample stays muted, so "danger everywhere" cannot pass this check',
      { neutralRow },
    )
    const syntheticGeometry = errorRows.find((row) => row.key === 'project-creator-error')?.props ?? null
    recorder.check(
      syntheticGeometry !== null
      && syntheticGeometry.color === DANGER_TEXT
      && Object.entries(NOTICE_GEOMETRY).every(([name, value]) => syntheticGeometry[name] === value),
      'the project creator error surface shares the notice geometry and danger colour',
      { syntheticGeometry },
    )

    screenshots['final'] = await writePng(client, 'settings-final')
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
    check: 'shared-ui-roles',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keepRoot ? root : '<temporary root removed>',
    screenshots,
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The waiting and failure states are produced by holding or failing one local-app-api request in the page (an injected transport fault); the views, their markup and their styles are the real ones.',
      'Synthetic entries in step 8 mount the real class names inside the live settings page to measure the shipped stylesheet. They are not a product walkthrough and are labelled in the observations.',
      'Animated elements are sampled on the settings pages this walkthrough visits; other pages keep their own motion declarations.',
      'Dense row, toolbar, tree and picker roles (sidebar navigation, workspace tree and browser toolbar, chat history, composer pickers) keep their own disabled opacity and are out of scope for this round; ui/README.md records them.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
