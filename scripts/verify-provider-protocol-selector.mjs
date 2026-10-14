// Real-window check for 设置 → 模型供应商 with the API 协议 selector.
//
// The protocol is what decides which wire client a provider gets, so it has to be
// visible, changeable, and — critically — PERSISTED. A selector that renders but
// does not round-trip through config would look correct and silently run every
// provider as chat-completions, which is the defect this whole change exists to fix.
//
// Usage:
//   node scripts/verify-provider-protocol-selector.mjs [--keep]
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

/** Every protocol the UI must offer, in the order the contract lists them. */
const EXPECTED_PROTOCOLS = ['openai-chat-completions', 'openai-responses', 'anthropic-messages']

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-protocol-selector-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const outDir = runArtifact('provider-protocol-selector')
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
    await waitForReveal(client)
    await client.evaluate(`[...document.querySelectorAll('.settings-nav-item')]
      .find((item) => item.textContent.includes('模型供应商'))?.click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-card .save-btn'))`), 60_000, 'provider card')
    await waitForReveal(client)

    // Open the existing provider's editor.
    await client.evaluate(`document.querySelector('.provider-card .save-btn').click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-editor'))`), 30_000, 'editor')

    const selector = await readSelector(client)
    if (!selector) throw new Error('the API 协议 selector was not rendered')
    for (const protocol of EXPECTED_PROTOCOLS) {
      if (!selector.options.includes(protocol)) failures.push(`the selector is missing ${protocol}`)
    }
    if (selector.options.length !== EXPECTED_PROTOCOLS.length) {
      failures.push(`the selector offers ${selector.options.length} protocols, expected ${EXPECTED_PROTOCOLS.length}: ${JSON.stringify(selector.options)}`)
    }
    if (selector.value !== 'anthropic-messages') {
      failures.push(`an existing provider did not show its saved protocol: ${selector.value}`)
    }
    if (!selector.hint || !selector.hint.includes('Anthropic')) {
      failures.push(`the hint does not describe the selected protocol: ${selector.hint}`)
    }
    // The request path stays visible next to the control, and it is what actually
    // reaches the endpoint, so a wrong one is a 404 at run time.
    if (selector.path !== '/messages') {
      failures.push(`the visible path does not match the protocol: ${selector.path}`)
    }
    await shot(client, outDir, 'protocol-anthropic')

    // Switch protocol and save: the change must reach config.json, not just the DOM.
    await client.evaluate(`(() => {
      const select = document.querySelector('.provider-editor select');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'openai-responses');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    const switched = await readSelector(client)
    if (switched.value !== 'openai-responses') failures.push(`switching the protocol did not take: ${switched.value}`)
    if (switched.path !== '/responses') {
      failures.push(`the visible path did not follow the switch: ${switched.path}`)
    }
    await shot(client, outDir, 'protocol-responses')

    // An unsaved protocol change is real unsaved content, so closing must ask.
    await client.evaluate(`document.querySelector('.provider-editor button[aria-label="关闭"]').click()`)
    const asked = await harness.waitFor(
      () => client.evaluate(`Boolean(document.querySelector('.provider-editor-discard')) || null`),
      10_000,
      'the discard question',
    ).then(() => true, () => false)
    if (!asked) failures.push('changing only the protocol was treated as no change at all')
    await client.evaluate(`document.querySelector('.provider-editor-discard .close-btn').click()`)

    await client.evaluate(`document.querySelector('.provider-editor .save-btn').click()`)
    await harness.waitFor(() => client.evaluate(`!document.querySelector('.provider-editor') || null`), 30_000, 'the save to settle')

    const persisted = await readPersistedProviders(dataDir)
    const saved = persisted.find((provider) => provider.id === 'proto-fixture')
    if (!saved) failures.push('the provider disappeared from config.json')
    else if (saved.api !== 'openai-responses') {
      failures.push(`the protocol did not reach config.json (got ${JSON.stringify(saved.api)})`)
    }

    console.log(JSON.stringify({
      check: 'provider-protocol-selector',
      ok: failures.length === 0,
      screenshots: [join(outDir, 'protocol-anthropic.png'), join(outDir, 'protocol-responses.png')],
      selector,
      switched,
      persistedProtocol: saved?.api ?? null,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

async function readSelector(client) {
  return client.evaluate(`(() => {
    const select = document.querySelector('.provider-editor select');
    if (!(select instanceof HTMLSelectElement)) return null;
    // The protocol's own description lives in the control's tooltip (the panel keeps
    // only the request path visible), so both are read here.
    return {
      value: select.value,
      options: [...select.options].map((option) => option.value),
      labels: [...select.options].map((option) => option.textContent.trim()),
      path: (document.querySelector('#provider-protocol-hint')?.textContent || '').trim(),
      hint: select.getAttribute('title'),
    };
  })()`)
}

async function readPersistedProviders(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'))
    return Array.isArray(parsed.providers) ? parsed.providers : []
  } catch {
    return []
  }
}

async function waitForReveal(client) {
  await harness.waitFor(() => client.evaluate(`(() => {
    const layer = document.querySelector('.presence-layer.settings-presence');
    const body = document.querySelector('.settings-workspace-body');
    return Boolean(layer && body && layer.classList.contains('presence-open') && Number(getComputedStyle(body).opacity) > 0.99);
  })()`), 30_000, 'settings reveal')
}

async function shot(client, dir, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

function config(workspaceDir) {
  return {
    version: 1,
    providers: [{
      id: 'proto-fixture',
      name: 'proto fixture',
      baseURL: 'https://api.anthropic.com/v1',
      api: 'anthropic-messages',
      apiKey: 'sk-protocol-fixture',
      models: ['claude-fixture'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'proto-fixture/claude-fixture',
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
