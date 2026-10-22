#!/usr/bin/env node
// R4-C C0/C2: real-Electron reproduction for the DELIV-02 false-completion
// defect. A wrong file is written, the model claims completion, and the
// authoritative Task Outcome must stay unverified/unknown.
//
// The script runs against a deterministic local Provider and the real
// Main/Runner/Renderer. It preserves both pieces of evidence: the model's
// verbatim final reply and the Runtime Task Outcome / rendered authority.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import {
  DELIV_02_COMPLETION_CLAIM,
  DELIV_02_PROMPT,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'

const characterize = process.argv.includes('--characterize-current-defect')
const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 45_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-deliv-02-claim-'))
const dataDir = join(root, 'data')
const chromiumDir = join(root, 'chromium')
const workspace = join(root, 'workspace')
const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
const report = {
  version: 1,
  ok: false,
  mode: characterize ? 'characterize-current-defect' : 'verify-fixed-contract',
  executionLevel: 'real Electron Renderer + Main/Runner + local controlled HTTP Provider + real workspace write',
  prompt: DELIV_02_PROMPT,
  modelCompletionClaim: DELIV_02_COMPLETION_CLAIM,
  root,
  cases: [],
  limits: [
    'The Provider is a deterministic local fixture, not a real Provider quality test.',
    'Renderer is driven through CDP DOM events, not native mouse or accessibility-device acceptance.',
    'The Runtime requirement parser is deliberately narrow; this scenario proves the unknown-inventory path, not general task extraction.',
  ],
}
let electron
let client

async function launch() {
  const port = await harness.reservePort()
  const processHandle = await harness.startElectron({
    dataDir, chromiumDir, debuggingPort: port, logPath: join(root, 'electron.log'),
  })
  const locator = await harness.waitForLocator(dataDir, processHandle.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.desktopAction(locator, 'resize', { width: 1200, height: 900 })
  const cdp = await harness.connectRenderer(port)
  await harness.waitFor(async () => (await harness.fetchJson(locator, '/runtime/readiness')).body?.state === 'ready' || null,
    90_000, 'Runtime readiness')
  return { processHandle, locator, cdp, evaluate: (expression) => cdp.evaluate(expression) }
}

async function sendAndRead(evaluate) {
  const before = await evaluate(`document.querySelectorAll('.message.user').length`)
  await evaluate(`(() => { const input=document.querySelector('.composer textarea'); input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(DELIV_02_PROMPT)}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); })()`)
  await harness.waitFor(() => evaluate(`document.querySelector('.composer .send-round:not(.stop)')?.disabled === false || null`),
    30_000, 'enabled send button')
  await evaluate(`document.querySelector('.composer .send-round:not(.stop)').click()`)
  await harness.waitFor(async () => {
    await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined)
    return evaluate(`(() => { const turns=[...document.querySelectorAll('.assistant-turn')]; const last=turns.at(-1); return last?.classList.contains('done') && last.querySelector('.task-outcome-card') ? true : null })()`)
  }, 90_000, 'Task Outcome card for DELIV-02')
  assert.ok(await evaluate(`document.querySelectorAll('.message.user').length > ${before}`), 'user request was not rendered')
  return evaluate(`(() => {
    const turn=[...document.querySelectorAll('.assistant-turn')].at(-1)
    const reply=turn.querySelector('.assistant-final > .markdown')
    const card=turn.querySelector('.task-outcome-card')
    const badge=card?.querySelector('.task-outcome-badge')
    const order=reply && card ? Boolean(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) : false
    return {
      replyText: reply?.innerText ?? null,
      cardText: card?.innerText ?? null,
      cardClassName: card?.className ?? null,
      cardRole: card?.getAttribute('role'),
      badgeClassName: badge?.className ?? null,
      replyBeforeCard: order,
      replyHtml: reply?.innerHTML ?? null,
    }
  })()`)
}

async function readExecutionLog() {
  const contents = await readdir(join(dataDir, 'execution-logs'))
  const logs = await Promise.all(contents.filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(dataDir, 'execution-logs', name), 'utf8'))))
  const log = logs.find((item) => item.inboundText === DELIV_02_PROMPT)
  assert.ok(log, 'Runtime did not persist an execution log for the DELIV-02 prompt')
  return log
}

// Characterization assertions document the pre-fix presentation. They are kept
// only for the C0 audit run; the fixed-contract mode asserts the C1 contract.
function assertCharacterization(view) {
  assert.equal(view.replyText?.trim(), DELIV_02_COMPLETION_CLAIM, 'the model completion claim must be preserved verbatim')
  assert.equal(view.replyBeforeCard, true, 'the reply must precede the acceptance card')
  assert.match(view.cardClassName ?? '', /is-unresolved/u, 'current card treats the unknown outcome as unresolved')
  assert.match(view.badgeClassName ?? '', /muted/u, 'current unknown badge is muted')
  assert.equal(view.cardRole, null, 'current card has no live-region role')
  assert.ok(view.cardText?.includes('无法确认目标是否全部满足'), `current muted status label missing: ${view.cardText}`)
  assert.ok(view.cardText?.includes('验收清单无法确认'), 'current inventory label missing')
  assert.ok(view.cardText?.includes('无法确认完整的要求清单'), 'current remaining-work reason missing')
  assert.ok(view.cardText?.includes('没有可展示的要求验收记录'), 'current fallback sentence missing')
  for (const forbidden of ['已验证通过', '已按明确的验收条件通过', '未验收', '模型最终回复', '不构成验收']) {
    assert.ok(!view.cardText?.includes(forbidden), `pre-fix card unexpectedly includes ${forbidden}`)
  }
}

