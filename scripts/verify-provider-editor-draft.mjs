// Real-window acceptance for the provider editor's draft and leave behaviour (taskbook UX-06).
//
// UX-06 was that the settings draft lived in page-local state and the settings container remounts
// per page, so switching settings pages threw the edit away; closing or cancelling dropped it
// silently, and the close entry stayed clickable while a save was in flight.
//
// The contract now is an in-memory editing session with four visible states (untouched, modified,
// saving, save failed). This fixture drives the real editor and checks each acceptance bullet:
// edit → switch page → return; cancel; a failed save; and closing while saving.
//
// Usage:
//   node scripts/verify-provider-editor-draft.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-provider-draft')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1180, height: 780 }
const EVALUATE_TIMEOUT_MS = 20_000
const DRAFT_NAME = '草稿中的显示名称'

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
      id: 'acceptance', name: 'Draft Acceptance Provider', baseURL: providerBaseURL,
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

/** Fail or hold the next provider save, and count every one the renderer issues. */
const INSTALL_SAVE_PROBE = `(() => {
  if (window.__lsSaveProbe) return true
  const probe = { saves: 0, failNext: false, delayNextMs: 0, failures: 0 }
  window.__lsSaveProbe = probe
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    if (method === 'POST' && url.includes('/config/providers')) {
      probe.saves += 1
      if (probe.delayNextMs > 0) {
        const waitMs = probe.delayNextMs
        probe.delayNextMs = 0
        await new Promise((done) => setTimeout(done, waitMs))
      }
      if (probe.failNext) {
        probe.failNext = false
        probe.failures += 1
        return new Response(JSON.stringify({ error: 'acceptance fixture: provider save failed on purpose' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return originalFetch(input, init)
  }
  return true
})()`

const EDITOR_STATE_EXPRESSION = `(() => {
  const editor = document.querySelector('.provider-editor')
  if (!(editor instanceof HTMLElement)) return null
  const inputs = [...editor.querySelectorAll('.settings-inline-field input')]
  return {
    label: editor.getAttribute('aria-label'),
    name: inputs[1]?.value ?? null,
    status: editor.querySelector('.provider-editor-status')?.textContent?.trim() ?? null,
    error: [...editor.querySelectorAll('.dialog-error')].map((element) => element.textContent?.trim() ?? ''),
    closeDisabled: editor.querySelector('.dialog-close')?.disabled ?? null,
    cancelDisabled: editor.querySelector('.close-btn')?.disabled ?? null,
    saveLabel: editor.querySelector('.save-btn')?.textContent?.trim() ?? null,
    saveDisabled: editor.querySelector('.save-btn')?.disabled ?? null,
  }
})()`

const CARDS_EXPRESSION = `(() => [...document.querySelectorAll('.provider-card')].map((card) => ({
  title: card.querySelector('.provider-card-title')?.textContent?.trim() ?? '',
  text: card.textContent?.trim().slice(0, 80) ?? '',
})))()`

