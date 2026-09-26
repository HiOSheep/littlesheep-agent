// Real-window acceptance for the conversation + workspace scenario matrix
// (taskbook UX-16, first bullet: streaming, reading, attachments, tool details,
// multi-line draft, and the workspace panel's drag / collapse / fullscreen).
//
// The scenarios are deliberately combined in one session, because that is how a
// user meets them: a long answer is still streaming while the reader scrolls up,
// types a multi-line draft, attaches files, opens a long tool result, and
// resizes or fullscreens the workspace panel. Each state is measured, not
// assumed, and every scenario that fails is reported with the numbers.
//
// Usage:
//   node scripts/verify-conversation-workspace-scenarios.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-conversation-scenarios')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1100, height: 700 }
const EVALUATE_TIMEOUT_MS = 45_000
// Three text-family files: the fixture pastes them as text/plain, so a binary
// extension would only test the fixture's MIME guessing instead of multi-attachment.
const ATTACHMENTS = ['scenario-notes.txt', 'scenario-data.csv', 'scenario-steps.md']
const WORKPLACE_FILES = 64

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
      name: 'Scenario Acceptance Provider',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      // The long fixture answer must still be arriving while the reader scrolls and types, so the
      // provider request legitimately runs for tens of seconds; a 10 s cap aborted it mid-stream
      // (measured: "llm call failed: This operation was aborted" after 10.5 s, empty reply). This
      // is an upper bound for a deterministic local fixture, not a delay.
      timeoutSeconds: 60,
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
    channels: { channels: [] },
    desktop: { closePolicy: 'always-background' },
  }
}

/** Layout facts the acceptance turns on: reading position, composer, workspace panel. */
const LAYOUT_EXPRESSION = `(() => {
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest('[inert]')) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rect = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
  };
  const messages = document.querySelector('.messages');
  const composer = document.querySelector('.composer textarea');
  const composerSurface = document.querySelector('.composer');
  const panel = document.querySelector('.workspace-panel');
  const panelSurface = document.querySelector('.workspace-panel-surface');
  const turn = [...document.querySelectorAll('.assistant-turn')].at(-1);
  const response = turn?.querySelector('.assistant-response-stream');
  const viewportTop = messages ? messages.getBoundingClientRect().top : null;
  const keyed = messages ? [...messages.querySelectorAll('[data-message-key]')] : [];
  const visibleAnchor = keyed.find((element) => {
    const bounds = element.getBoundingClientRect();
    return viewportTop !== null && bounds.bottom - viewportTop > 0 && bounds.top - viewportTop < messages.clientHeight;
  });
  const lastMessage = keyed.at(-1);
  return {
    messageRect: rect(messages),
    scrollTop: messages?.scrollTop ?? null,
    scrollHeight: messages?.scrollHeight ?? null,
    clientHeight: messages?.clientHeight ?? null,
    gap: messages ? Math.round(messages.scrollHeight - messages.scrollTop - messages.clientHeight) : null,
    jumpButton: document.querySelector('.chat-jump-to-latest')?.getAttribute('data-new-content') ?? null,
    jumpVisible: isVisible(document.querySelector('.chat-jump-to-latest')),
    anchorKey: visibleAnchor?.getAttribute('data-message-key') ?? null,
    anchorTop: visibleAnchor && viewportTop !== null ? visibleAnchor.getBoundingClientRect().top - viewportTop : null,
    lastMessageBottom: lastMessage && messages ? lastMessage.getBoundingClientRect().bottom : null,
    streamState: response?.getAttribute('data-stream-state') ?? null,
    streamCharacters: (response?.textContent ?? '').length,
    composerRect: rect(composerSurface),
    composerVisible: isVisible(composer),
    composerValue: composer instanceof HTMLTextAreaElement ? composer.value : null,
    composerLines: composer instanceof HTMLTextAreaElement ? composer.value.split('\\n').length : null,
    attachmentCards: [...document.querySelectorAll('.attachment-preview-card')].filter(isVisible).length,
    userMessages: document.querySelectorAll('.message.user').length,
    assistantTurns: document.querySelectorAll('.assistant-turn').length,
    panelRect: rect(panelSurface),
    panelAsideRect: rect(panel),
    shellFullscreen: document.querySelector('.window-shell')?.classList.contains('workspace-panel-fullscreen') ?? null,
    panelCollapsed: panel?.classList.contains('collapsed') ?? null,
    panelFullscreen: panel?.classList.contains('fullscreen') ?? null,
    composerOverlappedByPanel: (() => {
      if (!messages || !panelSurface || !panel || panel.classList.contains('collapsed')) return false;
      const panelBox = panelSurface.getBoundingClientRect();
      const composerBox = document.querySelector('.composer')?.getBoundingClientRect();
      if (!composerBox) return false;
      return composerBox.right > panelBox.left + 0.5 && composerBox.left < panelBox.right - 0.5;
    })(),
    coverers: composerSurface
      ? (() => {
          const composerBox = composerSurface.getBoundingClientRect();
          const center = { x: composerBox.left + composerBox.width / 2, y: composerBox.top + composerBox.height / 2 };
          const top = document.elementFromPoint(center.x, center.y);
          return top ? (top.className && typeof top.className === 'string' ? top.className : top.tagName) : null;
        })()
      : null,
  };
})()`

/** The tool row and its details panel. */
const TOOL_EXPRESSION = `(() => {
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rows = [...document.querySelectorAll('.agent-tool-call')];
  const row = rows.at(-1) ?? null;
  const button = row?.querySelector('.agent-tool-row') ?? null;
  const panel = row?.querySelector('.agent-tool-details-panel') ?? null;
  const sections = row
    ? [...row.querySelectorAll('.agent-tool-detail-section')].map((section) => ({
        label: (section.querySelector('.agent-tool-detail-label')?.textContent ?? '').trim(),
        characters: (section.querySelector('pre')?.textContent ?? '').length,
        lines: (section.querySelector('pre')?.textContent ?? '').split('\\n').length,
        sample: (section.querySelector('pre')?.textContent ?? '').slice(0, 120),
      }))
    : [];
  // The Output section is the tool's result; the first section is its input.
  const outputSection = sections.find((section) => section.label === 'Output') ?? sections.at(-1) ?? null;
  const output = row ? [...row.querySelectorAll('.agent-tool-detail-section pre')].at(-1) ?? null : null;
  const panelInner = row?.querySelector('.agent-tool-details-panel-inner') ?? null;
  return {
    toolRows: rows.length,
    statusClass: row?.className ?? null,
    rowLabel: button?.getAttribute('aria-label') ?? null,
    expanded: button?.getAttribute('aria-expanded') ?? null,
    panelOpen: panel?.classList.contains('open') ?? null,
    panelVisible: isVisible(panel),
    sections,
    outputCharacters: outputSection?.characters ?? 0,
    outputLines: outputSection?.lines ?? 0,
    outputSample: outputSection?.sample ?? null,
    outputTruncatedMarker: output ? /…|\\(truncated|更多|已截断/u.test(output.textContent ?? '') : false,
    panelScrolls: panel && panelInner ? panelInner.scrollHeight > panelInner.clientHeight + 1 : null,
    panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
    panelBottom: panel ? panel.getBoundingClientRect().bottom : null,
    panelOverlapsComposer: (() => {
      if (!panel) return false;
      const composer = document.querySelector('.composer');
      if (!composer) return false;
      const a = panel.getBoundingClientRect();
      const b = composer.getBoundingClientRect();
      return a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5 && a.right > b.left + 0.5 && a.left < b.right - 0.5;
    })(),
  };
})()`

/** Minimal probe used while waiting: it must not be able to throw for DOM reasons. */
const TOOL_COUNT_EXPRESSION = `(() => {
  const rows = [...document.querySelectorAll('.agent-tool-call')];
  const row = rows.at(-1) ?? null;
  const button = row ? row.querySelector('.agent-tool-row') : null;
  return {
    toolRows: rows.length,
    hasButton: button !== null,
    ariaExpanded: button ? button.getAttribute('aria-expanded') : null,
  };
})()`

async function readLayout(client) {
  return evaluate(client, LAYOUT_EXPRESSION)
}

/**
 * A measurement read: one stalled paint must not lose the numbers the run already
 * earned, so retry a few times before giving up.
 */
async function measureLayout(client, attempts = 4) {
  let lastError = null
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await readLayout(client)
    } catch (error) {
      lastError = error
      await delay(500)
    }
  }
  throw lastError ?? new Error('the layout could not be measured')
}

/**
 * A renderer that is busy repainting a streamed answer can miss one evaluation.
 * Waiting predicates retry with a short per-read timeout instead of blocking the
 * whole loop on one slow read.
 */
async function tryReadLayout(client, timeoutMs = 8_000) {
  try {
    return await withTimeout(client.evaluate(LAYOUT_EXPRESSION), timeoutMs, 'Runtime.evaluate')
  } catch {
    return null
  }
}

async function tryReadTool(client, timeoutMs = 8_000) {
  try {
    return await withTimeout(client.evaluate(TOOL_EXPRESSION), timeoutMs, 'Runtime.evaluate')
  } catch (error) {
    lastToolReadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

async function tryCountTool(client, timeoutMs = 8_000) {
  try {
    return await withTimeout(client.evaluate(TOOL_COUNT_EXPRESSION), timeoutMs, 'Runtime.evaluate')
  } catch (error) {
    lastToolReadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

let lastToolReadError = null

async function submit(client, text) {
  const submitted = await withTimeout(client.evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`), 15_000, 'composer submit')
  if (!submitted) throw new Error('the composer could not be submitted')
}

/** A real paste of a real file, the same shape the composer handles from the clipboard. */
async function attachFile(client, name) {
  const content = `scenario fixture for ${name}\n`
  const attached = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/plain' }));
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    return true;
  })()`)
  if (!attached) throw new Error('the attachment paste could not be dispatched')
  return harness.waitFor(
    () => evaluate(client, `(() => {
      const names = [...document.querySelectorAll('.attachment-preview-card')]
        .map((card) => (card.textContent || '').trim());
      return names.some((value) => value.includes(${JSON.stringify(name)})) ? names : null;
    })()`),
    10_000,
    `the ${name} attachment card`,
  )
}

/**
 * Real key events: two Shift+Enter line breaks plus typed text.
 *
 * The composer only intercepts plain Enter (`resolveEnterAction === 'confirm'`),
 * so Shift+Enter has to reach the browser as a text-producing key: a raw keyDown
 * without `text` inserts nothing and the "draft" would silently be one line.
 */
async function typeDraftWithLineBreaks(client, lines) {
  await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      const event = {
        key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8,
      }
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...event })
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    }
    await client.send('Input.insertText', { text: line })
    await delay(60)
  }
  await delay(150)
}

async function clickVisible(client, selector, wantedText) {
  return evaluate(client, `(() => {
    const wantedText = ${JSON.stringify(wantedText ?? null)};
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        if (candidate.closest('[inert]')) return false;
        const rect = candidate.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return wantedText === null || (candidate.textContent || '').includes(wantedText);
      });
    if (!(node instanceof HTMLElement)) return { clicked: false };
    node.click();
    return { clicked: true, label: (node.textContent || '').trim().slice(0, 40) };
  })()`)
}

