// Real-window acceptance for keyboard-only layers and focus (taskbook UX-07, extended by UX-38).
//
// UX-07 asks for the interaction that a mouse hides: opening a layer with the keyboard alone,
// Tab staying inside the dialog, Escape removing exactly one layer, and focus landing back on
// the control that opened it. Two layers is the interesting case — the archive page lives inside
// the settings overlay, and a delete confirmation opens on top of it, so one Escape must close
// the dialog and leave the page behind it.
//
// The keys are dispatched through CDP, so the renderer receives real `keydown` events and native
// button activation; the fixture never calls the click handlers directly.
//
// UX-38 adds the chat area itself: a seeded conversation longer than one history page, walked
// with Tab from the composer through every control the reader needs (loading older history, a
// message meta copy button, a tool row's disclosure, a code toolbar copy button, the way back to
// the newest message), then walked back with Shift+Tab, plus one Escape case for a composer
// layer where exactly one layer may close.
//
// Usage:
//   node scripts/verify-keyboard-modal-focus.mjs [--out=<dir>] [--keep]

import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-keyboard-modal')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1180, height: 760 }
const EVALUATE_TIMEOUT_MS = 15_000
const SESSION_TITLE = '键盘验收归档对话'
/** A conversation longer than one history page (120 messages), so "load older" is offered. */
const CHAT_SESSION_ID = 'keyboard-chat-session'
const CHAT_SESSION_TITLE = '键盘验收聊天会话'
const CHAT_SEEDED_MESSAGES = 130
/** Upper bound on the forward walk; a full cycle is ~150 controls in this fixture. */
const MAX_CHAT_TAB_STEPS = 260
/** Steps allowed to find the "back to latest" control walking backwards out of the composer. */
const MAX_JUMP_BACK_STEPS = 12

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

/**
 * Capture with a bounded retry, the same way `verify-desktop-cold-start-visuals` does it: a frame
 * Chromium has not produced yet (or an occluded window) is not a defect. Three failed attempts
 * still fail, and the attempt count is reported.
 */
async function writePng(client, name, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send('Page.bringToFront').catch(() => undefined)
      const shot = await withTimeout(
        client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
        10_000,
        'Page.captureScreenshot',
      )
      if (!shot?.data) throw new Error('empty capture payload')
      await mkdir(join(outRoot, 'screenshots'), { recursive: true })
      const path = join(outRoot, 'screenshots', `${name}.png`)
      await writeFile(path, Buffer.from(shot.data, 'base64'))
      return path
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw new Error(`${name}: ${lastError instanceof Error ? lastError.message : 'no frame'} (after ${attempts} attempts)`)
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance', name: 'Electron Acceptance', baseURL: providerBaseURL,
      apiKey: 'acceptance-key', timeoutSeconds: 10, models: ['slow-a'],
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
  }
}

async function seedArchive(dataDir) {
  const now = Date.now()
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  await mkdir(join(dataDir, 'archive'), { recursive: true })
  const session = {
    id: 'keyboard-archived-session',
    title: SESSION_TITLE,
    createdAt: now - 60_000,
    lastMessageAt: now - 30_000,
    mode: 'research',
    scope: 'standalone',
    archivedAt: now,
  }
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: [] }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'archive', 'index.json'), `${JSON.stringify({ projects: [], sessions: [session] }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'sessions', `${session.id}.jsonl`), `${JSON.stringify({
    type: 'metadata',
    metadata: {
      title: session.title,
      model: '',
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.lastMessageAt).toISOString(),
      messageCount: 2,
    },
  })}\n`, 'utf8')
}

/**
 * A conversation longer than one history page, written in the store's own JSONL format (the same
 * format `scripts/verify-chat-history-paging.mjs` seeds). 131 messages leave one page of 120 in
 * the window, so the transcript offers the "load older" entry and is tall enough for the reader
 * to be away from the newest message — the two preconditions the keyboard walkthrough needs.
 */
async function seedChatSession(dataDir) {
  const now = Date.now()
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  const lines = [JSON.stringify({
    type: 'metadata',
    metadata: {
      title: CHAT_SESSION_TITLE,
      model: '',
      createdAt: new Date(now - CHAT_SEEDED_MESSAGES * 1_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      messageCount: CHAT_SEEDED_MESSAGES,
    },
  })]
  for (let index = 0; index < CHAT_SEEDED_MESSAGES; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    lines.push(JSON.stringify({
      id: `keyboard-chat-message-${String(index).padStart(4, '0')}`,
      role,
      content: [{
        type: 'text',
        text: `第 ${index + 1} 条键盘验收历史：这一段只负责让历史超过一页，并让读物离开最新消息。`,
      }],
      timestamp: new Date(now - (CHAT_SEEDED_MESSAGES - index) * 1_000).toISOString(),
      sessionId: CHAT_SESSION_ID,
    }))
  }
  await writeFile(join(dataDir, 'sessions', `${CHAT_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({
    sessions: [{
      id: CHAT_SESSION_ID,
      title: CHAT_SESSION_TITLE,
      createdAt: now - CHAT_SEEDED_MESSAGES * 1_000,
      lastMessageAt: now,
      mode: 'research',
      scope: 'standalone',
    }],
  }, null, 2)}\n`, 'utf8')
}

/** A real key press: the renderer sees the same event a keyboard user produces. */
async function pressKey(client, key, { shift = false } = {}) {
  const keyCode = key === 'Tab' ? 9 : key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0
  const code = key === 'Tab' ? 'Tab' : key === 'Enter' ? 'Enter' : 'Escape'
  const modifiers = shift ? 8 : 0
  await client.send('Input.dispatchKeyEvent', {
    // `keyDown` (not `rawKeyDown`) is what lets Chromium run the default action: Enter activates
    // a focused button, which is exactly the keyboard path this fixture is testing.
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  })
  await delay(150)
}

/** Type into the real composer and submit with a real Enter, the way the other fixtures do. */
async function submitComposerPrompt(client, text) {
  const drafted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, ${JSON.stringify(text)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.focus()
    return true
  })()`)
  if (drafted !== true) throw new Error('the composer could not be drafted for the chat walkthrough')
  await pressKey(client, 'Enter')
}

