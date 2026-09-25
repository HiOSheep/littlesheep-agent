// Real-window acceptance for irreversible deletion (taskbook UX-02).
//
// `danger-confirm.tsx` and `deletion-impact.ts` are unit-tested, but the acceptance asks for the
// real paths: cancel, Escape, a failing request, same-task double clicks, a project that owns
// several conversations, and provider removal. The two properties that matter are "nothing is
// deleted before confirmation" and "the confirmation says what the API will really do".
//
// The fixture seeds the archive index directly (the same `archive/index.json` the app writes),
// then drives the real archive page and counts the DELETE requests the renderer issues through a
// `fetch` probe installed in the page.
//
// Usage:
//   node scripts/verify-deletion-confirmation.mjs [--out=<dir>] [--keep]

import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-deletion-confirmation')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1180, height: 760 }
const EVALUATE_TIMEOUT_MS = 15_000
const PROJECT = { id: 'archived-project-alpha', name: '归档项目甲' }
const SESSION_A = { id: 'archived-session-alpha', title: '归档对话 甲' }
const SESSION_B = { id: 'archived-session-beta', title: '归档对话 乙' }
const PROJECT_SESSION_A = { id: 'archived-project-session-alpha', title: '项目对话 甲' }
const PROJECT_SESSION_B = { id: 'archived-project-session-beta', title: '项目对话 乙' }

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