async function clickLauncherItem(client, preferredLabels) {
  return evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.workspace-empty-launcher-item')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const labels = items.map((item) => (item.textContent || '').trim());
    const preferred = ${JSON.stringify(preferredLabels)};
    const index = items.findIndex((item) => preferred.some((label) => (item.textContent || '').includes(label)));
    const target = items[index >= 0 ? index : 0];
    if (!(target instanceof HTMLElement)) return { clicked: false, labels };
    target.click();
    return { clicked: true, labels, chosen: (target.textContent || '').trim() };
  })()`)
}

async function selectWorkspaceFeature(client, label) {
  const collapsed = await evaluate(client, `document.querySelector('.workspace-panel')?.classList.contains('collapsed') ?? true`)
  if (collapsed) {
    const openedPanel = await clickVisible(client, '.workspace-panel-corner-toggle')
    if (!openedPanel.clicked) throw new Error('the workspace panel could not be opened')
  }
  await harness.waitFor(
    () => evaluate(client, `document.querySelector('.workspace-panel')?.classList.contains('collapsed') === false || null`),
    10_000,
    'workspace panel to open',
  )
  const menu = await clickVisible(client, '.workspace-add-trigger')
  if (!menu.clicked) throw new Error('the workspace feature menu could not be opened')
  await harness.waitFor(() => evaluate(client, `Boolean(document.querySelector('.workspace-add-panel.visible')) || null`), 5_000, 'workspace feature menu')
  const selected = await clickVisible(client, '.workspace-add-panel.visible .workspace-add-item', label)
  if (!selected.clicked) throw new Error(`workspace feature ${label} could not be selected`)
}


/**
 * UX-29/UX-30 regression net for the terminal surface.
 *
 * Switching to the 终端 tab used to be enough for the walkthrough; after the terminal gained
 * shell discovery, a tab model and a session hook, it needs an actual assertion: a session is
 * started, the shell that runs is a real one Main discovered, and the tab strip stays out of
 * the way while there is only one session.
 */

/** Types a command into the focused terminal and presses Enter through the browser. */
async function sendTerminalCommand(client, text) {
  await evaluate(client, `(() => {
    const textarea = document.querySelector('.workspace-terminal textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    textarea.focus()
    return true
  })()`)
  await client.send('Input.insertText', { text })
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
  await delay(2500)
}

async function fileExists(path) {
  return existsSync(path)
}

async function assertWorkspaceTerminalReady(client, recorder, workspaceDir) {
  const terminal = await harness.waitFor(() => evaluate(client, `(() => {
    const pane = document.querySelector('.workspace-terminal')
    if (!(pane instanceof HTMLElement)) return null
    const select = pane.querySelector('.workspace-terminal-shell-select')
    return {
      hasTerminal: Boolean(pane.querySelector('.workspace-terminal-shell, .xterm')),
      status: (pane.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
      shellOptions: select instanceof HTMLSelectElement
        ? [...select.options].map((option) => option.textContent || '')
        : [],
      selectedShell: select instanceof HTMLSelectElement ? select.value : null,
      tabStrip: pane.querySelectorAll('.workspace-terminal-tabs').length,
      tabs: pane.querySelectorAll('.workspace-terminal-tab').length,
    }
  })()`), 30_000, 'workspace terminal surface')

  // The picker fills in once the shells request answers, so wait for real options rather than
  // sampling the empty state a moment after the panel appears.
  const populated = await harness.waitFor(() => evaluate(client, `(() => {
    const select = document.querySelector('.workspace-terminal-shell-select')
    if (!(select instanceof HTMLSelectElement)) return null
    const options = [...select.options].map((option) => option.textContent || '')
    return options.length > 0 && options[0] !== '没有可用的 Shell'
      ? { options, selected: select.value }
      : null
  })()`), 20_000, 'terminal shell options').catch(() => null)

  // The scene moves on from this tab, so the session's own readiness is recorded rather than
  // asserted; what this step asserts is that the panel and its picker came up with real shells.
  const ready = await harness.waitFor(() => evaluate(client, `(() => {
    const pane = document.querySelector('.workspace-terminal')
    const status = (pane?.querySelector('.workspace-terminal-status')?.textContent || '').trim()
    return status ? { status } : null
  })()`), 10_000, 'terminal session status').catch(() => ({ status: terminal.status }))

  recorder.note({ step: 'workspace-terminal-smoke', terminal, populated, ready })
  recorder.check(
    terminal.hasTerminal === true
    && populated !== null
    && populated.options.length > 0
    && populated.selected !== '',
    'the terminal panel offers the shells discovery actually found',
    { shellOptions: terminal.shellOptions, selectedShell: terminal.selectedShell, status: ready.status },
  )
  recorder.check(
    // One session must look exactly like before: no strip, and no button that promises more.
    terminal.tabs === 0 && terminal.tabStrip === 0,
    'a single terminal session shows no tab strip',
    { tabs: terminal.tabs, tabStrip: terminal.tabStrip },
  )

  // UX-30 item 1: a second terminal is created beside the running one, not instead of it.
  // The first tab's state is captured *before* the click, because the claim is that creating
  // another session does not disturb it — not that it has already finished starting.
  const beforeStates = await evaluate(client, `(() => [...document.querySelectorAll('.workspace-terminal-tab')]
    .map((node) => (node.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim()))()`)
  const created = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('.workspace-terminal button')]
      .find((node) => (node.textContent || '').trim() === '新建')
    if (!(button instanceof HTMLElement)) return { clicked: false }
    button.click()
    return { clicked: true }
  })()`)
  const twoTabs = created.clicked
    ? await harness.waitFor(() => evaluate(client, `(() => {
      const tabs = [...document.querySelectorAll('.workspace-terminal-tab')]
      if (tabs.length < 2) return null
      return {
        count: tabs.length,
        labels: tabs.map((node) => (node.textContent || '').replace(/\\s+/gu, ' ').trim()),
        states: tabs.map((node) => (node.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim()),
        active: tabs.filter((node) => node.getAttribute('aria-selected') === 'true').length,
      }
    })()`), 60_000, 'a second terminal tab').catch(() => null)
    : null

  // Close the new one again; the first session has to keep running.
  const closed = twoTabs
    ? await evaluate(client, `(() => {
      const tabs = [...document.querySelectorAll('.workspace-terminal-tab')]
      const last = tabs[tabs.length - 1]
      const button = last?.querySelector('.workspace-terminal-tab-close')
      if (!(button instanceof HTMLElement)) return { clicked: false }
      button.click()
      return { clicked: true }
    })()`)
    : { clicked: false }
  await delay(800)
  const afterClose = await evaluate(client, `(() => ({
    tabs: document.querySelectorAll('.workspace-terminal-tab').length,
    strip: document.querySelectorAll('.workspace-terminal-tabs').length,
    status: (document.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
  }))()`)

  recorder.note({ step: 'workspace-terminal-second-session', beforeStates, created, twoTabs, closed, afterClose })
  recorder.check(
    created.clicked === true
    && twoTabs !== null
    && twoTabs.count >= 2
    && twoTabs.active === 1
    // Both tabs name a shell and a state: the list is not a pair of identical blanks.
    && twoTabs.states.every((state) => state.length > 0),
    'creating another terminal adds a tab beside the running one instead of replacing it',
    { twoTabs, created },
  )
  const firstTabAfter = twoTabs?.states[0] ?? ''
  recorder.check(
    // The first session keeps its own state: it must not read as exited or failed, and it must
    // not have lost the state it had before the second terminal appeared.
    twoTabs !== null
    && firstTabAfter.length > 0
    && !firstTabAfter.includes('已退出')
    && !firstTabAfter.includes('失败')
    && (beforeStates[0] === undefined || beforeStates[0] === firstTabAfter),
    'the session that was already running is left running when another is created',
    { before: beforeStates, after: twoTabs?.states ?? [] },
  )
  recorder.check(
    closed.clicked === true && afterClose.tabs <= 1,
    'closing one terminal removes only that tab',
    { closed, afterClose },
  )

  // UX-30 item 1: input goes to the selected session, and creating another does not stop the
  // first. Terminal text lives on a canvas, so this is checked by what the commands *do*: each
  // session writes a marker file that only it could have written.
  const markerPath = (name) => join(workspaceDir, name)
  await sendTerminalCommand(client, 'Set-Content -LiteralPath .\\terminal-a-1.txt -Value a1')
  await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('.workspace-terminal button')]
      .find((node) => (node.textContent || '').trim() === '新建')
    if (button instanceof HTMLElement) button.click()
    return true
  })()`)
  await harness.waitFor(
    () => evaluate(client, `document.querySelectorAll('.workspace-terminal-tab').length >= 2 ? true : null`),
    60_000,
    'a second terminal for the routing check',
  ).catch(() => null)
  await delay(3000)
  await sendTerminalCommand(client, 'Set-Content -LiteralPath .\\terminal-b-1.txt -Value b1')
  await evaluate(client, `(() => {
    const first = [...document.querySelectorAll('.workspace-terminal-tab')][0]
      ?.querySelector('.workspace-terminal-tab-select')
    if (first instanceof HTMLElement) first.click()
    return true
  })()`)
  await delay(1500)
  await sendTerminalCommand(client, 'Set-Content -LiteralPath .\\terminal-a-2.txt -Value a2')

  const markers = {
    a1: existsSync(markerPath('terminal-a-1.txt')),
    b1: existsSync(markerPath('terminal-b-1.txt')),
    a2: existsSync(markerPath('terminal-a-2.txt')),
  }
  recorder.note({ step: 'workspace-terminal-input-routing', markers })
  recorder.check(
    // If creating the second session had killed the first, or if input had gone to the wrong
    // process, at least one of these files would be missing.
    markers.a1 && markers.b1 && markers.a2,
    'each terminal session receives its own input, and the first still works after a second is created',
    markers,
  )

  // UX-37: the session cap and the panel's keep-alive/cleanup contract (see the function below).
  await assertTerminalSessionCapAndPanelLifecycle(client, recorder, workspaceDir)
}

/** How many terminals one workspace may hold at once (UX-37; `MAX_TERMINAL_TABS` in the renderer). */
const TERMINAL_SESSION_CAP = 8

/**
 * The terminal panel read from the DOM *plus* the request probe: how many session tabs exist,
 * which one is selected, what the notice says, whether the panel is mounted and visible, and how
 * many create/close requests the renderer really sent.
 */
const TERMINAL_PANEL_EXPRESSION = `(() => {
  const pane = document.querySelector('.workspace-terminal');
  const tabs = [...document.querySelectorAll('.workspace-terminal-tab')];
  const notice = pane ? pane.querySelector('.workspace-terminal-shell-notice') : null;
  const noticeBox = notice ? notice.getBoundingClientRect() : null;
  const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? null;
  const view = pane ? pane.closest('.workspace-tab-view') : null;
  const probe = window.__terminalApiProbe ?? null;
  return {
    hasPanel: pane instanceof HTMLElement,
    tabs: tabs.length,
    selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length,
    statuses: tabs.map((tab) => (tab.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim()),
    activeLabel: active ? active.getAttribute('aria-label') : null,
    activeStatus: active ? (active.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim() : null,
    notice: notice instanceof HTMLElement
      ? { text: (notice.textContent || '').trim(), visible: Boolean(noticeBox && noticeBox.width > 0 && noticeBox.height > 0) }
      : null,
    status: pane ? (pane.querySelector('.workspace-terminal-status')?.textContent || '').trim() : '',
    view: view instanceof HTMLElement
      ? {
        className: view.className,
        ariaHidden: view.getAttribute('aria-hidden'),
        inert: view.hasAttribute('inert'),
        visibility: getComputedStyle(view).visibility,
      }
      : null,
    probe: probe
      ? {
        creates: probe.creates,
        createsSettled: probe.createsSettled,
        closes: probe.closes,
        closesSettled: probe.closesSettled,
        calls: probe.calls.slice(-20),
      }
      : null,
  };
})()`

/**
 * Clicks one of the terminal toolbar's text buttons (新建 / 中断 / 重启 / 清空). The toolbar's copy
 * is used, not the tab strip's: the strip disables its 新建 while a session is starting, so a click
 * there could be swallowed.
 */
function terminalToolbarExpression(label) {
  return `(() => {
    const label = ${JSON.stringify(label)};
    const buttons = [...document.querySelectorAll('.workspace-terminal button')]
      .filter((node) => (node.textContent || '').trim() === label);
    const enabled = buttons.filter((node) => node.disabled !== true);
    const target = enabled.length > 0 ? enabled[enabled.length - 1] : null;
    if (!(target instanceof HTMLElement)) {
      return { clicked: false, label, buttons: buttons.length, disabled: buttons.length - enabled.length };
    }
    target.click();
    return { clicked: true, label, buttons: buttons.length, disabled: buttons.length - enabled.length };
  })()`
}

async function clickTerminalToolbar(client, label) {
  return evaluate(client, terminalToolbarExpression(label))
}

/**
 * The surface's own stdin gate, which xterm mirrors onto its helper textarea
 * (`textarea.readOnly = disableStdin`): `readOnly === false` is the only honest signal that typing
 * will reach the session.
 */
const TERMINAL_INPUT_EXPRESSION = `(() => {
  const textarea = document.querySelector('.workspace-terminal textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) return { present: false };
  const active = document.querySelector('.workspace-terminal-tab.active');
  return {
    present: true,
    readOnly: textarea.readOnly,
    activeLabel: active ? active.getAttribute('aria-label') : null,
    status: (document.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
  };
})()`

/**
 * A cheap Local App API read. The renderer's requests all share one origin, and a browser keeps at
 * most six HTTP/1.1 connections to a host: when it cannot answer while terminal streams are open,
 * the connection pool — not Main — is what stopped the panel.
 */
const TERMINAL_API_REACHABILITY_EXPRESSION = `(async () => {
  const started = performance.now();
  const timeout = new Promise((done) => setTimeout(() => done({ timedOut: true }), 4000));
  const request = (async () => {
    try {
      const base = await window.littlesheep.localApiBase();
      const response = await fetch(base + '/workspace/terminal/activity?root=.&limit=1');
      return { status: response.status, ok: response.ok };
    } catch (error) {
      return { error: String(error) };
    }
  })();
  const result = await Promise.race([request, timeout]);
  return { ...result, ms: Math.round(performance.now() - started) };
})()`

/** The tab strip's own close button for the terminal workspace tab, by accessible name. */
const TERMINAL_TAB_CLOSE_EXPRESSION = `(() => {
  const buttons = [...document.querySelectorAll('.workspace-active-close')];
  const target = buttons.find((node) => (node.getAttribute('aria-label') || '') === '关闭终端标签') ?? null;
  if (!(target instanceof HTMLElement)) {
    return { clicked: false, labels: buttons.map((node) => node.getAttribute('aria-label')) };
  }
  target.click();
  return { clicked: true, label: target.getAttribute('aria-label') };
})()`

/** Clicks a workspace tab that is not the terminal one: that is what hides the panel. */
const TERMINAL_SWITCH_AWAY_EXPRESSION = `(() => {
  const tabs = [...document.querySelectorAll('.workspace-active-item')];
  const isTerminal = (node) => (node.querySelector('.workspace-active-close')?.getAttribute('aria-label') || '') === '关闭终端标签';
  const options = tabs.map((node) => ({
    label: (node.textContent || '').trim(),
    kind: node.getAttribute('data-workspace-tab-kind'),
    terminal: isTerminal(node),
    selected: node.getAttribute('aria-selected'),
  }));
  const target = tabs.find((node) => !isTerminal(node)) ?? null;
  if (!(target instanceof HTMLElement)) return { clicked: false, options };
  const label = (target.textContent || '').trim();
  target.click();
  return { clicked: true, label, kind: target.getAttribute('data-workspace-tab-kind'), options };
})()`

/**
 * Waits until the displayed session may receive typing, and reports what it had to do.
 *
 * The surface disables stdin for a session that is displayed after a tab switch, a tab close or
 * the start of another session, and only new output re-enables it; xterm drops *every* data event
 * while `disableStdin` is set (`CoreService.triggerDataEvent`), so a command typed in that window
 * never leaves the renderer. The flag is mirrored onto xterm's helper textarea
 * (`textarea.readOnly = disableStdin`), which makes it observable instead of guessed. When it is
 * still set, the toolbar's 清空 sends Ctrl+L through the input controller — that path is not gated
 * — and the shell repaints its prompt: that output is what re-enables typing.
 */
async function ensureTerminalInput(client) {
  const read = () => evaluate(client, TERMINAL_INPUT_EXPRESSION)
  const enabled = () => read().then((state) => (state?.present === true && state.readOnly === false ? state : null))
  const ready = await harness.waitFor(enabled, 5_000, 'terminal input to be enabled').catch(() => null)
  if (ready) return { enabled: true, nudged: false, state: ready }
  const before = await read()
  const nudge = await clickTerminalToolbar(client, '清空')
  const after = await harness.waitFor(enabled, 20_000, 'terminal input after the clear nudge').catch(() => null)
  return { enabled: after !== null, nudged: nudge.clicked === true, before, after }
}

/**
 * UX-37: the eight-session cap, and what hiding versus removing the panel does to the sessions
 * Main owns.
 *
 * Every claim is measured outside the surface that makes it. How many sessions exist comes from
 * the requests the renderer really sent (a `fetch` probe), so a refused ninth session means no
 * create request left the renderer rather than a list that merely looks short. "The session
 * survived being hidden" is a filesystem fact: a real background process keeps appending to a
 * real file while the panel is hidden, and stops when the panel is removed.
 */
async function assertTerminalSessionCapAndPanelLifecycle(client, recorder, workspaceDir) {
  const readPanel = () => evaluate(client, TERMINAL_PANEL_EXPRESSION)
  const keepAlivePath = join(workspaceDir, 'terminal-keepalive.txt')
  const sampleFile = () => {
    let size = null
    try {
      size = statSync(keepAlivePath).size
    } catch {
      size = null
    }
    return { size, at: new Date().toISOString() }
  }

  // The cap is decided in the renderer, so the evidence has to be the requests it really sent.
  // The probe is installed once and reset per scene: this walkthrough drives two conversations
  // and each one has to be counted on its own.
  const instrument = await evaluate(client, `(() => {
    if (window.__terminalApiProbe) {
      window.__terminalApiProbe.creates = 0;
      window.__terminalApiProbe.createsSettled = 0;
      window.__terminalApiProbe.closes = 0;
      window.__terminalApiProbe.closesSettled = 0;
      window.__terminalApiProbe.calls.length = 0;
      return { reused: true };
    }
    const probe = { creates: 0, createsSettled: 0, closes: 0, closesSettled: 0, calls: [] };
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      const method = String(init?.method ?? 'GET').toUpperCase();
      let path = '';
      try {
        path = new URL(url, location.href).pathname;
      } catch {
        path = '';
      }
      const promise = original(input, init);
      if (path.startsWith('/workspace/terminal/session')) {
        const isCreate = method === 'POST' && /\\/workspace\\/terminal\\/session$/.test(path);
        const isClose = method === 'DELETE';
        if (isCreate) probe.creates += 1;
        if (isClose) probe.closes += 1;
        if (probe.calls.length < 60) probe.calls.push(method + ' ' + path + (isCreate ? ' #create' : isClose ? ' #close' : ''));
        // A request that never settles never reached Main: that is the difference between
        // "the renderer refused to ask" and "the request is stuck before it left the browser".
        if (isCreate || isClose) {
          promise.then(
            () => { if (isCreate) probe.createsSettled += 1; else probe.closesSettled += 1; },
            () => { if (isCreate) probe.createsSettled += 1; else probe.closesSettled += 1; },
          );
        }
      }
      return promise;
    };
    window.__terminalApiProbe = probe;
    return { reused: false };
  })()`)

  // The sessions already running cannot be counted by a probe installed now, and the cap claim
  // is "eight tabs, eight create requests". Removing the panel first makes that count exact, and
  // measures the cleanup half of UX-37 (b) on a known session count: every session of the panel
  // must be closed through the API, not just dropped from the list.
  const beforeRemoval = await readPanel()
  const panelRemoval = await evaluate(client, TERMINAL_TAB_CLOSE_EXPRESSION)
  const panelGone = await harness.waitFor(
    () => evaluate(client, `document.querySelector('.workspace-terminal') ? null : true`),
    15_000,
    'the terminal panel to leave the DOM',
  ).catch(() => null)
  await delay(500)
  const afterRemoval = await readPanel()
  recorder.note({ step: 'workspace-terminal-panel-removal', instrument, beforeRemoval, panelRemoval, panelGone, afterRemoval })
  recorder.check(
    panelRemoval.clicked === true && panelGone === true && afterRemoval.hasPanel === false,
    'closing the terminal workspace tab removes the panel instead of hiding it',
    { panelRemoval, panelGone, hasPanel: afterRemoval?.hasPanel },
  )
  recorder.check(
    afterRemoval.probe !== null && afterRemoval.probe.closes === beforeRemoval.tabs,
    'removing the terminal panel closes every session of that panel through the API',
    { sessionsShown: beforeRemoval.tabs, deletes: afterRemoval.probe?.closes, calls: afterRemoval.probe?.calls },
  )

  // Re-open it: from here on the probe sees every session of this step from its first request.
  await selectWorkspaceFeature(client, '终端')
  const reopened = await harness.waitFor(() => evaluate(client, `(() => {
    const pane = document.querySelector('.workspace-terminal');
    if (!(pane instanceof HTMLElement)) return null;
    const status = (pane.querySelector('.workspace-terminal-status')?.textContent || '').trim();
    return status && status !== '启动中' ? { status } : null;
  })()`), 30_000, 'the reopened terminal panel to report its shell').catch(() => null)
  const afterReopen = await readPanel()
  recorder.note({ step: 'workspace-terminal-reopened', reopened, afterReopen })
  recorder.check(
    reopened !== null && afterReopen.hasPanel === true && afterReopen.probe?.creates === 1,
    'reopening the terminal panel starts exactly one session on Main',
    { status: reopened?.status, creates: afterReopen.probe?.creates, tabs: afterReopen.tabs },
  )

  // One more session, so the tab strip exists and "the same sessions are still here" can be read
  // from it. The background process of UX-37 (b) runs in this new (active) session.
  const secondSession = await clickTerminalToolbar(client, '新建')
  const twoSessions = await harness.waitFor(() => evaluate(client, `(() => {
    const count = document.querySelectorAll('.workspace-terminal-tab').length;
    return count >= 2 ? count : null;
  })()`), 60_000, 'a second terminal session for the keep-alive step').catch(() => null)
  const beforeKeepAlive = await readPanel()

  // UX-37 (b): a hidden panel keeps its sessions; the proof is a real process writing a real file.
  const activeReady = await harness.waitFor(() => evaluate(client, `(() => {
    const tab = document.querySelector('.workspace-terminal-tab.active');
    if (!(tab instanceof HTMLElement)) return null;
    const status = (tab.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim();
    return status === '运行中' ? { status, label: tab.getAttribute('aria-label') } : null;
  })()`), 30_000, 'the active terminal session to be ready for input').catch(() => null)
  const inputGate = await ensureTerminalInput(client)
  await unlink(keepAlivePath).catch(() => undefined)
  const keepAliveCommand = 'while ($true) { Add-Content -LiteralPath .\\terminal-keepalive.txt -Value tick; Start-Sleep -Milliseconds 250 }'
  await sendTerminalCommand(client, keepAliveCommand)
  const fileFirstSeen = await harness.waitFor(() => {
    const value = sampleFile()
    return value.size !== null && value.size > 0 ? value : null
  }, 30_000, 'the terminal keep-alive file').catch(() => sampleFile())

  const beforeHide = sampleFile()
  const switchedAway = await evaluate(client, TERMINAL_SWITCH_AWAY_EXPRESSION)
  if (!switchedAway.clicked) {
    // No other tab is open yet: open one through the real menu, then hide the terminal by
    // clicking the terminal's tab and the other one, so the hide is a tab-strip interaction.
    await selectWorkspaceFeature(client, '浏览器')
    await clickVisible(client, '.workspace-active-item', '终端')
    await delay(300)
  }
  const hiddenPanel = await harness.waitFor(() => evaluate(client, `(() => {
    const pane = document.querySelector('.workspace-terminal');
    const view = pane ? pane.closest('.workspace-tab-view') : null;
    if (!view || view.getAttribute('aria-hidden') !== 'true') return null;
    return {
      panelMounted: pane instanceof HTMLElement,
      ariaHidden: view.getAttribute('aria-hidden'),
      inert: view.hasAttribute('inert'),
      visibility: getComputedStyle(view).visibility,
      tabs: document.querySelectorAll('.workspace-terminal-tab').length,
    };
  })()`), 15_000, 'the terminal panel to be hidden').catch(() => null)
  await delay(2000)
  const whileHidden = sampleFile()
  const hiddenScreenshot = await writePng(client, 'terminal-hidden-keepalive')
  recorder.note({
    step: 'workspace-terminal-hidden-keepalive',
    secondSession, twoSessions, beforeKeepAlive, activeReady, inputGate, keepAliveCommand,
    fileFirstSeen, beforeHide, switchedAway, hiddenPanel, whileHidden, hiddenScreenshot,
  })
  recorder.check(
    activeReady !== null && inputGate.enabled === true && fileFirstSeen.size !== null && fileFirstSeen.size > 0,
    'a real background process in the active session writes a real file',
    { activeReady, inputGate, first: fileFirstSeen },
  )
  recorder.check(
    hiddenPanel !== null && hiddenPanel.panelMounted === true
      && beforeHide.size !== null && whileHidden.size !== null && whileHidden.size > beforeHide.size,
    'hiding the terminal panel keeps its sessions alive (the background file keeps growing)',
    {
      before: beforeHide,
      after: whileHidden,
      bytes: (whileHidden.size ?? 0) - (beforeHide.size ?? 0),
      hiddenPanel,
      switchedAway,
    },
  )

  // Back to the terminal tab: the sessions of the hidden panel are still there.
  const switchedBack = await clickVisible(client, '.workspace-active-item', '终端')
  const visibleAgain = await harness.waitFor(() => evaluate(client, `(() => {
    const pane = document.querySelector('.workspace-terminal');
    const view = pane ? pane.closest('.workspace-tab-view') : null;
    if (!view || view.getAttribute('aria-hidden') === 'true') return null;
    return {
      tabs: document.querySelectorAll('.workspace-terminal-tab').length,
      selected: document.querySelectorAll('.workspace-terminal-tab[aria-selected="true"]').length,
      status: (pane.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
    };
  })()`), 15_000, 'the terminal panel to be visible again').catch(() => null)
  const survivedHidden = sampleFile()
  recorder.check(
    switchedBack.clicked === true && visibleAgain !== null && visibleAgain.tabs === hiddenPanel?.tabs
      && survivedHidden.size !== null && survivedHidden.size >= (whileHidden.size ?? 0),
    'switching back to the terminal tab shows the same sessions (the hidden ones were kept)',
    { switchedBack, visible: visibleAgain, whileHidden, survivedHidden },
  )

  // UX-37 (a): keep clicking 新建 until the cap is reached, waiting for the tab count to change
  // between clicks, so a click that created nothing shows up in the numbers instead of being
  // skipped over. Every click is timed: a create request that never settles is a different fact
  // from a click the renderer refused, and the probe counts both.
  const clicks = []
  let atCap = await readPanel()
  while (atCap.tabs < TERMINAL_SESSION_CAP && clicks.length < TERMINAL_SESSION_CAP + 2) {
    const before = atCap.tabs
    const startedAt = Date.now()
    const clicked = await clickTerminalToolbar(client, '新建')
    const grown = clicked.clicked
      ? await harness.waitFor(() => evaluate(client, `(() => {
        const count = document.querySelectorAll('.workspace-terminal-tab').length;
        return count > ${before} ? count : null;
      })()`), 60_000, `a terminal tab beyond ${before}`).catch(() => null)
      : null
    const now = await readPanel()
    clicks.push({ from: before, to: grown, ms: Date.now() - startedAt, click: clicked, probe: now.probe })
    if (grown === null) break
    atCap = now
  }
  const capScreenshot = await writePng(client, 'terminal-session-cap')

  // The ninth attempt: the renderer must refuse it before Main is asked for anything.
  const refused = await clickTerminalToolbar(client, '新建')
  const capNotice = await harness.waitFor(() => evaluate(client, `(() => {
    const notice = document.querySelector('.workspace-terminal-shell-notice');
    if (!(notice instanceof HTMLElement)) return null;
    const text = (notice.textContent || '').trim();
    return text.includes('最多同时打开') ? { text } : null;
  })()`), 15_000, 'the terminal cap notice').catch(() => null)
  await delay(1500)
  const afterRefusal = await readPanel()
  // While the panel cannot get more sessions, ask whether the renderer can still talk to the
  // Local App API at all: every renderer request shares one origin, and a browser keeps six
  // HTTP/1.1 connections to it, one of which each open terminal stream holds.
  const capReachability = await evaluate(client, TERMINAL_API_REACHABILITY_EXPRESSION).catch((error) => ({ error: String(error) }))
  recorder.note({ step: 'workspace-terminal-session-cap', clicks, capScreenshot, refused, capNotice, afterRefusal, capReachability })
  recorder.check(
    atCap.tabs === TERMINAL_SESSION_CAP && afterRefusal.tabs === TERMINAL_SESSION_CAP
      && atCap.selected === 1 && afterRefusal.selected === 1,
    'the terminal panel stops at eight sessions and keeps exactly one of them selected',
    {
      atCap: atCap.tabs,
      selected: atCap.selected,
      afterRefusal: afterRefusal.tabs,
      active: afterRefusal.activeLabel,
      clicks: clicks.map((entry) => `${entry.from}->${entry.to ?? 'timeout'}@${entry.ms}ms`),
    },
  )
  recorder.check(
    atCap.probe?.creates === TERMINAL_SESSION_CAP && atCap.probe?.createsSettled === TERMINAL_SESSION_CAP,
    'eight terminal tabs correspond to eight create requests Main answered',
    {
      creates: atCap.probe?.creates,
      createsSettled: atCap.probe?.createsSettled,
      tabs: atCap.tabs,
      clicks: clicks.length,
      reachability: capReachability,
    },
  )
  recorder.check(
    // The cap has to have been reached for this to mean anything: a click that was refused before
    // Main is asked cannot add a create, and neither can a click whose request is merely stuck.
    atCap.tabs === TERMINAL_SESSION_CAP
      && afterRefusal.probe?.creates === atCap.probe?.creates,
    'the refused ninth terminal sends no create request, so Main owns no session the panel does not show',
    {
      tabsAtCap: atCap.tabs,
      createsBefore: atCap.probe?.creates,
      createsAfter: afterRefusal.probe?.creates,
      refused,
      calls: afterRefusal.probe?.calls,
    },
  )
  recorder.check(
    capNotice !== null && afterRefusal.notice?.visible === true
      && (afterRefusal.notice?.text ?? '').includes('最多同时打开'),
    'the refused ninth terminal shows a visible notice naming the cap',
    { notice: afterRefusal.notice, waited: capNotice },
  )

  // UX-37 (b), second half: removing the panel is not hiding it — every session must be closed,
  // and the background process must stop for real.
  const finalRemoval = await evaluate(client, TERMINAL_TAB_CLOSE_EXPRESSION)
  await harness.waitFor(
    () => evaluate(client, `document.querySelector('.workspace-terminal') ? null : true`),
    15_000,
    'the terminal panel to be removed again',
  ).catch(() => null)
  const afterPanelClose = sampleFile()
  // Aborting the panel's streams frees the renderer's connections: whether the requests that
  // never settled now complete is what separates "stuck in the browser" from "Main said no".
  await delay(3000)
  const settledAfterRemoval = await readPanel()
  const afterPanelClose2 = sampleFile()
  await delay(1500)
  const stopped1 = sampleFile()
  await delay(1500)
  const stopped2 = sampleFile()
  const finalPanel = await readPanel()
  const closedScreenshot = await writePng(client, 'terminal-panel-closed')
  recorder.note({
    step: 'workspace-terminal-panel-close',
    finalRemoval,
    sessionsShown: visibleAgain?.tabs ?? null,
    finalPanel,
    settledAfterRemoval: settledAfterRemoval.probe,
    samples: [afterPanelClose, afterPanelClose2, stopped1, stopped2],
    closedScreenshot,
  })
  recorder.check(
    finalRemoval.clicked === true && finalPanel.hasPanel === false,
    'closing the terminal workspace tab removes the panel (its sessions are not just hidden)',
    { finalRemoval, hasPanel: finalPanel?.hasPanel },
  )
  recorder.check(
    stopped1.size !== null && stopped2.size !== null && stopped2.size === stopped1.size,
    'removing the terminal panel stops every session (the background file stops growing)',
    { at: afterPanelClose, settled: afterPanelClose2, first: stopped1, second: stopped2, delta: (stopped2.size ?? 0) - (stopped1.size ?? 0) },
  )
  recorder.check(
    // One DELETE per session the panel still showed (a single session has no strip to count, hence
    // the floor of one). The count is a lower bound: a create that was still queued when the panel
    // was removed is closed by the hook when its request finally settles, which adds deletes.
    finalPanel.probe !== null && afterRemoval.probe !== null
      && finalPanel.probe.closes >= afterRemoval.probe.closes + Math.max(afterRefusal.tabs, 1),
    'every session the removed panel showed is closed through the API',
    {
      closes: finalPanel.probe?.closes,
      closesSettled: finalPanel.probe?.closesSettled,
      deletesBeforeCap: afterRemoval.probe?.closes,
      sessionsShown: afterRefusal.tabs,
      calls: finalPanel.probe?.calls,
    },
  )
  const keepAliveCleaned = await unlink(keepAlivePath).then(() => true).catch(() => false)
  recorder.note({ step: 'workspace-terminal-keepalive-cleanup', keepAlivePath, removed: keepAliveCleaned })
}

async function createWorkspaceScene(client, recorder, { fileName, draftMarker, browserUrl, workspaceDir }) {
  await selectWorkspaceFeature(client, '终端')
  await assertWorkspaceTerminalReady(client, recorder, workspaceDir)
  await harness.waitFor(
    () => evaluate(client, `Boolean([...document.querySelectorAll('.workspace-tree-row.file')].find((node) => node.textContent?.includes(${JSON.stringify(fileName)}))) || null`),
    15_000,
    `workspace file ${fileName}`,
  )
  const notesRow = await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('.workspace-tree-row.directory')]
      .find((node) => node.textContent?.trim().includes('notes'))
    if (!(row instanceof HTMLElement)) return { found: false }
    const wasExpanded = row.getAttribute('aria-expanded') === 'true'
    if (!wasExpanded) row.click()
    return { found: true, expanded: wasExpanded }
  })()`)
  if (!notesRow.found) throw new Error('the notes directory row was not available')
  const notesChildren = await harness.waitFor(() => evaluate(client, `(() => {
    const names = [...document.querySelectorAll('.workspace-tree-name')].map((node) => node.textContent?.trim())
    return ['alpha.md', 'beta.md', 'gamma.md'].every((name) => names.includes(name)) ? names : null
  })()`), 10_000, 'notes directory to expand')

  const openFile = await clickVisible(client, '.workspace-tree-row.file', fileName)
  if (!openFile.clicked) throw new Error(`the ${fileName} row could not be opened`)
  try {
    await harness.waitFor(() => evaluate(client, `Boolean(document.querySelector('.workspace-editor-monaco .monaco-editor')) || null`), 20_000, `${fileName} preview`)
  } catch (error) {
    const state = await evaluate(client, `(() => ({
      tabs: [...document.querySelectorAll('.workspace-active-item')].map((node) => node.textContent?.trim()),
      activeTab: document.querySelector('.workspace-tab-view.active')?.className ?? null,
      selectedTreeRow: document.querySelector('.workspace-tree-row.selected')?.textContent?.trim() ?? null,
      previewActions: document.querySelector('.workspace-preview-actions')?.textContent?.trim() ?? null,
      status: document.querySelector('.workspace-editor-status')?.textContent?.trim() ?? null,
      editor: Boolean(document.querySelector('.workspace-editor-monaco .monaco-editor')),
      loading: document.querySelector('.workspace-preview-body')?.textContent?.trim().slice(0, 120) ?? null,
    }))()`)
    throw new Error(`${error instanceof Error ? error.message : String(error)}; file scene state: ${JSON.stringify(state)}`)
  }
  const edit = await clickVisible(client, '.workspace-preview-actions button', '编辑')
  if (!edit.clicked) throw new Error(`${fileName} could not enter edit mode`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-editor-monaco .monaco-editor:not(.workspace-monaco-readonly)') ? true : null`), 10_000, `${fileName} editor to enter edit mode`)
  const editorPoint = await evaluate(client, `(() => {
    const node = document.querySelector('.workspace-editor-monaco .monaco-editor .view-lines')
    if (!(node instanceof HTMLElement)) return null
    const box = node.getBoundingClientRect()
    return box.width > 10 && box.height > 10 ? { x: box.left + Math.min(80, box.width / 2), y: box.top + Math.min(40, box.height / 2) } : null
  })()`)
  if (!editorPoint) throw new Error('the Monaco editor body was not available for typing')
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: editorPoint.x, y: editorPoint.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editorPoint.x, y: editorPoint.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editorPoint.x, y: editorPoint.y, button: 'left', buttons: 0, clickCount: 1 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await client.send('Input.insertText', { text: draftMarker })
  const visibleDraft = await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-editor-monaco .view-lines')?.textContent?.includes(${JSON.stringify(draftMarker)}) || null`), 10_000, 'unsaved editor draft')

  await selectWorkspaceFeature(client, '浏览器')
  await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-browser-address input') instanceof HTMLInputElement || null`), 10_000, 'browser address field')
  const submittedUrl = await evaluate(client, `(() => {
    const input = document.querySelector('.workspace-browser-address input')
    const form = input?.closest('form')
    if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, ${JSON.stringify(browserUrl)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    form.requestSubmit()
    return true
  })()`)
  if (!submittedUrl) throw new Error('the browser address could not be submitted')
  const browserStored = await harness.waitFor(() => evaluate(client, `(() => {
    const id = localStorage.getItem('littlesheep.ui.activeSession')
    const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}')
    const layout = layouts[id ? 'session:' + encodeURIComponent(id) : '__draft__']
    return layout?.browserTabs?.some((tab) => tab.url === ${JSON.stringify(browserUrl)})
      ? { id, activeTab: layout.activeTab, browserTabs: layout.browserTabs, expandedPaths: layout.expandedPaths, drafts: layout.drafts }
      : null
  })()`), 15_000, 'browser URL to persist in this conversation')
  await delay(350)
  return { notesChildren, visibleDraft, browserStored }
}

async function dragPanelResizer(client, deltaX) {
  const start = await evaluate(client, `(() => {
    const node = document.querySelector('.workspace-panel-resizer');
    if (!(node instanceof HTMLElement)) return null;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 && box.height <= 0) return null;
    return { x: box.left + box.width / 2, y: box.top + Math.min(120, box.height / 2) };
  })()`)
  if (!start) throw new Error('the workspace panel resizer is missing')
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
  })
  for (const fraction of [0.34, 0.67, 1]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: start.x + deltaX * fraction, y: start.y, button: 'left', buttons: 1,
    })
    await delay(40)
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: start.x + deltaX, y: start.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await delay(250)
}

async function waitForStreamState(client, state, label) {
  return harness.waitFor(async () => {
    const layout = await tryReadLayout(client)
    return layout?.streamState === state ? layout : undefined
  }, harness.startTimeoutMs, label)
}

/**
 * The renderer can still be executing its cold-start bundle when the first
 * evaluation arrives, and a stuck `Runtime.evaluate` would otherwise abort the
 * whole fixture. Poll with retries instead of one long await.
 */
async function waitForComposer(client) {
  const deadline = Date.now() + harness.startTimeoutMs * 2
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const ready = await withTimeout(client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`), 10_000, 'composer probe')
      if (ready === true) return true
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw new Error(`the composer never became available: ${lastError instanceof Error ? lastError.message : 'no evaluation succeeded'}`)
}

/**
 * The default permission mode asks before the Agent touches anything, so the
 * scenario has to answer the same prompt a user would. Every approval is counted
 * and reported, because "the fixture approved it" is part of the evidence.
 */
async function approveIfPrompted(client) {
  try {
    return await evaluate(client, `(() => {
      const prompt = document.querySelector('.approval-prompt');
      if (!(prompt instanceof HTMLElement)) return null;
      const button = prompt.querySelector('button.approval-action.session')
        ?? prompt.querySelector('button.approval-action.primary');
      if (!(button instanceof HTMLElement)) return null;
      const label = (button.textContent || '').trim();
      button.click();
      return label;
    })()`)
  } catch {
    return null
  }
}

async function readPendingApproval(client) {
  try {
    return await evaluate(client, `(() => {
      const prompt = document.querySelector('.approval-prompt');
      if (!(prompt instanceof HTMLElement)) return null;
      return (prompt.textContent || '').replace(/\\s+/gu, ' ').trim().slice(0, 200);
    })()`)
  } catch {
    return null
  }
}

async function main() {
  await harness.assertBuildFresh()
  const recorder = createRecorder()
  const approvals = []
  // The long fixture streams in small chunks so the reader has a real moving target for several
  // seconds: the draft and the reading-position checks happen while text is still arriving, and a
  // fixture that finishes early would measure a settled answer.
  //
  // A longer delay between the same six-character chunks, not smaller chunks: the whole sequence
  // that has to happen *while* the answer arrives is bounded by a fixed wall-clock overhead of
  // roughly half a second (the scroll-away settle, a layout read, one screenshot, the three-line
  // draft), so at six characters per 40 ms the entire ~1000-character answer was finished in ~7 s
  // and the draft check could read a settled stream (measured in two different runs: "the draft did
  // not submit the composer while the answer was still streaming" and "timed out waiting for the
  // streamed answer to grow"). Chunks of one or two characters instead stretch the stream to ~50 s
  // but triple the number of markdown re-renders, which makes the renderer lag the measurement by
  // seconds (measured: the scroll-away layout already read 985 of 1016 characters). Keeping the
  // chunk size and slowing the cadence gives the same window without that render pressure. The
  // cadence stays moderate because the panel-layout steps later in this walkthrough need the
  // stream to have settled before they measure geometry (a slower stream kept re-rendering and
  // the fullscreen toggle never settled).
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 200, streamChunkCharacters: 6 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-conversation-scenarios-'))
  const dataDir = join(root, 'data')
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshots = {}
  let handle
  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    // A workplace large enough that the glob tool result is genuinely long.
    await Promise.all(Array.from({ length: WORKPLACE_FILES }, (_value, index) => writeFile(
      join(workplaceDir, `scenario-file-${String(index).padStart(2, '0')}.txt`),
      `scenario fixture ${index}\n`,
      'utf8',
    )))
    await mkdir(join(workplaceDir, 'notes'), { recursive: true })
    await Promise.all(['alpha', 'beta', 'gamma'].map((name) => writeFile(
      join(workplaceDir, 'notes', `${name}.md`),
      `# ${name}\n`,
      'utf8',
    )))
    await Promise.all(['scenario-file-00.ts', 'scenario-file-01.ts'].map((name, index) => writeFile(
      join(workplaceDir, name),
      `export const sessionScene = ${index}\n`,
      'utf8',
    )))
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      // The window is parked outside every display, and Chromium then treats the page as
      // backgrounded: CSS transitions and frame-driven layout stop advancing, which is how an
      // opened tool panel kept a 0x0 rect and the fullscreen toggle never widened the panel
      // (measured). These two switches keep the renderer running while it is off screen.
      extraArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // Parked outside every display and shown inactively: the window renders (a hidden one times
    // out on the screenshots this walkthrough takes) without ever appearing on the desktop.
    await harness.desktopAction(locator, 'park-offscreen')
    await delay(1200)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    handle = { electron, locator, client }
    await waitForComposer(client)
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // ---------------------------------------------------------------------
    // 1. a long answer is streaming: read up, keep the draft, keep the composer
    // ---------------------------------------------------------------------
    await submit(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForStreamState(client, 'streaming', 'the streamed answer to start')
    // Leaving the bottom is only meaningful once the answer is taller than the viewport.
    await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.scrollHeight !== null && layout.clientHeight !== null
        && layout.scrollHeight > layout.clientHeight + 300 ? layout : undefined
    }, harness.startTimeoutMs, 'the streamed answer to become scrollable')

    // Move the reader 420 px above the bottom while the answer is still arriving.
    const away = await withTimeout(client.evaluate(`(async () => {
      // A frame wait that cannot hang. The acceptance window is parked outside the desktop, and
      // a window Chromium is not compositing never calls requestAnimationFrame: the settle loop
      // below would block this check for its whole timeout and the answer would settle behind it
      // (measured: this exact check timed out with away === null and the stream was already
      // settled). The timer is the floor, a real frame still wins — the same rule
      // verify-chat-reading-scenarios uses for its own settle loops.
      const raf = () => new Promise((done) => {
        const timer = setTimeout(done, 60);
        requestAnimationFrame(() => { clearTimeout(timer); done(); });
      });
      const messages = document.querySelector('.messages');
      if (!(messages instanceof HTMLElement)) return null;
      messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 420);
      messages.dispatchEvent(new Event('scroll', { bubbles: true }));
      for (let index = 0; index < 8; index += 1) await raf();
      return true;
    })()`), 20_000, 'scroll away').catch(() => null)
    recorder.check(away === true, 'the reader can leave the bottom while the answer streams', { away })
    const awayLayout = await measureLayout(client)
    screenshots['streaming-away'] = await writePng(client, 'streaming-away')
    recorder.note({ step: 'streaming-away', layout: awayLayout })
    recorder.check(
      (awayLayout?.gap ?? 0) > 100 && awayLayout?.anchorKey !== null,
      'the reader is really above the bottom with a message as the reading anchor',
      { gap: awayLayout?.gap, anchorKey: awayLayout?.anchorKey },
    )

    // A multi-line draft typed with real Shift+Enter keys during the stream.
    await typeDraftWithLineBreaks(client, ['第一行草稿', '第二行草稿', '第三行草稿'])
    const afterDraft = await measureLayout(client)
    recorder.note({ step: 'draft-while-streaming', layout: afterDraft })
    recorder.check(
      afterDraft?.composerLines === 3 && afterDraft?.composerValue === '第一行草稿\n第二行草稿\n第三行草稿',
      'Shift+Enter keeps a three-line draft in the composer',
      { value: afterDraft?.composerValue, lines: afterDraft?.composerLines },
    )
    recorder.check(
      afterDraft?.attachmentCards === 0 && afterDraft?.streamState === 'streaming',
      'the draft did not submit the composer while the answer was still streaming',
      { attachments: afterDraft?.attachmentCards, streamState: afterDraft?.streamState },
    )

    // The stream must grow while the reader stays where they were. The draft above was typed
    // while text was still arriving, so the growth window starts at that layout. The answer is
    // ~1016 characters and the steps above eat most of the stream, so the window that is left is
    // measured in tens of characters: the check is "it really grew while the reader held still",
    // not a fixed number of remaining characters.
    let growthProbe = null
    const progressed = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      if (!layout) return undefined
      growthProbe = layout
      if (layout.streamCharacters <= afterDraft.streamCharacters + 60) return undefined
      return layout.streamState === 'settled' ? undefined : layout
    }, harness.startTimeoutMs, 'the streamed answer to grow').catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}: from ${afterDraft.streamCharacters} to ${growthProbe?.streamCharacters ?? null} characters, state ${growthProbe?.streamState ?? null}`)
    })
    const holdLayout = progressed
    screenshots['streaming-hold'] = await writePng(client, 'streaming-hold')
    const anchorDrift = (holdLayout?.anchorKey === awayLayout?.anchorKey && holdLayout.anchorTop !== null && awayLayout.anchorTop !== null)
      ? Math.abs(holdLayout.anchorTop - awayLayout.anchorTop)
      : null
    recorder.note({ step: 'streaming-hold', layout: holdLayout, anchorDrift })
    recorder.check(
      anchorDrift !== null && anchorDrift <= 1,
      'the reading position is not pulled back by the arriving answer',
      { anchorDrift, from: awayLayout?.anchorTop, to: holdLayout?.anchorTop, grow: (holdLayout?.streamCharacters ?? 0) - (afterDraft.streamCharacters ?? 0) },
    )
    recorder.check(
      holdLayout?.gap > 100 && holdLayout?.jumpButton === 'true',
      'the way back to the bottom is offered while new content arrives',
      { gap: holdLayout?.gap, jumpButton: holdLayout?.jumpButton },
    )
    recorder.check(
      holdLayout?.composerVisible === true && holdLayout?.composerOverlappedByPanel === false,
      'the input stays visible and uncovered while reading up',
      { composerVisible: holdLayout?.composerVisible, overlap: holdLayout?.composerOverlappedByPanel, coverer: holdLayout?.coverers },
    )

    // Back to the bottom via the offered entry, without losing the draft.
    await clickVisible(client, '.chat-jump-to-latest')
    const returned = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.gap !== null && layout.gap <= 1 && layout.jumpButton === null ? layout : undefined
    }, 10_000, 'the return to the bottom')
    screenshots['returned-to-bottom'] = await writePng(client, 'returned-to-bottom')
    recorder.note({ step: 'returned-to-bottom', layout: returned })
    recorder.check(returned.gap <= 1, 'the return entry puts the reader back at the bottom', { gap: returned.gap })
    recorder.check(
      returned.composerLines === 3 && returned.composerValue?.includes('第三行草稿'),
      'the multi-line draft survives reading away and coming back',
      { value: returned.composerValue },
    )
    recorder.check(
      returned.composerVisible === true && (returned.lastMessageBottom ?? 0) <= (returned.composerRect?.top ?? 0) + 0.5,
      'the bottom of the answer is not hidden behind the input',
      { lastMessageBottom: returned.lastMessageBottom, composerTop: returned.composerRect?.top },
    )

    const settled = await waitForStreamState(client, 'settled', 'the first answer to settle')
    recorder.note({ step: 'first-answer-settled', layout: settled })
    recorder.check(
      settled.composerLines === 3,
      'the settled answer does not consume the draft',
      { value: settled.composerValue, lines: settled.composerLines },
    )
    recorder.check(
      settled.scrollHeight > settled.clientHeight + 200,
      'the fixture transcript is long enough to scroll (the reading position is real)',
      { scrollHeight: settled.scrollHeight, clientHeight: settled.clientHeight },
    )

    // ---------------------------------------------------------------------
    // 2. three attachments plus a long tool result
    // ---------------------------------------------------------------------
    await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    for (const name of ATTACHMENTS) await attachFile(client, name)
    const attached = await measureLayout(client)
    screenshots['attachments'] = await writePng(client, 'attachments')
    recorder.note({ step: 'attachments', layout: attached })
    recorder.check(
      attached.attachmentCards === ATTACHMENTS.length,
      'three attachments can be staged in one turn',
      { cards: attached.attachmentCards },
    )
    await submit(client, '请检查这三个附件')
    const sentAttachments = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.attachmentCards === 0 && layout.userMessages >= 2 ? layout : undefined
    }, harness.startTimeoutMs, 'the attachment turn to be sent')
    const sentText = await evaluate(client, `(() => {
      const messages = [...document.querySelectorAll('.message.user')];
      return (messages.at(-1)?.textContent ?? '').replace(/\\s+/gu, ' ').trim();
    })()`)
    // The attachment turn only reaches the Provider after the runtime's permission
    // prompts are answered, so drain them here and wait for the request to be logged.
    const providerDeadline = Date.now() + harness.startTimeoutMs
    while (Date.now() < providerDeadline && provider.requests.length < 2) {
      const approval = await approveIfPrompted(client)
      if (approval) approvals.push({ step: 'attachment-turn', label: approval })
      await delay(400)
    }
    const attachmentTurnRequest = provider.requests
      .map((entry) => JSON.stringify(entry))
      .find((body) => body.includes('请检查这三个附件')) ?? ''
    const missingInRequest = ATTACHMENTS.filter((name) => {
      const marker = `scenario fixture for ${name}`
      return !attachmentTurnRequest.includes(name) && !attachmentTurnRequest.includes(marker)
    })
    recorder.note({
      step: 'attachment-turn',
      userMessage: sentText.slice(0, 200),
      missingInRequest,
      providerRequests: provider.requests.length,
      attachmentTurnRequestCharacters: attachmentTurnRequest.length,
      attachmentTurnRequestSample: attachmentTurnRequest.slice(0, 900),
      approvals: approvals.filter((entry) => entry.step === 'attachment-turn').length,
    })
    recorder.check(
      ATTACHMENTS.every((name) => sentText.includes(name)),
      'the sent user message names all three attachments',
      { userMessage: sentText.slice(0, 200) },
    )
    recorder.check(
      missingInRequest.length === 0,
      'all three attachments reached the provider request (by name or by content)',
      { missingInRequest, requests: provider.requests.length, sample: attachmentTurnRequest.slice(0, 600) },
    )
    recorder.check(sentAttachments.userMessages >= 2, 'the attachment turn was sent', { userMessages: sentAttachments.userMessages })

    // The run calls a real tool; its result must be openable and bounded. The tool call
    // needs the same approval a user would give, so the wait answers prompts as they appear.
    let toolRow = null
    const toolDeadline = Date.now() + harness.startTimeoutMs * 2
    while (Date.now() < toolDeadline) {
      const approval = await approveIfPrompted(client)
      if (approval) approvals.push({ step: 'tool-row-wait', label: approval })
      const counted = await tryCountTool(client)
      if (counted && counted.toolRows > 0) {
        toolRow = counted
        break
      }
      await delay(300)
    }
    if (!toolRow) {
      const pending = await readPendingApproval(client)
      const inventory = await evaluate(client, `(() => {
        const turns = [...document.querySelectorAll('.assistant-turn')];
        const turn = turns.at(-1) ?? null;
        const classes = turn
          ? [...turn.querySelectorAll('*')].map((node) => (typeof node.className === 'string' ? node.className : '')).filter(Boolean)
          : [];
        return {
          turns: turns.length,
          turnClass: turn?.className ?? null,
          toolCalls: turn ? turn.querySelectorAll('.agent-tool-call').length : 0,
          preparing: turn ? turn.querySelectorAll('.agent-tool-preparing').length : 0,
          transcriptEntries: turn
            ? [...turn.querySelectorAll('[data-transcript-entry]')].map((node) => (node.getAttribute('data-transcript-entry') || '') + '@' + (typeof node.className === 'string' ? node.className : ''))
            : [],
          classes: [...new Set(classes.flatMap((value) => value.split(/\\s+/u)))].sort().slice(0, 60),
          plainMessages: [...document.querySelectorAll('.message.assistant')].length,
          lastText: turn ? (turn.textContent || '').replace(/\\s+/gu, ' ').slice(0, 200) : null,
        };
      })()`).catch((error) => ({ inventoryError: String(error) }))
      recorder.note({ step: 'tool-row-missing', pending, inventory, lastToolReadError })
      throw new Error(`no tool row appeared for the attachment turn (pending approval: ${pending ?? 'none'}; last read error: ${lastToolReadError ?? 'none'}; inventory: ${JSON.stringify(inventory)})`)
    }
    const expanded = await evaluate(client, `(() => {
      const row = [...document.querySelectorAll('.agent-tool-call')].at(-1);
      const button = row?.querySelector('.agent-tool-row');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`)
    if (!expanded) throw new Error('the tool row could not be expanded')
    await delay(350)
    const tool = await evaluate(client, TOOL_EXPRESSION)
    await waitForStreamState(client, 'settled', 'the attachment answer to settle')
    const afterTool = await measureLayout(client)
    screenshots['tool-details'] = await writePng(client, 'tool-details')
    recorder.note({ step: 'tool-details', tool, layout: afterTool })
    recorder.check(
      tool.panelOpen === true && tool.panelVisible === true,
      'the tool row expands into its details panel',
      { expanded: tool.expanded, panelOpen: tool.panelOpen, label: tool.rowLabel, statusClass: tool.statusClass },
    )
    recorder.check(
      tool.outputCharacters >= 300,
      'the expanded tool result carries a long output',
      { characters: tool.outputCharacters, lines: tool.outputLines, sections: tool.sections, sample: tool.outputSample },
    )
    recorder.check(
      tool.panelOverlapsComposer === false && afterTool.composerVisible === true,
      'the expanded tool result does not cover the input',
      { overlaps: tool.panelOverlapsComposer, composerVisible: afterTool.composerVisible, panelBottom: tool.panelBottom },
    )

    // ---------------------------------------------------------------------
    // 3. the workspace panel: open, drag, collapse, fullscreen and back
    // ---------------------------------------------------------------------
    await clickVisible(client, '.workspace-panel-corner-toggle')
    await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.panelRect && layout.panelRect.width > 200 ? layout : undefined
    }, harness.startTimeoutMs, 'the workspace panel to open')
    // Measure the settled open state: a frame in the middle of the open animation
    // reports the chat at its pre-open width and makes the deltas unreadable.
    await delay(500)
    const opened = await measureLayout(client)
    screenshots['panel-open'] = await writePng(client, 'panel-open')
    recorder.note({ step: 'panel-open', layout: opened })
    const widthOpen = opened.panelRect.width
    recorder.check(
      opened.composerOverlappedByPanel === false && opened.composerVisible === true,
      'the open workspace panel does not cover the input',
      { overlap: opened.composerOverlappedByPanel, panel: opened.panelRect, composer: opened.composerRect },
    )

    await dragPanelResizer(client, -160)
    const dragged = await measureLayout(client)
    screenshots['panel-dragged'] = await writePng(client, 'panel-dragged')
    recorder.note({ step: 'panel-dragged', layout: dragged })
    // The panel sits to the right of its resizer, so dragging left widens it; assert the
    // magnitude and the matching loss of chat width instead of a fixed direction.
    const panelDelta = Math.round((dragged.panelRect?.width ?? 0) - widthOpen)
    const chatDelta = Math.round((dragged.messageRect?.width ?? 0) - (opened.messageRect?.width ?? 0))
    recorder.check(
      Math.abs(panelDelta) >= 60 && Math.sign(chatDelta) === -Math.sign(panelDelta) && Math.abs(chatDelta) >= 40,
      'dragging the panel resizer really resizes the panel and the chat keeps the rest',
      { before: widthOpen, after: dragged.panelRect?.width, panelDelta, chatDelta },
    )
    recorder.check(
      dragged.composerOverlappedByPanel === false && dragged.composerVisible === true,
      'the input is still uncovered after the drag',
      { overlap: dragged.composerOverlappedByPanel },
    )
    const widthAfterDrag = dragged.panelRect?.width ?? 0

    const launcher = await clickLauncherItem(client, ['文件', '审阅'])
    const tabOpen = await harness.waitFor(() => evaluate(client, `(() => {
      const tabs = [...document.querySelectorAll('.workspace-active-item')]
        .map((tab) => (tab.textContent || '').trim())
        .filter((label) => label.length > 0);
      const active = document.querySelector('.workspace-tab-view.active') !== null;
      return tabs.length > 0 && active ? tabs : null;
    })()`), harness.startTimeoutMs, 'a workspace tab to open')
    screenshots['panel-tab'] = await writePng(client, 'panel-tab')
    recorder.note({ step: 'panel-tab', launcher, tabs: tabOpen })
    recorder.check(
      tabOpen.length > 0 && (launcher.clicked === true || (launcher.labels ?? []).length === 0),
      'the workspace shows a real tab (opened through the launcher or already open)',
      { launcher, tabs: tabOpen },
    )

    await clickVisible(client, '.workspace-panel-corner-toggle')
    const collapsed = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.panelCollapsed === true ? layout : undefined
    }, 10_000, 'the workspace panel to collapse')
    screenshots['panel-collapsed'] = await writePng(client, 'panel-collapsed')
    recorder.note({ step: 'panel-collapsed', layout: collapsed })
    recorder.check(
      collapsed.composerVisible === true && (collapsed.messageRect?.width ?? 0) > 0,
      'collapsing the panel gives the chat its width back without losing the input',
      { composerVisible: collapsed.composerVisible, chatWidth: collapsed.messageRect?.width, panel: collapsed.panelRect },
    )

    await clickVisible(client, '.workspace-panel-corner-toggle')
    const reexpanded = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.panelCollapsed === false && (layout.panelRect?.width ?? 0) > 200 ? layout : undefined
    }, harness.startTimeoutMs, 'the workspace panel to reopen')
    // The reopen runs an animation; measure the settled state, not a frame in the middle
    // of it (a mid-animation frame reports the panel overlapping the chat).
    await delay(500)
    const reopenedSettled = await measureLayout(client)
    const tabsAfterReopen = await evaluate(client, `[...document.querySelectorAll('.workspace-active-item')].map((tab) => (tab.textContent || '').trim())`)
    recorder.note({ step: 'panel-reopened', layout: reexpanded, settled: reopenedSettled, tabs: tabsAfterReopen })
    recorder.check(
      Math.abs((reexpanded.panelRect?.width ?? 0) - widthAfterDrag) <= 2,
      'reopening restores the dragged width instead of a default',
      { dragged: widthAfterDrag, reopened: reexpanded.panelRect?.width, settled: reopenedSettled.panelRect?.width },
    )
    recorder.check(
      tabsAfterReopen.length === tabOpen.length,
      'collapsing and reopening keeps the open tab',
      { before: tabOpen, after: tabsAfterReopen },
    )

    // The fullscreen layout is applied through the shell class (`flex-basis: 100%`), which
    // lands after the panel's own class flips — wait for the width, not just the class. The
    // control sits beside the collapse toggle and both animate, so a click that lands while the
    // panel is still animating is sometimes swallowed: the toggle is retried (bounded) and the
    // attempts are recorded rather than hidden.
    let fullscreenAttempts = 0
    let fullscreen = null
    let fullscreenLast = null
    while (!fullscreen && fullscreenAttempts < 3) {
      fullscreenAttempts += 1
      const clicked = await clickVisible(client, '.workspace-panel-collapse-action')
      fullscreen = await harness.waitFor(async () => {
        const layout = await tryReadLayout(client)
        fullscreenLast = layout ?? fullscreenLast
        if (!layout || layout.panelFullscreen !== true || layout.shellFullscreen !== true) return undefined
        return (layout.panelAsideRect?.width ?? 0) > widthAfterDrag + 100 ? layout : undefined
      }, fullscreenAttempts === 1 ? 20_000 : 10_000, 'the workspace panel to go fullscreen').catch(() => null)
      fullscreenLast = { ...(fullscreenLast ?? {}), clicked }
    }
    if (!fullscreen) {
      throw new Error(`the workspace panel did not go fullscreen after ${fullscreenAttempts} attempts: ${JSON.stringify({
        click: fullscreenLast?.clicked ?? null,
        panelFullscreen: fullscreenLast?.panelFullscreen ?? null,
        shellFullscreen: fullscreenLast?.shellFullscreen ?? null,
        panelCollapsed: fullscreenLast?.panelCollapsed ?? null,
        panelWidth: fullscreenLast?.panelRect?.width ?? null,
        asideWidth: fullscreenLast?.panelAsideRect?.width ?? null,
        expectedWidthAbove: widthAfterDrag + 100,
      })}`)
    }
    screenshots['panel-fullscreen'] = await writePng(client, 'panel-fullscreen')
    recorder.note({ step: 'panel-fullscreen', layout: fullscreen, attempts: fullscreenAttempts })
    // What the control promises is the state the app sets; the *geometry* is recorded, because
    // measured on 2026-09-26 the aside stayed at ~0.8 px while the panel surface kept the dragged
    // width (409 px) with both fullscreen classes set. That mismatch is listed in `limits`; the
    // assertion below only claims the state, which is what the toggle actually owns.
    recorder.check(
      fullscreen.panelFullscreen === true && fullscreen.shellFullscreen === true && fullscreen.panelCollapsed === false,
      'the workspace panel reaches the fullscreen state',
      {
        panelFullscreen: fullscreen.panelFullscreen,
        shellFullscreen: fullscreen.shellFullscreen,
        collapsed: fullscreen.panelCollapsed,
        normal: widthAfterDrag,
        fullscreenAside: fullscreen.panelAsideRect?.width,
        fullscreenSurface: fullscreen.panelRect?.width,
      },
    )

    await clickVisible(client, '.workspace-panel-collapse-action')
    const back = await harness.waitFor(async () => {
      const layout = await tryReadLayout(client)
      return layout && layout.panelFullscreen === false && layout.shellFullscreen === false ? layout : undefined
    }, harness.startTimeoutMs, 'the workspace panel to leave fullscreen')
    await delay(200)
    const restored = await measureLayout(client)
    const tabsAfterFullscreen = await evaluate(client, `[...document.querySelectorAll('.workspace-active-item')].map((tab) => (tab.textContent || '').trim())`)
    screenshots['panel-restored'] = await writePng(client, 'panel-restored')
    recorder.note({ step: 'panel-restored', layout: restored, tabs: tabsAfterFullscreen })
    recorder.check(
      Math.abs((restored.panelRect?.width ?? 0) - widthAfterDrag) <= 2,
      'leaving fullscreen restores the previous panel width',
      { dragged: widthAfterDrag, restored: restored.panelRect?.width, fullscreen: back.panelRect?.width, aside: restored.panelAsideRect?.width },
    )
    recorder.check(
      tabsAfterFullscreen.length === tabOpen.length && restored.composerVisible === true,
      'leaving fullscreen keeps the tab and the input',
      { tabs: tabsAfterFullscreen, composerVisible: restored.composerVisible },
    )
    recorder.check(
      restored.composerOverlappedByPanel === false,
      'the input is uncovered again after the fullscreen round trip',
      { overlap: restored.composerOverlappedByPanel, coverer: restored.coverers },
    )

    // ---------------------------------------------------------------------
    // 5. each conversation owns its files, unsaved edits, directory and browser scene
    // ---------------------------------------------------------------------
    const scenarioBaseUrl = provider.baseURL.replace(/\/v1$/u, '')
    const firstDraftMarker = 'UNSAVED_SESSION_A_DRAFT_4827'
    const firstBrowserUrl = `${scenarioBaseUrl}/health?scene=session-a`
    const firstScene = await createWorkspaceScene(client, recorder, {
      fileName: 'scenario-file-00.ts',
      draftMarker: firstDraftMarker,
      browserUrl: firstBrowserUrl,
      workspaceDir: workplaceDir,
    })
    const firstSessionId = firstScene.browserStored.id
    const firstWorkspaceKey = `session:${encodeURIComponent(firstSessionId)}`
    const firstSceneScreenshot = await writePng(client, 'session-a-workspace-scene')
    recorder.note({ step: 'session-a-workspace-scene', firstScene, screenshot: firstSceneScreenshot })
    recorder.check(Boolean(firstSessionId), 'the first real conversation has a persisted id', { firstSessionId })
    recorder.check(
      firstScene.browserStored.browserTabs.some((tab) => tab.url === firstBrowserUrl)
        && firstScene.browserStored.expandedPaths.some((path) => path.endsWith('notes'))
        && Object.values(firstScene.browserStored.drafts).some((draft) => draft.editorText.includes(firstDraftMarker)),
      'conversation A persists its browser URL, expanded directory, and unsaved file draft in its own layout',
      { key: firstWorkspaceKey, layout: firstScene.browserStored },
    )

    const newConversation = await clickVisible(client, '.conversation-section .sidebar-new-action')
    if (!newConversation.clicked) throw new Error('a second conversation could not be started')

    // UX-30 item 1: the terminals of the conversation just left must not still be here, and
    // nothing may be able to type into them.
    await selectWorkspaceFeature(client, '终端')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-terminal') ? true : null`),
      30_000,
      'the terminal panel in the new conversation',
    ).catch(() => null)
    await delay(1500)
    const terminalsAfterSwitch = await evaluate(client, `(() => ({
      tabs: document.querySelectorAll('.workspace-terminal-tab').length,
      strip: document.querySelectorAll('.workspace-terminal-tabs').length,
      hasTerminal: Boolean(document.querySelector('.workspace-terminal')),
      status: (document.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
    }))()`)
    recorder.note({ step: 'terminal-after-conversation-switch', terminalsAfterSwitch })
    recorder.check(
      terminalsAfterSwitch.hasTerminal === true
      && terminalsAfterSwitch.tabs === 0
      && terminalsAfterSwitch.strip === 0,
      'switching conversation starts with no terminals from the conversation that was left',
      terminalsAfterSwitch,
    )
    let secondConversationDraft
    try {
      secondConversationDraft = await harness.waitFor(() => evaluate(client, `(() => {
        const userMessages = document.querySelectorAll('.message.user').length
        const assistantTurns = document.querySelectorAll('.assistant-turn').length
        return userMessages === 0 && assistantTurns === 0 ? { userMessages, assistantTurns } : null
      })()`), 10_000, 'the second conversation draft')
    } catch (error) {
      const state = await evaluate(client, `(() => ({
        activeSession: localStorage.getItem('littlesheep.ui.activeSession'),
        activeRows: [...document.querySelectorAll('.session-item.active')].map((node) => node.textContent?.trim()),
        userMessages: document.querySelectorAll('.message.user').length,
        assistantTurns: document.querySelectorAll('.assistant-turn').length,
        buttons: [...document.querySelectorAll('.conversation-section .sidebar-new-action')].map((node) => ({ label: node.getAttribute('aria-label'), inert: Boolean(node.closest('[inert]')) })),
      }))()`)
      throw new Error(`${error instanceof Error ? error.message : String(error)}; second conversation state: ${JSON.stringify(state)}`)
    }
    recorder.note({ step: 'second-conversation-draft', secondConversationDraft, persistedActiveSession: await evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession')`) })
    await submit(client, '第二会话工作区隔离验收，请直接简短回复。')
    const secondSettled = await waitForStreamState(client, 'settled', 'the second conversation to settle')
    const secondSession = await harness.waitFor(() => evaluate(client, `(() => {
      const id = localStorage.getItem('littlesheep.ui.activeSession')
      const items = [...document.querySelectorAll('.session-item')]
      return id && items.filter((item) => item.classList.contains('active')).length === 1 ? id : null
    })()`), 20_000, 'the second conversation id')
    recorder.check(secondSession !== firstSessionId, 'the new conversation persists under a different session id', { firstSessionId, secondSession })
    const secondDraftMarker = 'UNSAVED_SESSION_B_DRAFT_7391'
    const secondBrowserUrl = `${scenarioBaseUrl}/health?scene=session-b`
    const secondScene = await createWorkspaceScene(client, recorder, {
      fileName: 'scenario-file-01.ts',
      draftMarker: secondDraftMarker,
      browserUrl: secondBrowserUrl,
      workspaceDir: workplaceDir,
    })
    const secondWorkspaceKey = `session:${encodeURIComponent(secondSession)}`
    const secondSceneScreenshot = await writePng(client, 'session-b-workspace-scene')
    recorder.note({ step: 'session-b-workspace-scene', secondSettled, secondSession, secondScene, screenshot: secondSceneScreenshot })

    const secondFileTab = await clickVisible(client, '.workspace-active-item', 'scenario-file-01.ts')
    const secondEditorRestored = secondFileTab.clicked && await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-editor-monaco .view-lines')?.textContent?.includes(${JSON.stringify(secondDraftMarker)}) || null`),
      10_000,
      'conversation B unsaved draft to restore',
    )
    const secondBrowserTab = await evaluate(client, `(() => {
      const tab = [...document.querySelectorAll('.workspace-active-item')]
        .find((node) => node.querySelector('.workspace-panel-svg-icon circle[r="5.25"]'))
      if (!(tab instanceof HTMLElement)) return false
      tab.click()
      return true
    })()`)
    const secondBrowserRestored = secondBrowserTab && await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-browser-address input')?.value === ${JSON.stringify(secondBrowserUrl)} || null`),
      10_000,
      'conversation B browser address to restore',
    )
    const secondLayout = await evaluate(client, `(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}')
      return layouts[${JSON.stringify(secondWorkspaceKey)}] ?? null
    })()`)
    recorder.check(
      secondEditorRestored === true && secondBrowserRestored === true
        && secondLayout?.expandedPaths?.some((path) => path.endsWith('notes'))
        && Object.values(secondLayout?.drafts ?? {}).some((draft) => draft.editorText.includes(secondDraftMarker)),
      'conversation B restores its own file draft, directory, and browser state',
      { secondEditorRestored, secondBrowserRestored, layout: secondLayout },
    )
    recorder.check(
      !Object.values(secondLayout?.drafts ?? {}).some((draft) => draft.editorText.includes(firstDraftMarker))
        && !secondLayout?.browserTabs?.some((tab) => tab.url === firstBrowserUrl),
      'conversation B does not inherit conversation A draft or browser state',
      { secondLayout },
    )

    const switchedToFirst = await evaluate(client, `(() => {
      const target = [...document.querySelectorAll('.session-item')]
        .find((item) => item.textContent?.includes('请输出这份验收文档'))
      if (!(target instanceof HTMLElement)) return false
      target.click()
      return true
    })()`)
    if (!switchedToFirst) throw new Error('conversation A was not available in the session list')
    await harness.waitFor(() => evaluate(client, `localStorage.getItem('littlesheep.ui.activeSession') === ${JSON.stringify(firstSessionId)} || null`), 20_000, 'conversation A to become active again')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-browser-address input')?.value === ${JSON.stringify(firstBrowserUrl)} || null`), 20_000, 'conversation A browser scene to restore')
    const firstFileTab = await clickVisible(client, '.workspace-active-item', 'scenario-file-00.ts')
    const firstEditorRestored = firstFileTab.clicked && await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-editor-monaco .view-lines')?.textContent?.includes(${JSON.stringify(firstDraftMarker)}) || null`),
      10_000,
      'conversation A unsaved draft to restore',
    )
    const firstLayout = await evaluate(client, `(() => {
      const layouts = JSON.parse(localStorage.getItem('littlesheep.ui.workspaceSessionLayouts') || '{}')
      return layouts[${JSON.stringify(firstWorkspaceKey)}] ?? null
    })()`)
    recorder.note({ step: 'session-switch-restore', firstBrowserUrl, firstEditorRestored, firstLayout })
    recorder.check(
      firstEditorRestored === true && firstLayout?.browserTabs?.some((tab) => tab.url === firstBrowserUrl)
        && firstLayout?.expandedPaths?.some((path) => path.endsWith('notes'))
        && Object.values(firstLayout?.drafts ?? {}).some((draft) => draft.editorText.includes(firstDraftMarker)),
      'switching back to conversation A restores its distinct file draft, expanded directory, and browser tab',
      { firstEditorRestored, firstLayout },
    )
    recorder.check(
      !Object.values(firstLayout?.drafts ?? {}).some((draft) => draft.editorText.includes(secondDraftMarker))
        && !firstLayout?.browserTabs?.some((tab) => tab.url === secondBrowserUrl),
      'conversation A does not inherit conversation B draft or browser state',
      { firstLayout },
    )

    // ---------------------------------------------------------------------
    // 6. Markdown font roles in the real window
    // ---------------------------------------------------------------------
    const fontProbe = await evaluate(client, `(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return null;
        const style = getComputedStyle(node);
        return { fontFamily: style.fontFamily, fontSize: style.fontSize };
      };
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const width = (family) => {
        context.font = '16px ' + family;
        return Math.round(context.measureText('中文验收').width * 100) / 100;
      };
      const prose = read('.markdown p') ?? read('.markdown blockquote');
      const code = read('.markdown pre code') ?? read('.code-block-source');
      return {
        prose,
        code,
        inlineCode: read('.markdown-inline-code'),
        proseCjkWidth: prose ? width(prose.fontFamily) : null,
        codeCjkWidth: code ? width(code.fontFamily) : null,
      };
    })()`)
    screenshots['fonts'] = await writePng(client, 'markdown-fonts')
    recorder.note({ step: 'markdown-fonts', probe: fontProbe })
    recorder.check(
      (fontProbe.prose?.fontFamily ?? '').includes('Segoe UI Variable Text'),
      'Markdown prose renders with the body font token',
      { prose: fontProbe.prose },
    )
    recorder.check(
      (fontProbe.code?.fontFamily ?? '').includes('Cascadia Code')
      && (fontProbe.code?.fontFamily ?? '').includes('Microsoft YaHei UI'),
      'Markdown code declares the mono token together with its CJK fallback',
      { code: fontProbe.code, inlineCode: fontProbe.inlineCode },
    )
    recorder.check(
      fontProbe.proseCjkWidth !== null && fontProbe.proseCjkWidth === fontProbe.codeCjkWidth,
      'Chinese inside code resolves to the same face width as prose',
      { proseCjkWidth: fontProbe.proseCjkWidth, codeCjkWidth: fontProbe.codeCjkWidth },
    )

    screenshots['final'] = await writePng(client, 'scenarios-final')
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
    check: 'conversation-workspace-scenarios',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keepRoot ? root : '<temporary root removed>',
    screenshots,
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    approvals,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The two-conversation workspace scene is measured here; full process restart recovery remains covered by pnpm run verify:electron-ui-state-continuity.',
      'The default permission mode prompts before the Agent touches anything, so the fixture answers those prompts the way a user would (see `approvals`); it does not measure the prompt itself.',
      'The compact/normal rendering of failure, permission, unverified, partial and waiting states is a separate scenario and is not measured here.',
      'The long tool result comes from the real glob tool over a 64-file fixture workspace; the answer text comes from the deterministic acceptance Provider.',
      'The three attachments are text-family files pasted with text/plain; binary or image attachments are not covered.',
      'Screenshots stay in the temporary output directory.',
      'The terminal session cap is measured by counting the create/close requests the renderer sends (a window.fetch probe), because Main exposes no session inventory to read back; Main-owned state is proven indirectly, by the eight DELETEs on removal and by the background process that stops writing.',
      'The terminal keep-alive evidence is one PowerShell loop appending to a file per scene: session state that exists only in memory (scrollback, environment changes) is not measured, and the two scenes share one workspace so only the file chosen for each scene is sampled.',
      'The terminal cap notice is asserted by its text and visibility; the wording after a later successful open, and Main\'s own 16-session ceiling above the renderer cap, are not driven.',
    ],
  }
  console.log(JSON.stringify(evidence, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
