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
let electron, client
const checks = []
function assert(condition, label) { if (!condition) throw new Error(label); checks.push(label) }
const evaluate = (expression) => client.evaluate(expression)
async function shot(name) {
  const image = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(outRoot, `${name}.png`), Buffer.from(image.data, 'base64'))
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
  await evaluate(`document.querySelector('.context-inspector-back').click()`)
  await harness.waitFor(() => evaluate(`!document.querySelector('.context-inspector-surface')`), 10000, 'Inspector closes')
  await delay(250)
}
async function session(title) {
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
  return { id, title, createdAt: Date.now(), lastMessageAt: Date.now(), mode: 'research', scope: 'standalone' }
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
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator); await harness.desktopAction(locator, 'resize', { width: 1180, height: 800 })
  // Find the renderer through the port passed to the process.
  const debuggingArg = electron.spawnargs.find((arg) => arg.startsWith('--remote-debugging-port='))
  client = await harness.connectRenderer(Number(debuggingArg.split('=')[1]))
  await harness.waitFor(() => evaluate(`!!document.querySelector('.composer textarea')`), 90000, 'composer')
  await draft('新会话草稿')
  const initialSessions = (await harness.fetchJson(locator, '/sessions')).body.sessions.length
  await open(); await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-empty')?.textContent.includes('尚未发送')`), 10000, 'new conversation empty state')
  await shot('empty'); await close()
  assert(await evaluate(`document.querySelector('.composer textarea').value === '新会话草稿'`), 'new conversation draft survives')
  assert((await harness.fetchJson(locator, '/sessions')).body.sessions.length === initialSessions, 'opening does not create a session')
  await session('上下文完整验收'); await draft('保留的检查草稿')
  await evaluate(`document.querySelector('.messages').scrollTop = 160`); await delay(150)
  const scroll = await evaluate(`document.querySelector('.messages').scrollTop`)
  await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('5,100')`), 10000, 'Provider fixture count')
  const content = await evaluate(`document.querySelector('.context-inspector-content').textContent`)
  assert(content.includes('5,000') && content.includes('5,100'), 'local and Provider ledgers stay separate')
  assert(content.includes('不可用') && content.includes('128,000'), 'missing cache write and model window are explicit')
  assert(!content.includes('PRIVATE_'), 'page does not display private raw content')
  const response = await harness.fetchJson(locator, '/sessions/inspector-full/context')
  assert(!JSON.stringify(response.body).includes('PRIVATE_') && !JSON.stringify(response.body).includes('systemPromptProjection'), 'endpoint excludes raw diagnostics')
  await shot('overview')
  await close()
  assert(await evaluate(`document.querySelector('.composer textarea').value === '保留的检查草稿'`), 'loaded conversation draft survives')
  assert(Math.abs(await evaluate(`document.querySelector('.messages').scrollTop`) - scroll) <= 1, 'chat scroll position survives')
  assert(await evaluate(`document.activeElement === document.querySelector('.context-usage')`), `focus returns to ring: ${await evaluate(`document.activeElement?.tagName`)}`)
  // Native keyboard activation and Escape close.
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await harness.waitFor(() => evaluate(`!!document.querySelector('.context-inspector-surface')`), 10000, 'keyboard opens Inspector')
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await harness.waitFor(() => evaluate(`!document.querySelector('.context-inspector-surface')`), 10000, 'Escape returns to chat')
  checks.push('native Enter and Escape navigation')
  await session('上下文缺失验收'); await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('部分数据')`), 10000, 'partial snapshot')
  assert(!await evaluate(`document.querySelector('.context-inspector-content').textContent.includes('5,100')`), 'switching sessions cannot leak prior Usage')
  await shot('partial'); await close()
  await draft(`请输出验收文档：${LONG_MARKDOWN_MARKER}`)
  await evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await harness.waitFor(() => evaluate(`!!document.querySelector('.composer-run-actions .stop')`), 10000, 'active Agent')
  await draft('运行中保留草稿'); await open()
  await harness.waitFor(() => evaluate(`document.querySelector('.context-inspector-content').textContent.includes('Agent 仍在运行')`), 10000, 'active status')
  await shot('active'); await close()
  assert(await evaluate(`!!document.querySelector('.composer-run-actions .stop') && document.querySelector('.composer textarea').value === '运行中保留草稿'`), 'navigation preserves active run and draft')
  const denied = await harness.fetchJson(locator, '/sessions/not-owned/context')
  assert(denied.status === 404, 'unknown session is denied')
  await writeFile(join(outRoot, 'result.json'), JSON.stringify({ ok: true, checks, evidence: ['empty.png', 'overview.png', 'partial.png', 'active.png'], provider: 'isolated synthetic HTTP', fixtureCounts: true }, null, 2))
  console.log(JSON.stringify({ ok: true, checks, outRoot }))
} finally {
  client?.close()
  if (electron?.exitCode === null) await harness.forceTerminate(electron)
  await provider.close()
  await harness.removeTemporaryRoot(root)
}
