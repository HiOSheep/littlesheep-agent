// Visual capture of 设置 → 模型供应商 with the reworked editor.
//
// The layout gate (`verify-model-provider-ui`) asserts geometry; this one writes the
// pixels a person would look at, for the editor's two states: the empty draft and a
// draft populated from the endpoint's catalog. Run with `--keep` to keep the root.
//
// Usage:
//   node scripts/capture-model-provider-editor.mjs [--keep]
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

async function main() {
  await harness.assertBuildFresh()
  const outDir = runArtifact('model-provider-editor')
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-provider-capture-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const provider = await startElectronAcceptanceProvider({
    models: ['vendor-listed', 'vendor-strong', 'vendor-mini'],
  })
  let electron
  let client
  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config(workplaceDir), null, 2)}\n`, 'utf8')
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-entry-btn'))`), 90_000, 'renderer')
    await client.evaluate(`document.querySelector('.settings-entry-btn').click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-workspace'))`), 90_000, 'settings')
    // The settings surface replays its reveal fade on navigation; capturing mid-fade
    // shows the app underneath it.
    await harness.waitFor(() => client.evaluate(`(() => {
      const layer = document.querySelector('.presence-layer.settings-presence');
      const body = document.querySelector('.settings-workspace-body');
      return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
    })()`), 30_000, 'settings reveal')
    await client.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((item) => item.textContent.includes('模型供应商'))?.click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-add'))`), 30_000, 'provider page')
    await harness.waitFor(() => client.evaluate(`(() => {
      const layer = document.querySelector('.presence-layer.settings-presence');
      const body = document.querySelector('.settings-workspace-body');
      return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
    })()`), 30_000, 'provider page reveal')
    await client.evaluate(`[...document.querySelectorAll('.provider-add')][1].click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-editor'))`), 30_000, 'editor')
    await shot(client, outDir, 'editor-empty')

    // Fill the draft the way a person would, then read the catalog. Fields are
    // addressed by their label rather than by position: adding a field (the API 协议
    // select) silently re-pointed every `:nth-of-type` selector here.
    await setInputByLabel(client, '供应商 ID', 'openai-go')
    await setInputByLabel(client, '显示名称', 'openai go')
    await setInputByLabel(client, 'API 地址', provider.baseURL)
    await setInputByLabel(client, 'API 密钥', 'sk-capture-fixture')
    await harness.waitFor(() => client.evaluate(`!document.querySelector('#provider-fetch-blocked')`), 20_000, 'fetch enabled')
    await shot(client, outDir, 'editor-filled')
    await client.evaluate(`document.querySelector('.provider-fetch-models').click()`)
    await harness.waitFor(
      () => client.evaluate(`Boolean(document.querySelector('.provider-fetch-result'))`),
      30_000,
      'catalog result',
    )
    await shot(client, outDir, 'editor-after-fetch')
    console.log(JSON.stringify({
      ok: true,
      screenshots: ['editor-empty.png', 'editor-filled.png', 'editor-after-fetch.png'].map((name) => join(outDir, name)),
      modelIds: await client.evaluate(`[...document.querySelectorAll('.provider-model-row .provider-model-id')].map((i) => i.value)`),
    }))
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    await provider.close().catch(() => undefined)
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

async function setInput(client, selector, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
}

/** Fill one editor field by its visible label, so adding a field cannot break this. */
async function setInputByLabel(client, label, value) {
  const filled = await client.evaluate(`(() => {
    const field = [...document.querySelectorAll('.provider-editor .settings-inline-field')]
      .find((node) => (node.querySelector('span')?.textContent || '').trim() === ${JSON.stringify(label)});
    const input = field?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  if (!filled) throw new Error(`the editor has no field labelled ${label}`)
  return filled
}

async function shot(client, dir, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

function config(workspaceDir) {
  return {
    version: 1,
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

await main()
