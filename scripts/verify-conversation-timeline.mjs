import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 45_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-conversation-timeline-'))
const dataDir = join(root, 'data')
const chromiumDir = join(root, 'chromium')
// Deliberately missing: Main must prepare this user-selected workspace before
// freezing its permission snapshot, instead of letting every file tool fail.
const workspace = join(root, 'new workspace')
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 60, streamChunkCharacters: 8 })
let electron, client
const report = { ok: false, root, checks: [], limits: ['Local HTTP Provider fixture; does not prove external model task quality or OS Shell isolation.'] }
try {
  await mkdir(dataDir)
  await mkdir(chromiumDir)
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'fixture', models: ['slow-a'] }],
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
  await evaluate(`(() => { const t=document.querySelector('.composer textarea'); t.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'请创建、读取并修改文件 LS-CONVERSATION-TIMELINE'); t.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`)
  await harness.waitFor(() => evaluate(`document.querySelector('.composer .send-round:not(.stop)')?.disabled === false || null`), 30_000, 'send enabled')
  await evaluate(`document.querySelector('.composer .send-round:not(.stop)').click()`)
  const seen = new Set()
  let prior = []
  const snapshots = []
  await harness.waitFor(async () => {
    await client.send('Page.captureScreenshot', { format: 'png' })
    const snapshot = await evaluate(`(() => { const turn=[...document.querySelectorAll('.assistant-turn')].at(-1); if(!turn)return null; return {status:turn.className,
      prose:[...turn.querySelectorAll('.agent-transcript-prose,.assistant-final')].map(e=>e.innerText),
      approval:!!document.querySelector('.approval-prompt:not(.full-access-warning)'),
      overflow:document.querySelector('.messages').scrollWidth>document.querySelector('.messages').clientWidth+1}; })()`)
    if (!snapshot) return null
    assert.equal(snapshot.approval, false, 'native workspace operations unexpectedly requested approval')
    assert.equal(snapshot.overflow, false, 'conversation overflowed horizontally')
    const combined = snapshot.prose.join('\n')
    for (const text of prior) assert.ok(combined.includes(text), `already displayed text disappeared: ${text}`)
    for (const text of ['我先创建文件，再读取并修改它。', '文件已创建，我现在检查原文。', '读取完成，接下来修改内容。']) if (combined.includes(text)) seen.add(text)
    prior = [...seen]
    snapshots.push(snapshot)
    return snapshot.status.includes('done') && combined.includes('TIMELINE-DONE') ? snapshot : null
  }, 90_000, 'ordered native file task completion')
  assert.equal(seen.size, 3)
  const settledProse = await evaluate(`document.querySelector('.assistant-turn.done').innerText`)
  for (const text of seen) assert.equal(settledProse.split(text).length - 1, 1, 'live settlement duplicated a progress paragraph')
  assert.equal(settledProse.includes('此段生成已中止'), false, 'successful tool task acquired a spurious aborted preview')
  assert.equal(await readFile(join(workspace, 'timeline.txt'), 'utf8'), 'after\n')
  const logFiles = await readdir(join(dataDir, 'execution-logs'))
  const logs = await Promise.all(logFiles.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(dataDir, 'execution-logs', name), 'utf8'))))
  const log = logs.find((item) => item.toolInvocations?.some((tool) => tool.callId === 'timeline-edit'))
  assert.ok(log)
  assert.equal(log.toolInvocations.length, 3)
  assert.ok(log.toolInvocations.every((tool) => tool.status === 'succeeded' && tool.approval.required === false))
  assert.deepEqual(log.conversationTranscript.map((entry) => entry.kind), ['text', 'tool', 'text', 'tool', 'text', 'tool', 'text'])
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'timeline.png'), Buffer.from(shot.data, 'base64'))
  report.checks.push('missing workspace prepared; native create/read/edit completed without approval; all prose stayed visible; persisted order matches')
  await harness.desktopAction(locator, 'resize', {width:1200,height:1200})
  await new Promise(resolve=>setTimeout(resolve,400))
  await evaluate(`document.querySelector('.messages').scrollTop=1e9`)
  await new Promise(resolve=>setTimeout(resolve,250))
  await evaluate(`(()=>{const row=[...document.querySelectorAll('.agent-tool-row')].find(row=>row.textContent.includes('读取'));if(!row)throw Error('missing read row');row.click()})()`)
  await new Promise(resolve=>setTimeout(resolve,400))
  await client.send('Page.captureScreenshot',{format:'png'})
  const buttonProbe=await evaluate(`(()=>{const m=document.querySelector('.messages');return {gap:m.scrollHeight-m.clientHeight-m.scrollTop,scrollHeight:m.scrollHeight,clientHeight:m.clientHeight,button:Boolean(document.querySelector('.chat-jump-to-latest')),motion:document.querySelector('.chat-jump-controls')?.getAttribute('data-motion')}})()`)
  process.stdout.write(JSON.stringify({buttonProbe})+'\n')
  assert.ok(buttonProbe.gap<72,'fixture must be near the bottom')
  assert.equal(buttonProbe.button,false,'opening a short detail at the bottom must not offer a jump')
  report.checks.push('opening tool detail at bottom without overflow does not show jump button')
  await harness.desktopAction(locator, 'resize', { width: 1200, height: 820 })
  const timeOrigin = await evaluate('performance.timeOrigin')
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*/sessions/*/messages*', requestStage: 'Response' }] })
  const pausedFrom = client.events.length
  await client.send('Page.reload')
  const pausedHistory = await harness.waitFor(() => client.events.slice(pausedFrom).find(event => event.method === 'Fetch.requestPaused'), 45_000, 'paused history response')
  await harness.waitFor(() => evaluate(`performance.timeOrigin !== ${timeOrigin} && Boolean(document.querySelector('.history-loading') && document.querySelector('.session-item.active')) || null`).catch(() => null), 45_000, 'pending restored history')
  await evaluate(`document.querySelector('.session-item.active').click()`)
  await client.send('Fetch.continueRequest', { requestId: pausedHistory.params.requestId })
  await client.send('Fetch.disable')
  await harness.waitFor(() => evaluate(`performance.timeOrigin !== ${timeOrigin} && document.readyState === 'complete' && document.querySelector('.assistant-turn.done')?.innerText.includes('TIMELINE-DONE') || null`).catch(() => null), 45_000, 'history reload')
  const reloaded = await evaluate(`document.querySelector('.assistant-turn.done').innerText`)
  for (const text of seen) assert.equal(reloaded.split(text).length - 1, 1, 'history lost or duplicated a progress paragraph')
  report.checks.push('renderer reload preserves each paragraph exactly once; reselecting an active session does not cancel its pending history')
  report.snapshots = snapshots
  report.ok = true
} finally {
  client?.close()
  if (electron) await harness.forceTerminate(electron).catch(() => undefined)
  await provider.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify({ ok: report.ok, root, checks: report.checks })}\n`)
}