function assertFixedContract(view) {
  assert.equal(view.replyText?.trim(), DELIV_02_COMPLETION_CLAIM, 'the model completion claim must be preserved verbatim')
  assert.equal(view.replyBeforeCard, true, 'the reply must precede the acceptance card')
  assert.match(view.cardClassName ?? '', /is-unresolved/u, 'unknown outcome must stay unresolved')
  assert.match(view.cardClassName ?? '', /is-unverified/u, 'unknown outcome must carry the explicit unverified acceptance state')
  assert.equal(view.cardRole, 'status', 'the acceptance card must be announced as a status')
  assert.match(view.badgeClassName ?? '', /unverified/u, 'unknown outcome must not use the muted badge')
  for (const required of ['未验收', '模型最终回复', '不构成验收通过', '验收清单无法确认', '无法确认完整的要求清单']) {
    assert.ok(view.cardText?.includes(required), `fixed card omitted: ${required}; card=${view.cardText}`)
  }
  for (const forbidden of ['已验证通过', '已按明确的验收条件通过']) {
    assert.ok(!view.cardText?.includes(forbidden), `unverified card must not claim acceptance: ${forbidden}`)
  }
}

async function readCardAndReplyAfterReload(evaluate) {
  const origin = await evaluate('performance.timeOrigin')
  await client.send('Page.reload')
  await harness.waitFor(() => evaluate(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && document.querySelectorAll('.assistant-turn.done').length >= 1 || null`).catch(() => null),
    60_000, 'session history after Renderer reload')
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.assistant-turn .task-outcome-card').length === 1 || null`),
    45_000, 'persisted Task Outcome card after reload')
  return evaluate(`(() => {
    const turn=[...document.querySelectorAll('.assistant-turn')].at(-1)
    const reply=turn.querySelector('.assistant-final > .markdown')
    const card=turn.querySelector('.task-outcome-card')
    return { replyText: reply?.innerText ?? null, cardText: card?.innerText ?? null, cardRole: card?.getAttribute('role'), cardClassName: card?.className ?? null }
  })()`)
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

  const launched = await launch()
  electron = launched.processHandle
  client = launched.cdp
  const evaluate = launched.evaluate

  const view = await sendAndRead(evaluate)
  const log = await readExecutionLog()

  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'goodbye', 'the wrong file bytes must exist on disk')
  assert.equal(log.reply, DELIV_02_COMPLETION_CLAIM, 'Runtime must preserve the model completion claim verbatim')
  assert.equal(log.taskOutcome?.execution?.status, 'completed', 'execution itself completed; only acceptance is unresolved')
  assert.equal(log.taskOutcome?.status, 'unknown', `Runtime must not accept the unsupported claim; got ${log.taskOutcome?.status}`)
  assert.equal(log.taskOutcome?.requirementInventory, 'unknown', 'the narrow parser must leave the inventory unknown')
  assert.equal(log.taskOutcome?.requirements?.length, 0, 'no recognized requirements are expected')
  assert.equal(log.taskOutcome?.artifacts?.length, 0, 'no verified artifacts are expected')
  assert.equal(log.taskOutcome?.evidence?.length, 0, 'no acceptance evidence is expected')
  assert.ok(log.taskOutcome?.remaining?.some((item) => item.reasonCode === 'requirements_unknown'), 'remaining must name the unknown requirement inventory')
  assert.equal(log.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length, 1, 'exactly one successful write')
  assert.equal(log.toolInvocations.filter((item) => item.toolName === 'runtime_check_file_content').length, 0, 'no independent Runtime check may run')

  if (characterize) assertCharacterization(view)
  else assertFixedContract(view)

  const reloaded = await readCardAndReplyAfterReload(evaluate)
  assert.equal(reloaded.replyText?.trim(), DELIV_02_COMPLETION_CLAIM, 'history replay must preserve the model reply verbatim')
  if (characterize) {
    assert.equal(reloaded.cardRole, null, 'pre-fix card has no live-region role after reload')
    assert.ok(reloaded.cardText?.includes('无法确认目标是否全部满足'), 'pre-fix history card keeps the muted label')
  } else {
    assert.equal(reloaded.cardRole, 'status', 'history replay keeps the status role')
    assert.ok(reloaded.cardText?.includes('未验收'), 'history replay keeps the explicit unverified acceptance')
  }

  report.cases.push({
    prompt: DELIV_02_PROMPT,
    modelReply: view.replyText,
    renderedCard: view.cardText,
    cardClassName: view.cardClassName,
    cardRole: view.cardRole,
    replyBeforeCard: view.replyBeforeCard,
    runtime: {
      outcomeStatus: log.taskOutcome.status,
      requirementInventory: log.taskOutcome.requirementInventory,
      executionStatus: log.taskOutcome.execution.status,
      remaining: log.taskOutcome.remaining,
      writeExecutions: log.toolInvocations.filter((item) => item.toolName === 'write' && item.status === 'succeeded').length,
      checkerExecutions: log.toolInvocations.filter((item) => item.toolName === 'runtime_check_file_content').length,
      actualFile: await readFile(join(workspace, 'result.txt'), 'utf8'),
    },
    afterReload: reloaded,
  })
  report.checks = characterize
    ? ['pre-fix Renderer shows the unknown outcome only as a muted card after the confident reply', 'Runtime outcome stays unknown with no evidence; reply preserved verbatim']
    : ['Renderer shows an explicit unverified acceptance and the claim disclaimer', 'Runtime outcome stays unknown with no evidence; reply preserved verbatim', 'reload preserves both the reply and the authoritative status']
  report.ok = true
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
  process.stdout.write(`${JSON.stringify({ ok: report.ok, mode: report.mode, root, cases: report.cases.length, checks: report.checks ?? [] })}\n`)
}
