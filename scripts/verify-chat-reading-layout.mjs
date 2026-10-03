// Real Renderer acceptance using isolated data and the local deterministic provider.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { LONG_MARKDOWN_MARKER, startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness()
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 20, streamChunkCharacters: 60 })
const root = await mkdtemp(join(tmpdir(), 'littlesheep-chat-layout-'))
const dataDir = join(root, 'data')
const workspace = join(dataDir, 'workplace')
const report = { checks: [], measurements: {}, screenshots: [] }
let child, client
const record = (name) => { report.checks.push(name); console.log(`PASS ${name}`) }
const evaluate = (source) => client.evaluate(source)
async function wait(source, label) {
  return harness.waitFor(() => evaluate(source), 60_000, label)
}
async function draft(text) {
  await evaluate(`(() => { const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await delay(50)
}
async function submit(text) {
  const before = await evaluate("document.querySelectorAll('.assistant-turn').length")
  await draft(text)
  await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))")
  await wait(`document.querySelectorAll('.assistant-turn').length > ${before} || null`, 'new turn')
}
async function settled() {
  await wait("document.querySelector('.assistant-turn:last-child .assistant-response-stream[data-stream-state=\"settled\"]') ? true : null", 'settled response')
  await delay(300)
}
async function screenshot(name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  const path = join(root, `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  report.screenshots.push(path)
}
const geometry = `(() => {
  const rect = (selector) => { const el=document.querySelector(selector); if(!el)return null;const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} };
  const messages=document.querySelector('.messages'); const textarea=document.querySelector('.composer textarea');
  return {header:rect('.chat-header'),messages:rect('.messages'),composer:rect('.composer'),shell:rect('.composer-shell'),chat:rect('.chat'),
    controls:rect('.composer-controls'),actions:rect('.composer-run-actions'),panel:rect('.chat-turn-panel'),
    overflow:messages.scrollWidth-messages.clientWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,
    draft:textarea.value,gap:messages.scrollHeight-messages.clientHeight-messages.scrollTop,
    active:document.querySelector('.chat-turn-trigger')?.textContent};
})()`

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'fixture.txt'), 'layout acceptance')
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'acceptance-key',
      timeoutSeconds: 15, models: ['slow-a'] }],
    agents: { defaults: { workspace, model: 'acceptance/slow-a', harness: 'core-flow' } },
  }))
  const port = await harness.reservePort()
  child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, child.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'resize', { width: 1280, height: 760 })
  await harness.desktopAction(locator, 'show')
  client = await harness.connectRenderer(port)
  await client.send('Page.bringToFront')
  await wait("document.querySelector('.composer textarea') ? true : null", 'composer')
  await harness.waitFor(async () => {
    const readiness = await harness.fetchJson(locator, '/runtime/readiness')
    return readiness?.body?.state === 'ready' ? true : null
  }, 60_000, 'runtime ready')
  const empty = await evaluate(geometry)
  assert(empty.messages.top >= empty.header.bottom - 1)
  assert(empty.composer.bottom <= empty.chat.bottom + 1)
  assert(empty.messages.bottom <= empty.shell.top + 1)
  await screenshot('empty')

  await submit(`请输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await wait("document.querySelector('.assistant-turn.running .assistant-process-content.open') ? true : null", 'bounded running state')
  assert.equal(await evaluate("document.querySelector('.assistant-turn.running .assistant-process-trigger').getAttribute('aria-expanded')"), 'true')
  assert(await evaluate("!!document.querySelector('.composer .stop:not(:disabled)')"))
  assert(await evaluate("document.querySelector('.assistant-turn.running .assistant-process-trigger').disabled"))
  record('DSH live process stays open and Stop remains reachable')
  await settled()
  const first = await evaluate(geometry)
  assert(Math.abs(first.composer.bottom - empty.composer.bottom) < 1)
  record('input stays at the same bottom position before and after sending')
  await submit('请使用 glob 工具列出当前工作区顶层条目')
  await settled()
  assert.equal(await evaluate("document.querySelector('.assistant-turn:last-child .assistant-process-trigger').getAttribute('aria-expanded')"), 'false')
  await evaluate("document.querySelector('.assistant-turn:last-child .assistant-process-trigger').click()")
  await delay(250)
  await wait("document.querySelector('.assistant-turn:last-child .agent-tool-row') ? true : null", 'recorded tool row')
  const toolRow = await evaluate("(() => {const e=document.querySelector('.assistant-turn:last-child .agent-tool-row');return {height:e.getBoundingClientRect().height, expanded:e.getAttribute('aria-expanded')}})()")
  assert.equal(toolRow.height, 24)
  assert.equal(toolRow.expanded, 'false')
  await evaluate("document.querySelector('.assistant-turn:last-child .agent-tool-row').click()")
  await delay(250)
  assert(await evaluate("!!document.querySelector('.assistant-turn:last-child .agent-tool-details-panel.open')"))
  await evaluate("document.querySelector('.assistant-turn:last-child .agent-tool-call').scrollIntoView({block:'start'})")
  await delay(250)
  await screenshot('dsh-tool-result')
  record('DSH completed process reopens its full history and a 24px tool row opens its result')
  await submit(`请再次输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await settled()
  // Pointer motion must highlight controls without creating floating information boxes.
  for (const selector of ['.chat-header .running-pill', '.assistant-turn:last-child .message-meta-copy', '.assistant-turn:last-child .turn-usage-button']) {
    const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2} })()`)
    await client.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point})
    await delay(650)
    assert(!(await evaluate("!!document.querySelector('.floating-help-tip.visible, .running-pill-panel, .turn-usage-panel')")))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('title')`), null)
  }
  record('conversation hover creates no tooltip or details panel')
  await evaluate("document.querySelector('.assistant-turn:last-child .turn-usage-button').click()")
  await delay(100)
  assert(await evaluate("!!document.querySelector('.turn-usage-panel')"))
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert(!(await evaluate("!!document.querySelector('.turn-usage-panel')")))
  assert.equal(await evaluate("document.activeElement.className"), 'turn-usage-button')
  await evaluate("document.querySelector('.chat-header .running-pill').click()")
  await delay(100)
  assert(await evaluate("!!document.querySelector('.running-pill-panel')"))
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert(!(await evaluate("!!document.querySelector('.running-pill-panel')")))
  record('usage and execution records open only on click and return focus on Escape')
  await screenshot('conversation')
  await evaluate("document.querySelector('.chat-turn-trigger').click()")
  await delay(120)
  await screenshot('directory')
  await evaluate("document.querySelector('.chat-turn-heading button').click()")

  await evaluate("document.querySelector('.chat-turn-trigger').click()")
  await delay(120)
  assert.equal(await evaluate("document.querySelectorAll('.chat-turn-entry').length"), 3)
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-search')
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))")
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-entry')
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));document.activeElement.click()")
  await delay(300)
  assert(!(await evaluate("!!document.querySelector('.chat-turn-panel')")))
  assert((await evaluate(geometry)).gap > 100)
  assert(await evaluate("!!document.querySelector('.chat-jump-to-latest')"))
  record('directory groups turns, moves with keyboard and jumps into the real transcript')
  await evaluate("document.querySelector('.chat-turn-trigger').click()")
  await delay(80)
  await evaluate("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('.chat-turn-search'),'没有匹配的内容');document.querySelector('.chat-turn-search').dispatchEvent(new Event('input',{bubbles:true}))")
  await delay(80)
  assert.equal(await evaluate("document.querySelectorAll('.chat-turn-entry').length"), 0)
  assert(await evaluate("!!document.querySelector('.chat-turn-empty')"))
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert.equal(await evaluate("document.activeElement.className"), 'chat-turn-trigger')
  record('search has an empty state and Escape returns focus')

  const longDraft = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行待发送内容，改变窗口宽度后也应保留。`).join('\n')
  await draft(longDraft)
  await harness.desktopAction(locator, 'resize', { width: 800, height: 660 })
  await delay(700)
  const narrow = await evaluate(geometry)
  assert.equal(narrow.draft, longDraft)
  assert(narrow.overflow <= 1 && narrow.documentOverflow <= 1)
  assert(narrow.actions.left >= narrow.composer.left && narrow.actions.right <= narrow.composer.right + 1)
  assert(narrow.composer.top > narrow.header.bottom)
  assert(narrow.messages.bottom <= narrow.shell.top + 1)
  assert(narrow.messages.height >= 80)
  await screenshot('narrow-draft')
  // Open the real split workspace to exercise a chat column below the responsive threshold.
  await evaluate("document.querySelector('button[aria-label=\"打开拓展工作区\"]')?.click()")
  await delay(700)
  const split = await evaluate(geometry)
  assert.equal(split.draft, longDraft)
  assert(split.overflow <= 1 && split.documentOverflow <= 1)
  assert(split.actions.right <= split.composer.right + 1 && split.actions.left >= split.composer.left)
  assert(split.actions.bottom <= split.composer.bottom - 7, 'wrapped controls must retain the input surface bottom padding')
  assert(split.messages.bottom <= split.shell.top + 1)
  await screenshot('split-draft')
  report.measurements.split = split
  report.measurements = { ...report.measurements, empty, first, narrow }
  record('narrow window retains a multiline draft, bounds the controls and keeps a reading area')
  await draft('')
  await evaluate("document.querySelector('.chat-jump-to-latest')?.click()")
  await delay(300)
  await submit('请简短确认这条消息。')
  await settled()
  await provider.setFaults([{ kind: 'status', status: 401, times: 40 }])
  await submit('检查失败状态的操作入口')
  await wait("document.querySelector('.assistant-turn.failed .assistant-turn-retry') ? true : null", 'failed turn retry')
  assert(await evaluate("!!document.querySelector('.assistant-turn.failed [data-transcript-attention=\"true\"]')"))
  await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').click()")
  await delay(200)
  assert(await evaluate("document.querySelector('.assistant-turn.failed .assistant-turn-retry').getBoundingClientRect().height >= 24"))
  assert.equal(await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').getAttribute('aria-expanded')"), 'true')
  assert(await evaluate("document.querySelector('.assistant-turn.failed .assistant-process-trigger').disabled"))
  await screenshot('failure-visible')
  record('DSH failed process stays open with its recorded failure and retry')
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(root, 'report.json')}`)
} finally {
  client?.close()
  if (child?.exitCode === null) await harness.forceTerminate(child)
  await provider.close()
}
