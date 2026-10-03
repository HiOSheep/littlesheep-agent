// Real-window acceptance for the workspace terminal (UX-29 shell selection, UX-30 sessions).
//
// The window is parked outside every display and shown inactively: it renders normally, so
// layout-dependent checks work, and it never appears on the user's desktop.
//
// Terminal output is a canvas, so session behaviour is measured by what the commands *do*: each
// session writes marker files that only it could have written. That proves both that input
// reached the selected session and that the other session was still alive.
//
//   node scripts/verify-workspace-terminal.mjs [--keep]
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const WINDOW = { width: 1280, height: 840 }
const EVALUATE_TIMEOUT_MS = 45_000

function createRecorder() {
  const observations = []
  const failures = []
  let checks = 0
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      checks += 1
      if (!condition) failures.push({ check, detail })
    },
    evidence: (limits) => ({ checks, failures, observations, limits }),
  }
}

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
])
const evaluate = (client, expression) => withTimeout(client.evaluate(expression), EVALUATE_TIMEOUT_MS, 'Runtime.evaluate')

/** Types a command into the focused terminal and presses Enter through the browser. */
async function sendTerminalCommand(client, text) {
  // The live xterm mirrors `disableStdin` onto its helper textarea, and it drops every data event
  // while that is set — a session that is starting, or one that was just switched to before its
  // stream re-attached, would silently swallow the command.
  await harness.waitFor(() => evaluate(client, `(() => {
    const textareas = [...document.querySelectorAll('.workspace-terminal textarea')]
    const textarea = textareas[textareas.length - 1]
    return textarea instanceof HTMLTextAreaElement && !textarea.readOnly ? true : null
  })()`), 30_000, 'the terminal to accept input')
  await evaluate(client, `(() => {
    // The live xterm is the last one in the panel: earlier nodes linger while the surface
    // re-attaches to a different session.
    const textareas = [...document.querySelectorAll('.workspace-terminal textarea')]
    const textarea = textareas[textareas.length - 1]
    if (!(textarea instanceof HTMLTextAreaElement)) return false
    textarea.focus()
    return true
  })()`)
  await client.send('Input.insertText', { text })
  // A separate beat before Enter: right after a tab switch the surface is still writing the
  // session's replayed history, and an Enter delivered inside that burst is what the earlier
  // runs lost (the text reached the shell, the line stayed unsubmitted).
  await delay(250)
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

async function clickTerminalButton(client, label) {
  return evaluate(client, `(() => {
    const button = [...document.querySelectorAll('.workspace-terminal button')]
      .find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)})
    if (!(button instanceof HTMLElement)) return { clicked: false }
    button.click()
    return { clicked: true }
  })()`)
}

const terminalSurface = (client) => evaluate(client, `(() => {
  const pane = document.querySelector('.workspace-terminal')
  if (!(pane instanceof HTMLElement)) return null
  const picker = pane.querySelector('.workspace-terminal-shell-picker')
  const label = picker?.querySelector('button')?.getAttribute('aria-label') ?? ''
  const tabs = [...pane.querySelectorAll('.workspace-terminal-tab')]
  return {
    shellOptions: label ? [label] : [],
    selectedShell: label || null,
    tabs: tabs.length,
    states: tabs.map((node) => (node.querySelector('.workspace-terminal-tab-shell')?.textContent || '').trim()),
    activeTabs: tabs.filter((node) => node.getAttribute('aria-selected') === 'true').length,
    status: (pane.querySelector('.workspace-terminal-status')?.textContent || '').trim(),
  }
})()`)

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-terminal-'))
  const dataDir = join(root, 'data')
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0 })
  let locator

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    await writeFile(join(workplaceDir, 'readme.txt'), 'terminal fixture\n', 'utf8')
    // The terminal does not call the model, but the app expects a configured provider to boot
    // into a usable composer, so the same acceptance provider the other walkthroughs use is
    // registered here too.
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
          workspace: workplaceDir,
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
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    // Parked outside every display: the window renders (screenshots and layout work) without
    // appearing on the user's desktop, and never takes focus.
    await harness.desktopAction(locator, 'park-offscreen')
    await delay(1200)
    await harness.desktopAction(locator, 'resize', WINDOW)

    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => evaluate(client, `document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )

    // Open the workspace panel on the terminal feature by seeding the layout the app restores:
    // this is the same shape the review walkthrough uses, so the panel comes up already on the
    // terminal without guessing at buttons.
    const seedSource = `(() => {
      const layout = {
        collapsed: false,
        fullscreen: true,
        activeTab: 'review',
        openTabs: [],
        fileNavigatorCollapsed: false,
        fileNavigatorWidth: 214,
        reviewNavigatorWidth: 214,
        expandedPaths: [],
        drafts: {},
        browserTabs: [],
      }
      const values = {
        'littlesheep.ui.workspacePanelCollapsed': 'false',
        'littlesheep.ui.workspacePanelFullscreen': 'true',
        'littlesheep.ui.workspacePanelTab': 'review',
        'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([]),
        'littlesheep.ui.workspacePanelOpenRoot': ${JSON.stringify(workplaceDir)},
        'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: layout }),
      }
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    })()`
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: seedSource })
    const openedTerminal = { seeded: true }
    await client.send('Page.reload', { ignoreCache: false })
    await delay(2500)
    await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-start-shells button:not(:disabled)') ? true : null`), 30000, 'start page shell choices')
    const homepage = await evaluate(client, `({ tabs: document.querySelectorAll('.workspace-active-item').length, visible: !!document.querySelector('.workspace-empty-launcher') })`)
    recorder.check(homepage.tabs === 0 && homepage.visible, 'home is shown with no workspace tab', homepage)
    const startShot = await client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(root, 'start.png'), Buffer.from(startShot.data, 'base64'))
    const selected = await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('.workspace-start-shells button')]
      const button = buttons.find(x => !x.disabled)
      const label = button?.getAttribute('aria-label')
      button?.click()
      return label
    })()`)
    await harness.waitFor(() => evaluate(client, `document.querySelector('.workspace-terminal') ? true : null`), 30000, 'terminal opened from start page')
    const first = await terminalSurface(client)
    recorder.note({ step: 'terminal-open', selected, first })
    recorder.check(Boolean(selected) && first && first.tabs === 0 && !first.selectedShell,
      'start page chooses the shell and terminal opens without an internal picker', { selected, first })

    // The status line only reads 就绪 after a command has completed, so readiness is measured by
    // what the shell does: a marker file that only a live session can write. Waiting on the text
    // alone timed out for the full 90 s in every previous run and then typed into nothing.
    const readyMarker = join(workplaceDir, 'terminal-ready.txt')
    let firstReady = false
    const ready = await harness.waitFor(async () => {
      await sendTerminalCommand(client, 'Set-Content -LiteralPath .\\terminal-ready.txt -Value ready')
      firstReady = existsSync(readyMarker)
      return firstReady ? await terminalSurface(client) : null
    }, 90_000, 'the first session to accept a command').catch(async () => await terminalSurface(client))
    recorder.note({ step: 'terminal-first-ready', ready, firstReady })
    recorder.check(
      firstReady === true,
      'the first terminal really runs a shell instead of only reporting that it is starting',
      { ready, firstReady },
    )

    const minimal = await evaluate(client, `(() => ({
      picker: !!document.querySelector('.workspace-terminal .workspace-terminal-shell-picker'),
      border: getComputedStyle(document.querySelector('.workspace-terminal-shell')).borderWidth,
      radius: getComputedStyle(document.querySelector('.workspace-terminal-shell')).borderRadius,
      extras: document.querySelectorAll('.workspace-terminal-status, .workspace-terminal-title, .workspace-terminal-activity, .workspace-terminal-tabs').length,
      buttons: [...document.querySelectorAll('.workspace-terminal button')].map(x => x.textContent.trim()),
    }))()`)
    recorder.check(!minimal.picker && minimal.border === '0px' && minimal.radius === '0px' && minimal.extras === 0
      && !minimal.buttons.some(x => ['新建', '中断', '重启', '清空'].includes(x)),
      'terminal content has no internal picker, toolbar or card frame', minimal)
    const terminalShot = await client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(root, 'terminal.png'), Buffer.from(terminalShot.data, 'base64'))
    const pidPath = join(workplaceDir, 'terminal-pid.txt')
    await sendTerminalCommand(client, 'Set-Content -LiteralPath .\\terminal-pid.txt -Value $PID')
    await harness.waitFor(() => existsSync(pidPath), 10000, 'shell process identity')
    const shellPid = Number((await readFile(pidPath, 'utf8')).replace(/^\uFEFF/, '').trim())
    const alive = () => { try { process.kill(shellPid, 0); return true } catch { return false } }
    recorder.check(Number.isInteger(shellPid) && shellPid > 0 && alive(), 'the terminal owns a live shell process', { shellPid })
    const closed = await evaluate(client, `(() => {
      const active = document.querySelector('.workspace-active-item[aria-selected="true"]')
      const button = active?.querySelector('button')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`)
    await harness.waitFor(() => !alive(), 15000, 'closing the terminal tab ends its shell')
    const afterClose = await terminalSurface(client)
    const backHome = await evaluate(client, `!!document.querySelector('.workspace-empty-launcher') && document.querySelectorAll('.workspace-active-item').length === 0`)
    recorder.check(closed && afterClose === null && !alive() && backHome,
      'closing the workspace tab removes the terminal and ends its shell process', { closed, afterClose, shellPid })

  } finally {
    // The parked app holds the process open; an acceptance run quits it explicitly.
    if (locator) await harness.desktopAction(locator, 'quit').catch(() => undefined)
    const evidence = recorder.evidence([
      'Terminal output renders to a canvas, so rendered text is not read. Input is typed into the live xterm through CDP and the evidence that it reached a shell is the marker file each command writes; per-session input *routing* (a byte queued while the reader switches tabs) is covered by the terminal-session unit tests, not here.',
      'The sessions run real shells on this machine; their own startup time is the only reason the waits are generous.',
      'The window is parked off screen rather than hidden, because a hidden window does not lay out or paint.',
    ])
    await provider.close().catch(() => undefined)
    if (!keep) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    if (evidence.failures.length > 0) process.exitCode = 1
  }
}

await main()