async function openSettingsPage(client, label) {
  await evaluate(client, `(() => {
    if (!document.querySelector('.settings-workspace')) document.querySelector('.settings-entry-btn')?.click()
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

async function openEditor(client) {
  // Returning to the page with a stored session draft re-opens the editor by itself (the restored
  // draft is what decides whether the editor renders), so an already-open editor is the expected
  // outcome there and the list's edit entry is only needed when nothing is being edited.
  await harness.waitFor(() => evaluate(client, `(() => {
    if (document.querySelector('.provider-editor')) return 'editor'
    return document.querySelector('.provider-card .save-btn') ? 'list' : null
  })()`), harness.startTimeoutMs, 'the provider editor or its edit entry')
    .catch(async (error) => {
      const diagnostics = {
        settingsOpen: await evaluate(client, `Boolean(document.querySelector('.settings-workspace'))`).catch(() => null),
        presenceHidden: await evaluate(client, `Boolean(document.querySelector('.settings-presence.presence-hidden'))`).catch(() => null),
        activeNav: await evaluate(client, `document.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? null`).catch(() => null),
        editorOpen: await evaluate(client, `Boolean(document.querySelector('.provider-editor'))`).catch(() => null),
        cards: await evaluate(client, `document.querySelectorAll('.provider-card').length`).catch(() => null),
        visibleText: await evaluate(client, `(document.body.innerText ?? '').slice(0, 260)`).catch(() => null),
      }
      const path = await writePng(client, 'open-editor-diagnostic').catch(() => null)
      throw new Error(`${error.message}: ${JSON.stringify({ ...diagnostics, screenshot: path })}`)
    })
  const opened = await evaluate(client, `(() => {
    if (document.querySelector('.provider-editor')) return 'already-open'
    const button = [...document.querySelectorAll('.provider-card .save-btn')][0]
    if (!(button instanceof HTMLElement)) return 'missing'
    button.click()
    return 'clicked'
  })()`)
  if (opened === 'missing') throw new Error('no provider edit entry was found')
  await harness.waitFor(() => evaluate(client, `document.querySelector('.provider-editor') ? true : null`), harness.startTimeoutMs, 'the provider editor')
  await delay(200)
  return opened
}

async function typeName(client, value) {
  return evaluate(client, `(() => {
    const input = [...document.querySelectorAll('.provider-editor .settings-inline-field input')][1]
    if (!(input instanceof HTMLInputElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

const SECRET_MARKER = 'ux06-discard-secret-7f0c'

async function typeSecret(client) {
  return evaluate(client, `(() => {
    const input = document.querySelector('.provider-editor input[type="password"]')
    if (!(input instanceof HTMLInputElement)) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, ${JSON.stringify(SECRET_MARKER)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

async function secretState(client) {
  return evaluate(client, `(() => ({
    draftPresent: document.querySelector('.provider-editor input[type="password"]')?.value === ${JSON.stringify(SECRET_MARKER)},
    browserStorageClean: !JSON.stringify(Object.entries(localStorage)).includes(${JSON.stringify(SECRET_MARKER)})
      && !JSON.stringify(Object.entries(sessionStorage)).includes(${JSON.stringify(SECRET_MARKER)}),
  }))()`)
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-provider-draft-'))
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
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW)
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
    if (!await evaluate(client, INSTALL_SAVE_PROBE)) throw new Error('the save probe could not be installed')

    await openSettingsPage(client, '模型供应商')
    const providersBefore = await harness.fetchJson(locator, '/config/providers').then((response) => response.body?.providers ?? null)

    // --- 1. editing marks the session dirty ----------------------------------------------------
    await openEditor(client)
    const untouched = await evaluate(client, EDITOR_STATE_EXPRESSION)
    await typeName(client, DRAFT_NAME)
    const secretEntered = await typeSecret(client)
    await delay(200)
    const modified = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const secretWhileEditing = await secretState(client)
    const modifiedScreenshot = await writePng(client, 'editor-modified')

    // --- 2. switching settings pages with the editor open, then returning -----------------------
    // The modal overlay covers the settings content, not the navigation rail, so switching pages
    // mid-edit is a path a user really has. The editor unmounts without a cancel, and the draft has
    // to come back: that is what the module-scoped editing session exists for.
    const navAttempt = await evaluate(client, `(() => {
      const items = [...document.querySelectorAll('.settings-nav-item')]
      const target = items.find((item) => item.textContent?.includes('界面'))
      if (!(target instanceof HTMLElement)) return 'missing'
      target.click()
      return 'clicked'
    })()`)
    await delay(500)
    const afterSwitch = await evaluate(client, `(() => ({
      editorOpen: Boolean(document.querySelector('.provider-editor')),
      activeNav: document.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? null,
    }))()`)
    await openSettingsPage(client, '模型供应商')
    await openEditor(client)
    const restored = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const secretAfterReturn = await secretState(client)
    const restoredScreenshot = await writePng(client, 'editor-restored')

    // --- 3. closing with unsaved edits asks instead of discarding silently ----------------------
    await evaluate(client, `document.querySelector('.provider-editor .close-btn')?.click()`)
    await delay(250)
    const discardPrompt = await evaluate(client, `(() => {
      const prompt = document.querySelector('.provider-editor-discard')
      return prompt ? {
        text: prompt.textContent?.trim() ?? '',
        actions: [...prompt.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
      } : null
    })()`)
    const editorStillOpen = await evaluate(client, `Boolean(document.querySelector('.provider-editor'))`)
    const nameBeforeKeep = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const promptScreenshot = await writePng(client, 'editor-discard-prompt')
    // "继续编辑" keeps the editor and the draft.
    await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('.provider-editor-discard button')]
      buttons.find((button) => button.textContent?.includes('继续编辑'))?.click()
      return true
    })()`)
    await delay(250)
    const afterKeepEditing = await evaluate(client, EDITOR_STATE_EXPRESSION)
    // "丢弃修改" closes and drops it; reopening shows the saved value again.
    await evaluate(client, `document.querySelector('.provider-editor .close-btn')?.click()`)
    await delay(200)
    await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('.provider-editor-discard button')]
      buttons.find((button) => button.textContent?.includes('丢弃修改'))?.click()
      return true
    })()`)
    await delay(300)
    const closedByDiscard = await evaluate(client, `Boolean(document.querySelector('.provider-editor'))`)
    await openEditor(client)
    const afterDiscard = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const secretAfterDiscard = await secretState(client)
    const savesAfterDiscard = await evaluate(client, `window.__lsSaveProbe.saves`)
    await evaluate(client, `document.querySelector('.provider-editor .close-btn')?.click()`)
    await delay(250)

    // --- 4. a failed save keeps the editor and the editable content ----------------------------
    await openEditor(client)
    await typeName(client, DRAFT_NAME)
    await evaluate(client, `(() => { window.__lsSaveProbe.failNext = true; return true })()`)
    await evaluate(client, `document.querySelector('.provider-editor .save-btn')?.click()`)
    await harness.waitFor(() => evaluate(client, `(() => {
      const editor = document.querySelector('.provider-editor')
      return editor && [...editor.querySelectorAll('.dialog-error')].length > 0 ? true : null
    })()`), 30_000, 'the save failure notice')
    await delay(200)
    const saveFailed = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const providersAfterFailure = await harness.fetchJson(locator, '/config/providers').then((response) => response.body?.providers ?? null)
    const failureScreenshot = await writePng(client, 'editor-save-failed')

    // --- 5. the editor cannot be left while a save is in flight, and the save wins ---------------
    await evaluate(client, `(() => { window.__lsSaveProbe.delayNextMs = 1500; return true })()`)
    await evaluate(client, `document.querySelector('.provider-editor .save-btn')?.click()`)
    await delay(300)
    const saving = await evaluate(client, EDITOR_STATE_EXPRESSION)
    const savingScreenshot = await writePng(client, 'editor-saving')
    const closed = await harness.waitFor(() => evaluate(client, `document.querySelector('.provider-editor') ? null : true`), 30_000, 'the editor closing after the save')
    await delay(400)
    const cardsAfterSave = await evaluate(client, CARDS_EXPRESSION)
    const probeState = await evaluate(client, `window.__lsSaveProbe`)
    const configFileClean = !(await readFile(join(dataDir, 'config.json'), 'utf8')).includes(SECRET_MARKER)
    const electronLogClean = !(await readFile(logPath, 'utf8').catch(() => '')).includes(SECRET_MARKER)

    const results = {
      providersBefore,
      navAttempt,
      afterSwitch,
      untouched,
      modified,
      secretEntered,
      secretWhileEditing,
      secretAfterReturn,
      secretAfterDiscard,
      configFileClean,
      electronLogClean,
      restored,
      discardPrompt,
      editorStillOpen,
      nameBeforeKeep,
      afterKeepEditing,
      closedByDiscard,
      afterDiscard,
      savesAfterDiscard,
      saveFailed,
      providersAfterFailure,
      saving,
      closed,
      cardsAfterSave,
      probeState,
      screenshots: { modifiedScreenshot, restoredScreenshot, failureScreenshot, savingScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. four states: untouched is silent, editing says so.
    expect(untouched !== null, 'the editor did not open')
    expect(untouched.status === null, `an untouched draft claimed a state: ${JSON.stringify(untouched.status)}`)
    expect(modified.status === '已修改，尚未保存。', `the dirty state was not shown: ${JSON.stringify(modified.status)}`)
    expect(secretEntered === true && secretWhileEditing.draftPresent, 'the secret draft did not reach the editor')
    expect(secretWhileEditing.browserStorageClean, 'the secret reached browser storage while editing')
    // 2. the page switch unmounts the editor and returning restores the draft.
    expect(navAttempt === 'clicked', 'the settings navigation could not be clicked')
    expect(afterSwitch.editorOpen === false, 'switching pages left the editor mounted')
    expect(afterSwitch.activeNav === '界面', `the page did not switch: ${JSON.stringify(afterSwitch.activeNav)}`)
    expect(restored.name === DRAFT_NAME, `the draft was lost across pages: ${JSON.stringify(restored.name)}`)
    expect(secretAfterReturn.draftPresent && secretAfterReturn.browserStorageClean,
      'the secret did not remain only in the in-memory draft across pages')
    // The editor labels a restored draft that still differs from its baseline as "已修改": the
    // dirty fact wins over the restored one, which is the more useful statement for the user.
    expect(['已修改，尚未保存。', '已恢复上次离开时未保存的草稿。'].includes(restored.status),
      `the restored draft was not reported: ${JSON.stringify(restored.status)}`)
    // 3. closing with unsaved edits asks, and both answers behave.
    expect(discardPrompt !== null, 'closing with unsaved edits did not ask')
    expect(discardPrompt.actions.some((label) => label.includes('继续编辑')), `no keep-editing action: ${JSON.stringify(discardPrompt.actions)}`)
    expect(discardPrompt.actions.some((label) => label.includes('丢弃修改')), `no discard action: ${JSON.stringify(discardPrompt.actions)}`)
    expect(editorStillOpen === true, 'the editor closed before the question was answered')
    expect(nameBeforeKeep.name === DRAFT_NAME, 'the draft was dropped while the question was open')
    expect(afterKeepEditing.name === DRAFT_NAME && afterKeepEditing.status === '已修改，尚未保存。',
      `继续编辑 did not keep the draft: ${JSON.stringify(afterKeepEditing)}`)
    expect(closedByDiscard === false, '丢弃修改 did not close the editor')
    expect(afterDiscard.name !== DRAFT_NAME, `丢弃修改 kept the draft: ${JSON.stringify(afterDiscard.name)}`)
    expect(afterDiscard.status === null, `丢弃修改 left a dirty state: ${JSON.stringify(afterDiscard.status)}`)
    expect(secretAfterDiscard.draftPresent === false && secretAfterDiscard.browserStorageClean,
      'the discarded secret was still in the editor or browser storage')
    expect(configFileClean && electronLogClean, 'the unsaved secret reached config or Electron log')
    expect(savesAfterDiscard === 0, `discarding issued ${savesAfterDiscard} save requests`)
    // 4. a failed save explains itself, keeps the content, and does not change the list.
    expect(saveFailed.error.some((text) => text.includes('保存失败')), `no save failure was shown: ${JSON.stringify(saveFailed.error)}`)
    expect(saveFailed.name === DRAFT_NAME, `the failed save dropped the edited content: ${JSON.stringify(saveFailed.name)}`)
    expect(JSON.stringify(providersAfterFailure) === JSON.stringify(providersBefore),
      'the failed save still changed the stored provider list')
    // 5. saving blocks the way out, then lands.
    expect(saving.saveLabel === '保存中…', `the save button did not report progress: ${JSON.stringify(saving.saveLabel)}`)
    expect(saving.closeDisabled === true, 'the close entry stayed enabled while saving')
    expect(saving.cancelDisabled === true, 'cancel stayed enabled while saving')
    expect(saving.status === '保存中…', `the saving state was not shown: ${JSON.stringify(saving.status)}`)
    expect(closed === true, 'the editor did not close after a successful save')
    expect(cardsAfterSave.some((card) => card.text.includes(DRAFT_NAME)), `the saved name is not in the list: ${JSON.stringify(cardsAfterSave)}`)
    expect(probeState.saves === 2, `expected two save attempts, saw ${probeState.saves}`)

    if (failures.length > 0) {
      throw new Error(`provider editor draft acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'provider-editor-draft', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'provider-editor-draft',
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
