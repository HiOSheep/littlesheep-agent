import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 45_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-conversation-models-'))
const dataDir = join(root, 'data')
const chromiumDir = join(root, 'chromium')
// Deliberately missing: Main must prepare this user-selected workspace before
// freezing its permission snapshot, instead of letting every file tool fail.
const workspace = join(root, 'new workspace')
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 0 })
let electron, client
const report = { ok: false, root, checks: [], limits: ['Local HTTP Provider fixture; does not prove external model task quality or OS Shell isolation.'] }
try {
  await mkdir(dataDir)
  await mkdir(chromiumDir)
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'fixture', models: ['slow-a', 'slow-b'] }],
    agents: { defaults: { model: 'acceptance/slow-a', workspace, maxRecoveryAttempts: 1, maxModelCallsPerRun: 32 } },
  }))
  const port = await harness.reservePort()
  electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.desktopAction(locator, 'resize', { width: 1200, height: 820 })
  client = await harness.connectRenderer(port)
  const evaluate = (code) => client.evaluate(code)
  await harness.waitFor(async () => (await harness.fetchJson(locator, '/runtime/readiness')).body?.state === 'ready' || null, 90_000, 'runtime ready')

  const wait = (condition, label) => harness.waitFor(() => evaluate(condition).catch(() => null), 45_000, label)
  const type = async (text) => evaluate(`(() => {const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`)
  const label = () => evaluate(`document.querySelector('.runtime-picker-trigger')?.getAttribute('aria-label')`)
  const send = async (text) => {
    const before = await evaluate(`document.querySelectorAll('.message.user').length`)
    await type(text)
    await wait(`document.querySelector('.composer .send-round:not(.stop)')?.disabled===false`, 'enabled send')
    await evaluate(`document.querySelector('.composer .send-round:not(.stop)').click()`)
    await wait(`document.querySelectorAll('.message.user').length>${before} && !document.querySelector('.composer .send-round.stop') && !!document.querySelector('.assistant-turn.done')`, 'completed model turn')
  }
  const choose = async (model) => {
    await evaluate(`document.querySelector('.runtime-picker-trigger').click()`)
    await wait(`!!document.querySelector('.runtime-picker-panel')`, 'model picker')
    await evaluate(`document.querySelector('.runtime-submenu-trigger').click()`)
    await wait(`!![...document.querySelectorAll('.runtime-model-option')].find(e=>e.textContent.includes(${JSON.stringify(model)}))`, 'model option')
    await evaluate(`[...document.querySelectorAll('.runtime-model-option')].find(e=>e.textContent.includes(${JSON.stringify(model)})).click()`)
    await wait(`document.querySelector('.runtime-picker-trigger').getAttribute('aria-label').includes(${JSON.stringify(model)})`, 'selected model')
  }
  await send('MODEL-ISOLATION-A')
  assert.match(await label(), /slow-a/)
  await evaluate(`document.querySelector('.conversation-section .sidebar-new-action').click()`)
  await wait(`!document.querySelector('.session-item.active')`, 'new conversation')
  await choose('slow-b')
  await send('MODEL-ISOLATION-B')
  assert.match(await label(), /slow-b/)
  await type('draft B stays in B')
  await evaluate(`[...document.querySelectorAll('.session-item')].find(e=>e.textContent.includes('MODEL-ISOLATION-A')).click()`)
  await wait(`document.querySelector('.session-item.active')?.textContent.includes('MODEL-ISOLATION-A') && document.querySelector('.composer textarea')?.value === ''`, 'conversation A')
  assert.match(await label(), /slow-a/)
  await send('MODEL-ISOLATION-A-SECOND')
  await evaluate(`[...document.querySelectorAll('.session-item')].find(e=>e.textContent.includes('MODEL-ISOLATION-B')).click()`)
  await wait(`document.querySelector('.composer textarea')?.value==='draft B stays in B'`, 'B draft restored')
  assert.match(await label(), /slow-b/)
  const origin = await evaluate('performance.timeOrigin')
  await client.send('Page.reload')
  await wait(`performance.timeOrigin!==${origin} && document.readyState==='complete' && document.querySelector('.session-item.active')?.textContent.includes('MODEL-ISOLATION-B')`, 'restored B')
  await wait(`document.querySelector('.runtime-picker-trigger')?.getAttribute('aria-label').includes('slow-b')`, 'persisted B model')
  const requests = await (await fetch(provider.baseURL.replace(/\/v1$/, '') + '/requests')).json()
  const requestFor = marker => requests.requests.filter(r=>r.messages.some(m=>JSON.stringify(m).includes(marker)))
  assert.ok(requestFor('MODEL-ISOLATION-B').length > 0)
  assert.ok(requestFor('MODEL-ISOLATION-B').every(r=>r.model==='slow-b'))
  assert.ok(requestFor('MODEL-ISOLATION-A-SECOND').length > 0)
  assert.ok(requestFor('MODEL-ISOLATION-A-SECOND').every(r=>r.model==='slow-a'))
  const runtime = await harness.fetchJson(locator, '/runtime')
  assert.equal(runtime.body.model, 'acceptance/slow-a')
  assert.equal(await evaluate(`!!document.querySelector('.checkpoint-recovery-trigger,.checkpoint-recovery-layer')`), false)
  const shot = await client.send('Page.captureScreenshot', {format:'png'})
  await writeFile(join(root,'models.png'),Buffer.from(shot.data,'base64'))
  report.checks.push('model A/B isolated across switching and renderer reload; actual HTTP requests use each selected model; global default unchanged; draft remains scoped; no recovery modal or launcher')
  report.requests = requests.requests.map(r=>({model:r.model,requestIndex:r.requestIndex}))
  report.ok=true
} finally {
  client?.close()
  if(electron) await harness.forceTerminate(electron).catch(()=>undefined)
  await provider.close()
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  process.stdout.write(JSON.stringify({ok:report.ok,root,checks:report.checks})+'\n')
}