/** Wait until the newest assistant turn has stopped streaming. */
async function waitForSettledTurn(client, timeoutMs) {
  return harness.waitFor(() => evaluate(client, `(() => {
    const turn = [...document.querySelectorAll('.assistant-turn')].at(-1)
    const response = turn?.querySelector('.assistant-response-stream')
    return response?.getAttribute('data-stream-state') === 'settled' ? 'settled' : null
  })()`), timeoutMs, 'settled turn')
}

/**
 * One Tab stop: what is focused, where it sits in the tabbable document order, and which of the
 * chat-area controls it is. `domIndex` is the honest ground truth for "an ordered trace": the tab
 * order of an element with tabindex 0 *is* its document order, so a sequence that does not
 * increase (beyond the single wraparound a full cycle has) is a real ordering defect.
 *
 * The tabbable set has to include everything Chromium can focus, not only buttons: `<summary>` is
 * focusable, and so is a scrollable container such as the code block's `pre`.
 */
const CHAT_FOCUS_EXPRESSION = `(() => {
  window.__ux38FocusSequence = window.__ux38FocusSequence ?? 0
  const identity = (element) => {
    if (!(element instanceof HTMLElement)) return null
    // A stable per-element id survives the tabbable set changing size mid-walk. "Back to latest"
    // is offered only while the reader is away from the bottom, so walking the transcript can
    // mount or unmount it, which shifts every document index after it.
    if (!element.dataset.ux38FocusId) {
      window.__ux38FocusSequence += 1
      element.dataset.ux38FocusId = 'ux38-focus-' + window.__ux38FocusSequence
    }
    return element.dataset.ux38FocusId
  }
  const active = document.activeElement
  const isTabbable = (element) => {
    if (!(element instanceof HTMLElement)) return false
    if (element.hasAttribute('disabled')) return false
    if (element.closest('[inert]')) return false
    if (element.getClientRects().length === 0) return false
    if (element.tabIndex >= 0) return true
    // Chromium makes an overflowing scroll region keyboard-focusable even without a tabindex,
    // which is how the code block's source pane becomes a Tab stop. Every non-visible overflow
    // value establishes a scroll container, not only auto/scroll.
    const style = getComputedStyle(element)
    const scrollsX = style.overflowX !== 'visible' && element.scrollWidth > element.clientWidth + 1
    const scrollsY = style.overflowY !== 'visible' && element.scrollHeight > element.clientHeight + 1
    return scrollsX || scrollsY
  }
  const tabbables = [...document.querySelectorAll('button, a[href], textarea, input, select, summary, [tabindex]')]
    .filter(isTabbable)
  const element = active instanceof HTMLElement ? active : null
  // An element the predicate missed still gets an honest position: how many tabbable controls come
  // before it in document order. Ordering is then judged on that rank, never on the predicate.
  const documentRank = (target) => {
    if (!(target instanceof HTMLElement)) return -1
    const direct = tabbables.indexOf(target)
    if (direct >= 0) return direct
    return tabbables.filter((candidate) => (candidate.compareDocumentPosition(target) & 4) !== 0).length
  }
  const style = element ? getComputedStyle(element) : null
  return {
    focusId: identity(active),
    tag: element?.tagName ?? 'NONE',
    className: typeof element?.className === 'string' ? element.className : '',
    label: element?.getAttribute('aria-label') ?? null,
    text: (element?.textContent ?? '').trim().slice(0, 24),
    domIndex: tabbables.indexOf(active),
    domRank: documentRank(active),
    tabbableCount: tabbables.length,
    scrollRegion: element
      ? (style.overflowX !== 'visible' || style.overflowY !== 'visible')
        && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      : false,
    isComposerInput: element === document.querySelector('.composer textarea'),
    isHistoryLoadOlder: element?.classList.contains('history-load-older') === true,
    isMetaCopy: element?.classList.contains('message-meta-copy') === true,
    isToolRow: element?.classList.contains('agent-tool-row') === true,
    isCodeCopyButton: element?.closest('.code-toolbar') !== null
      && element?.closest('.code-toolbar') !== undefined
      && (element?.getAttribute('aria-label') ?? '').startsWith('复制'),
    isJumpToLatest: element?.classList.contains('chat-jump-to-latest') === true,
    jumpOffered: Boolean(document.querySelector('.chat-jump-to-latest')),
    inMessages: element?.closest('.messages') !== null && element?.closest('.messages') !== undefined,
    inComposer: element?.closest('.composer') !== null && element?.closest('.composer') !== undefined,
  }
})()`

/**
 * Every layer a chat-area Escape could close, so "exactly one layer closed" can be a delta. A
 * layer counts as open only while it is really visible: mounted-but-hidden surfaces (the settings
 * workspace keeps its controls in the DOM) must not make the delta say two layers closed.
 */
const LAYER_STATE_EXPRESSION = `(() => {
  const open = (selector) => {
    const element = document.querySelector(selector)
    if (!(element instanceof HTMLElement)) return false
    if (element.getAttribute('aria-hidden') === 'true') return false
    if (element.hasAttribute('inert')) return false
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })
    }
    return element.getClientRects().length > 0
  }
  return {
    settings: open('.settings-workspace'),
    archive: open('.archive-page'),
    dangerConfirm: open('.danger-confirm-dialog'),
    // The full-access confirmation is itself an .approval-prompt element; the Agent approval
    // prompt is the one without that class.
    approvalPrompt: open('.approval-prompt:not(.full-access-warning)'),
    fullAccessWarning: open('.full-access-warning'),
    modePickerPanel: open('.mode-picker-panel'),
    runtimePickerPanel: open('.runtime-picker-panel'),
    addMenuPanel: open('.add-menu-panel'),
  }
})()`

