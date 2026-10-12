// Isolated real-window history latency and pagination probe; no provider calls.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness()
await harness.assertBuildFresh()
const root = await mkdtemp(join(tmpdir(), 'ls-history-speed-'))
const dataDir = join(root, 'data'), count = 240, now = Date.now()
await mkdir(join(dataDir, 'sessions'), { recursive: true })
await mkdir(join(dataDir, 'workplace'), { recursive: true })
const sessions = []
for (const id of ['history-a', 'history-b']) {
  const lines = [JSON.stringify({ type: 'metadata', metadata: { title: id, createdAt: new Date(now).toISOString(), messageCount: count } })]
  for (let i = 0; i < count; i++) {
    const text = i % 2 ? `## 回合 ${i}\n\n` + ('正文与验证结果，检查历史阅读的完整性。\n\n- 验证数据读取\n- 验证消息显示\n\n| 项目 | 结果 |\n| --- | --- |\n| 阅读 | 正常 |\n\n').repeat(8) : `问题 ${i}：检查长对话性能`
    lines.push(JSON.stringify({ id: `${id}-${i}`, role: i % 2 ? 'assistant' : 'user', sessionId: id, timestamp: new Date(now - count * 1000 + i * 1000).toISOString(), content: [{ type: 'text', text }] }))
  }
  await writeFile(join(dataDir, 'sessions', `${id}.jsonl`), lines.join('\n') + '\n')
  sessions.push({ id, title: id, createdAt: now, lastMessageAt: now, scope: 'standalone', mode: 'research' })
}
await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ sessions }))
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [], agents: { defaults: { workspace: join(dataDir, 'workplace'), model: '', harness: 'core-flow' } } }))
const port = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
let client
try {
  const locator = await harness.waitForLocator(dataDir, child.pid)
  await harness.desktopAction(locator, 'resize', { width: 1280, height: 900 })
  await harness.desktopAction(locator, 'show')
  client = await harness.connectRenderer(port)
  await harness.waitFor(() => client.evaluate('document.querySelectorAll(".session-item").length === 2'), 30000)
  await delay(500)
  assert.equal(await client.evaluate('!!document.querySelector(".settings-workspace")'), false)
  // Measure inside Chromium through paint, avoiding CDP polling latency.
  const samples = []
  for (const id of ['history-a', 'history-b', 'history-a', 'history-b', 'history-a']) {
    samples.push(await client.evaluate(`new Promise(resolve => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-message-key="${id}-239"]')) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({id:'${id}',paintMs:performance.now()-start,messages:document.querySelectorAll('[data-message-key]').length,api:performance.getEntriesByType('resource').filter(r=>r.name.includes('/sessions/${id}/messages')).map(r=>({duration:r.duration,bytes:r.decodedBodySize}))})));
      });
      observer.observe(document.querySelector('.chat'), {childList:true,subtree:true});
      [...document.querySelectorAll('.session-item')].find(el=>el.textContent.includes('${id}')).click();
    })`))
    await delay(150)
  }
  // Loading older content retains the current reader anchor and all message ids.
  await client.evaluate("document.querySelector('.messages').scrollTop=0")
  await delay(200)
  const before = await client.evaluate("[...document.querySelectorAll('[data-message-key]')].map(el=>el.dataset.messageKey)")
  await client.evaluate("document.querySelector('.history-load-older').click()")
  await harness.waitFor(() => client.evaluate(`document.querySelectorAll('[data-message-key]').length > ${before.length} && !document.querySelector('.history-load-older')?.disabled`), 20000)
  let after = await client.evaluate("[...document.querySelectorAll('[data-message-key]')].map(el=>el.dataset.messageKey)")
  assert.equal(new Set(after).size, after.length)
  assert(before.every(id => after.includes(id)))
  assert.equal(after.at(-1), 'history-a-239')
  while (await client.evaluate('!!document.querySelector(".history-load-older")')) {
    const previousCount = after.length
    await client.evaluate("document.querySelector('.history-load-older').click()")
    await harness.waitFor(() => client.evaluate(`document.querySelectorAll('[data-message-key]').length > ${previousCount} && !document.querySelector('.history-load-older')?.disabled`), 20000)
    after = await client.evaluate("[...document.querySelectorAll('[data-message-key]')].map(el=>el.dataset.messageKey)")
  }
  assert.equal(after.length, count)
  assert.equal(new Set(after).size, count)
  assert.equal(after[0], 'history-a-0')
  const settingsMs = await client.evaluate(`new Promise(resolve=>{
    const start=performance.now(),observer=new MutationObserver(()=>{
      if(!document.querySelector('.settings-sidebar-search'))return;
      observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    });observer.observe(document.body,{childList:true,subtree:true});document.querySelector('.settings-entry-btn').click();
  })`)
  await delay(600)
  await client.evaluate("[...document.querySelectorAll('.settings-nav-item')].find(el=>el.textContent.trim()==='外观').click()")
  await harness.waitFor(() => client.evaluate('!!document.querySelector(".appearance-settings-page")'), 10000)
  await client.evaluate("(() => {const input=document.querySelector('.settings-sidebar-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'外观');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await delay(100)
  await client.evaluate("document.querySelector('[aria-label=\"退出设置页\"]').click()")
  await delay(650)
  assert(await client.evaluate('!!document.querySelector(".settings-workspace")'))
  await client.evaluate("document.querySelector('.settings-entry-btn').click()")
  await delay(650)
  assert.equal(await client.evaluate('document.querySelector(".settings-sidebar-search input").value'), '外观')
  await client.evaluate("document.querySelector('[aria-label=\"退出设置页\"]').click()")
  await delay(650)
  await client.evaluate("document.querySelector('.sidebar-nav-button[aria-label=\"插件\"]').click()")
  await harness.waitFor(() => client.evaluate('!!document.querySelector(".plugin-page-heading")'), 10000)
  const report = { root, fixtureMessages: count, samples, pagination: { before: before.length, after: after.length, retained: true }, deferredSettings: { firstOpenMs: settingsMs, absentAtStartup: true, stateRetainedOnReopen: true, pluginsLoaded: true } }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  client?.close()
  if (child.exitCode === null) await harness.forceTerminate(child)
}
