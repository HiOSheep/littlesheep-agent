// Real-window acceptance for the shared code-wrap control (taskbook UX-23).
//
// One isolated application run verifies that the chat toolbar and the workspace
// editor read and update the same remembered preference. The workspace fixture
// contains one deliberately long source line so Monaco's visual wrapping is
// observable in the rendered editor, not inferred from its React props.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outDir = join(tmpdir(), 'littlesheep-code-wrap-control')
const screenshotDir = join(outDir, 'screenshots')
const EVALUATE_TIMEOUT_MS = 5_000
const WINDOW_SIZE = { width: 1280, height: 820 }
const STORAGE_KEY = 'littlesheep.ui.codeWrap'

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

async function writePng(client, name) {
  const shot = await withTimeout(
    client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    10_000,
    'Page.captureScreenshot',
  )
  const path = join(screenshotDir, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
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
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        maxModelCallsPerRun: 32,
      },
    },
  }
}

async function submitPrompt(client, prompt) {
  const submitted = await evaluate(client, `(() => {
    const textarea = document.querySelector('.composer textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, ${JSON.stringify(prompt)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  if (!submitted) throw new Error('could not submit the code-wrap fixture')
}

async function clickVisible(client, selector, textPart = '') {
  return evaluate(client, `(() => {
    const wanted = ${JSON.stringify(textPart)}
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => {
      if (!(candidate instanceof HTMLElement) || candidate.closest('[inert]')) return false
      const readable = (candidate.getAttribute('aria-label') || '') + ' ' + (candidate.textContent || '')
      if (wanted && !readable.includes(wanted)) return false
      const box = candidate.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
    if (!(node instanceof HTMLElement)) return { clicked: false }
    node.click()
    return { clicked: true, label: (node.textContent || '').trim().slice(0, 50) }
  })()`)
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-code-wrap-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workspaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const fixturePath = join(workspaceDir, 'code-wrap-fixture.ts')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 10, streamChunkCharacters: 60 })
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([
      mkdir(screenshotDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
    ])
    await writeFile(fixturePath,
      `export const codeWrapProbe = '${'0123456789abcdef'.repeat(28)}'\n`,
      'utf8',
    )
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    client = await harness.connectRenderer(debuggingPort)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer',
    )
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')

    // Chat code blocks default to horizontal scrolling and expose language + actions.
    await submitPrompt(client, `请输出代码折行验收文档：${LONG_MARKDOWN_MARKER}`)
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.assistant-turn:last-of-type .code-block-source')?.getAttribute('data-code-wrap') === 'off' || null`),
      60_000,
      'chat code block',
    )
    await harness.waitFor(
      () => evaluate(client, `Boolean(document.querySelector('.assistant-response-stream[data-stream-state="settled"]')) || null`),
      60_000,
      'chat code answer to settle',
    )
    await delay(300)
    const initialChat = await evaluate(client, `(() => {
      const turn = document.querySelector('.assistant-turn:last-of-type')
      const blocks = [...(turn?.querySelectorAll('.code-block-source') ?? [])]
      const block = blocks.find((candidate) => candidate.textContent?.includes('RetryProgress')) ?? blocks.at(-1)
      const toolbar = block?.closest('.code-block')?.querySelector('.code-toolbar')
      const toggle = toolbar?.querySelector('.code-wrap-toggle')
      return {
        observedBlocks: blocks.map((candidate) => ({
          label: candidate.closest('.code-block')?.querySelector('.code-language-label')?.textContent?.trim() ?? null,
          sample: (candidate.textContent ?? '').trim().slice(0, 42),
          visible: candidate.getBoundingClientRect().width > 0,
        })),
        language: toolbar?.querySelector('.code-language-label')?.textContent?.trim() ?? null,
        copyButton: Boolean(toolbar?.querySelector('button[aria-label="复制代码"]')),
        toggleLabel: toggle?.getAttribute('aria-label') ?? null,
        pressed: toggle?.getAttribute('aria-pressed') ?? null,
        wrapState: block?.getAttribute('data-code-wrap') ?? null,
        whiteSpace: block ? getComputedStyle(block).whiteSpace : null,
        clientWidth: block?.clientWidth ?? null,
        scrollWidth: block?.scrollWidth ?? null,
        storage: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
      }
    })()`)
    const copied = await clickVisible(client, '.assistant-turn:last-of-type .code-block button[aria-label="复制代码"]')
    const copiedChat = await harness.waitFor(() => evaluate(client, `(() => {
      const turn = document.querySelector('.assistant-turn:last-of-type')
      const button = [...(turn?.querySelectorAll('.code-block button') ?? [])]
        .find((candidate) => candidate.getAttribute('aria-label') === '代码已复制')
      return button ? { label: button.getAttribute('aria-label'), copied: button.getAttribute('data-copied') } : null
    })()`), 5_000, 'copy button feedback')
    const chatToggle = await clickVisible(client, '.assistant-turn:last-of-type .code-wrap-toggle', '开启自动换行')
    if (!chatToggle.clicked) throw new Error('the chat wrap button was not reachable')
    const wrappedChat = await harness.waitFor(() => evaluate(client, `(() => {
      const turn = document.querySelector('.assistant-turn:last-of-type')
      const blocks = [...(turn?.querySelectorAll('.code-block-source') ?? [])]
      const block = blocks.find((candidate) => candidate.textContent?.includes('RetryProgress')) ?? blocks.at(-1)
      return block?.getAttribute('data-code-wrap') === 'on' ? {
        state: block.getAttribute('data-code-wrap'),
        whiteSpace: getComputedStyle(block).whiteSpace,
        label: block.closest('.code-block')?.querySelector('.code-wrap-toggle')?.getAttribute('aria-label'),
        pressed: block.closest('.code-block')?.querySelector('.code-wrap-toggle')?.getAttribute('aria-pressed'),
        storage: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
        clientWidth: block.clientWidth,
        scrollWidth: block.scrollWidth,
      } : null
    })()`), 5_000, 'chat wrap state to turn on')
    const chatScreenshot = await writePng(client, 'chat-wrapped')

    // Open the workspace terminal surface so the real file navigator is available,
    // then open the isolated long-line fixture through its visible tree row.
    const panelCollapsed = await evaluate(client, `document.querySelector('.workspace-panel')?.classList.contains('collapsed') ?? true`)
    if (panelCollapsed) {
      const opened = await clickVisible(client, '.workspace-panel-corner-toggle')
      if (!opened.clicked) throw new Error('the workspace panel could not be opened')
    }
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-panel')?.classList.contains('collapsed') === false || null`),
      10_000,
      'workspace panel',
    )
    const openedTerminal = await clickVisible(client, '.workspace-add-trigger')
    if (!openedTerminal.clicked) throw new Error('the workspace feature menu could not be opened')
    await harness.waitFor(
      () => evaluate(client, `Boolean(document.querySelector('.workspace-add-panel.visible')) || null`),
      5_000,
      'workspace feature menu to open',
    )
    const selectedTerminal = await clickVisible(client, '.workspace-add-panel.visible .workspace-add-item', '终端')
    if (!selectedTerminal.clicked) throw new Error('the terminal workspace surface could not be selected')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.workspace-tree-row.file')?.textContent?.includes('code-wrap-fixture.ts') || null`),
      15_000,
      'workspace fixture row',
    )
    const openedFile = await clickVisible(client, '.workspace-tree-row.file', 'code-wrap-fixture.ts')
    if (!openedFile.clicked) throw new Error('the workspace fixture file could not be opened')
    await harness.waitFor(
      () => evaluate(client, `Boolean(document.querySelector('.workspace-editor-monaco .monaco-editor') && document.querySelector('.workspace-preview-actions .code-wrap-icon')) || null`),
      20_000,
      'workspace code editor and wrap control',
    )
    await delay(500)
    const wrappedWorkspace = await evaluate(client, `(() => {
      const editor = document.querySelector('.workspace-editor-monaco .monaco-editor')
      const button = document.querySelector('.workspace-preview-actions .code-wrap-toggle')
      const viewLines = editor?.querySelector('.view-lines')
      return {
        language: document.querySelector('.workspace-preview-statusbar')?.textContent?.trim() ?? null,
        label: button?.getAttribute('aria-label') ?? null,
        pressed: button?.getAttribute('aria-pressed') ?? null,
        visualLines: viewLines?.querySelectorAll('.view-line').length ?? null,
        storage: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
      }
    })()`)
    const workspaceToggle = await clickVisible(client, '.workspace-preview-actions .code-wrap-toggle', '关闭自动换行')
    if (!workspaceToggle.clicked) throw new Error('the workspace wrap button was not reachable')
    const unwrappedWorkspace = await harness.waitFor(() => evaluate(client, `(() => {
      const editor = document.querySelector('.workspace-editor-monaco .monaco-editor')
      const button = document.querySelector('.workspace-preview-actions .code-wrap-toggle')
      const turn = document.querySelector('.assistant-turn:last-of-type')
      const blocks = [...(turn?.querySelectorAll('.code-block-source') ?? [])]
      const block = blocks.find((candidate) => candidate.textContent?.includes('RetryProgress')) ?? blocks.at(-1)
      const viewLines = editor?.querySelector('.view-lines')
      if (button?.getAttribute('aria-pressed') !== 'false' || block?.getAttribute('data-code-wrap') !== 'off') return null
      return {
        label: button.getAttribute('aria-label'),
        pressed: button.getAttribute('aria-pressed'),
        visualLines: viewLines?.querySelectorAll('.view-line').length ?? null,
        storage: localStorage.getItem(${JSON.stringify(STORAGE_KEY)}),
        chatWrapState: block.getAttribute('data-code-wrap'),
      }
    })()`), 5_000, 'workspace switch to turn wrapping off and update chat')
    const workspaceScreenshot = await writePng(client, 'workspace-unwrapped')

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    expect(initialChat.language === 'TS', `chat language label was ${initialChat.language}`)
    expect(initialChat.copyButton && copied.clicked, 'chat code toolbar copy button was not clickable')
    expect(copiedChat.copied === 'true', 'chat copy action did not show its completed state')
    expect(initialChat.toggleLabel === '开启自动换行' && initialChat.pressed === 'false', 'chat code wrap control does not start off')
    expect(initialChat.wrapState === 'off' && initialChat.whiteSpace === 'pre', 'chat code starts wrapped or lacks horizontal scrolling')
    expect(wrappedChat.state === 'on' && wrappedChat.whiteSpace === 'pre-wrap', 'chat code did not switch to wrapping')
    expect(wrappedChat.label === '关闭自动换行' && wrappedChat.pressed === 'true', 'chat toggle state is not visible and accessible')
    expect(wrappedChat.storage === 'on', 'chat toggle was not remembered in localStorage')
    expect(wrappedWorkspace.pressed === 'true' && wrappedWorkspace.storage === 'on', 'workspace did not receive the chat preference')
    expect((wrappedWorkspace.visualLines ?? 0) > 1, `workspace editor did not wrap the long line (${wrappedWorkspace.visualLines} visual line)`)
    expect(unwrappedWorkspace.label === '开启自动换行' && unwrappedWorkspace.pressed === 'false', 'workspace toggle did not show the off state')
    expect(unwrappedWorkspace.storage === 'off' && unwrappedWorkspace.chatWrapState === 'off', 'workspace toggle did not update the shared stored preference and chat block')
    expect((unwrappedWorkspace.visualLines ?? 0) < (wrappedWorkspace.visualLines ?? 0),
      `Monaco visual line count did not decrease when wrapping was disabled (${wrappedWorkspace.visualLines} to ${unwrappedWorkspace.visualLines})`)

    const evidence = {
      window: WINDOW_SIZE,
      fixturePath,
      chatDefault: initialChat,
      chatCopy: copiedChat,
      chatWrapped: wrappedChat,
      workspaceWrapped: wrappedWorkspace,
      workspaceUnwrapped: unwrappedWorkspace,
      screenshots: { chat: chatScreenshot, workspace: workspaceScreenshot },
      failures,
    }
    if (failures.length) throw new Error(`code-wrap control acceptance failed: ${JSON.stringify(evidence)}`)
    console.log(JSON.stringify({ check: 'code-wrap-control', ok: true, evidence }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'code-wrap-control',
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
    if (!preserve) await harness.removeTemporaryRoot(root)
  }
}

await main()
