// Real-window acceptance for the skills page states (taskbook UX-04).
//
// UX-04 is about four facts that must not collapse into one empty view: still loading, loaded and
// genuinely empty, loaded with content, and failed. It also asks that a failed *reload* keeps the
// list the user is reading and marks it as not refreshed, and that a failed *detail* read keeps
// the list and the selection with a retry.
//
// The page loads through the Local App API, so the fixture injects failures and a delayed answer
// through a `fetch` probe in the page instead of touching the data root.
//
// Usage:
//   node scripts/verify-skills-catalog-states.mjs [--out=<dir>] [--keep]

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-skills-states')))
const keepRoot = process.argv.includes('--keep')
const WINDOW = { width: 1180, height: 780 }
const EVALUATE_TIMEOUT_MS = 20_000

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

/**
 * Inject failures and a delay into the skills endpoints. The probe holds the *next* list request
 * open so the loading state can be observed, fails a chosen number of list requests, and fails
 * detail reads for one skill.
 */
const INSTALL_SKILLS_PROBE = `(() => {
  if (window.__lsSkillsProbe) return true
  const probe = { listDelayMs: 0, emptyListTimes: 0, failListTimes: 0, failDetailNames: [], delayDetailNames: [], listRequests: 0, detailRequests: 0, failures: [] }
  window.__lsSkillsProbe = probe
  const originalFetch = window.fetch.bind(window)
  const skillsPath = '/skills'
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const index = url.indexOf(skillsPath)
    if (index < 0) return originalFetch(input, init)
    const tail = url.slice(index + skillsPath.length)
    const isList = tail === '' || tail.startsWith('?')
    const name = isList ? '' : decodeURIComponent(tail.replace(/^\\//u, '').split('?')[0])
    if (isList) {
      probe.listRequests += 1
      if (probe.listDelayMs > 0) {
        const waitMs = probe.listDelayMs
        probe.listDelayMs = 0
        await new Promise((done) => setTimeout(done, waitMs))
      }
      if (probe.failListTimes > 0) {
        probe.failListTimes -= 1
        probe.failures.push({ kind: 'list', at: Math.round(performance.now()) })
        return new Response(JSON.stringify({ error: 'acceptance fixture: skills list failed on purpose' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (probe.emptyListTimes > 0) {
        probe.emptyListTimes -= 1
        probe.failures.push({ kind: 'empty-list', at: Math.round(performance.now()) })
        return new Response(JSON.stringify({ skills: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
    } else {
      probe.detailRequests += 1
      if (probe.delayDetailNames.includes(name)) {
        probe.delayDetailNames = probe.delayDetailNames.filter((item) => item !== name)
        await new Promise((done) => setTimeout(done, 1_800))
      }
      if (probe.failDetailNames.includes(name)) {
        probe.failDetailNames = probe.failDetailNames.filter((item) => item !== name)
        probe.failures.push({ kind: 'detail', name, at: Math.round(performance.now()) })
        return new Response(JSON.stringify({ error: 'acceptance fixture: skill detail failed on purpose' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return originalFetch(input, init)
  }
  return true
})()`

const SKILLS_STATE_EXPRESSION = `(() => {
  const page = document.querySelector('.memory-skills-dialog')
  if (!(page instanceof HTMLElement)) return null
  const feedback = [...page.querySelectorAll('.ms-feedback')].map((block) => ({
    tone: block.querySelector('.ms-feedback-text')?.className ?? '',
    text: block.querySelector('.ms-feedback-text')?.textContent?.trim() ?? '',
    action: block.querySelector('.ms-feedback-action')?.textContent?.trim() ?? null,
  }))
  return {
    hint: page.querySelector('.dialog-hint')?.textContent?.trim() ?? null,
    items: [...page.querySelectorAll('.ms-item-name')].map((element) => element.textContent?.trim() ?? ''),
    feedback,
    refreshLabel: [...page.querySelectorAll('.dialog-header .ms-feedback-action')].map((element) => element.textContent?.trim() ?? ''),
    detailOpen: Boolean(page.querySelector('.ms-back')),
    detailTitle: page.querySelector('h3')?.textContent?.trim() ?? null,
  }
})()`

