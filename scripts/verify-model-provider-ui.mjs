// Real Electron verification for 设置 → 模型供应商.
//
// The page must render the provider cards in normal flow and open the editor
// as a viewport-fixed dialog. This guards the regression where both layers end
// up in the same column and visually overlap.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Process launch/exit, the locator handshake, the CDP client and the polling
// primitives come from the shared real-window harness.
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = 60_000
const SCREENSHOT_PATH = join(repoRoot, '.codex_tmp', 'model-provider-ui.png')
const LIST_SCREENSHOT_PATH = join(repoRoot, '.codex_tmp', 'model-provider-list.png')
const harness = createElectronHarness({ startTimeoutMs: START_TIMEOUT_MS })
const { waitFor, reservePort, waitForExit } = harness

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-model-provider-ui-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  let electron
  let client
  let preserve = false

  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(dirname(SCREENSHOT_PATH), { recursive: true }),
    ])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir), null, 2)}\n`, 'utf8')

    const debuggingPort = await reservePort()
    electron = await startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    client = await connectRenderer(debuggingPort)
    await waitForRendererReady(client)

    await client.evaluate(`document.querySelector('.settings-entry-btn')?.click()`)
    await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.settings-workspace'))`), START_TIMEOUT_MS, 'settings workspace')
    const revealOnOpen = await waitFor(async () => client.evaluate(`document.querySelector('.presence-layer.settings-presence')?.classList.contains('visible') || null`), 5_000, 'settings reveal').then(() => true, () => false)
    const opened = await client.evaluate(`(() => {
      const item = [...document.querySelectorAll('.settings-nav-item')]
        .find((candidate) => candidate.textContent?.includes('模型供应商'))
      if (!(item instanceof HTMLElement)) return false
      item.click()
      return true
    })()`)
    if (!opened) throw new Error('模型供应商 settings navigation item was unavailable')
    await waitFor(async () => client.evaluate(`document.querySelector('.settings-nav-item.active')?.textContent?.includes('模型供应商') === true`), START_TIMEOUT_MS, 'model provider page')
    // Settings replays its reveal fade on every navigation; measure only after
    // the surface reaches full opacity or the capture shows the app underneath.
    await waitForSettingsReveal(client)
    const revealOnPage = await client.evaluate(`(() => {
      const layer = document.querySelector('.presence-layer.settings-presence')
      const body = document.querySelector('.settings-workspace-body')
      return {
        layerClass: layer?.className ?? null,
        bodyOpacity: body ? getComputedStyle(body).opacity : null,
      }
    })()`)
    // Control: navigate to a page unrelated to this change and sample the same
    // reveal state, so a re-fade is attributable to navigation in general.
    const otherPageReveal = await client.evaluate(`(async () => {
      const item = [...document.querySelectorAll('.settings-nav-item')]
        .find((candidate) => candidate.textContent?.includes('内置浏览器'))
      item?.click()
      const samples = []
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
        const layer = document.querySelector('.presence-layer.settings-presence')
        const body = document.querySelector('.settings-workspace-body')
        samples.push({
          className: layer?.className ?? null,
          opacity: body ? Number(getComputedStyle(body).opacity) : null,
        })
      }
      const back = [...document.querySelectorAll('.settings-nav-item')]
        .find((candidate) => candidate.textContent?.includes('模型供应商'))
      back?.click()
      return samples
    })()`)
    await waitFor(async () => client.evaluate(`document.querySelectorAll('.provider-card').length >= 1 || null`), START_TIMEOUT_MS, 'provider cards')

    const listState = await client.evaluate(`(() => {
      const page = document.querySelector('.settings-module-page')
      if (!(page instanceof HTMLElement)) return null
      const cards = [...page.querySelectorAll('.provider-card')].map((card) => {
        const rect = card.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
      })
      return {
        inlineDialogCount: page.querySelectorAll('.dialog').length,
        editorPanelCount: page.querySelectorAll('.overlay').length,
        cardCount: cards.length,
        cardNames: [...page.querySelectorAll('.provider-card .provider-card-title strong')].map((node) => node.textContent ?? ''),
        emptyStateVisible: Boolean(page.querySelector('.provider-empty')),
        hiddenPresetsListed: [...page.querySelectorAll('.provider-card .provider-card-title strong')]
          .map((node) => node.textContent ?? '')
          .filter((name) => name === 'OpenAI' || name === 'DeepSeek' || name === 'GLM / Zhipu AI').length,
        overlappingCards: cards.filter((card, index) => index > 0 && card.top < cards[index - 1].bottom - 1).length,
        horizontalOverflow: page.scrollWidth - page.clientWidth,
        cards,
      }
    })()`)
    if (!listState) throw new Error('model provider page was not measurable')
    // Only configured providers belong on the page: the fixture configures one
    // custom provider, and the three built-in presets have no key.
    if (listState.cardCount !== 1) {
      throw new Error(`expected only the configured provider card, saw ${JSON.stringify(listState.cardNames)}`)
    }
    if (listState.hiddenPresetsListed !== 0) {
      throw new Error(`unconfigured built-in presets were listed: ${JSON.stringify(listState.cardNames)}`)
    }
    if (listState.emptyStateVisible) {
      throw new Error('empty state was rendered while a configured provider exists')
    }
    if (listState.inlineDialogCount !== 0 || listState.editorPanelCount !== 0) {
      throw new Error(`provider list rendered an editor panel: ${JSON.stringify(listState)}`)
    }
    if (listState.overlappingCards !== 0) {
      throw new Error(`provider cards overlap in normal flow: ${JSON.stringify(listState.cards)}`)
    }
    if (listState.horizontalOverflow > 1) {
      throw new Error(`provider page overflows horizontally by ${listState.horizontalOverflow}px`)
    }
    await captureScreenshot(client, LIST_SCREENSHOT_PATH)

    const pickerState = await client.evaluate(`(async () => {
      const addButton = document.querySelector('.provider-actions .provider-add')
      if (!(addButton instanceof HTMLElement)) return null
      addButton.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
      const picker = document.querySelector('.provider-template-picker')
      if (!(picker instanceof HTMLElement)) return null
      const groups = [...picker.querySelectorAll('.provider-template-group')].map((node) => node.textContent ?? '')
      const buttons = [...picker.querySelectorAll('.provider-template strong')].map((node) => node.textContent ?? '')
      return { groups, buttons }
    })()`)
    if (!pickerState) throw new Error('add-provider picker did not open')
    if (!pickerState.buttons.includes('OpenAI') || !pickerState.buttons.includes('OpenRouter')) {
      throw new Error(`add-provider picker is missing presets or templates: ${JSON.stringify(pickerState)}`)
    }
    await client.evaluate(`document.querySelector('.provider-template-picker .dialog-close')?.click()`)
    await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.provider-actions')) || null`), START_TIMEOUT_MS, 'provider list after picker')

    const editorOpened = await client.evaluate(`(() => {
      const button = document.querySelector('.provider-card .provider-card-actions .save-btn')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`)
    if (!editorOpened) throw new Error('provider editor button was unavailable')
    await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.settings-module-page .overlay .provider-editor')) || null`), START_TIMEOUT_MS, 'provider editor panel')
    await waitForSettingsReveal(client)

    const modalState = await client.evaluate(`(() => {
      const overlay = document.querySelector('.settings-module-page .overlay')
      const dialog = document.querySelector('.provider-editor')
      if (!(overlay instanceof HTMLElement) || !(dialog instanceof HTMLElement)) return null
      const overlayStyle = getComputedStyle(overlay)
      const overlayRect = overlay.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      const body = dialog.querySelector('.provider-editor-body')
      const field = dialog.querySelector('.settings-inline-field')
      const row = dialog.querySelector('.provider-model-row')
      const dialogStyle = getComputedStyle(dialog)
      return {
        position: overlayStyle.position,
        overlayRect: { top: overlayRect.top, left: overlayRect.left, width: overlayRect.width, height: overlayRect.height },
        dialogRect: { top: dialogRect.top, left: dialogRect.left, width: dialogRect.width, height: dialogRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        modelRowCount: dialog.querySelectorAll('.provider-model-row').length,
        fieldCount: dialog.querySelectorAll('.settings-inline-field').length,
        parentClass: overlay.parentElement?.className ?? '',
        remainingCards: document.querySelectorAll('.settings-module-page .provider-card').length,
        computed: {
          surface: dialogStyle.getPropertyValue('--surface'),
          radiusUi: dialogStyle.getPropertyValue('--radius-ui'),
          dialogBackground: dialogStyle.backgroundColor,
          dialogDisplay: dialogStyle.display,
          dialogWidth: dialogStyle.width,
          bodyDisplay: body ? getComputedStyle(body).display : null,
          bodyDirection: body ? getComputedStyle(body).flexDirection : null,
          fieldDisplay: field ? getComputedStyle(field).display : null,
          rowDisplay: row ? getComputedStyle(row).display : null,
          rowColumns: row ? getComputedStyle(row).gridTemplateColumns : null,
          styleSheetCount: document.styleSheets.length,
          stylesheetHasOverlayRule: [...document.styleSheets].some((sheet) => {
            try {
              return [...sheet.cssRules].some((rule) => String(rule.cssText).includes('.provider-editor-overlay'))
            } catch {
              return false
            }
          }),
          matchedDialogRules: [...document.styleSheets].flatMap((sheet) => {
            try {
              return [...sheet.cssRules]
                .filter((rule) => rule.selectorText && dialog.matches(rule.selectorText))
                .map((rule) => ({
                  selector: rule.selectorText,
                  width: rule.style.width,
                  background: rule.style.background,
                  backgroundColor: rule.style.backgroundColor,
                  position: rule.style.position,
                }))
            } catch {
              return []
            }
          }),
        },
      }
    })()`)
    if (!modalState) throw new Error('provider editor dialog was not measurable')
    // Inside the settings workspace the shared overlay is neutralized to an
    // in-flow block on purpose; the editor must be the page's only panel.
    if (modalState.position !== 'relative') {
      throw new Error(`provider editor panel is not in the settings flow: ${JSON.stringify(modalState)}`)
    }
    if (modalState.remainingCards !== 0) {
      throw new Error(`provider list was still rendered behind the editor: ${JSON.stringify(modalState)}`)
    }
    const dialogInsideViewport = modalState.dialogRect.left >= -1
      && modalState.dialogRect.left + modalState.dialogRect.width <= modalState.viewport.width + 1
    if (!dialogInsideViewport) {
      throw new Error(`provider editor dialog overflows the viewport horizontally: ${JSON.stringify(modalState)}`)
    }
    if (modalState.dialogRect.width < 600) {
      throw new Error(`provider editor dialog collapsed to ${modalState.dialogRect.width}px: ${JSON.stringify(modalState)}`)
    }
    if (modalState.modelRowCount < 1 || modalState.fieldCount < 4) {
      throw new Error(`provider editor dialog is missing fields or model rows: ${JSON.stringify(modalState)}`)
    }

    await captureScreenshot(client, SCREENSHOT_PATH)
    const surfaceProbe = await client.evaluate(`(() => {
      const describe = (element) => ({
        className: element.className,
        opacity: getComputedStyle(element).opacity,
        visibility: getComputedStyle(element).visibility,
        top: Math.round(element.getBoundingClientRect().top),
        height: Math.round(element.getBoundingClientRect().height),
      })
      const layers = [...document.querySelectorAll('.presence-layer')].map(describe)
      const workspaces = [...document.querySelectorAll('.settings-workspace')].map(describe)
      const bodies = [...document.querySelectorAll('.settings-workspace-body')].map(describe)
      const body = document.querySelector('.settings-workspace-body')
      const composer = document.querySelector('.composer')
      const point = { x: Math.round(window.innerWidth * 0.62), y: Math.round(window.innerHeight * 0.5) }
      const hit = document.elementFromPoint(point.x, point.y)
      return {
        bodyBackground: body ? getComputedStyle(body).backgroundColor : null,
        bodyRect: body ? { top: body.getBoundingClientRect().top, height: body.getBoundingClientRect().height } : null,
        bodyOpacity: body ? getComputedStyle(body).opacity : null,
        composerRect: composer ? { top: composer.getBoundingClientRect().top, height: composer.getBoundingClientRect().height } : null,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        hitText: hit instanceof HTMLElement ? (hit.textContent ?? '').slice(0, 40) : null,
        layers,
        workspaces,
        bodies,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      }
    })()`)
    const rafProbe = await client.evaluate(`new Promise((resolvePromise) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolvePromise({ raf: false }) } }, 2000)
      requestAnimationFrame(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ raf: true })
      })
    })`)
    client.close()
    client = undefined
    console.log(JSON.stringify({
      check: 'model-provider-ui',
      ok: true,
      screenshot: SCREENSHOT_PATH,
      cardCount: listState.cardCount,
      modelRowCount: modalState.modelRowCount,
      panelPosition: modalState.position,
      surfaceProbe,
      rafProbe,
      revealOnOpen,
      revealOnPage,
      otherPageReveal,
      diagnostics: modalState.computed,
    }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'model-provider-ui',
      ok: false,
      root,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!preserve) {
      // Chromium keeps profile files locked for a moment after the process is
      // signalled; the temp root is disposable either way.
      await waitForExit(electron, 20_000).catch(() => undefined)
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
    }
  }
}

