// Real-window check for the composer's model picker submenu width.
//
// The model ids a custom provider reports are long ("deepseek-v4.1-flash"), and the
// flyout used to be capped at a fixed 143px: every name was ellipsized mid-word, so
// two versions of the same model could not be told apart, and the labels ran under
// the neighbouring panel. This measures the real flyout against its own content and
// against the window.
//
// Usage:
//   node scripts/verify-runtime-picker-submenu-width.mjs [--keep]
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

/** Long ids on purpose: these are what a real gateway reports. */
const MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4.1-pro',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'claude-sonnet-4-5-20250929',
]

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-submenu-width-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const screenshotPath = runArtifact('runtime-picker-submenu.png')
  let electron
  let client
  const failures = []
  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(dirname(screenshotPath), { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config(workplaceDir), null, 2)}\n`, 'utf8')
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.runtime-picker-trigger'))`), 90_000, 'composer')

    // Narrow window first: the flyout has to fit what the viewport actually leaves.
    await harness.desktopAction(locator, 'resize', { width: 900, height: 760 })
    await openModelSubmenu(client)

    const measured = await client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      if (!(submenu instanceof HTMLElement)) return null;
      const panel = document.querySelector('.runtime-picker-panel');
      const options = [...submenu.querySelectorAll('.runtime-model-option')];
      const rect = submenu.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        submenuWidth: Math.round(rect.width),
        submenuLeft: Math.round(rect.left),
        submenuRight: Math.round(rect.right),
        panelRight: Math.round(panelRect.right),
        viewportWidth: window.innerWidth,
        // A label is clipped when its span scrolls wider than the space it was given.
        clipped: options.filter((option) => {
          const span = option.querySelector('span:not(.runtime-menu-check)');
          return span instanceof HTMLElement && span.scrollWidth > span.clientWidth + 1;
        }).map((option) => (option.textContent || '').trim()),
        labels: options.map((option) => (option.textContent || '').trim()),
        overflowsRight: rect.right > window.innerWidth,
        overlapsPanel: rect.left < panelRect.right - 1,
        measureExists: Boolean(document.querySelector('.runtime-submenu-measure')),
        measureHidden: (() => {
          const ruler = document.querySelector('.runtime-submenu-measure');
          return ruler ? getComputedStyle(ruler).visibility : null;
        })(),
      };
    })()`)
    if (!measured) throw new Error('the model submenu was not measurable')
    if (!measured.measureExists) failures.push('the off-screen ruler is missing')
    if (measured.measureHidden !== 'hidden') failures.push(`the ruler is visible (${measured.measureHidden})`)
    if (measured.clipped.length > 0) {
      failures.push(`model labels are still clipped: ${JSON.stringify(measured.clipped)}`)
    }
    if (measured.overflowsRight) {
      failures.push(`the flyout overflows the window (${measured.submenuRight} > ${measured.viewportWidth})`)
    }
    if (measured.overlapsPanel) {
      failures.push(`the flyout covers the main menu (${measured.submenuLeft} < ${measured.panelRight})`)
    }
    if (measured.submenuWidth <= 143) {
      failures.push(`the flyout is still at its old fixed width (${measured.submenuWidth}px)`)
    }

    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'))

    // Wide window: the flyout keeps every name readable rather than stretching.
    await harness.desktopAction(locator, 'resize', { width: 1600, height: 1000 })
    await harness.waitFor(() => client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      return submenu ? submenu.getBoundingClientRect().right <= window.innerWidth : null;
    })()`), 20_000, 'flyout to settle after resize')
    const wide = await client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      const options = [...submenu.querySelectorAll('.runtime-model-option')];
      return {
        submenuWidth: Math.round(submenu.getBoundingClientRect().width),
        clipped: options.filter((option) => {
          const span = option.querySelector('span:not(.runtime-menu-check)');
          return span instanceof HTMLElement && span.scrollWidth > span.clientWidth + 1;
        }).length,
      };
    })()`)
    if (wide.clipped > 0) failures.push(`labels clip again in a wide window: ${wide.clipped}`)

    // The narrowest window the app supports: the flyout must stay inside the viewport
    // and must not run under the main menu, even though the names no longer fit.
    await harness.desktopAction(locator, 'resize', { width: 800, height: 600 })
    await harness.waitFor(() => client.evaluate(`window.innerWidth <= 810 ? true : null`), 20_000, 'the 800px viewport')
    await harness.waitFor(() => client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      return submenu ? submenu.getBoundingClientRect().right <= window.innerWidth : null;
    })()`), 20_000, 'flyout to settle at the minimum window')
    const minimum = await client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      const panel = document.querySelector('.runtime-picker-panel');
      const rect = submenu.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        submenuWidth: Math.round(rect.width),
        submenuLeft: Math.round(rect.left),
        panelRight: Math.round(panelRect.right),
        viewportWidth: window.innerWidth,
        overflowsRight: rect.right > window.innerWidth,
        overlapsPanel: rect.left < panelRect.right - 1,
      };
    })()`)
    if (minimum.overflowsRight) failures.push(`the flyout overflows the 800px window: ${JSON.stringify(minimum)}`)
    if (minimum.overlapsPanel) failures.push(`the flyout covers the menu at 800px: ${JSON.stringify(minimum)}`)

    // The closed chip follows the label it shows. Switching to a much longer model used to
    // leave the chip at the width recorded for the previous one, cutting the name mid-word
    // with no ellipsis (asked for 2026-10-15): it has to grow with the label, not only shrink
    // to it. Measured in a window that can afford the label, which is where the difference
    // shows; a row too narrow to hold it still clamps the chip.
    await harness.desktopAction(locator, 'resize', { width: 1600, height: 1000 })
    await harness.waitFor(() => client.evaluate(`(() => {
      const submenu = document.querySelector('.runtime-submenu.runtime-model-menu');
      return submenu ? submenu.getBoundingClientRect().right <= window.innerWidth : null;
    })()`), 20_000, 'flyout to settle before the model switch')
    const longest = MODELS[MODELS.length - 1]
    await client.evaluate(`(() => {
      const option = [...document.querySelectorAll('.runtime-model-option')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(longest)}));
      if (!(option instanceof HTMLElement)) return false;
      option.click();
      return true;
    })()`)
    await harness.waitFor(() => client.evaluate(`(() => {
      const trigger = document.querySelector('.runtime-picker-trigger');
      if (!(trigger instanceof HTMLElement) || document.querySelector('.runtime-menu-shell.open')) return null;
      return (trigger.textContent || '').includes(${JSON.stringify(longest)}) ? true : null;
    })()`), 20_000, `the closed chip to show ${longest}`)
    const closedChip = await client.evaluate(`(() => {
      const picker = document.querySelector('.runtime-picker');
      const trigger = document.querySelector('.runtime-picker-trigger');
      const model = document.querySelector('.runtime-picker-model');
      const group = document.querySelector('.runtime-picker-label-group');
      const width = (node) => node ? Math.round(node.getBoundingClientRect().width) : null;
      return {
        label: (model?.textContent || '').trim(),
        pickerWidth: width(picker),
        pickerMaxWidth: getComputedStyle(picker).maxWidth,
        pickerClosedVar: getComputedStyle(picker).getPropertyValue('--runtime-picker-closed-width').trim(),
        labelWidth: width(group),
        rightWidth: width(document.querySelector('.composer-right')),
        leftWidth: width(document.querySelector('.composer-left')),
        rowWidth: width(document.querySelector('.composer-controls')),
        triggerClient: trigger.clientWidth,
        triggerScroll: trigger.scrollWidth,
        clips: trigger.scrollWidth > trigger.clientWidth + 1,
      };
    })()`)
    if (closedChip.label !== longest) {
      failures.push(`the chip did not take the longer model: ${JSON.stringify(closedChip)}`)
    }
    if (closedChip.clips) {
      failures.push(`the closed chip clips its label: ${JSON.stringify(closedChip)}`)
    }

    console.log(JSON.stringify({
      check: 'runtime-picker-submenu-width',
      ok: failures.length === 0,
      screenshot: screenshotPath,
      narrow: measured,
      wide,
      minimum,
      closedChip,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

async function openModelSubmenu(client) {
  const state = await harness.waitFor(async () => {
    const snapshot = await client.evaluate(`(() => {
      const trigger = document.querySelector('.runtime-picker-trigger');
      return trigger ? { text: (trigger.textContent || '').trim(), disabled: trigger.disabled === true } : null;
    })()`)
    return snapshot && !snapshot.disabled ? snapshot : undefined
  }, 60_000, 'the runtime picker to become usable')
  await client.evaluate(`document.querySelector('.runtime-picker-trigger').click()`)
  await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.runtime-menu-shell.open'))`), 20_000, `open menu (trigger said ${JSON.stringify(state)})`)
  await client.evaluate(`(() => {
    const trigger = document.querySelector('.runtime-submenu-trigger');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true;
  })()`)
  try {
    await harness.waitFor(
      () => client.evaluate(`Boolean(document.querySelector('.runtime-submenu.runtime-model-menu.visible'))`),
      20_000,
      'model submenu',
    )
  } catch (error) {
    const debug = await client.evaluate(`(() => {
      const shell = document.querySelector('.runtime-menu-shell');
      const triggers = [...document.querySelectorAll('.runtime-submenu-trigger')];
      const empty = document.querySelector('.runtime-empty');
      return {
        shellOpen: shell?.className ?? null,
        triggers: triggers.map((node) => (node.textContent || '').trim()),
        empty: (empty?.textContent || '').trim() || null,
        pickerTrigger: (document.querySelector('.runtime-picker-trigger')?.textContent || '').trim(),
      };
    })()`)
    throw new Error(`${error.message}; dom=${JSON.stringify(debug)}`)
  }
}

function config(workspaceDir) {
  return {
    version: 1,
    providers: [{
      id: 'openai-go',
      name: 'openai go',
      baseURL: 'http://127.0.0.1:9/v1',
      // A plaintext key, so the provider counts as configured without depending on
      // an ambient environment variable the developer machine happens to have.
      apiKey: 'sk-submenu-width-fixture',
      models: MODELS,
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `openai-go/${MODELS[0]}`,
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

await main()