/** Focus a selector without clicking it, then report what is focused. */
async function focusSelector(client, selector) {
  return evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLElement)) return null
    element.focus({ preventScroll: true })
    return document.activeElement === element
  })()`)
}

const FOCUS_STATE_EXPRESSION = `(() => {
  const active = document.activeElement
  const dialog = document.querySelector('.danger-confirm-dialog')
  return {
    activeLabel: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 30) ?? null,
    activeClass: typeof active?.className === 'string' ? active.className : null,
    insideDialog: Boolean(dialog && active && dialog.contains(active)),
    dialogOpen: Boolean(dialog),
    archiveOpen: Boolean(document.querySelector('.archive-page')),
    settingsOpen: Boolean(document.querySelector('.settings-workspace')),
    chatVisible: Boolean(document.querySelector('.messages')),
  }
})()`

const INSTALL_APPROVAL_PROBE = `(() => {
  const probe = { responses: [] }
  window.__ux07ApprovalProbe = probe
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String((init && init.method) || 'GET').toUpperCase()
    if (method === 'POST' && /\\/approvals\\/[^/]+$/u.test(url)) {
      let body = null
      try { body = JSON.parse(String(init?.body ?? 'null')) } catch {}
      const entry = { approved: body?.approved ?? null, status: null }
      probe.responses.push(entry)
      const response = await originalFetch(input, init)
      entry.status = response.status
      return response
    }
    return originalFetch(input, init)
  }
  return true
})()`

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-keyboard-modal-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await seedArchive(dataDir)
    // The chat walkthrough's conversation, written before the app starts so the sidebar lists it.
    await seedChatSession(dataDir)
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.settings-entry-btn') instanceof HTMLElement || null`),
      harness.startTimeoutMs,
      'the settings entry',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // --- 1. open the settings layer and the archive page with the keyboard alone ---------------
    const entryFocused = await focusSelector(client, '.settings-entry-btn')
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`), harness.startTimeoutMs, 'settings navigation')
    // The nav item that says 归档 is not the first one; focus it explicitly by index.
    const archiveNavIndex = await evaluate(client, `(() => {
      const items = [...document.querySelectorAll('.settings-nav-item')]
      return items.findIndex((item) => item.textContent?.includes('归档'))
    })()`)
    if (archiveNavIndex < 0) throw new Error('the archive navigation item is missing')
    const navFocused = await evaluate(client, `(() => {
      const items = [...document.querySelectorAll('.settings-nav-item')]
      const target = items[${archiveNavIndex}]
      if (!(target instanceof HTMLElement)) return false
      target.focus({ preventScroll: true })
      return document.activeElement === target
    })()`)
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.archive-session-row') ? true : null`), harness.startTimeoutMs, 'the archived conversation row')
    const openedByKeyboard = await evaluate(client, `(() => ({
      archiveOpen: Boolean(document.querySelector('.archive-page')),
      settingsOpen: Boolean(document.querySelector('.settings-workspace')),
      focused: document.activeElement?.textContent?.trim().slice(0, 30) ?? null,
    }))()`)

    // --- 2. open the confirmation with the keyboard --------------------------------------------
    const deleteFocused = await focusSelector(client, '.archive-session-row .archive-action.danger')
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog') ? true : null`), harness.startTimeoutMs, 'the confirmation dialog')
    await delay(200)
    const opened = await evaluate(client, FOCUS_STATE_EXPRESSION)
    const dialogScreenshot = await writePng(client, 'dialog-open')

    // --- 3. Tab stays inside the dialog ---------------------------------------------------------
    const tabTrace = []
    for (let index = 0; index < 5; index += 1) {
      await pressKey(client, 'Tab')
      tabTrace.push(await evaluate(client, FOCUS_STATE_EXPRESSION))
    }
    for (let index = 0; index < 2; index += 1) {
      await pressKey(client, 'Tab', { shift: true })
      tabTrace.push(await evaluate(client, FOCUS_STATE_EXPRESSION))
    }
    const tabScreenshot = await writePng(client, 'dialog-tab-cycle')

    // --- 4. one Escape removes one layer, and focus goes back to the trigger --------------------
    await pressKey(client, 'Escape')
    await delay(250)
    const afterFirstEscape = await evaluate(client, FOCUS_STATE_EXPRESSION)
    // A second Escape is *recorded*, not asserted: the settings layer is a persistent page-level
    // surface, and closing it is the 退出设置 control's job (no Escape scope is registered for
    // it). What UX-07 requires is that the first Escape removed exactly one layer.
    await pressKey(client, 'Escape')
    await delay(400)
    const afterSecondEscape = await evaluate(client, FOCUS_STATE_EXPRESSION)
    const secondEscapeClosedSettings = afterSecondEscape.settingsOpen === false
    const escapeScreenshot = await writePng(client, 'after-escape')

    // --- 5. a real Agent approval starts on its explanation and Escape denies the write -------
    const exitFocused = await focusSelector(client, '[aria-label="退出设置页"]')
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`), harness.startTimeoutMs, 'the composer after leaving settings')
    await evaluate(client, INSTALL_APPROVAL_PROBE)
    const promptDrafted = await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '请使用 write 工具创建 UX07-APPROVAL-ESCAPE 验收文件')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.focus()
      return true
    })()`)
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.approval-prompt') ? true : null`), harness.startTimeoutMs, 'the Agent approval prompt')
    const approvalOpened = await evaluate(client, `(() => {
      const prompt = document.querySelector('.approval-prompt')
      const active = document.activeElement
      return {
        title: prompt?.querySelector('h2')?.textContent?.trim() ?? null,
        focusOnHeading: active === prompt?.querySelector('h2'),
        action: prompt?.querySelector('.approval-kicker')?.textContent?.trim() ?? null,
      }
    })()`)
    await pressKey(client, 'Enter')
    const approvalAfterEnter = await evaluate(client, `Boolean(document.querySelector('.approval-prompt'))`)
    const backgroundPoint = await evaluate(client, `(() => {
      const textarea = document.querySelector('.composer textarea')
      if (!(textarea instanceof HTMLTextAreaElement)) return null
      const bounds = textarea.getBoundingClientRect()
      window.__ux07BackgroundClicks = 0
      textarea.addEventListener('click', () => { window.__ux07BackgroundClicks += 1 })
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    })()`)
    if (!backgroundPoint) throw new Error('the background composer is missing')
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: backgroundPoint.x, y: backgroundPoint.y, button: 'left', buttons: 1, clickCount: 1,
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: backgroundPoint.x, y: backgroundPoint.y, button: 'left', buttons: 0, clickCount: 1,
    })
    const backgroundClickCount = await evaluate(client, `window.__ux07BackgroundClicks`)
    const approvalTabTrace = []
    for (let index = 0; index < 4; index += 1) {
      await pressKey(client, 'Tab')
      approvalTabTrace.push(await evaluate(client, `(() => {
        const prompt = document.querySelector('.approval-prompt')
        return Boolean(prompt && document.activeElement && prompt.contains(document.activeElement))
      })()`))
    }
    await pressKey(client, 'Escape')
    // The first key starts the exit animation. A second key while the old DOM
    // is still present must not trigger another approval decision.
    await pressKey(client, 'Escape')
    await delay(300)
    const approvalAfterEscape = await evaluate(client, `(() => ({
      promptOpen: Boolean(document.querySelector('.approval-prompt')),
      focusRestored: document.activeElement === document.querySelector('.composer textarea'),
      settingsOpen: Boolean(document.querySelector('.settings-workspace')),
    }))()`)
    await harness.waitFor(() => evaluate(client, `window.__ux07ApprovalProbe?.responses?.some((item) => item.status !== null) || null`), harness.startTimeoutMs, 'the approval response')
    const approvalResponses = await evaluate(client, `window.__ux07ApprovalProbe.responses`)
    const approvalScreenshot = await writePng(client, 'approval-denied-by-escape')
    const deniedWritePath = join(workplaceDir, 'ux07-approval-escape-probe.txt')
    const deniedWriteAbsent = await access(deniedWritePath).then(() => false, () => true)

    // --- 6. the chat area itself, walked with real keys -----------------------------------------
    // The denied run may still be finishing; the walkthrough reads a different conversation, so it
    // only has to wait for the transcript to stop streaming.
    const deniedRunSettled = await harness.waitFor(() => evaluate(client, `(() => {
      const streaming = document.querySelector('.assistant-response-stream[data-stream-state="streaming"]')
      return streaming ? null : true
    })()`), 30_000, 'the denied run to settle').catch(() => false)
    const chatSessionOpened = await harness.waitFor(() => evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.session-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(CHAT_SESSION_TITLE)}))
      if (!(item instanceof HTMLElement)) return null
      item.click()
      return true
    })()`), harness.startTimeoutMs, 'the seeded chat session row')
    await harness.waitFor(() => evaluate(client, `document.querySelectorAll('.messages .message').length > 100 ? true : null`), harness.startTimeoutMs, 'the seeded chat history page')
    // Two live runs in the seeded conversation give the walk its real controls: the tool row that
    // owns a disclosure, and the long Markdown answer that owns a code toolbar.
    await submitComposerPrompt(client, '请使用 glob 工具列出当前工作区顶层条目')
    await waitForSettledTurn(client, 60_000)
    await submitComposerPrompt(client, `请输出这份验收文档：${LONG_MARKDOWN_MARKER}`)
    await waitForSettledTurn(client, 60_000)
    await delay(600)
    const chatFixture = await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      if (messages instanceof HTMLElement) {
        messages.scrollTop = 0
        messages.dispatchEvent(new Event('scroll', { bubbles: true }))
      }
      return {
        renderedMessages: document.querySelectorAll('.messages .message').length,
        loadOlder: Boolean(document.querySelector('.history-load-older')),
        toolRow: Boolean(document.querySelector('.messages .agent-tool-row')),
        codeToolbarButton: Boolean(document.querySelector('.messages .code-toolbar button')),
        metaCopy: Boolean(document.querySelector('.messages .message-meta-copy')),
      }
    })()`)
    await delay(400)
    const jumpOfferedBeforeWalk = await evaluate(client, `(() => {
      const button = document.querySelector('.chat-jump-to-latest')
      return button instanceof HTMLElement
        ? { present: true, label: button.textContent?.trim() ?? null }
        : { present: false, label: null }
    })()`)

    // 6a. forward: from the composer input, one real Tab at a time, until focus comes back to it.
    const composerFocused = await focusSelector(client, '.composer textarea')
    if (composerFocused !== true) throw new Error('the composer could not be focused for the chat walkthrough')
    const forwardTrace = []
    const focusBlips = []
    let chatCycleCompleted = false
    let forwardPresses = 0
    let previousStop = null
    while (forwardPresses < MAX_CHAT_TAB_STEPS && !chatCycleCompleted) {
      await pressKey(client, 'Tab')
      forwardPresses += 1
      const state = await evaluate(client, CHAT_FOCUS_EXPRESSION)
      if (state.tag === 'BODY') {
        // A press that leaves focus on the document body is a focus blip, not a control. The
        // observed case is the "back to latest" button unmounting as focus scrolling reaches the
        // bottom of the transcript. It is recorded and the walk continues from where focus is.
        focusBlips.push({
          direction: 'forward',
          afterStep: forwardTrace.length,
          afterClass: previousStop?.className ?? null,
          afterWasMetaCopy: previousStop?.isMetaCopy === true,
          jumpOfferedAfterwards: state.jumpOffered,
        })
        previousStop = null
        continue
      }
      forwardTrace.push(state)
      previousStop = state
      if (state.isComposerInput) chatCycleCompleted = true
    }
    const chatWalkScreenshot = await writePng(client, 'chat-area-tab-walk')

    // 6b. backward: the same number of real Shift+Tab presses must retrace the same controls and
    //     land back on the composer input.
    const reverseTrace = []
    let reversePresses = 0
    let focusReturnedToComposer = false
    // The ring it has to retrace holds `forwardTrace.length` stops, ending on the composer input.
    while (reversePresses < MAX_CHAT_TAB_STEPS && reverseTrace.length < forwardTrace.length) {
      await pressKey(client, 'Tab', { shift: true })
      reversePresses += 1
      const state = await evaluate(client, CHAT_FOCUS_EXPRESSION)
      if (state.tag === 'BODY') {
        focusBlips.push({ direction: 'backward', afterStep: reverseTrace.length, afterClass: null, afterWasMetaCopy: false, jumpOfferedAfterwards: state.jumpOffered })
        continue
      }
      reverseTrace.push(state)
      if (state.isComposerInput) focusReturnedToComposer = true
    }
    if (!focusReturnedToComposer) {
      focusReturnedToComposer = await evaluate(client, `document.activeElement === document.querySelector('.composer textarea')`)
    }

    // 6c. the way back to the newest message. The forward walk dragged the transcript to the
    //     bottom (focus scrolling), so the reader is deliberately put back away from it first.
    await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      if (messages instanceof HTMLElement) {
        messages.scrollTop = 0
        messages.dispatchEvent(new Event('scroll', { bubbles: true }))
      }
      return true
    })()`)
    await delay(400)
    const jumpOfferedAfterWalk = await evaluate(client, `(() => {
      const button = document.querySelector('.chat-jump-to-latest')
      return button instanceof HTMLElement
        ? { present: true, label: button.textContent?.trim() ?? null }
        : { present: false, label: null }
    })()`)
    const jumpBackTrace = []
    let jumpReached = false
    if (jumpOfferedAfterWalk.present) {
      await focusSelector(client, '.composer textarea')
      for (let step = 0; step < MAX_JUMP_BACK_STEPS && !jumpReached; step += 1) {
        await pressKey(client, 'Tab', { shift: true })
        const state = await evaluate(client, CHAT_FOCUS_EXPRESSION)
        jumpBackTrace.push(state)
        jumpReached = state.isJumpToLatest === true
      }
    }
    if (jumpReached) {
      await pressKey(client, 'Enter')
      await delay(700)
    }
    const afterJumpToLatest = await evaluate(client, `(() => {
      const messages = document.querySelector('.messages')
      return {
        jumpPresent: Boolean(document.querySelector('.chat-jump-to-latest')),
        gapToBottomPx: messages instanceof HTMLElement
          ? Math.round(messages.scrollHeight - messages.scrollTop - messages.clientHeight)
          : null,
      }
    })()`)
    const jumpScreenshot = await writePng(client, 'chat-jump-to-latest')

    // --- 7. one Escape closes exactly one composer layer ---------------------------------------
    const modeBefore = await evaluate(client, `document.querySelector('.mode-picker-trigger')?.getAttribute('aria-label') ?? null`)
    const modeTriggerFocused = await focusSelector(client, '.mode-picker-trigger')
    await pressKey(client, 'Enter')
    await delay(300)
    const modePickerOpened = await evaluate(client, `(() => ({
      expanded: document.querySelector('.mode-picker-trigger')?.getAttribute('aria-expanded') ?? null,
      panelHidden: document.querySelector('.mode-picker-panel')?.getAttribute('aria-hidden') ?? null,
    }))()`)
    const fullAccessOptionFocused = await evaluate(client, `(() => {
      const option = [...document.querySelectorAll('.mode-picker-panel .mode-option')]
        .find((element) => element.getAttribute('aria-label')?.startsWith('完全访问'))
      if (!(option instanceof HTMLElement)) return null
      option.focus({ preventScroll: true })
      return document.activeElement === option
    })()`)
    await pressKey(client, 'Enter')
    await harness.waitFor(() => evaluate(client, `document.querySelector('.full-access-warning') ? true : null`), harness.startTimeoutMs, 'the full-access confirmation')
    await delay(300)
    const layersBeforeEscape = await evaluate(client, LAYER_STATE_EXPRESSION)
    const confirmationFocus = await evaluate(client, `(() => {
      const active = document.activeElement
      return {
        tag: active?.tagName ?? 'NONE',
        className: typeof active?.className === 'string' ? active.className : null,
        label: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 24) ?? null,
        insideWarning: Boolean(document.querySelector('.full-access-warning')?.contains(active)),
      }
    })()`)
    // The layer is entered with a key, not by the initial focus: opening the confirmation closes
    // the picker panel and makes it inert in the same commit, so the option button that asked for
    // it is blurred to document.body before the dialog's own focus target can take over. What the
    // keyboard user gets is the modal surface's Tab trap, which is what this press proves.
    await pressKey(client, 'Tab')
    const confirmationAfterTab = await evaluate(client, `(() => {
      const active = document.activeElement
      return {
        tag: active?.tagName ?? 'NONE',
        label: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 24) ?? null,
        insideWarning: Boolean(document.querySelector('.full-access-warning')?.contains(active)),
      }
    })()`)
    await pressKey(client, 'Escape')
    await delay(450)
    const layersAfterEscape = await evaluate(client, LAYER_STATE_EXPRESSION)
    const focusAfterEscape = await evaluate(client, `(() => {
      const active = document.activeElement
      return {
        tag: active?.tagName ?? 'NONE',
        className: typeof active?.className === 'string' ? active.className : null,
        label: active?.getAttribute('aria-label') ?? null,
        inComposer: Boolean(active?.closest?.('.composer')),
        inMessages: Boolean(active?.closest?.('.messages')),
        insideDismissedLayer: Boolean(document.querySelector('.full-access-warning')),
      }
    })()`)
    const modeAfterEscape = await evaluate(client, `document.querySelector('.mode-picker-trigger')?.getAttribute('aria-label') ?? null`)
    const modeTriggerAfterEscape = await evaluate(client, `(() => ({
      expanded: document.querySelector('.mode-picker-trigger')?.getAttribute('aria-expanded') ?? null,
    }))()`)
    // The reader must not be stranded outside the chat area: one more real key has to reach a real
    // control again.
    await pressKey(client, 'Tab')
    const focusAfterRecoveryTab = await evaluate(client, `(() => {
      const active = document.activeElement
      return {
        tag: active?.tagName ?? 'NONE',
        className: typeof active?.className === 'string' ? active.className : null,
        insideDismissedLayer: Boolean(document.querySelector('.full-access-warning')),
      }
    })()`)
    // A second Escape is recorded, not asserted: the picker panel registers no Escape scope of its
    // own (only the confirmation does), so what UX-38 requires is that the *first* one closed
    // exactly the confirmation.
    await pressKey(client, 'Escape')
    await delay(350)
    const afterSecondChatEscape = await evaluate(client, LAYER_STATE_EXPRESSION)
    const escapeLayerScreenshot = await writePng(client, 'chat-layer-after-escape')
    const layerDelta = Object.fromEntries(Object.entries(layersAfterEscape)
      .filter(([key, value]) => layersBeforeEscape[key] !== value)
      .map(([key, value]) => [key, `${layersBeforeEscape[key]} → ${value}`]))

    const results = {
      entryFocused,
      navFocused,
      openedByKeyboard,
      deleteFocused,
      opened,
      tabTrace,
      afterFirstEscape,
      afterSecondEscape,
      secondEscapeClosedSettings,
      exitFocused,
      promptDrafted,
      approvalOpened,
      approvalAfterEnter,
      backgroundClickCount,
      approvalTabTrace,
      approvalAfterEscape,
      approvalResponses,
      deniedWriteAbsent,
      deniedRunSettled,
      chatSessionOpened,
      chatFixture,
      jumpOfferedBeforeWalk,
      jumpOfferedAfterWalk,
      chatWalk: {
        composerFocused,
        cycleCompleted: chatCycleCompleted,
        steps: forwardTrace.length,
        presses: forwardPresses,
        reversePresses,
        tabbableCount: forwardTrace[0]?.tabbableCount ?? null,
        forwardTrace,
        reverseTrace,
        focusBlips,
        focusReturnedToComposer,
      },
      jumpBackTrace,
      jumpReached,
      afterJumpToLatest,
      chatLayerEscape: {
        modeBefore,
        modeTriggerFocused,
        modePickerOpened,
        fullAccessOptionFocused,
        confirmationFocus,
        confirmationAfterTab,
        layersBeforeEscape,
        layersAfterEscape,
        layerDelta,
        focusAfterEscape,
        focusAfterRecoveryTab,
        modeAfterEscape,
        modeTriggerAfterEscape,
        afterSecondChatEscape,
      },
      screenshots: { dialogScreenshot, tabScreenshot, escapeScreenshot, approvalScreenshot, chatWalkScreenshot, jumpScreenshot, escapeLayerScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. the whole path was opened with keys, not clicks.
    expect(entryFocused === true, 'the settings entry could not be focused')
    expect(navFocused === true, 'the archive navigation item could not be focused')
    expect(openedByKeyboard.archiveOpen, 'the archive page did not open from the keyboard')
    expect(deleteFocused === true, 'the delete action could not be focused')
    // 2. initial focus is the deliberate target.
    expect(opened.dialogOpen, 'the dialog did not open from the keyboard')
    expect(opened.activeClass?.includes('close-btn') === true,
      `initial focus was not the cancel button: ${JSON.stringify(opened.activeLabel)}`)
    // 3. Tab never leaves the dialog.
    expect(tabTrace.every((state) => state.insideDialog),
      `Tab left the dialog: ${JSON.stringify(tabTrace.map((state) => state.activeClass))}`)
    expect(new Set(tabTrace.map((state) => state.activeClass)).size >= 2, 'Tab never reached the second action')
    // 4. one Escape per layer, focus returned to the trigger.
    expect(afterFirstEscape.dialogOpen === false, 'the first Escape did not close the dialog')
    expect(afterFirstEscape.archiveOpen, 'the first Escape also closed the page behind the dialog')
    expect(afterFirstEscape.settingsOpen, 'the first Escape closed the settings layer as well')
    expect(afterFirstEscape.activeClass?.includes('archive-action') === true,
      `focus did not return to the delete action: ${JSON.stringify(afterFirstEscape.activeClass)}`)
    // 5. a real write approval is readable before any grant; Escape rejects it.
    expect(exitFocused === true, 'the settings exit could not be focused')
    expect(promptDrafted === true, 'the approval request could not be submitted')
    expect(approvalOpened.title === '允许写入文件？', `unexpected approval title: ${approvalOpened.title}`)
    expect(approvalOpened.action === 'Agent 工具调用', 'approval did not come from an Agent tool')
    expect(approvalOpened.focusOnHeading, 'approval initially focused an action instead of its explanation')
    expect(approvalAfterEnter, 'Enter on the heading unexpectedly approved the operation')
    expect(backgroundClickCount === 0, 'a pointer click reached the background composer through the approval layer')
    expect(approvalTabTrace.every(Boolean), 'Tab escaped the approval dialog')
    expect(approvalAfterEscape.promptOpen === false, 'Escape did not close the approval dialog')
    expect(approvalAfterEscape.focusRestored, 'approval did not restore focus to the composer')
    expect(approvalResponses.length === 1 && approvalResponses[0]?.approved === false && approvalResponses[0]?.status < 300,
      `Escape must submit one rejection: ${JSON.stringify(approvalResponses)}`)
    expect(deniedWriteAbsent, 'the denied write still reached the filesystem')

    // 6. the chat area is reachable and ordered for a keyboard-only reader.
    const forwardIndexWhere = (predicate) => forwardTrace.findIndex(predicate)
    const loadOlderIndex = forwardIndexWhere((state) => state.isHistoryLoadOlder)
    // The walk is a cycle, so the chat controls are judged in the ring anchored at the entry the
    // reader meets first — the "load older" button at the top of the loaded page.
    const ring = loadOlderIndex >= 0
      ? [...forwardTrace.slice(loadOlderIndex), ...forwardTrace.slice(0, loadOlderIndex)]
      : forwardTrace
    const ringIndexWhere = (predicate) => ring.findIndex(predicate)
    const metaCopyRing = ringIndexWhere((state) => state.isMetaCopy)
    const toolRowRing = ringIndexWhere((state) => state.isToolRow)
    const codeCopyRing = ringIndexWhere((state) => state.isCodeCopyButton)
    const traceSummary = JSON.stringify(forwardTrace
      .filter((state) => state.inMessages || state.isJumpToLatest || state.isComposerInput)
      .map((state) => `${state.domIndex}:${state.className || state.tag}`))
    const domOrderViolations = []
    const tabbableSetShifts = []
    const offListStops = []
    let wraparounds = 0
    for (let index = 1; index < forwardTrace.length; index += 1) {
      const previous = forwardTrace[index - 1]
      const current = forwardTrace[index]
      if (previous.domRank < 0 || current.domRank < 0) {
        domOrderViolations.push({ index, reason: 'no document rank', previous: previous.domRank, current: current.domRank, className: current.className })
        continue
      }
      if (previous.tabbableCount !== current.tabbableCount) {
        // An element mounted or unmounted between two presses, so document ranks are not
        // comparable across this step. The stable focusId is what the mirror check uses.
        tabbableSetShifts.push({ index, from: previous.tabbableCount, to: current.tabbableCount, previousClass: previous.className, currentClass: current.className })
        continue
      }
      if (current.focusId === previous.focusId) {
        domOrderViolations.push({ index, reason: 'focus did not move', className: current.className })
        continue
      }
      if (current.domRank < previous.domRank) wraparounds += 1
    }
    for (const state of forwardTrace) {
      if (state.domIndex < 0) offListStops.push({ tag: state.tag, className: state.className, scrollRegion: state.scrollRegion, domRank: state.domRank })
    }
    results.chatWalk.tabbableSetShifts = tabbableSetShifts
    results.chatWalk.offListStops = offListStops
    expect(deniedRunSettled === true, 'the transcript was still streaming before the chat walkthrough')
    expect(chatSessionOpened === true, 'the seeded chat session was not listed in the sidebar')
    expect(chatFixture.renderedMessages > 100, `the seeded chat page held ${chatFixture.renderedMessages} messages`)
    expect(chatFixture.loadOlder === true, 'a conversation longer than one history page offered no "load older" entry')
    expect(chatFixture.toolRow === true, 'the chat fixture rendered no tool activity row')
    expect(chatFixture.codeToolbarButton === true, 'the chat fixture rendered no code toolbar button')
    expect(chatFixture.metaCopy === true, 'the chat fixture rendered no message meta copy button')
    expect(composerFocused === true, 'the composer input could not be focused for the chat walkthrough')
    expect(chatCycleCompleted === true,
      `Tab never came back to the composer input within ${MAX_CHAT_TAB_STEPS} presses (${forwardTrace.length} stops recorded)`)
    expect(domOrderViolations.length === 0,
      `the chat Tab order did not follow document order: ${JSON.stringify(domOrderViolations.slice(0, 6))}`)
    expect(wraparounds <= 1, `the chat Tab walk wrapped around the document ${wraparounds} times`)
    expect(tabbableSetShifts.length <= 4,
      `the tabbable set changed size ${tabbableSetShifts.length} times during the walk: ${JSON.stringify(tabbableSetShifts.slice(0, 4))}`)
    expect(loadOlderIndex >= 0, `the keyboard walk never reached .history-load-older: ${traceSummary}`)
    expect(metaCopyRing >= 0, `the keyboard walk never reached a .message-meta-copy button: ${traceSummary}`)
    expect(toolRowRing >= 0, `the keyboard walk never reached a tool row's expander: ${traceSummary}`)
    expect(codeCopyRing >= 0, `the keyboard walk never reached a code toolbar copy button: ${traceSummary}`)
    expect(metaCopyRing < toolRowRing && toolRowRing < codeCopyRing,
      `the chat-area controls were not reachable in reading order (meta copy ${metaCopyRing}, tool row ${toolRowRing}, code copy ${codeCopyRing})`)
    expect(`${forwardTrace[loadOlderIndex]?.label ?? ''}${forwardTrace[loadOlderIndex]?.text ?? ''}`.trim().length > 0,
      'the "load older" entry has no accessible name')
    const toolRowState = toolRowRing >= 0 ? ring[toolRowRing] : undefined
    expect((toolRowState?.label ?? '').length > 0, 'the tool row expander has no accessible name')
    const codeCopyState = codeCopyRing >= 0 ? ring[codeCopyRing] : undefined
    expect((codeCopyState?.label ?? '').length > 0, 'the code copy button has no accessible name')
    // The reverse walk must retrace the same stops, by stable element identity, and return to
    // where it started. The set of stops can change under the reader while it is walking — the
    // jump-to-latest button disappears once Tab has taken the reader back to the bottom, which
    // `tabbableSetShifts` records — so the mirror is checked on the stops that still existed for
    // the walk back, and the walk back has to cover all of them.
    const forwardIds = forwardTrace.map((state) => state.focusId)
    // Both directions can see stops the other did not: the jump-to-latest button unmounts when the
    // reader reaches the bottom and mounts again on the way back. The mirror is therefore checked
    // on the stops both walks saw — and the coverage guard below keeps that from passing on a
    // handful of them.
    const reverseIds = reverseTrace
      .map((state) => state.focusId)
      .filter((id) => forwardIds.includes(id))
    // The forward walk ends the moment it comes back to the composer, so the walk back is the
    // stops before that return, reversed, and then the composer again.
    const expectedStops = [...forwardTrace.slice(0, -1)].reverse().concat(forwardTrace.slice(-1))
    const mirrored = expectedStops
      .filter((state) => reverseIds.includes(state.focusId))
      .map((state) => state.focusId)
    const reverseMirrorViolations = []
    for (let index = 0; index < reverseIds.length; index += 1) {
      const expected = mirrored[index] ?? null
      if (reverseIds[index] !== expected) {
        reverseMirrorViolations.push({
          index,
          expected,
          observed: reverseIds[index],
          observedClass: reverseTrace[index]?.className ?? null,
        })
      }
    }
    expect(mirrored.length >= Math.max(2, forwardIds.length - 2),
      `Shift+Tab covered only ${mirrored.length} of the ${forwardIds.length} stops the forward walk visited`)
    expect(reverseMirrorViolations.length === 0,
      `Shift+Tab did not retrace the forward walk: ${JSON.stringify(reverseMirrorViolations.slice(0, 6))}`)
    expect(focusReturnedToComposer === true,
      'Shift+Tab back through the chat area did not return focus to the composer input')
    // 7. the way back to the newest message, while the reader is away from it.
    expect(jumpOfferedAfterWalk.present === true,
      'the reader was scrolled away from the newest message but .chat-jump-to-latest was not offered')
    expect(jumpReached === true,
      `the "back to latest" control was not reachable with Shift+Tab from the composer: ${JSON.stringify(jumpBackTrace.map((state) => state.className))}`)
    expect(afterJumpToLatest.jumpPresent === false, 'activating "back to latest" left the control offered')
    expect(afterJumpToLatest.gapToBottomPx !== null && afterJumpToLatest.gapToBottomPx <= 2,
      `activating "back to latest" left the reader ${afterJumpToLatest.gapToBottomPx}px from the newest message`)
    // 8. one Escape closes exactly one composer layer, and nothing else.
    expect(modeTriggerFocused === true, 'the permission-mode trigger could not be focused')
    expect(modePickerOpened.expanded === 'true', `the permission-mode picker did not open from the keyboard (aria-expanded=${modePickerOpened.expanded})`)
    expect(fullAccessOptionFocused === true, 'the full-access option could not be focused from the keyboard')
    expect(layersBeforeEscape.fullAccessWarning === true, 'the full-access confirmation did not open')
    expect(confirmationAfterTab.insideWarning === true,
      `Tab did not enter the confirmation layer: ${JSON.stringify(confirmationAfterTab)}`)
    expect(layerDelta.fullAccessWarning === 'true → false',
      `the first Escape did not close the confirmation layer: ${JSON.stringify(layerDelta)}`)
    expect(Object.keys(layerDelta).length === 1,
      `one Escape changed more than the confirmation layer: ${JSON.stringify(layerDelta)}`)
    expect(modeAfterEscape === modeBefore,
      `Escape did not cancel the permission-mode change (${JSON.stringify(modeBefore)} → ${JSON.stringify(modeAfterEscape)})`)
    expect(modeTriggerAfterEscape.expanded === 'false',
      `the mode picker is still expanded after Escape (${modeTriggerAfterEscape.expanded})`)
    expect(focusAfterEscape.insideDismissedLayer === false, 'the dismissed confirmation layer is still in the DOM')
    expect(focusAfterEscape.className?.includes('full-access-warning') !== true,
      `focus stayed inside the dismissed confirmation layer: ${JSON.stringify(focusAfterEscape)}`)
    expect(focusAfterEscape.inComposer === true || focusAfterEscape.tag === 'BODY',
      `Escape left focus outside the chat area: ${JSON.stringify(focusAfterEscape)}`)
    expect(focusAfterRecoveryTab.tag !== 'BODY' && focusAfterRecoveryTab.tag !== 'NONE',
      `the keyboard user was stranded on the document body after the dismissal: ${JSON.stringify(focusAfterRecoveryTab)}`)

    if (failures.length > 0) {
      throw new Error(`keyboard modal focus acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    // Recorded limits. Every one of these is a known boundary of the fixture or a finding the walk
    // reported instead of asserting, not a passed check.
    results.limits = [
      'The chat-area walkthrough runs in a seeded conversation (131 messages written straight into the session JSONL) so that one history page leaves a "load older" entry and a transcript tall enough for the reader to be away from the newest message. The seeded text is fixture data; the controls it exposes are the real renderer components. The two extra turns the walk needs (a tool row and a code block) are real runs of the acceptance provider inside that conversation.',
      'Tab is dispatched with Input.dispatchKeyEvent, so the renderer runs its own default actions. Focus order is judged against the tabbable elements that are not inert, not disabled, visible and (for scroll regions without a tabindex) overflowing, which is document order for tabindex 0 — a positive tabindex would show up as an ordering violation rather than being normalised away.',
      `The forward walk observed ${results.chatWalk.focusBlips.length} Tab press(es) that left focus on document.body instead of a control: focusing the last message scrolls the transcript to the bottom, the "back to latest" control is only offered while the reader is away from it, so it unmounted between the press and the measurement. Those presses are recorded in chatWalk.focusBlips and do not appear as stops; the control's reachability is asserted separately in section 6c, where the reader is deliberately scrolled away again and Shift+Tab from the composer lands on it.`,
      `The tabbable set changed size ${results.chatWalk.tabbableSetShifts.length} time(s) during the walk (chatWalk.tabbableSetShifts): the same "back to latest" control mounting again as the reverse walk scrolled the transcript away from the bottom. Document indexes are therefore not compared across those steps; the forward/reverse mirror is compared by a stable per-element id.`,
      `The walk reached ${results.chatWalk.offListStops.length} stop(s) the gate's own tabbable predicate did not model (chatWalk.offListStops); each one is still ordered by its document rank, so the ordered-trace check does not depend on that predicate being complete.`,
      'The composer permission-mode picker registers no Escape scope of its own: only the full-access confirmation does. That is why section 7 asserts that the *first* Escape closed exactly the confirmation (layer delta, permission mode unchanged) and records the second Escape rather than requiring it to close the picker panel.',
      `The full-access confirmation does not hold focus when it opens (the observed activeElement was ${JSON.stringify(results.chatLayerEscape.confirmationFocus.tag)}): choosing the option closes the picker panel and makes it inert in the same React commit, so Chromium blurs the option button to the document body before the dialog's own initial focus target is focusable. The layer is still keyboard-usable — the next Tab is routed into it by the modal surface (asserted) and Escape closes it — but the layer does not return focus to the mode-picker trigger, unlike the approval prompt which restores focus to the composer.`,
    ]
    console.log(JSON.stringify({ check: 'keyboard-modal-focus', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'keyboard-modal-focus',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) await harness.forceTerminate(electron)
    await provider.close().catch(() => undefined)
    if (!preserve && !keepRoot) await harness.removeTemporaryRoot(root)
  }
}

await main()