function buildConfig(workspaceDir) {
  return {
    version: 1,
    providers: [{
      id: 'local-gw',
      name: '本地网关',
      baseURL: 'http://127.0.0.1:8000/v1',
      models: [{
        id: 'vendor-model',
        name: 'Vendor Model',
        contextWindow: 128000,
        maxOutputTokens: 32000,
        reasoningOptions: ['auto', 'high'],
      }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'local-gw/vendor-model',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 120,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function startElectron({ dataDir, chromiumDir, debuggingPort, logPath }) {
  return harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath,
    // The fixture data root must decide what counts as configured: ambient
    // provider keys would silently enable built-in presets.
    extraEnv: Object.fromEntries(
      ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GLM_API_KEY', 'LOCAL_GW_API_KEY'].map((name) => [name, undefined]),
    ),
  })
}

async function connectRenderer(port) {
  const client = await harness.connectRenderer(port)
  // This gate captures screenshots, so it turns the Page domain on itself.
  await client.send('Page.enable')
  await waitFor(async () => {
    try {
      return await client.evaluate(`Boolean(document.querySelector('.composer textarea') && document.querySelector('.sidebar-resizer'))`)
    } catch {
      // The startup page and the renderer share a WebContents. Navigation can
      // replace the execution context between target discovery and evaluation.
      return undefined
    }
  }, START_TIMEOUT_MS, 'renderer UI context')
  return client
}

async function waitForRendererReady(client) {
  await waitFor(async () => client.evaluate(`Boolean(document.querySelector('.composer textarea') && document.querySelector('.sidebar-resizer'))`), START_TIMEOUT_MS, 'renderer UI')
}

/**
 * Settings replays its reveal fade on every navigation. Measuring or capturing
 * before it settles shows the app underneath the settings surface.
 */
async function waitForSettingsReveal(client) {
  await waitFor(async () => client.evaluate(`(() => {
    const layer = document.querySelector('.presence-layer.settings-presence')
    const body = document.querySelector('.settings-workspace-body')
    if (!(layer instanceof HTMLElement) || !(body instanceof HTMLElement)) return null
    return layer.classList.contains('presence-open')
      && Number(getComputedStyle(body).opacity) > 0.99
      ? true
      : null
  })()`), START_TIMEOUT_MS, 'settings reveal settle')
}

async function captureScreenshot(client, path) {
  await client.send('Page.enable')
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
}

await main()
