// Real Electron acceptance against synthetic data: navigation, privacy, ledgers and active runs.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ContextEngine } from '../packages/context/dist/index.js'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider, LONG_MARKDOWN_MARKER } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90000, actionTimeoutMs: 30000 })
const outRoot = resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? join(tmpdir(), 'littlesheep-context-inspector'))
const root = await mkdtemp(join(tmpdir(), 'ls-context-inspector-'))
const dataDir = join(root, 'data')
const chromiumDir = join(root, 'chromium')
const provider = await startElectronAcceptanceProvider({ requestDelayMs: 6000, streamChunkDelayMs: 80, streamChunkCharacters: 40 })
let electron, client, locator
const checks = []
const screenshots = []
const visualEvidence = []
let failureStage = 'setup'
function assert(condition, label) { if (!condition) throw new Error(label); checks.push(label) }
const evaluate = (expression) => client.evaluate(expression)
async function shot(name) {
  const image = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(outRoot, `${name}.png`)
  await writeFile(path, Buffer.from(image.data, 'base64'))
  screenshots.push(path)
}
async function captureThemePair(name) {
  const originalTheme = await evaluate("document.documentElement.getAttribute('data-ls-theme') || 'dark'")
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.setAttribute('data-ls-theme','${theme}')`)
    await delay(120)
    const style = await evaluate(`(() => {
      const root=getComputedStyle(document.documentElement), surface=document.querySelector('.context-inspector-surface');
      const refresh=document.querySelector('.context-inspector-refresh');
      const table=document.querySelector('.context-inspector-table-scroll');
      const timeline=document.querySelector('.context-inspector-timeline');
      const pick=el=>el?{color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor,
        radius:getComputedStyle(el).borderTopLeftRadius,fontSize:getComputedStyle(el).fontSize}:null;
      return {theme:${JSON.stringify(theme)},background:root.getPropertyValue('--bg').trim(),surface:pick(surface),refresh:pick(refresh),
        table:pick(table),timeline:pick(timeline)};
    })()`)
    visualEvidence.push({ scene: name, ...style })
    await shot(`${name}-${theme}`)
  }
  await evaluate(`document.documentElement.setAttribute('data-ls-theme',${JSON.stringify(originalTheme)})`)
  await delay(120)
}
async function draft(text) {
  await evaluate(`(() => { const input = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
}
async function open() {
  await evaluate(`document.querySelector('.context-usage').click()`)
  await harness.waitFor(() => evaluate(`!!document.querySelector('.context-inspector-surface')`), 10000, 'Inspector opens')
}
async function close() {
  await evaluate(`document.querySelector('.workspace-active-item.active .workspace-active-close').click()`)
  await harness.waitFor(() => evaluate(`!document.querySelector('.context-inspector-surface')`), 10000, 'Inspector closes')
  await delay(250)
}
async function session(title) {
  failureStage = `wait-session-row:${title}`
  try {
    await harness.waitFor(() => evaluate(`!![...document.querySelectorAll('.session-item')]
      .find((item) => item.textContent.includes(${JSON.stringify(title)}))`), 15000, `session row ${title}`)
  } catch (error) {
    const rows = await evaluate(`(() => ({rowCount:document.querySelectorAll('.session-item').length,
      rows:[...document.querySelectorAll('.session-item')].map(item=>({text:item.innerText,
        id:item.getAttribute('data-session-id'),html:item.outerHTML.slice(0,700)})),
      sidebarText:document.querySelector('.sidebar')?.innerText?.slice(0,1500)}))()`)
    throw new Error(`fixture session row did not render: ${title}; ${JSON.stringify(rows)}; ${error instanceof Error ? error.message : String(error)}`)
  }
  await evaluate(`(() => { [...document.querySelectorAll('.session-item')].find((item) => item.textContent.includes(${JSON.stringify(title)})).click(); })()`)
  await delay(600)
}
async function seed(id, title, partial) {
  const now = new Date().toISOString()
  const runId = `fixture-${id}`
  const prepared = new ContextEngine().prepare({ runId, sessionId: id, stage: 'execute', requestIndex: 1,
    request: { model: 'acceptance/slow-a', messages: [{ role: 'system', content: 'PRIVATE_PROMPT_SENTINEL' }, { role: 'user', content: 'fixture' }] } })
  const snapshot = structuredClone(prepared.contextSnapshot)
  snapshot.budget = { status: 'known', maxContextTokens: 128000, reservedOutputTokens: 4096, availablePromptTokens: 123904, compressionThresholdRatio: 0.8 }
  snapshot.itemsTruncated = partial
  if (!partial) {
    snapshot.localTokenLedger = { version: 1, source: 'local', accuracy: 'exact', provider: 'acceptance', model: 'slow-a', tokenizerId: 'synthetic-ui-fixture', promptTokens: 5000, countedAt: now }
    snapshot.providerUsage = { version: 1, source: 'provider', provider: 'acceptance', model: 'slow-a', promptTokens: 5100, completionTokens: 72, totalTokens: 5172, cachedPromptTokens: 4000, reportedAt: now }
  }
  const messages = Array.from({ length: 40 }, (_, index) => ({ id: `${id}-${index}`, sessionId: id, runId,
    role: index % 2 ? 'assistant' : 'user', timestamp: now, content: [{ type: 'text', text: `诊断验收消息 ${index + 1}：用于确认聊天滚动与草稿保留。` }] }))
  await writeFile(join(dataDir, 'sessions', `${id}.jsonl`), [JSON.stringify({ type: 'metadata', metadata: { title, createdAt: now, updatedAt: now, messageCount: messages.length } }), ...messages.map(JSON.stringify)].join('\n') + '\n')
  await writeFile(join(dataDir, 'execution-logs', `${runId}.json`), JSON.stringify({ runId, sessionId: id, startedAt: now, endedAt: now, status: 'ok', model: 'acceptance/slow-a', inboundText: 'fixture', reply: 'fixture', durationMs: 1, trace: [], toolCalls: [],
    systemPromptProjection: 'PRIVATE_PROMPT_SENTINEL', memoryAccess: { private: 'PRIVATE_MEMORY_SENTINEL' }, modelRequests: [prepared.modelRequestSnapshot], contextSnapshots: [snapshot] }))
  return { id, title, createdAt: Date.now(), lastMessageAt: Date.now(), mode: 'workspace-write', permissionVersion: 2, scope: 'standalone' }
}
try {
  await Promise.all([mkdir(join(dataDir, 'sessions'), { recursive: true }), mkdir(join(dataDir, 'execution-logs'), { recursive: true }), mkdir(chromiumDir, { recursive: true }), mkdir(outRoot, { recursive: true })])
  const workspace = join(dataDir, 'workplace'); await mkdir(workspace)
  const sessions = [await seed('inspector-full', '上下文完整验收', false), await seed('inspector-partial', '上下文缺失验收', true)]
  await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ sessions }))
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'fixture-key', models: [{ id: 'slow-a', contextWindow: 128000 }] }],
    agents: { defaults: { workspace, model: 'acceptance/slow-a', reasoning: 'auto', timeoutSeconds: 120 } } }))
  electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort: await harness.reservePort(), logPath: join(root, 'electron.log') })
  locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator); await harness.desktopAction(locator, 'resize', { width: 1180, height: 800 })
  // Find the renderer through the port passed to the process.
  const debuggingArg = electron.spawnargs.find((arg) => arg.startsWith('--remote-debugging-port='))
  client = await harness.connectRenderer(Number(debuggingArg.split('=')[1]))
  await harness.waitFor(() => evaluate(`!!document.querySelector('.composer textarea')`), 90000, 'composer')
  const indexedSessions = await harness.fetchJson(locator, '/sessions')
  const indexedTitles = indexedSessions.body.sessions.map((item) => item.title)
  if (!sessions.every((item) => indexedTitles.includes(item.title))) {
    throw new Error(`fixture sessions were not accepted by the session index: ${JSON.stringify(indexedTitles)}`)
  }
  failureStage = 'new-conversation-inspector-empty'
  await draft('新会话草稿')
  const controls = await evaluate(`(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, height: r.height }; };
    return { ring: rect('.context-usage-ring'), model: rect('.runtime-picker-trigger'), send: rect('.send-round') };
  })()`)
  assert(Math.abs(controls.ring.y + controls.ring.height / 2 - controls.model.y - controls.model.height / 2) <= 1
    && Math.abs(controls.ring.y + controls.ring.height / 2 - controls.send.y - controls.send.height / 2) <= 1, 'composer controls share a vertical center')
  await captureThemePair('composer')
  const initialSessions = (await harness.fetchJson(locator, '/sessions')).body.sessions.length
  await open(); await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-empty')?.textContent.includes('尚未发送')`), 10000, 'new conversation empty state')
  await delay(350)
  const placement = await evaluate(`(() => {
    const page = document.querySelector('.context-inspector-surface');
    const panel = document.querySelector('.workspace-panel');
    const r = page.getBoundingClientRect(), p = panel.querySelector('.workspace-panel-surface').getBoundingClientRect();
    return { contained: panel.contains(page), left: r.left, right: r.right, panelLeft: p.left, panelRight: p.right,
      appInert: document.querySelector('.app-panels').hasAttribute('inert'),
      chatVisibility: getComputedStyle(document.querySelector('.chat')).visibility,
      workspaceInert: document.querySelector('.workspace-panel-contents').hasAttribute('inert') };
  })()`)
  await captureThemePair('empty')
  assert(placement.contained && placement.left >= placement.panelLeft && placement.right <= placement.panelRight + 1
    && !placement.appInert && placement.chatVisibility === 'visible' && !placement.workspaceInert,
    `Inspector stays inside workspace while chat remains interactive: ${JSON.stringify(placement)}`)
  await close()
  assert(await evaluate(`document.querySelector('.composer textarea').value === '新会话草稿'`), 'new conversation draft survives')
  assert((await harness.fetchJson(locator, '/sessions')).body.sessions.length === initialSessions, 'opening does not create a session')
  await evaluate(`[...document.querySelectorAll('.workspace-empty-launcher-item')].find((item) => item.textContent.includes('审阅')).click()`)
  await open()
  assert(await evaluate(`document.querySelectorAll('.workspace-active-item').length === 2 && document.querySelector('.workspace-active-item.active').textContent.includes('上下文')`), 'Inspector uses shared workspace tab strip')
  await evaluate(`[...document.querySelectorAll('.workspace-active-item')].find((item) => item.textContent.includes('审阅')).click()`)
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-surface')?.closest('.workspace-tab-view')?.hasAttribute('inert')`), 10000, 'Inspector caches as an inactive tab')
  await open(); await close()
  assert(await evaluate(`document.querySelector('.workspace-active-item.active')?.textContent.includes('审阅')`), 'native close restores the preceding workspace tab')
  failureStage = 'history-session-full'
  await session('上下文完整验收'); await draft('保留的检查草稿')
  await evaluate(`document.querySelector('.messages').scrollTop = 160`); await delay(150)
  const scroll = await evaluate(`document.querySelector('.messages').scrollTop`)
  await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('5,100')`), 10000, 'Provider fixture count')
  const content = await evaluate(`document.querySelector('.context-inspector-content').textContent`)
  assert(content.includes('5,000') && content.includes('5,100'), 'local and Provider ledgers stay separate')
  assert(content.includes('不可用') && content.includes('128,000'), 'missing cache write and model window are explicit')
  assert(!content.includes('PRIVATE_'), 'page does not display private raw content')
  const density = await evaluate(`(() => {
    const fields = [...document.querySelectorAll('.context-inspector-card')];
    const rects = fields.map((field) => field.getBoundingClientRect());
    const firstGrid = document.querySelector('.context-inspector-cards').getBoundingClientRect();
    return { count: fields.length, columns: Math.abs(rects[0].top - rects[1].top) < 1 && rects[1].left >= rects[0].right,
      maxFieldHeight: Math.max(...rects.map((rect) => rect.height)), overviewHeight: firstGrid.height };
  })()`)
  assert(density.count === 14 && density.columns && density.maxFieldHeight <= 90 && density.overviewHeight <= 260,
    `compact two-column fields fit the workspace: ${JSON.stringify(density)}`)
  assert(await evaluate(`!document.querySelector('.context-inspector-table-scroll') && !document.querySelector('.context-inspector-overview .context-inspector-card small') && !!document.querySelector('.context-inspector-timeline-row')`),
    'session overview has no field explanations or single-request source table')
  const response = await harness.fetchJson(locator, '/sessions/inspector-full/context')
  assert(!JSON.stringify(response.body).includes('PRIVATE_') && !JSON.stringify(response.body).includes('systemPromptProjection'), 'endpoint excludes raw diagnostics')
  await captureThemePair('overview')
  failureStage = 'request-detail'
  await evaluate(`document.querySelector('.context-inspector-timeline-row').click()`)
  await harness.waitFor(() => evaluate(`!!document.querySelector('.context-inspector-table-scroll') && !!document.querySelector('.context-inspector-back')`), 10000, 'trajectory opens request detail')
  assert(await evaluate(`document.querySelector('.context-inspector-content').textContent.includes('5,000') && document.querySelector('.context-inspector-content').textContent.includes('5,100')`), 'trajectory detail preserves independent local and Provider counts')
  await captureThemePair('detail')
  await evaluate(`document.querySelector('.context-inspector-back').click()`)
  assert(await evaluate(`!!document.querySelector('.context-inspector-overview') && !document.querySelector('.context-inspector-table-scroll')`), 'request detail returns to session overview in the same workspace tab')
  await evaluate(`document.querySelector('.workspace-panel-collapse-action').click()`)
  await harness.waitFor(() => evaluate(`document.querySelector('.workspace-panel').classList.contains('fullscreen')`), 10000, 'native workspace fullscreen')
  assert(await evaluate(`!!document.querySelector('.workspace-panel.fullscreen .context-inspector-surface')`), 'Inspector follows native workspace fullscreen')
  await evaluate(`document.querySelector('.workspace-panel-collapse-action').click()`)
  await close()
  assert(await evaluate(`document.querySelector('.composer textarea').value === '保留的检查草稿'`), 'loaded conversation draft survives')
  assert(Math.abs(await evaluate(`document.querySelector('.messages').scrollTop`) - scroll) <= 1, 'chat scroll position survives')
  await evaluate(`document.querySelector('.context-usage').focus()`)
  // Native keyboard activation and the shared workspace close control.
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await harness.waitFor(() => evaluate(`!!document.querySelector('.context-inspector-surface')`), 10000, 'keyboard opens Inspector')
  await evaluate(`document.querySelector('.workspace-active-item.active .workspace-active-close').focus()`)
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await harness.waitFor(() => evaluate(`!document.querySelector('.context-inspector-surface')`), 10000, 'workspace keyboard closes Inspector')
  checks.push('native keyboard entry and shared tab close')
  failureStage = 'history-session-partial'
  await session('上下文缺失验收'); await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('部分数据')`), 10000, 'partial snapshot')
  assert(!await evaluate(`document.querySelector('.context-inspector-content').textContent.includes('5,100')`), 'switching sessions cannot leak prior Usage')
  await captureThemePair('partial'); await close()
  await draft(`请输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await harness.waitFor(() => evaluate(`!!document.querySelector('.composer-run-actions .stop')`), 10000, 'active Agent')
  await draft('运行中保留草稿'); await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('Agent 仍在运行')`), 10000, 'active status')
  await captureThemePair('active'); await close()
  assert(await evaluate(`!!document.querySelector('.composer-run-actions .stop') && document.querySelector('.composer textarea').value === '运行中保留草稿'`), 'navigation preserves active run and draft')
  const denied = await harness.fetchJson(locator, '/sessions/not-owned/context')
  assert(denied.status === 404, 'unknown session is denied')
  await writeFile(join(outRoot, 'result.json'), JSON.stringify({ ok: true, checks, screenshots, visualEvidence,
    states: ['composer', 'empty', 'overview', 'detail', 'partial', 'active'], themes: ['dark', 'light'],
    provider: 'isolated synthetic HTTP', fixtureCounts: true }, null, 2))
  console.log(JSON.stringify({ ok: true, checks, outRoot }))
} catch (error) {
  let diagnostic = null
  try {
    diagnostic = client ? await evaluate(`(() => ({theme:document.documentElement.getAttribute('data-ls-theme'),
      sessionRows:[...document.querySelectorAll('.session-item')].map(item=>({text:item.innerText,
        id:item.getAttribute('data-session-id'),html:item.outerHTML.slice(0,800)})),
      history:document.querySelector('.conversation-section')?.innerText?.slice(0,1600),
      activeSession:document.querySelector('.session-item.active')?.innerText,
      inspector:document.querySelector('.context-inspector-content')?.innerText?.slice(0,1600),
      surfaces:['.context-inspector-surface','.context-inspector-refresh','.context-inspector-timeline']
        .map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,found:false};
          const style=getComputedStyle(el),rect=el.getBoundingClientRect();return {selector,found:true,
            rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
            computed:{color:style.color,background:style.backgroundColor,radius:style.borderTopLeftRadius,
              fontSize:style.fontSize,overflow:style.overflow},html:el.outerHTML.slice(0,1200)}})}))()`)
      : null
    if (client) await shot('failure')
  } catch (diagnosticError) {
    diagnostic = { failure: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }
  }
  await mkdir(outRoot, { recursive: true })
  await writeFile(join(outRoot, 'result.json'), JSON.stringify({ ok: false, failureStage,
    error: error instanceof Error ? error.stack ?? error.message : String(error), checks, screenshots,
    visualEvidence, diagnostic }, null, 2))
  throw error
} finally {
  client?.close()
  if (electron?.exitCode === null) await harness.forceTerminate(electron)
  await provider.close()
  await harness.removeTemporaryRoot(root)
}
