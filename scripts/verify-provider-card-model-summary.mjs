// Real-window check for 设置 → 模型供应商 with a provider that declares many models.
//
// The reported defect: a provider with dozens of models rendered as one wall of
// identical chips, so the page never said what was configured. This asserts the card
// states the count, bounds its preview, and offers the rest behind one control.
//
// Usage:
//   node scripts/verify-provider-card-model-summary.mjs [--keep]
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

/** 40 models, mostly bare ids: the shape the report came from. */
const MANY_MODELS = Array.from({ length: 40 }, (_, index) => (
  index === 0 ? { id: 'deepseek-v4.1-flash', contextWindow: 1000000, maxOutputTokens: 640000 } : { id: `vendor-model-${index}` }
))
const FEW_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-card-summary-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const outDir = runArtifact('provider-card-summary')
  let electron
  let client
  const failures = []
  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config(workplaceDir), null, 2)}\n`, 'utf8')
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-entry-btn'))`), 90_000, 'renderer')
    await client.evaluate(`document.querySelector('.settings-entry-btn').click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-workspace'))`), 60_000, 'settings')
    // Settings replays its reveal fade on open and on every navigation; a click that
    // lands mid-fade is dropped, so the reveal has to settle first.
    await waitForReveal(client)
    await client.evaluate(`[...document.querySelectorAll('.settings-nav-item')]
      .find((item) => item.textContent.includes('模型供应商'))?.click()`)
    try {
      await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-card'))`), 60_000, 'provider cards')
    } catch (error) {
      const debug = await client.evaluate(`(() => ({
        navItems: [...document.querySelectorAll('.settings-nav-item')].map((n) => (n.textContent || '').trim()),
        active: document.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? null,
        cards: document.querySelectorAll('.provider-card').length,
        pageText: (document.querySelector('.settings-module-page')?.textContent || '').slice(0, 400),
      }))()`)
      throw new Error(`${error.message}; dom=${JSON.stringify(debug)}`)
    }
    await harness.waitFor(() => client.evaluate(`(() => {
      const layer = document.querySelector('.presence-layer.settings-presence');
      const body = document.querySelector('.settings-workspace-body');
      return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
    })()`), 30_000, 'settings reveal')

    const collapsed = await readCardState(client, 'openai go')
    if (!collapsed) throw new Error('the openai go card was not found on the page')
    if (collapsed.summary === null) failures.push('the card does not state how many models are configured')
    if (!(collapsed.summary ?? '').includes('40')) failures.push(`the count does not report 40: ${collapsed.summary}`)
    if (collapsed.visibleChips !== 8) failures.push(`the collapsed preview shows ${collapsed.visibleChips} chips, expected 8`)
    if (collapsed.expanded !== false) failures.push('the card starts expanded instead of showing a readable preview')
    if (!(collapsed.toggleLabel ?? '').includes('32')) {
      failures.push(`the toggle does not say how many are hidden: ${collapsed.toggleLabel}`)
    }
    if (collapsed.chipsFitViewport !== true) failures.push('the card overflows horizontally')
    await shot(client, outDir, 'card-collapsed')

    // The other provider states its own count and needs no toggle.
    const few = await readCardState(client, 'small gw')
    if (few.summary !== '2 个模型') failures.push(`a small provider misstates its count: ${few.summary}`)
    if (few.toggleVisible) failures.push('a small provider still shows an expand control')

    // Expanding reveals every configured model, and collapsing puts it back.
    await client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.provider-card')]
        .find((node) => (node.querySelector('.provider-card-title strong')?.textContent || '').trim() === 'openai go');
      card.querySelector('.provider-models-toggle').click();
    })()`)
    await harness.waitFor(() => client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.provider-card')]
        .find((node) => (node.querySelector('.provider-card-title strong')?.textContent || '').trim() === 'openai go');
      return card && card.querySelectorAll('.provider-model-chip').length === 40;
    })()`), 20_000, 'every model to be reachable')
    const expanded = await readCardState(client, 'openai go')
    if (expanded.expanded !== true) failures.push('the expanded card does not report aria-expanded')
    if (expanded.chipsFitViewport !== true) failures.push('the expanded card overflows horizontally')
    await shot(client, outDir, 'card-expanded')

    await client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.provider-card')]
        .find((node) => (node.querySelector('.provider-card-title strong')?.textContent || '').trim() === 'openai go');
      card.querySelector('.provider-models-toggle').click();
    })()`)
    await harness.waitFor(() => client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.provider-card')]
        .find((node) => (node.querySelector('.provider-card-title strong')?.textContent || '').trim() === 'openai go');
      return card && card.querySelectorAll('.provider-model-chip').length === 8;
    })()`), 20_000, 'the preview to fold back')

    console.log(JSON.stringify({
      check: 'provider-card-model-summary',
      ok: failures.length === 0,
      screenshots: [join(outDir, 'card-collapsed.png'), join(outDir, 'card-expanded.png')],
      collapsed,
      expanded,
      few,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

/** Wait for the settings surface's reveal fade, which gates nav clicks. */
async function waitForReveal(client) {
  await harness.waitFor(() => client.evaluate(`(() => {
    const layer = document.querySelector('.presence-layer.settings-presence');
    const body = document.querySelector('.settings-workspace-body');
    return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
  })()`), 30_000, 'settings reveal')
}

async function readCardState(client, providerName) {
  return client.evaluate(`(() => {
    // Match the card's own title, not its body: a model id can contain another
    // provider's name ("deepseek-v4.1-flash" lives under openai go in this fixture).
    const card = [...document.querySelectorAll('.provider-card')]
      .find((node) => (node.querySelector('.provider-card-title strong')?.textContent || '').trim() === ${JSON.stringify(providerName)});
    if (!card) return null;
    const toggle = card.querySelector('.provider-models-toggle');
    return {
      summary: card.querySelector('.provider-model-count')?.textContent?.trim() ?? null,
      note: card.querySelector('.provider-card-note')?.textContent?.trim() ?? null,
      visibleChips: card.querySelectorAll('.provider-model-chip').length,
      toggleVisible: Boolean(toggle),
      toggleLabel: toggle ? (toggle.textContent || '').trim() : null,
      expanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : false,
      chipsFitViewport: card.getBoundingClientRect().right <= window.innerWidth
        && card.scrollWidth <= card.clientWidth,
    };
  })()`)
}

async function shot(client, dir, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

function config(workspaceDir) {
  return {
    version: 1,
    providers: [
      {
        id: 'openai-go',
        name: 'openai go',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-card-summary-fixture',
        models: MANY_MODELS,
      },
      {
        // A small custom provider: it must state its count and offer no expand
        // control, which is the other half of the reported problem. It is not a
        // built-in preset id, so nothing merges extra models into it.
        id: 'small-gw',
        name: 'small gw',
        baseURL: 'http://127.0.0.1:10/v1',
        apiKey: 'sk-card-summary-fixture',
        models: FEW_MODELS,
      },
    ],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'openai-go/vendor-model-1',
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