async function openSkillsPage(client) {
  await evaluate(client, `(() => {
    if (document.querySelector('.settings-workspace')) return true
    document.querySelector('.settings-entry-btn')?.click()
    return true
  })()`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.settings-nav-item') ? true : null`), harness.startTimeoutMs, 'settings navigation')
  const index = await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.settings-nav-item')]
    return items.findIndex((item) => item.textContent?.includes('技能'))
  })()`)
  if (index < 0) throw new Error('the skills navigation item is missing')
  await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('.settings-nav-item')]
    items[${index}]?.click()
    return true
  })()`)
  await harness.waitFor(() => evaluate(client, `document.querySelector('.memory-skills-dialog') ? true : null`), harness.startTimeoutMs, 'the skills page')
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-skills-states-'))
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
    if (!await evaluate(client, INSTALL_SKILLS_PROBE)) throw new Error('the skills probe could not be installed')

    // --- 1. the first load is a *loading* state, not an empty one -----------------------------
    await evaluate(client, `(() => { window.__lsSkillsProbe.listDelayMs = 1800; return true })()`)
    await openSkillsPage(client)
    const loading = await evaluate(client, SKILLS_STATE_EXPRESSION)
    const loadingScreenshot = await writePng(client, 'skills-loading')

    // --- 2. loaded with content ----------------------------------------------------------------
    const ready = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state && state.items.length > 0 ? state : null
    })()`), 30_000, 'the loaded skill list')
    const readyScreenshot = await writePng(client, 'skills-ready')

    // --- 3. a failed reload keeps the list and marks it stale -----------------------------------
    await evaluate(client, `(() => { window.__lsSkillsProbe.failListTimes = 1; return true })()`)
    const refreshClicked = await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('.memory-skills-dialog .dialog-header .ms-feedback-action')]
      const target = buttons[0]
      if (!(target instanceof HTMLElement)) return false
      target.click()
      return true
    })()`)
    const stale = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state && state.feedback.some((entry) => entry.tone.includes('warning')) ? state : null
    })()`), 30_000, 'the stale-list warning')
    const staleScreenshot = await writePng(client, 'skills-stale')

    // --- 4. the offered reload recovers ---------------------------------------------------------
    await evaluate(client, `(() => {
      const blocks = [...document.querySelectorAll('.memory-skills-dialog .ms-feedback')]
      const target = blocks.find((block) => block.querySelector('.ms-feedback-text')?.className.includes('warning'))
      target?.querySelector('.ms-feedback-action')?.click()
      return true
    })()`)
    const recovered = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state && state.feedback.length === 0 && state.items.length > 0 ? state : null
    })()`), 30_000, 'the recovered list')

    // --- 5. a failed detail read keeps the list and offers the same skill again -----------------
    const firstSkill = ready.items[0]
    await evaluate(client, `(() => { window.__lsSkillsProbe.failDetailNames = [${JSON.stringify(firstSkill)}]; return true })()`)
    await evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.memory-skills-dialog .ms-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(firstSkill)}))
      item?.click()
      return true
    })()`)
    const detailFailure = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state && state.feedback.some((entry) => entry.text.includes('读取技能详情失败')) ? state : null
    })()`), 30_000, 'the detail failure')
    const detailFailureScreenshot = await writePng(client, 'skills-detail-failed')

    await evaluate(client, `(() => {
      const blocks = [...document.querySelectorAll('.memory-skills-dialog .ms-feedback')]
      const target = blocks.find((block) => block.querySelector('.ms-feedback-text')?.textContent?.includes('读取技能详情失败'))
      target?.querySelector('.ms-feedback-action')?.click()
      return true
    })()`)
    const detailRecovered = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state && state.detailOpen && state.detailTitle ? state : null
    })()`), 30_000, 'the recovered detail')
    await evaluate(client, `document.querySelector('.memory-skills-dialog .ms-back')?.click()`)
    await delay(300)

    // --- 6. rapid selection: a slower earlier response must not replace the latest choice --------
    const secondSkill = ready.items.find((name) => name !== firstSkill)
    await evaluate(client, `(() => { window.__lsSkillsProbe.delayDetailNames = [${JSON.stringify(firstSkill)}]; return true })()`)
    await evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.memory-skills-dialog .ms-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(firstSkill)}))
      item?.click()
      return true
    })()`)
    await harness.waitFor(() => evaluate(client, `window.__lsSkillsProbe.detailRequests >= 2`), 5_000, 'the slower first detail request to start')
    await delay(80)
    await evaluate(client, `(() => {
      const item = [...document.querySelectorAll('.memory-skills-dialog .ms-item')]
        .find((element) => element.textContent?.includes(${JSON.stringify(secondSkill)}))
      item?.click()
      return true
    })()`)
    const fastSwitch = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state?.detailTitle === ${JSON.stringify(secondSkill)} ? state : null
    })()`), 10_000, 'the second selected skill to open first')
    await delay(2_000)
    const afterLateDetail = await evaluate(client, SKILLS_STATE_EXPRESSION)
    await evaluate(client, `document.querySelector('.memory-skills-dialog .ms-back')?.click()`)
    await delay(250)
    const backToList = await evaluate(client, SKILLS_STATE_EXPRESSION)

    // --- 7. a successful empty response is distinguishable from an error -------------------------
    await evaluate(client, `(() => { window.__lsSkillsProbe.emptyListTimes = 1; return true })()`)
    const emptyRefreshClicked = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll('.memory-skills-dialog .dialog-header .ms-feedback-action')][0]
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`)
    const empty = await harness.waitFor(() => evaluate(client, `(() => {
      const state = ${SKILLS_STATE_EXPRESSION}
      return state?.hint === '暂无技能' && state.items.length === 0 ? state : null
    })()`), 10_000, 'the successful empty skills state')
    const emptyScreenshot = await writePng(client, 'skills-empty')
    const probeState = await evaluate(client, `window.__lsSkillsProbe`)

    const results = {
      loading,
      ready,
      refreshClicked,
      stale,
      recovered,
      detailFailure,
      detailRecovered,
      fastSwitch,
      afterLateDetail,
      emptyRefreshClicked,
      empty,
      backToList,
      probeState,
      screenshots: { loadingScreenshot, readyScreenshot, staleScreenshot, detailFailureScreenshot, emptyScreenshot },
    }

    const failures = []
    const expect = (condition, message) => { if (!condition) failures.push(message) }
    // 1. loading is its own visible state.
    expect(loading?.hint === '正在加载技能…', `the loading state was not shown: ${JSON.stringify(loading?.hint)}`)
    expect(loading?.items.length === 0, 'the loading state listed skills')
    // 2. content arrives.
    expect(ready.items.length > 0, 'the ready state listed no skills')
    expect(ready.hint === null, 'the ready state still showed a hint')
    expect(ready.refreshLabel.includes('刷新'), `no refresh entry is offered: ${JSON.stringify(ready.refreshLabel)}`)
    // 3. a failed reload keeps the list and says it is not refreshed.
    expect(refreshClicked, 'the refresh entry could not be clicked')
    expect(stale.items.length === ready.items.length, `the failed reload changed the list (${stale.items.length} vs ${ready.items.length})`)
    expect(stale.feedback.some((entry) => entry.text.includes('未能刷新技能列表')), 'the failed reload was not explained')
    expect(stale.feedback.some((entry) => entry.action === '重新加载'), 'the failed reload offered no retry')
    expect(!stale.feedback.some((entry) => entry.text.includes('技能列表加载失败')), 'a failed rebuild was reported as a first-load failure')
    // 4. the retry recovers into the clean ready state.
    expect(recovered.feedback.length === 0, 'the recovery kept a failure notice')
    expect(recovered.items.length > 0, 'the recovery listed no skills')
    // 5. a failed detail read keeps the list and the retry opens the same skill.
    expect(detailFailure.items.length === ready.items.length, 'the failed detail read dropped the list')
    expect(detailFailure.detailOpen === false, 'the failed detail read opened an empty detail view')
    expect(detailFailure.feedback.some((entry) => entry.text.includes('读取技能详情失败')), 'the detail failure was not explained')
    expect(detailFailure.feedback.some((entry) => entry.action === '重试'), 'the detail failure offered no retry')
    expect(detailRecovered.detailTitle === firstSkill, `the retry opened ${JSON.stringify(detailRecovered.detailTitle)} instead of ${JSON.stringify(firstSkill)}`)
    expect(fastSwitch.detailTitle === secondSkill, `the fast second selection opened ${JSON.stringify(fastSwitch.detailTitle)} instead of ${JSON.stringify(secondSkill)}`)
    expect(afterLateDetail.detailTitle === secondSkill, `the slower earlier response replaced ${JSON.stringify(secondSkill)} with ${JSON.stringify(afterLateDetail.detailTitle)}`)
    expect(backToList.detailOpen === false && backToList.items.length > 0, '返回 did not restore the list after rapid switching')
    expect(emptyRefreshClicked, 'the empty-state refresh could not be clicked')
    expect(empty.hint === '暂无技能' && empty.items.length === 0 && empty.feedback.length === 0,
      `the successful empty response was not rendered as an empty state: ${JSON.stringify(empty)}`)
    expect(probeState.failures.some((entry) => entry.kind === 'empty-list'), 'the empty response was not injected')

    if (failures.length > 0) {
      throw new Error(`skills catalog states failed: ${JSON.stringify({ results, failures })}`)
    }
    console.log(JSON.stringify({ check: 'skills-catalog-states', ok: true, evidence: results }))
  } catch (error) {
    preserve = true
    console.error(JSON.stringify({
      check: 'skills-catalog-states',
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