/** Two archived conversations with history, written where the app reads them. */
async function seedArchive(dataDir) {
  const now = Date.now()
  const projectPath = join(dataDir, '..', 'archived-project-files')
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  await mkdir(join(dataDir, 'archive'), { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'keep-after-archive-delete.txt'), 'project files are outside archive deletion\n', 'utf8')
  const project = {
    ...PROJECT,
    path: projectPath,
    createdAt: new Date(now - 300_000).toISOString(),
    lastActiveAt: new Date(now - 60_000).toISOString(),
    archivedAt: now,
  }
  const sessions = [
    ...[SESSION_A, SESSION_B].map((session, index) => ({
      ...session,
      createdAt: now - (index + 4) * 60_000,
      lastMessageAt: now - (index + 3) * 60_000,
      mode: 'research',
      scope: 'standalone',
      archivedAt: now - index * 1_000,
    })),
    ...[PROJECT_SESSION_A, PROJECT_SESSION_B].map((session, index) => ({
      ...session,
      createdAt: now - (index + 2) * 60_000,
      lastMessageAt: now - (index + 1) * 60_000,
      mode: 'research',
      scope: 'project',
      projectId: PROJECT.id,
      workspacePath: projectPath,
      archivedAt: now - index * 1_000,
    })),
  ].map((session, index) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt,
    mode: session.mode,
    scope: session.scope,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    archivedAt: session.archivedAt,
  }))
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: [] }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'archive', 'index.json'), `${JSON.stringify({ projects: [project], sessions }, null, 2)}\n`, 'utf8')
  for (const session of sessions) {
    const lines = [JSON.stringify({
      type: 'metadata',
      metadata: {
        title: session.title,
        model: '',
        createdAt: new Date(session.createdAt).toISOString(),
        updatedAt: new Date(session.lastMessageAt).toISOString(),
        messageCount: 4,
      },
    })]
    for (let index = 0; index < 4; index += 1) {
      lines.push(JSON.stringify({
        id: `${session.id}-message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `${session.title} 的第 ${index + 1} 条消息。` }],
        timestamp: new Date(session.createdAt + index * 1_000).toISOString(),
        sessionId: session.id,
      }))
    }
    await writeFile(join(dataDir, 'sessions', `${session.id}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  }
  return { project, projectPath, sessions }
}

/** Count the DELETE requests the renderer actually issues, and optionally fail the next one. */
const INSTALL_DELETE_PROBE = `(() => {
  if (window.__lsDeleteProbe) return true
  const probe = { requests: [], failNext: false }
  window.__lsDeleteProbe = probe
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    if (method === 'DELETE') {
      probe.requests.push({ url, at: Math.round(performance.now()) })
      if (probe.failNext) {
        probe.failNext = false
        return new Response(JSON.stringify({ error: 'acceptance fixture: delete failed on purpose' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return originalFetch(input, init)
  }
  return true
})()`

const DIALOG_STATE_EXPRESSION = `(() => {
  const dialog = document.querySelector('.danger-confirm-dialog')
  if (!(dialog instanceof HTMLElement)) return null
  return {
    label: dialog.getAttribute('aria-label'),
    name: dialog.querySelector('.danger-confirm-name')?.textContent?.trim() ?? '',
    removes: [...dialog.querySelectorAll('.danger-confirm-list li')].map((item) => item.textContent?.trim() ?? ''),
    preserved: [...dialog.querySelectorAll('.danger-confirm-preserved li')].map((item) => item.textContent?.trim() ?? ''),
    inUse: dialog.querySelector('.danger-confirm-inuse')?.textContent?.trim() ?? null,
    error: dialog.querySelector('.dialog-error')?.textContent?.trim() ?? null,
    confirmDisabled: dialog.querySelector('.danger-btn')?.disabled ?? null,
    focused: document.activeElement?.textContent?.trim() ?? '',
  }
})()`

const ARCHIVE_STATE_EXPRESSION = `(() => ({
  rows: [...document.querySelectorAll('.archive-session-row')].map((row) => row.textContent?.trim() ?? ''),
  projects: [...document.querySelectorAll('.archive-project-row .archive-row-text strong')].map((row) => row.textContent?.trim() ?? ''),
  dialogOpen: Boolean(document.querySelector('.danger-confirm-dialog')),
  deletes: window.__lsDeleteProbe?.requests?.length ?? null,
}))()`

async function openArchivePage(client) {
  await evaluate(client, `(() => {
    if (document.querySelector('.settings-workspace')) return true
    document.querySelector('.settings-entry-btn')?.click()
    return true
  })()`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`), harness.startTimeoutMs, 'settings navigation')
  const opened = await evaluate(client, `(() => {
    const item = [...document.querySelectorAll('.settings-nav-item')]
      .find((element) => element.textContent?.includes('归档'))
    if (!(item instanceof HTMLElement)) return false
    item.click()
    return true
  })()`)
  if (!opened) throw new Error('the archive settings page was not reachable')
  await harness.waitFor(() => evaluate(client, `document.querySelector('.archive-page') ? true : null`), harness.startTimeoutMs, 'archive page')
}

async function openModelsPage(client) {
  const opened = await evaluate(client, `(() => {
    const item = [...document.querySelectorAll('.settings-nav-item')]
      .find((element) => element.textContent?.includes('模型供应商'))
    if (!(item instanceof HTMLElement)) return false
    item.click()
    return true
  })()`)
  if (!opened) throw new Error('the model providers settings page was not reachable')
  await harness.waitFor(() => evaluate(client, `document.querySelector('.provider-card') ? true : null`), harness.startTimeoutMs, 'configured provider card')
}

async function clickDeleteFor(client, title) {
  const clicked = await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('.archive-session-row')]
      .find((element) => element.textContent?.includes(${JSON.stringify(title)}))
    const button = row?.querySelector('.archive-action.danger')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no delete action for "${title}"`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog') ? true : null`), harness.startTimeoutMs, 'confirmation layer')
  await delay(150)
}

async function clickProjectDeleteFor(client, name) {
  const clicked = await evaluate(client, `(() => {
    const row = [...document.querySelectorAll('.archive-project-row')]
      .find((element) => element.textContent?.includes(${JSON.stringify(name)}))
    const button = row?.querySelector('.archive-action.danger')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no delete action for archived project "${name}"`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog') ? true : null`), harness.startTimeoutMs, 'project confirmation layer')
  await delay(150)
}

async function clickProviderDeleteFor(client, name) {
  const clicked = await evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.provider-card')]
      .find((element) => element.textContent?.includes(${JSON.stringify(name)}))
    const button = card?.querySelector('.provider-remove')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error(`no delete action for provider "${name}"`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog') ? true : null`), harness.startTimeoutMs, 'provider confirmation layer')
  await delay(150)
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-deletion-confirmation-'))
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
    const seededArchive = await seedArchive(dataDir)
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
    if (!await evaluate(client, INSTALL_DELETE_PROBE)) throw new Error('the delete probe could not be installed')

    await openArchivePage(client)
    const seeded = await harness.waitFor(() => evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.archive-session-row')]
      return rows.length >= 2 ? rows.length : null
    })()`), harness.startTimeoutMs, 'seeded archive rows')
    const initial = await evaluate(client, ARCHIVE_STATE_EXPRESSION)

    // --- 1. the confirmation appears and explains itself; nothing is deleted yet ---------------
    await clickDeleteFor(client, SESSION_A.title)
    const dialog = await evaluate(client, DIALOG_STATE_EXPRESSION)
    const afterOpen = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    const dialogScreenshot = await writePng(client, 'confirm-open')

    // --- 2. Escape cancels without deleting ---------------------------------------------------
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await delay(300)
    const afterEscape = await evaluate(client, ARCHIVE_STATE_EXPRESSION)

    // --- 3. the cancel button cancels without deleting ----------------------------------------
    await clickDeleteFor(client, SESSION_A.title)
    await evaluate(client, `document.querySelector('.danger-confirm-dialog .close-btn')?.click()`)
    await delay(300)
    const afterCancel = await evaluate(client, ARCHIVE_STATE_EXPRESSION)

    // --- 4. a double click submits exactly one delete ------------------------------------------
    await clickDeleteFor(client, SESSION_A.title)
    await evaluate(client, `(() => {
      const button = document.querySelector('.danger-confirm-dialog .danger-btn')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      button.click()
      return true
    })()`)
    const removed = await harness.waitFor(() => evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.archive-session-row')]
      return rows.some((row) => row.textContent?.includes(${JSON.stringify(SESSION_A.title)})) ? null : true
    })()`), 30_000, 'the confirmed row disappearing')
    const afterConfirm = await evaluate(client, ARCHIVE_STATE_EXPRESSION)

    // --- 5. a failing request keeps the confirmation open and locatable -------------------------
    await clickDeleteFor(client, SESSION_B.title)
    await evaluate(client, `(() => { window.__lsDeleteProbe.failNext = true; return true })()`)
    await evaluate(client, `document.querySelector('.danger-confirm-dialog .danger-btn')?.click()`)
    await harness.waitFor(() => evaluate(client, `document.querySelector('.danger-confirm-dialog .dialog-error') ? true : null`), 30_000, 'the failure staying visible')
      .catch(async (error) => {
        const diagnostics = {
          dialog: await evaluate(client, DIALOG_STATE_EXPRESSION).catch(() => null),
          archive: await evaluate(client, ARCHIVE_STATE_EXPRESSION).catch(() => null),
          probeRequests: await evaluate(client, `window.__lsDeleteProbe?.requests ?? null`).catch(() => null),
          pageError: await evaluate(client, `document.querySelector('.archive-error')?.textContent?.trim() ?? null`).catch(() => null),
          visibleText: await evaluate(client, `(document.body.innerText ?? '').slice(0, 300)`).catch(() => null),
        }
        const path = await writePng(client, 'delete-failure-diagnostic').catch(() => null)
        throw new Error(`${error.message}: ${JSON.stringify({ ...diagnostics, screenshot: path })}`)
      })
    await delay(200)
    const afterFailure = await evaluate(client, DIALOG_STATE_EXPRESSION)
    const stateAfterFailure = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    const failureScreenshot = await writePng(client, 'confirm-failed')
    // and the same dialog still works once the request succeeds
    await evaluate(client, `document.querySelector('.danger-confirm-dialog .danger-btn')?.click()`)
    await harness.waitFor(() => evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.archive-session-row')]
      return rows.some((row) => row.textContent?.includes(${JSON.stringify(SESSION_B.title)})) ? null : true
    })()`), 30_000, 'the retried delete')
    const afterRetry = await evaluate(client, ARCHIVE_STATE_EXPRESSION)

    // --- 6. a project confirmation names and removes every archived conversation, but not files --
    await clickProjectDeleteFor(client, PROJECT.name)
    const projectDialog = await evaluate(client, DIALOG_STATE_EXPRESSION)
    const beforeProjectDelete = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    await evaluate(client, `document.querySelector('.danger-confirm-dialog .danger-btn')?.click()`)
    await harness.waitFor(() => evaluate(client, `(() => {
      const row = [...document.querySelectorAll('.archive-project-row')]
        .find((element) => element.textContent?.includes(${JSON.stringify(PROJECT.name)}))
      return row ? null : true
    })()`), 30_000, 'the archived project disappearing')
    const afterProjectDelete = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    const projectFilesRemain = await access(join(seededArchive.projectPath, 'keep-after-archive-delete.txt')).then(() => true, () => false)
    const remainingSessionFiles = await Promise.all([PROJECT_SESSION_A, PROJECT_SESSION_B].map(async (session) => {
      const path = join(dataDir, 'sessions', `${session.id}.jsonl`)
      return await access(path).then(() => true, () => false)
    }))

    // --- 7. provider deletion names configuration impact and keeps its key/conversations -------
    await openModelsPage(client)
    await clickProviderDeleteFor(client, 'Electron Acceptance')
    const providerDialog = await evaluate(client, DIALOG_STATE_EXPRESSION)
    const beforeProviderDelete = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    await evaluate(client, `(() => {
      const button = document.querySelector('.danger-confirm-dialog .danger-btn')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      button.click()
      return true
    })()`)
    await harness.waitFor(() => evaluate(client, `(() => {
      const card = [...document.querySelectorAll('.provider-card')]
        .find((element) => element.textContent?.includes('Electron Acceptance'))
      return card ? null : true
    })()`), 30_000, 'the provider card disappearing')
    const afterProviderDelete = await evaluate(client, ARCHIVE_STATE_EXPRESSION)
    const providerDeleteRequests = await evaluate(client, `window.__lsDeleteProbe.requests.slice(-1)`)

    const results = {
      seeded,
      initial,
      dialog,
      afterOpen,
      afterEscape,
      afterCancel,
      removed,
      afterConfirm,
      afterFailure,
      stateAfterFailure,
      afterRetry,
      projectDialog,
      beforeProjectDelete,
      afterProjectDelete,
      projectFilesRemain,
      remainingSessionFiles,
      providerDialog,
      beforeProviderDelete,
      afterProviderDelete,
      providerDeleteRequests,
      screenshots: { dialogScreenshot, failureScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. the layer explains the object and its impact, with nothing deleted yet.
    expect(dialog !== null, 'the confirmation layer did not appear')
    expect(dialog?.label?.includes('永久删除'), `the dialog heading does not say what it does: ${JSON.stringify(dialog?.label)}`)
    expect(dialog?.name?.includes(SESSION_A.title), `the dialog does not name the conversation: ${JSON.stringify(dialog?.name)}`)
    expect((dialog?.removes?.length ?? 0) > 0, 'the dialog lists no consequences')
    expect(dialog?.focused === '取消', `the initial focus is not on cancel: ${JSON.stringify(dialog?.focused)}`)
    expect(afterOpen.deletes === 0, `opening the confirmation already deleted something (${afterOpen.deletes})`)
    // 2 and 3. both cancel paths leave the archive untouched.
    expect(afterEscape.dialogOpen === false, 'Escape did not close the confirmation')
    expect(afterEscape.deletes === 0, `Escape deleted something (${afterEscape.deletes})`)
    expect(afterEscape.rows.length === initial.rows.length, 'Escape changed the archive')
    expect(afterCancel.dialogOpen === false, 'the cancel button did not close the confirmation')
    expect(afterCancel.deletes === 0, `cancelling deleted something (${afterCancel.deletes})`)
    expect(afterCancel.rows.length === initial.rows.length, 'cancelling changed the archive')
    // 4. one confirmation, one delete.
    expect(removed === true, 'the confirmed conversation is still listed')
    expect(afterConfirm.deletes === 1, `a double click submitted ${afterConfirm.deletes} deletes`)
    expect(afterConfirm.dialogOpen === false, 'the confirmation stayed open after a successful delete')
    // 5. a failure stays visible and the retry works.
    expect(afterFailure?.error !== null && afterFailure?.error !== undefined, 'the failed delete reported no error')
    expect(stateAfterFailure.dialogOpen === true, 'the confirmation closed even though the delete failed')
    expect(stateAfterFailure.rows.some((row) => row.includes(SESSION_B.title)), 'the conversation disappeared despite the failed delete')
    expect(afterRetry.deletes === 3, `the retry did not submit exactly one more delete (${afterRetry.deletes})`)
    expect(afterRetry.rows.some((row) => row.includes(SESSION_B.title)) === false, 'the retried delete did not remove the conversation')
    expect(projectDialog?.name?.includes(PROJECT.name), `the confirmation does not name the archived project: ${JSON.stringify(projectDialog?.name)}`)
    expect(projectDialog?.removes?.some((text) => text.includes('2 个归档对话')), `the confirmation does not disclose both archived conversations: ${JSON.stringify(projectDialog?.removes)}`)
    expect(projectDialog?.removes?.some((text) => text.includes('2 个对话保存在本地的消息记录')), `the confirmation does not disclose the local conversation history: ${JSON.stringify(projectDialog?.removes)}`)
    expect(projectDialog?.preserved?.some((text) => text.includes('不会删除磁盘上的项目文件夹')), `the confirmation does not disclose that project files are preserved: ${JSON.stringify(projectDialog?.preserved)}`)
    expect(beforeProjectDelete.deletes === 3, `opening the project confirmation issued a DELETE (${beforeProjectDelete.deletes})`)
    expect(beforeProjectDelete.rows.some((row) => row.includes(PROJECT_SESSION_A.title)) && beforeProjectDelete.rows.some((row) => row.includes(PROJECT_SESSION_B.title)), 'the project conversations were missing before confirmation')
    expect(afterProjectDelete.deletes === 4, `confirming project deletion did not issue exactly one DELETE (${afterProjectDelete.deletes})`)
    expect(afterProjectDelete.projects.includes(PROJECT.name) === false, 'the archived project remains listed after confirmed deletion')
    expect(afterProjectDelete.rows.some((row) => row.includes(PROJECT_SESSION_A.title) || row.includes(PROJECT_SESSION_B.title)) === false, 'one or more project conversations remain listed after deletion')
    expect(projectFilesRemain, 'deleting the archive record removed the project folder from disk')
    expect(remainingSessionFiles.every((exists) => !exists), `project conversation history files were not all deleted: ${JSON.stringify(remainingSessionFiles)}`)
    expect(providerDialog?.name?.includes('Electron Acceptance'), `the confirmation does not name the provider: ${JSON.stringify(providerDialog?.name)}`)
    expect(providerDialog?.removes?.some((text) => text.includes('1 个模型条目')), `the confirmation does not list the provider model entry: ${JSON.stringify(providerDialog?.removes)}`)
    expect(providerDialog?.preserved?.some((text) => text.includes('API 密钥仍留在系统密钥库')), `the confirmation does not state that the key is preserved: ${JSON.stringify(providerDialog?.preserved)}`)
    expect(providerDialog?.preserved?.some((text) => text.includes('不会删除任何对话记录')), `the confirmation does not state that conversation records are preserved: ${JSON.stringify(providerDialog?.preserved)}`)
    expect(providerDialog?.inUse?.includes('slow-a'), `the confirmation does not identify the currently selected model: ${JSON.stringify(providerDialog?.inUse)}`)
    expect(beforeProviderDelete.deletes === 4, `opening the provider confirmation issued a DELETE (${beforeProviderDelete.deletes})`)
    expect(afterProviderDelete.deletes === 5, `a double click on provider deletion submitted ${afterProviderDelete.deletes - 4} DELETE requests`)
    expect(providerDeleteRequests.length === 1 && providerDeleteRequests[0]?.url?.includes('/config/providers/acceptance'), `the confirmed request was not scoped to one provider DELETE: ${JSON.stringify(providerDeleteRequests)}`)
    expect(afterProviderDelete.rows.length === beforeProviderDelete.rows.length, 'deleting the provider changed archived conversation records')

    if (failures.length > 0) {
      throw new Error(`deletion confirmation acceptance failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'deletion-confirmation', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'deletion-confirmation',
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
