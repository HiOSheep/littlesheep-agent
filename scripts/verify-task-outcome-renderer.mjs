import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 45_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-task-outcome-renderer-'))
const dataDir = join(root, 'data')
const chromiumDir = join(root, 'chromium')
const workspace = join(root, 'workspace')
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
const report = {
  version: 1,
  ok: false,
  executionLevel: 'real Electron Renderer + Main/Runner + local controlled HTTP Provider + real workspace Tools',
  root,
  cases: [],
  limits: [
    'The Provider is a deterministic local fixture, not a real Provider quality test.',
    'Renderer is driven through CDP DOM events; this is not native mouse or accessibility-device acceptance.',
    'The check proves the narrow explicit root-level text requirement contract only.',
  ],
}
let electron
let client

try {
  await mkdir(dataDir)
  await mkdir(chromiumDir)
  await mkdir(workspace)
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'fixture', models: ['slow-a'] }],
    agents: { defaults: { model: 'acceptance/slow-a', workspace, maxRecoveryAttempts: 1, maxModelCallsPerRun: 32 } },
  }))

  const port = await harness.reservePort()
  electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.desktopAction(locator, 'resize', { width: 1200, height: 900 })
  client = await harness.connectRenderer(port)
  const evaluate = (expression) => client.evaluate(expression)
  await harness.waitFor(async () => (await harness.fetchJson(locator, '/runtime/readiness')).body?.state === 'ready' || null,
    90_000, 'Runtime readiness')

  async function send(prompt, { expectOutcome = true } = {}) {
    const before = await evaluate(`document.querySelectorAll('.message.user').length`)
    await evaluate(`(() => { const input=document.querySelector('.composer textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`)
    await harness.waitFor(() => evaluate(`document.querySelector('.composer .send-round:not(.stop)')?.disabled === false || null`),
      30_000, 'enabled send button')
    await evaluate(`document.querySelector('.composer .send-round:not(.stop)').click()`)
    await harness.waitFor(async () => {
      await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined)
      return evaluate(`(() => { const turns=[...document.querySelectorAll('.assistant-turn')]; const last=turns.at(-1); return last?.classList.contains('done') && ${expectOutcome ? 'last.querySelector(".task-outcome-card")' : '!last.querySelector(".task-outcome-card")'} ? true : null })()`)
    }, 90_000, expectOutcome ? `Task Outcome card for ${prompt}` : `ordinary reply without a Task Outcome card for ${prompt}`)
    assert.ok(await evaluate(`document.querySelectorAll('.message.user').length > ${before}`), 'user request was not rendered')
    return evaluate(`(() => { const cards=document.querySelectorAll('.assistant-turn .task-outcome-card'); return cards.item(cards.length - 1)?.innerText ?? '' })()`)
  }

  const visibleCases = [
    { prompt: 'Create s2cc-passed.txt, content must be hello.', expected: 'passed', text: ['已验证通过', '已按明确的验收条件通过'] },
    { prompt: 'Create s2cc-failed.txt, content must be hello.', expected: 'failed', text: ['检查未通过', '文件内容与要求不一致'] },
    { prompt: 'Create s2cc-unchecked.txt, content must be hello.', expected: 'unverified', text: ['尚未验证', '尚未执行独立检查'] },
  ]

  for (const scenario of visibleCases) {
    const text = await send(scenario.prompt)
    for (const expectedText of scenario.text) assert.ok(text.includes(expectedText), `${scenario.expected} card omitted: ${expectedText}`)
    assert.ok(text.includes('执行：执行已结束'), `${scenario.expected} should show Runtime execution separately`)
    if (scenario.expected !== 'passed') {
      assert.ok(!text.includes('已按明确的验收条件通过'), `${scenario.expected} must not look like full acceptance`)
    }
    if (scenario.expected === 'passed') {
      assert.ok(text.includes('s2cc-passed.txt'), 'passed outcome must show its actual checked artifact')
      await evaluate(`(() => {
        const last=[...document.querySelectorAll('.assistant-turn')].at(-1)
        last?.querySelector('.task-outcome-evidence summary')?.click()
      })()`)
      const evidenceText = await evaluate(`([...document.querySelectorAll('.assistant-turn')].at(-1)?.querySelector('.task-outcome-card')?.innerText ?? '')`)
      assert.ok(evidenceText.includes('要求检查 · 通过'), 'passed outcome should expose its actual check evidence')
      assert.ok(evidenceText.includes('result.txt') || evidenceText.includes('s2cc-passed.txt'),
        'check evidence should use a safe workspace-relative resource')
      assert.ok(!evidenceText.includes(root), 'check evidence must not expose the absolute temporary workspace path')
    }
    const contents = await readdir(join(dataDir, 'execution-logs'))
    const logs = await Promise.all(contents.filter((name) => name.endsWith('.json')).map(async (name) =>
      JSON.parse(await readFile(join(dataDir, 'execution-logs', name), 'utf8'))))
    const log = logs.find((item) => item.inboundText === scenario.prompt)
    assert.ok(log?.taskOutcome, `Runtime did not persist Task Outcome for ${scenario.expected}`)
    assert.equal(log.taskOutcome.requirements[0]?.status, scenario.expected)
    assert.equal(log.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 1)
    assert.equal(log.toolInvocations.filter((item) => item.toolName === 'runtime_check_file_content' && item.status === 'succeeded').length,
      scenario.expected === 'unverified' ? 0 : 1)
    const expectedFile = scenario.expected === 'failed' ? 'goodbye' : 'hello'
    assert.equal(await readFile(join(workspace, scenario.prompt.match(/Create (\S+),/u)[1]), 'utf8'), expectedFile)
    report.cases.push({ prompt: scenario.prompt, oracle: scenario.expected, runtimeRequirement: log.taskOutcome.requirements[0].status,
      toolCalls: log.toolInvocations.map((item) => ({ tool: item.toolName, status: item.status })), visibleText: text })
  }

  const multiPrompt = 'Create s2ce-a.txt, content must be hello.\nCreate s2ce-b.txt, content must be world.'
  const multiText = await send(multiPrompt)
  assert.ok(multiText.includes('部分要求已通过，仍有未满足项'), 'T07 should show partial completion')
  assert.ok(multiText.includes('已验证通过'), 'T07 should show the passed requirement')
  assert.ok(multiText.includes('检查未通过'), 'T07 should show the failed requirement')
  assert.ok(multiText.includes('s2ce-a.txt') && multiText.includes('s2ce-b.txt'), 'T07 should list both actual files')
  assert.ok(!multiText.includes('已按明确的验收条件通过'), 'T07 partial outcome must not look fully complete')
  const multiLogs = await Promise.all((await readdir(join(dataDir, 'execution-logs')))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(dataDir, 'execution-logs', name), 'utf8'))))
  const multiLog = multiLogs.find((item) => item.inboundText === multiPrompt)
  assert.ok(multiLog?.taskOutcome, 'Runtime did not persist the T07 Task Outcome')
  assert.equal(multiLog.taskOutcome.requirementInventory, 'complete')
  assert.equal(multiLog.taskOutcome.status, 'partially_completed')
  assert.deepEqual(multiLog.taskOutcome.requirements.map((item) => item.status), ['passed', 'failed'])
  assert.equal(multiLog.taskOutcome.requirements[0].sourceMessageId, multiLog.taskOutcome.requirements[1].sourceMessageId,
    'both requirements must trace to the same original user message')
  assert.deepEqual(multiLog.taskOutcome.artifacts.map((item) => [item.resourceRef, item.verification]), [
    ['workspace:s2ce-a.txt', 'passed'],
    ['workspace:s2ce-b.txt', 'failed'],
  ])
  assert.equal(multiLog.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 2)
  assert.equal(multiLog.toolInvocations.filter((item) => item.toolName === 'runtime_check_file_content' && item.status === 'succeeded').length, 2)
  assert.equal(await readFile(join(workspace, 's2ce-a.txt'), 'utf8'), 'hello')
  assert.equal(await readFile(join(workspace, 's2ce-b.txt'), 'utf8'), 'goodbye')
  report.cases.push({
    prompt: multiPrompt,
    oracle: ['passed', 'failed'],
    runtimeRequirement: multiLog.taskOutcome.requirements.map((item) => item.status),
    runtimeOutcome: multiLog.taskOutcome.status,
    toolCalls: multiLog.toolInvocations.map((item) => ({ tool: item.toolName, status: item.status })),
    visibleText: multiText,
  })

  const cardsBeforeChat = await evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length`)
  await send('Hi, can you explain what a checkpoint is?', { expectOutcome: false })
  assert.equal(await evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length`), cardsBeforeChat,
    'ordinary conversation should not add an empty Task Outcome card')

  const countBeforeReload = await evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length`)
  assert.equal(countBeforeReload, 4, 'one card per task turn before reload; ordinary conversation stays lightweight')
  const origin = await evaluate('performance.timeOrigin')
  await client.send('Page.reload')
  await harness.waitFor(() => evaluate(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && document.querySelectorAll('.assistant-turn.done').length >= 5 || null`).catch(() => null),
    60_000, 'session history after Renderer reload')
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length === 4 || null`),
    45_000, 'one persisted Task Outcome card per historical run')
  const reloaded = await evaluate(`([...document.querySelectorAll('.assistant-turn .task-outcome-card')].map((card) => card.innerText))`)
  assert.equal(reloaded.length, 4)
  assert.ok(reloaded[0].includes('已按明确的验收条件通过'))
  assert.ok(reloaded[1].includes('检查未通过'))
  assert.ok(reloaded[2].includes('尚未验证'))
  assert.ok(reloaded[3].includes('部分要求已通过，仍有未满足项'))
  assert.ok(reloaded[3].includes('检查未通过'))
  report.checks = [
    'real Main/Runner wrote actual temporary workspace files through Tools',
    'the independently checked wrong file is shown as failed while execution remained successful',
    'the correct file shows passed only after the Runtime content checker ran',
    'expanded check evidence shows the bounded workspace-relative file reference without its absolute path',
    'a successful write without an independent check remains unverified',
    'two explicit requirements from one user message retain independent passed/failed evidence and render as partial completion',
    'ordinary chat remains readable without an empty Task Outcome card',
    'Renderer reload reuses one durable Task Outcome card per Run without duplicate cards',
  ]
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'task-outcome-renderer.png'), Buffer.from(screenshot.data, 'base64'))
  report.ok = true
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.providerRequests = provider.requests.map((request) => ({
    requestIndex: request.requestIndex,
    model: request.model,
    tools: request.tools,
    responseSummary: request.responseSummary,
    responseToolCallIds: request.responseToolCallIds,
  }))
  if (client) {
    report.failureUi = await client.evaluate(`({
      bodyText: document.body.innerText.slice(-4000),
      turns: [...document.querySelectorAll('.assistant-turn')].slice(-2).map(turn => ({
        classes: turn.className,
        text: turn.innerText.slice(-1600),
      })),
    })`).catch((captureError) => ({ captureError: String(captureError) }))
  }
  throw error
} finally {
  client?.close()
  if (electron) await harness.forceTerminate(electron).catch(() => undefined)
  await provider.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify({ ok: report.ok, root, cases: report.cases.length, checks: report.checks ?? [] })}\n`)
}
