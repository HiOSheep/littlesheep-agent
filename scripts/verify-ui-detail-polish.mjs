// Shown Electron, populated Renderer API fixture. This checks layout and interaction,
// not Main's aggregation or the user's real usage history.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const out = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || await mkdtemp(join(tmpdir(), 'ls-detail-evidence-')))
const root = await mkdtemp(join(tmpdir(), 'ls-detail-polish-'))
const dataDir = join(root, 'data'), chromiumDir = join(root, 'chromium'), workspace = join(dataDir, 'workplace')
const h = createElectronHarness({ startTimeoutMs: 90_000 })
const report = { fixture: 'isolated shown Electron; populated usage response at Renderer fetch boundary', scenes: [], checks: {} }
let electron, client, locator
const evaluate = expression => client.evaluate(expression)
const clickText = (selector, text) => evaluate(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing: '+${JSON.stringify(text)});e.click()})()`)
async function resize(width, height) {
  await h.desktopAction(locator, 'resize', { width, height })
  await h.waitFor(() => evaluate(`innerWidth===${width}&&innerHeight===${height}||null`), 15_000, 'window resize')
}
async function screenshot(name) {
  await delay(450)
  const scene = await evaluate(`(() => {
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
    const labels=[...document.querySelectorAll('.usage-heatmap-weekdays span')];
    const weeks=[...document.querySelectorAll('.usage-heatmap-week')];
    const rows=labels.map((e,i)=>({label:rect(e),cell:weeks.length?rect(weeks[0].children[i]):null}));
    const scroll=document.querySelector('.usage-heatmap-scroll');
    return {name:${JSON.stringify(name)},viewport:{w:innerWidth,h:innerHeight},theme:document.documentElement.dataset.lsTheme,
      shellOverflow:document.documentElement.scrollWidth>innerWidth,
      rows,months:[...document.querySelectorAll('.usage-heatmap-months span')].map(e=>e.textContent).filter(Boolean),
      chartScroll:scroll?{width:scroll.clientWidth,content:scroll.scrollWidth}:null,
      cellCount:document.querySelectorAll('[data-date]').length,
      summary:document.querySelector('.usage-summary')?.innerText,
      menu:[...document.querySelectorAll('.split-button-menu-item')].map(e=>({radius:getComputedStyle(e).borderRadius,rect:rect(e)}))};
  })()`)
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  await writeFile(join(out, name + '.png'), Buffer.from(shot.data, 'base64'))
  report.scenes.push(scene)
  assert.equal(scene.shellOverflow, false, name + ' window overflow')
  for (const row of scene.rows) assert.ok(Math.abs(row.label.y - row.cell.y) < 1, name + ' weekday not aligned')
  if (scene.months.length) {
    assert.deepEqual(scene.months, Array.from({ length: 12 }, (_, i) => `${i + 1}月`), 'one label per month')
    assert.equal(scene.cellCount, 365, 'all calendar days present')
    if (scene.viewport.w >= 1280) assert.ok(scene.chartScroll.content <= scene.chartScroll.width + 1, 'year fits desktop chart')
  }
}
function installUsageFixture() {
  const original = window.fetch.bind(window)
  window.__usageFixtureFailure = false
  const dates = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
  const recorded = { '2026-09-22': 925415, '2026-09-30': 74200 }
  const days = dates.filter(date => date !== '2026-08-10').map(date => {
    const total = recorded[date] || 0
    const state = total ? 'recorded' : date === '2026-09-23' ? 'partial' : date > '2026-10-02' ? 'future' : 'empty'
    return { date, state, total, input: Math.round(total * .8), output: total - Math.round(total * .8), cached: 0, reasoning: 0,
      requests: total ? 10 : state === 'partial' ? 2 : 0, missingResponses: state === 'partial' ? 1 : 0, unreportedRequests: state === 'partial' ? 1 : 0 }
  })
  const payload = { version: 1, timezone: 'Asia/Hong_Kong', range: { from: dates[0], to: dates.at(-1), days: 365 },
    bounds: { maxRangeDays: 400, maxIdentities: 64, identitiesTruncated: false }, filters: {}, days,
    totals: { total: 999615, input: 799692, output: 199923, cached: 0, reasoning: 0, activeDays: 3, requests: 22, peak: { date: '2026-09-22', total: 925415 } },
    identities: { providers: [{ id: 'acceptance-provider-with-a-long-name', requests: 22, total: 999615 }], models: [{ id: 'acceptance-model-with-a-long-name', requests: 22, total: 999615 }] },
    coverage: { timezone: 'Asia/Hong_Kong', timezoneSource: 'system', indexedRuns: 64, indexedSessions: 62, attempts: 426,
      missingResponses: 138, unreportedRequests: 266, unreadableRuns: 0, modes: { next: 64, shadow: 0, unknown: 0 }, duplicateAttempts: 0,
      projectionBuilt: true, stale: false, retainedAfterDeleteSessions: 60,
      backfill: { status: 'partial', partitions: 691, processed: 0, indexed: 0, failed: 0 },
      statement: '统计时区 Asia/Hong_Kong（默认系统时区）；按 Provider 实报 usage 的 model_response_received 事件时间归入本地日；总量取实报 totalTokens，缺失时按实报输入 + 输出求和；缓存读写与推理是子集，不重复计入总量；本地上下文计数、安全估算与 embedding 不计入；同一 requestId 只计一次；投影覆盖 64 个 run / 62 个会话；缺失覆盖：138 个响应未报 usage、266 个请求无响应；回填状态 partial（已索引 0/691 个分区）；60 个已永久删除的会话仍保留不含内容的用量摘要。' } }
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url || String(input)
    if (url.includes('/runtime/usage/refresh')) return new Response(JSON.stringify(window.__usageFixtureFailure ? { error: '用量服务暂不可用' } : {}), { status: window.__usageFixtureFailure ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
    if (!url.includes('/runtime/usage/daily')) return original(input, init)
    const query = new URL(url, location.href).searchParams
    return new Response(JSON.stringify({ ...payload, filters: { provider: query.get('provider') || undefined, model: query.get('model') || undefined } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}
try {
  await h.assertBuildFresh()
  await Promise.all([mkdir(out, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
  await writeFile(join(workspace, 'package.json'), '{\n  "name": "littlesheep-ui-fixture"\n}\n')
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [], agents: { defaults: { workspace } } }))
  const debuggingPort = await h.reservePort()
  electron = await h.startElectron({ dataDir, chromiumDir, debuggingPort, logPath: join(root, 'electron.log') })
  locator = await h.waitForLocator(dataDir, electron.pid)
  await h.waitForDesktop(locator); await h.desktopAction(locator, 'show')
  client = await h.connectRenderer(debuggingPort)
  await client.send('Runtime.enable'); await client.send('Page.bringToFront')
  await h.waitFor(() => evaluate(`!!document.querySelector('.composer textarea')||null`), 30_000, 'composer')
  await evaluate(`(${installUsageFixture.toString()})()`)
  await resize(1280, 900)
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
  await clickText('.settings-nav-item', 'Token 用量')
  await h.waitFor(() => evaluate(`document.querySelectorAll('[data-date]').length===365||null`), 15_000, 'populated calendar')
  await screenshot('usage-dark')
  assert.equal(await evaluate(`document.querySelector('.usage-methodology').open`), false)
  assert.equal(await evaluate(`document.querySelector('.usage-summary dd').title`), '999,615 tok')
  await evaluate(`document.querySelector('[data-date="2026-09-22"]').click()`)
  await h.waitFor(() => evaluate(`document.querySelector('[data-date="2026-09-22"]').getAttribute('aria-selected')==='true'||null`), 5000, 'selected cell')
  assert.ok((await evaluate(`document.querySelector('.usage-day-panel').innerText`)).includes('925,415'))
  await screenshot('usage-day-detail')
  await evaluate(`document.querySelector('[data-date="2026-08-10"]').click()`)
  assert.ok((await evaluate(`document.querySelector('.usage-day-panel').innerText`)).includes('投影未覆盖'))
  assert.equal(await evaluate(`document.querySelector('[data-date="2026-08-10"]').tabIndex`), 0)
  for (const [date, key, target] of [['2026-01-03', 'Home', '2026-01-01'], ['2026-01-03', 'End', '2026-01-04'], ['2026-01-07', 'Home', '2026-01-05'], ['2026-12-29', 'End', '2026-12-31']]) {
    await evaluate(`document.querySelector('[data-date="${date}"]').focus()`)
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Home' ? 36 : 35 })
    assert.equal(await evaluate(`document.activeElement.dataset.date`), target, 'Monday calendar Home/End')
  }
  report.checks.calendarKeyboard = 'Home/End respects padded first/last Monday week; uncovered days remain selectable'
  await evaluate(`document.querySelector('.usage-methodology summary').click();document.querySelector('.usage-legend-details summary').click()`)
  await screenshot('usage-accounting-expanded')
  await evaluate(`document.querySelector('.usage-methodology summary').click();document.querySelector('.usage-legend-details summary').click();document.documentElement.dataset.lsTheme='light'`)
  await screenshot('usage-light')
  await resize(900, 700); await screenshot('usage-compact')
  await clickText('.settings-nav-item', '界面')
  await evaluate(`(() => {const e=document.querySelector('input[aria-label="界面字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'20');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await clickText('.settings-nav-item', 'Token 用量'); await screenshot('usage-large-type')
  await evaluate(`document.querySelector('.usage-chart').scrollIntoView({block:'center'})`)
  await screenshot('usage-large-type-calendar')
  await clickText('.settings-nav-item', '界面')
  await evaluate(`(() => {const e=document.querySelector('input[aria-label="界面字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'14');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await clickText('.settings-nav-item', 'Token 用量'); await resize(1280, 900)
  await evaluate(`document.querySelector('button[aria-label="统计指标"]').click()`)
  await screenshot('usage-filter-menu')
  await clickText('.settings-select-menu button', '输出')
  assert.ok((await evaluate(`document.querySelector('.usage-heatmap').getAttribute('aria-label')`)).includes('输出'))
  await evaluate(`window.__usageFixtureFailure=true;document.querySelector('.usage-refresh').click()`)
  await h.waitFor(() => evaluate(`!!document.querySelector('.usage-refresh-failure')||null`), 5000, 'failed refresh notice')
  assert.equal(await evaluate(`document.querySelectorAll('[data-date]').length`), 365)
  await screenshot('usage-refresh-failure')
  report.checks.refreshFailure = 'previous calendar and totals remain readable; error and coverage warning visible'
  await evaluate(`document.querySelector('button[aria-label="退出设置页"]').click()`)
  await h.waitFor(() => evaluate(`!![...document.querySelectorAll('.workspace-tree-row.file')].find(e=>e.textContent.trim()==='package.json')||null`), 15_000, 'file navigator')
  await evaluate(`[...document.querySelectorAll('.workspace-tree-row.file')].find(e=>e.textContent.trim()==='package.json').click()`)
  await h.waitFor(() => evaluate(`!!document.querySelector('.workspace-preview-open-with .split-button-chevron')||null`), 15_000, 'file toolbar')
  await evaluate(`document.querySelector('.workspace-preview-open-with .split-button-chevron').click()`)
  await screenshot('file-open-menu-dark')
  const menu = await evaluate(`(() => {const r=document.querySelector('.split-button-menu').getBoundingClientRect();const e=document.querySelector('.split-button-menu-item.divider-before').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,hoverX:e.x+e.width/2,hoverY:e.y+e.height/2}})()`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: menu.hoverX, y: menu.hoverY })
  await delay(200)
  const closeup = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: menu.x - 8, y: menu.y - 8, width: menu.w + 16, height: menu.h + 16, scale: 2 } })
  await writeFile(join(out, 'file-open-menu-detail.png'), Buffer.from(closeup.data, 'base64'))
  const radii = await evaluate(`({outer:getComputedStyle(document.querySelector('.split-button-menu')).borderRadius,rows:[...document.querySelectorAll('.split-button-menu-item')].map(e=>getComputedStyle(e).borderRadius)})`)
  assert.equal(radii.outer, '18px'); assert.ok(radii.rows.every(r => r === '10px'), 'divider keeps all row corners')
  report.checks.menuRadii = radii
  await evaluate(`document.documentElement.dataset.lsTheme='light'`); await screenshot('file-open-menu-light')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await h.waitFor(() => evaluate(`!document.querySelector('.split-button-menu')||null`), 5000, 'Escape closes menu')
  report.checks.uncaughtErrors = client.events.filter(e => e.method === 'Runtime.exceptionThrown')
  assert.equal(report.checks.uncaughtErrors.length, 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack
  if (client) await screenshot('failure').catch(() => {})
  throw error
} finally {
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, scenes: report.scenes.length, out, error: report.error }))
  client?.close(); await h.forceTerminate(electron)
}
