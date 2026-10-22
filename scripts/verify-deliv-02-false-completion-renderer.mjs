#!/usr/bin/env node
// R4-C C2/C3: real-Electron regression for the delivery-consistency contract.
//
// Runs the real Main/Runner/Renderer against a deterministic local Provider and
// checks that the model's natural-language claim and the authoritative Runtime
// Task Outcome are displayed as separate facts:
// - wrong file + confident completion claim -> explicit "未验收", never a pass;
// - independent check passing -> "已验证通过";
// - correct file without independent check -> "尚未验证", never a pass;
// - partial requirements -> both passed and failed requirements, never full pass;
// - permission denial / tool execution failure -> unresolved, never a pass;
// - ordinary chat stays lightweight;
// - reload, Electron restart and session switching preserve the same statuses
//   and the model's verbatim reply.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import {
  DELIV_02_COMPLETION_CLAIM,
  DELIV_02_DENIED_PROMPT,
  DELIV_02_PROMPT,
  DELIV_02_TOOL_ERROR_PROMPT,
  ORDINARY_CHAT_PROMPT,
  SECOND_SESSION_PROMPT,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 45_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-deliv-02-claim-'))
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
  checks: [],
  limits: [
    'The Provider is a deterministic local fixture, not a real Provider quality test.',
    'Renderer is driven through CDP DOM events; this is not native mouse or accessibility-device acceptance.',
    'The narrow production parser covers only a fixed file-content request; these cases prove the accepted/failed/unverified/unknown/blocked paths, not general task extraction.',
  ],
}
let electron
let client

function evaluate(expression) {
  assert.ok(client, 'Renderer CDP client is not connected')
  return client.evaluate(expression)
}

const TURN_VIEW = `(() => {
  const turn=[...document.querySelectorAll('.assistant-turn')].at(-1)
  const reply=turn?.querySelector('.assistant-final > .markdown')
  const card=turn?.querySelector('.task-outcome-card')
  const badge=card?.querySelector('.task-outcome-badge')
  return {
    replyText: reply?.innerText ?? null,
    cardText: card?.innerText ?? null,
    cardClassName: card?.className ?? null,
    cardRole: card?.getAttribute('role') ?? null,
    cardAcceptance: card?.getAttribute('data-acceptance') ?? null,
    badgeClassName: badge?.className ?? null,
    replyBeforeCard: reply && card ? Boolean(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
  }
})()`

const TURNS_SNAPSHOT = `([...document.querySelectorAll('.assistant-turn')].map((turn) => ({
  reply: turn.querySelector('.assistant-final > .markdown')?.innerText ?? null,
  card: turn.querySelector('.task-outcome-card')?.innerText ?? null,
  cardRole: turn.querySelector('.task-outcome-card')?.getAttribute('role') ?? null,
})))`

async function launch() {
  const port = await harness.reservePort()
  const processHandle = await harness.startElectron({ dataDir, chromiumDir, debuggingPort: port, logPath: join(root, 'electron.log') })
  const locator = await harness.waitForLocator(dataDir, processHandle.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.desktopAction(locator, 'resize', { width: 1200, height: 900 })
  const cdp = await harness.connectRenderer(port)
  await harness.waitFor(async () => (await harness.fetchJson(locator, '/runtime/readiness')).body?.state === 'ready' || null,
    90_000, 'Runtime readiness')
  return { processHandle, locator, cdp }
}

async function waitForTurnDone({ expectCard }) {
  const cardCheck = expectCard
    ? `if (!card) return null; return true`
    : `if (card) return null; return true`
  return harness.waitFor(async () => {
    await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined)
    return evaluate(`(() => {
      const turns=[...document.querySelectorAll('.assistant-turn')]
      const last=turns.at(-1)
      if (!last || !last.classList.contains('done')) return null
      const card=last.querySelector('.task-outcome-card')
      ${cardCheck}
    })()`)
  }, 90_000, expectCard ? 'settled Task Outcome card' : 'ordinary settled reply without a card')
}

async function sendPrompt(prompt, { expectCard = true } = {}) {
  const before = await evaluate(`document.querySelectorAll('.message.user').length`)
  await evaluate(`(() => { const input=document.querySelector('.composer textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(prompt)}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`)
  await harness.waitFor(() => evaluate(`document.querySelector('.composer .send-round:not(.stop)')?.disabled === false || null`), 30_000, 'enabled send button')
  await evaluate(`document.querySelector('.composer .send-round:not(.stop)').click()`)
  await waitForTurnDone({ expectCard })
  assert.ok(await evaluate(`document.querySelectorAll('.message.user').length > ${before}`), 'user request was not rendered')
  return evaluate(TURN_VIEW)
}

async function readLogFor(prompt) {
  const contents = await readdir(join(dataDir, 'execution-logs'))
  const logs = await Promise.all(contents.filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(dataDir, 'execution-logs', name), 'utf8'))))
  const log = logs.find((item) => item.inboundText === prompt)
  assert.ok(log, `Runtime did not persist an execution log for: ${prompt}`)
  return log
}

function assertNoVerifiedClaim(view, label) {
  assert.ok(!view.cardText?.includes('已验证通过'), `${label} must not render 已验证通过; card=${view.cardText}`)
  assert.ok(!view.cardText?.includes('已按明确的验收条件通过'), `${label} must not render full acceptance; card=${view.cardText}`)
}

function assertUnverifiedCard(view, label) {
  assert.match(view.cardClassName ?? '', /is-unverified/u, `${label} must carry the unverified card state`)
  assert.equal(view.cardAcceptance, 'unverified', `${label} must expose data-acceptance=unverified`)
  assert.equal(view.cardRole, 'status', `${label} must be announced as a status`)
  assert.match(view.badgeClassName ?? '', /unverified/u, `${label} must not use the muted badge`)
  assertNoVerifiedClaim(view, label)
}

async function reloadAndSnapshot() {
  const before = await evaluate(TURNS_SNAPSHOT)
  const origin = await evaluate('performance.timeOrigin')
  await client.send('Page.reload')
  await harness.waitFor(() => evaluate(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && document.querySelectorAll('.assistant-turn.done').length >= ${before.length} || null`).catch(() => null),
    60_000, 'session history after Renderer reload')
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length === ${before.filter((item) => item.card).length} || null`),
    45_000, 'persisted Task Outcome cards after reload')
  return { before, after: await evaluate(TURNS_SNAPSHOT) }
}

try {
  await mkdir(dataDir)
  await mkdir(chromiumDir)
  await mkdir(workspace)
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({
    version: 1,
    providers: [{ id: 'acceptance', name: 'Acceptance', baseURL: provider.baseURL, apiKey: 'fixture', models: ['slow-a'] }],
    agents: { defaults: { model: 'acceptance/slow-a', workspace, maxRecoveryAttempts: 1, maxModelCallsPerRun: 32 } },
  }))

  let launched = await launch()
  electron = launched.processHandle
  client = launched.cdp

  // 1. DELIV-02 negative: wrong file + confident claim, no independent check.
  const deliv = await sendPrompt(DELIV_02_PROMPT)
  const delivLog = await readLogFor(DELIV_02_PROMPT)
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'goodbye', 'the wrong file bytes must exist on disk')
  assert.equal(deliv.replyText?.trim(), DELIV_02_COMPLETION_CLAIM, 'the model completion claim must be preserved verbatim')
  assert.equal(deliv.replyBeforeCard, true, 'the reply must precede the acceptance card')
  assertUnverifiedCard(deliv, 'DELIV-02')
  for (const required of ['未验收', '模型最终回复', '不构成验收通过', '验收清单无法确认', '无法确认完整的要求清单']) {
    assert.ok(deliv.cardText?.includes(required), `DELIV-02 card omitted: ${required}; card=${deliv.cardText}`)
  }
  assert.equal(delivLog.reply, DELIV_02_COMPLETION_CLAIM, 'Runtime must preserve the model completion claim verbatim')
  assert.equal(delivLog.taskOutcome?.execution?.status, 'completed', 'execution itself completed; only acceptance is unresolved')
  assert.equal(delivLog.taskOutcome?.status, 'unknown', 'Runtime must not accept the unsupported claim')
  assert.equal(delivLog.taskOutcome?.requirementInventory, 'unknown', 'the narrow parser must leave the inventory unknown')
  assert.equal(delivLog.taskOutcome?.requirements?.length, 0, 'no recognized requirements are expected')
  assert.equal(delivLog.taskOutcome?.artifacts?.length, 0, 'no verified artifacts are expected')
  assert.equal(delivLog.taskOutcome?.evidence?.length, 0, 'no acceptance evidence is expected')
  assert.ok(delivLog.taskOutcome?.remaining?.some((item) => item.reasonCode === 'requirements_unknown'), 'remaining must name the unknown inventory')
  assert.equal(delivLog.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 1, 'exactly one successful write')
  assert.equal(delivLog.toolInvocations.filter((item) => item.toolName === 'runtime_check_file_content').length, 0, 'no independent Runtime check may run')
  report.cases.push({ case: 'deliv-02-false-completion', visible: deliv, runtime: {
    outcomeStatus: delivLog.taskOutcome.status, requirementInventory: delivLog.taskOutcome.requirementInventory,
    executionStatus: delivLog.taskOutcome.execution.status, requirements: delivLog.taskOutcome.requirements.length,
    artifacts: delivLog.taskOutcome.artifacts.length, evidence: delivLog.taskOutcome.evidence.length,
    writeExecutions: 1, checkerExecutions: 0, actualFile: 'goodbye',
  } })

  // 2. Positive control: independently checked correct file.
  const passedPrompt = 'Create s2cc-passed.txt, content must be hello.'
  const passed = await sendPrompt(passedPrompt)
  const passedLog = await readLogFor(passedPrompt)
  assert.ok(passed.cardText?.includes('已验证通过'), 'checked success must show 已验证通过')
  assert.ok(passed.cardText?.includes('已按明确的验收条件通过'), 'checked success must show full acceptance')
  assert.equal(passed.cardAcceptance, 'completed', 'checked success must be data-acceptance=completed')
  assert.equal(passedLog.taskOutcome?.requirements?.[0]?.status, 'passed', 'Runtime must record the passed requirement')
  assert.equal(await readFile(join(workspace, 's2cc-passed.txt'), 'utf8'), 'hello', 'the checked file must exist')
  report.cases.push({ case: 'independently-checked-success', visible: passed, runtime: { requirement: passedLog.taskOutcome.requirements[0].status } })

  // 3. Correct output but no independent verification: unverified, never passed.
  const uncheckedPrompt = 'Create s2cc-unchecked.txt, content must be hello.'
  const unchecked = await sendPrompt(uncheckedPrompt)
  const uncheckedLog = await readLogFor(uncheckedPrompt)
  assertUnverifiedCard(unchecked, 'unchecked write')
  assert.ok(unchecked.cardText?.includes('尚未验证'), 'unchecked write must show 尚未验证')
  assert.ok(unchecked.cardText?.includes('尚未执行独立检查'), 'unchecked write must explain the missing check')
  assert.equal(uncheckedLog.taskOutcome?.requirements?.[0]?.status, 'unverified', 'Runtime must record unverified')
  assert.equal(await readFile(join(workspace, 's2cc-unchecked.txt'), 'utf8'), 'hello', 'the unchecked file must exist')
  report.cases.push({ case: 'correct-output-no-independent-check', visible: unchecked, runtime: { requirement: uncheckedLog.taskOutcome.requirements[0].status } })

  // 4. Partial requirements: passed + failed together, never full acceptance.
  const partialPrompt = 'Create s2ce-a.txt, content must be hello.\nCreate s2ce-b.txt, content must be world.'
  const partial = await sendPrompt(partialPrompt)
  const partialLog = await readLogFor(partialPrompt)
  assert.ok(partial.cardText?.includes('部分要求已通过，仍有未满足项'), 'partial outcome must be labelled as partial')
  assert.ok(partial.cardText?.includes('已验证通过'), 'partial outcome must show the passed requirement')
  assert.ok(partial.cardText?.includes('检查未通过'), 'partial outcome must show the failed requirement')
  assert.ok(!partial.cardText?.includes('已按明确的验收条件通过'), 'partial outcome must not render full acceptance')
  assert.equal(partialLog.taskOutcome?.status, 'partially_completed', 'Runtime must settle partial completion')
  assert.deepEqual(partialLog.taskOutcome?.requirements?.map((item) => item.status), ['passed', 'failed'], 'both requirement outcomes must persist')
  report.cases.push({ case: 'partial-requirements', visible: partial, runtime: { status: partialLog.taskOutcome.status, requirements: partialLog.taskOutcome.requirements.map((item) => item.status) } })

  // 5. Permission denial: the write must not be shown as accepted.
  const denied = await sendPrompt(DELIV_02_DENIED_PROMPT)
  const deniedLog = await readLogFor(DELIV_02_DENIED_PROMPT)
  assertNoVerifiedClaim(denied, 'permission denial')
  assert.notEqual(deniedLog.taskOutcome?.status, 'completed', 'a denied write cannot complete the task')
  assert.equal(deniedLog.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 0, 'no write may succeed outside the workspace')
  assert.equal(existsSync(join(workspace, '..', 'deliv-02-outside.txt')), false, 'the denied file must not be created outside the workspace')
  assert.ok(denied.cardText?.includes('尚未验证') || denied.cardText?.includes('未验收') || denied.cardText?.includes('任务受到阻断'), 'denial must be shown as unverified or blocked')
  report.cases.push({ case: 'permission-denied-write', visible: denied, runtime: {
    outcomeStatus: deniedLog.taskOutcome?.status ?? null, invocations: deniedLog.toolInvocations.map((item) => ({ tool: item.toolName, status: item.status })),
  } })

  // 6. Tool execution failure (invalid write input): unresolved, never accepted.
  const error = await sendPrompt(DELIV_02_TOOL_ERROR_PROMPT)
  const errorLog = await readLogFor(DELIV_02_TOOL_ERROR_PROMPT)
  assertNoVerifiedClaim(error, 'tool execution failure')
  assert.notEqual(errorLog.taskOutcome?.status, 'completed', 'a failed tool call cannot complete the task')
  assert.equal(errorLog.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 0, 'no write may succeed')
  assert.ok(errorLog.toolInvocations.some((item) => item.toolName === 'write' && item.status !== 'succeeded'), 'the failed write invocation must be recorded')
  assert.ok(error.cardText?.includes('尚未验证') || error.cardText?.includes('未验收') || error.cardText?.includes('检查受阻'), 'tool failure must be shown as unverified or blocked')
  report.cases.push({ case: 'tool-execution-failure', visible: error, runtime: {
    outcomeStatus: errorLog.taskOutcome?.status ?? null, invocations: errorLog.toolInvocations.map((item) => ({ tool: item.toolName, status: item.status })),
  } })

  // 7. Ordinary conversation stays lightweight.
  const cardsBeforeChat = await evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length`)
  const chat = await sendPrompt(ORDINARY_CHAT_PROMPT, { expectCard: false })
  assert.equal(chat.cardText, null, 'ordinary chat must not render an acceptance card')
  assert.equal(await evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length`), cardsBeforeChat,
    'ordinary conversation must not add an empty Task Outcome card')

  // 8. Reload: every status and reply survives.
  const reloaded = await reloadAndSnapshot()
  assert.equal(reloaded.after.length, reloaded.before.length, 'reload must preserve the turn count')
  assert.deepEqual(reloaded.after.map((item) => item.card), reloaded.before.map((item) => item.card), 'reload must preserve every card text')
  assert.deepEqual(reloaded.after.map((item) => item.reply), reloaded.before.map((item) => item.reply), 'reload must preserve every reply verbatim')
  assert.ok(reloaded.after.some((item) => item.reply?.trim() === DELIV_02_COMPLETION_CLAIM), 'reload must preserve the completion claim')
  assert.ok(reloaded.after.some((item) => item.card?.includes('未验收')), 'reload must preserve the unverified acceptance')
  assert.ok(reloaded.after.every((item) => !item.card || item.cardRole === 'status'), 'every persisted acceptance card must stay a status')

  // 9. Full Electron restart: the same durable history comes back.
  client?.close()
  await harness.forceTerminate(electron)
  launched = await launch()
  electron = launched.processHandle
  client = launched.cdp
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length === ${reloaded.after.filter((item) => item.card).length} || null`),
    60_000, 'persisted Task Outcome cards after Electron restart')
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn.done').length >= ${reloaded.after.length} || null`),
    60_000, 'session history after Electron restart')
  const restarted = await evaluate(TURNS_SNAPSHOT)
  assert.deepEqual(restarted.map((item) => item.card), reloaded.after.map((item) => item.card), 'restart must preserve every card text')
  assert.ok(restarted.some((item) => item.reply?.trim() === DELIV_02_COMPLETION_CLAIM), 'restart must preserve the completion claim')

  // 10. Session switching: leave the task session, come back, and compare.
  await evaluate(`document.querySelector('.sidebar-nav-button[aria-label="新对话"]')?.click()`)
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn').length === 0 || null`), 30_000, 'new empty conversation')
  await sendPrompt(SECOND_SESSION_PROMPT, { expectCard: false })
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.session-item').length >= 2 || null`), 30_000, 'two sessions in the sidebar')
  const sessionCount = await evaluate(`document.querySelectorAll('.session-item').length`)
  let taskSessionIndex = -1
  let ordinarySessionIndex = -1
  for (let index = 0; index < sessionCount; index += 1) {
    await evaluate(`document.querySelectorAll('.session-item')[${index}]?.click()`)
    await harness.waitFor(() => evaluate(`document.querySelectorAll('.session-item.active')?.length === 1 || null`), 15_000, `session ${index} active`)
    await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn.done').length > 0 || null`), 30_000, `session ${index} history`)
    const body = await evaluate(`document.body.innerText`)
    if (body.includes(DELIV_02_COMPLETION_CLAIM) && body.includes('未验收')) taskSessionIndex = index
    else if (body.includes('What is a checkpoint?')) ordinarySessionIndex = index
  }
  assert.ok(taskSessionIndex >= 0, 'the task session must be reachable from the sidebar')
  assert.ok(ordinarySessionIndex >= 0, 'the ordinary second session must be reachable from the sidebar')
  await evaluate(`document.querySelectorAll('.session-item')[${taskSessionIndex}]?.click()`)
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length === ${reloaded.after.filter((item) => item.card).length} || null`),
    30_000, 'task session cards after switching back')
  const switchedBack = await evaluate(TURNS_SNAPSHOT)
  assert.ok(switchedBack.some((item) => item.reply?.trim() === DELIV_02_COMPLETION_CLAIM), 'switching sessions back must preserve the completion claim')
  assert.deepEqual(switchedBack.map((item) => item.card), reloaded.after.map((item) => item.card), 'switching sessions must preserve every card text')

  report.checks = [
    'wrong file + confident claim renders explicit 未验收 and the claim disclaimer, never 已验证通过',
    'Runtime keeps outcome=unknown, inventory=unknown, zero acceptance evidence, and the verdict text verbatim',
    'independently checked correct file renders 已验证通过 / full acceptance',
    'correct file without an independent check renders 尚未验证 and is data-acceptance=unverified',
    'partial requirements keep passed and failed requirements visible and never claim full acceptance',
    'permission denial and tool execution failure stay unresolved, with no successful write and no pass claim',
    'ordinary chat adds no empty Task Outcome card',
    'Renderer reload preserves every reply byte-for-byte and every card/status',
    'full Electron restart reloads the same durable history and statuses',
    'session switching restores the task card/reply and keeps the ordinary session separate',
  ]
  report.ok = true
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'deliv-02-claim-consistency.png'), Buffer.from(screenshot.data, 'base64'))
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.providerRequests = provider.requests.map((request) => ({
    requestIndex: request.requestIndex, responseSummary: request.responseSummary, responseToolCallIds: request.responseToolCallIds,
  }))
  if (client) {
    report.failureUi = await client.evaluate(`({
      bodyText: document.body.innerText.slice(-4000),
      turns: [...document.querySelectorAll('.assistant-turn')].slice(-2).map(turn => ({ classes: turn.className, text: turn.innerText.slice(-1600) })),
    })`).catch((captureError) => ({ captureError: String(captureError) }))
  }
  throw error
} finally {
  client?.close()
  if (electron) await harness.forceTerminate(electron).catch(() => undefined)
  await provider.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify({ ok: report.ok, root, cases: report.cases.length, checks: report.checks })}\n`)
}
