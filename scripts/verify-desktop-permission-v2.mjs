// Real Electron acceptance for Permission V2 selection, persistence, approval UI,
// and Main-enforced file boundaries. All writes target an isolated temp data root.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  P4_CHECKPOINT_RESUME_EXEC_MARKER,
  P4_OUTSIDE_WRITE_MARKER,
  P4_PROTECTED_WRITE_MARKER,
  P4_READ_CONTINUATION_MARKER,
  P4_STALE_OBSERVATION_MARKER,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const WINDOW_SIZE = { width: 1280, height: 860 }
const root = await mkdtemp(join(tmpdir(), 'littlesheep-permission-v2-'))
const dataDir = join(root, 'data')
const workplaceDir = join(dataDir, 'workplace')
const chromiumDir = join(root, 'chromium')
const logPath = join(root, 'electron.log')
const outsideSentinel = join(root, 'p4-outside-permission-sentinel.txt')
const workspaceWritePath = join(workplaceDir, 'ux07-approval-escape-probe.txt')
const stalePath = join(workplaceDir, 'p4-stale.txt')
const protectedPath = resolve(repoRoot, 'packages/app/src/shared/permission-modes.ts')
const keepRoot = process.argv.includes('--keep')
const report = {
  check: 'desktop-permission-v2',
  ok: false,
  assertions: [],
  limits: [
    'The Windows workspace-file guard is available in this environment; an unavailable native backend is covered by Main and tool-service tests, not simulated as an Electron capability.',
    'Checkpoint resume starts from a Runner-persisted interrupted run shaped as the supported legacy waiting-user record. The persisted session is downgraded before an orderly Electron restart; resume and the fresh Shell decision use the real Renderer.',
    'Shell remains approval-gated. The two preceding Node commands print marker text and are approved one at a time; the batch fixture contains two marker-only commands explicitly listed and approved together.',
    'The fixed S2 candidate is exercised in real PowerShell: one explicit remember choice, an exact second invocation without a prompt, no authorization viewing/revocation UI or API, then a read-only downgrade that requires a fresh decision.',
  ],
}

let electron
let client
let provider
let locator
let failure
let protectedSourceBytes
let staleProviderEvidence = []
const staleObservationTimeline = []

function note(name, detail = {}) {
  report.assertions.push({ name, ok: true, ...detail })
}

async function evaluate(expression) {
  return client.evaluate(expression)
}

async function click(selector, label = selector) {
  const clicked = await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  })()`)
  assert.equal(clicked, true, `could not click ${label}`)
}

async function clickByText(selector, label) {
  const clicked = await evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => (element.textContent || '').replace(/\\s+/gu, ' ').trim() === ${JSON.stringify(label)});
    if (!(target instanceof HTMLElement)) return false;
    target.click();
    return true;
  })()`)
  assert.equal(clicked, true, `could not click ${label}`)
}

async function selectedMode() {
  return evaluate(`document.querySelector('.mode-picker-trigger .model-picker-current')?.textContent?.trim() ?? null`)
}

async function activeSessionTitle() {
  return evaluate(`document.querySelector('.session-item.active .session-title')?.textContent?.trim() ?? null`)
}

async function chooseMode(label) {
  await click('.mode-picker-trigger', 'permission mode picker')
  await harness.waitFor(() => evaluate(`document.querySelector('.mode-picker-panel')?.getAttribute('aria-hidden') === 'false' || null`),
    harness.actionTimeoutMs, 'permission menu')
  const clicked = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.mode-option')]
      .find((element) => (element.textContent || '').trim().startsWith(${JSON.stringify(label)}));
    if (!(option instanceof HTMLElement)) return false;
    option.click();
    return true;
  })()`)
  assert.equal(clicked, true, `permission option not found: ${label}`)
  if (label !== '完全访问') {
    await harness.waitFor(async () => (await selectedMode()) === label || null, harness.actionTimeoutMs, `${label} mode selection`)
  }
}

async function typeAndSend(text) {
  await harness.waitFor(() => evaluate(`!document.querySelector('.composer .send-round.stop') || null`),
    harness.actionTimeoutMs, 'idle composer before a new user turn')
  const userMessageCount = await evaluate(`document.querySelectorAll('.message-with-meta.user').length`)
  const input = await evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
    return textarea.value === ${JSON.stringify(text)};
  })()`)
  assert.equal(input, true, 'could not enter text into the Renderer composer')
  await harness.waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.composer .send-round:not(.stop)');
    return button instanceof HTMLButtonElement && !button.disabled ? true : null;
  })()`), harness.actionTimeoutMs, 'enabled send button')
  await click('.composer .send-round:not(.stop)', 'send button')
  await harness.waitFor(() => evaluate(`document.querySelectorAll('.message-with-meta.user').length > ${userMessageCount} || null`),
    harness.actionTimeoutMs, 'submitted user message in the Renderer transcript')
}

async function approvalText() {
  return evaluate(`(() => {
    const dialog = document.querySelector('.approval-prompt:not(.full-access-warning)');
    if (!(dialog instanceof HTMLElement)) return null;
    const style = getComputedStyle(dialog);
    const rect = dialog.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0
      ? dialog.innerText.replace(/\\s+/gu, ' ').trim()
      : null;
  })()`)
}

async function waitForApproval(label) {
  try {
    return await harness.waitFor(async () => (await approvalText()) || undefined, harness.actionTimeoutMs, label)
  } catch (error) {
    const [readiness, activeRuns, sessions] = await Promise.all([
      harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined),
      harness.fetchJson(locator, '/application/active-runs').catch(() => undefined),
      harness.fetchJson(locator, '/sessions').catch(() => undefined),
    ])
    report.approvalTimeoutEvidence = {
      label,
      composerError: await evaluate(`document.querySelector('.composer-error')?.textContent?.trim() ?? null`).catch(() => null),
      latestAssistantTurn: await evaluate(`document.querySelector('.assistant-turn:last-of-type')?.innerText?.slice(-1200) ?? null`).catch(() => null),
      userMessageCount: await evaluate(`document.querySelectorAll('.message-with-meta.user').length`).catch(() => null),
      runtimeReadiness: readiness?.body ?? null,
      activeRuns: activeRuns?.body ?? null,
      sessions: sessions?.body?.sessions?.map(({ id, mode, permissionVersion, scope }) => ({ id, mode, permissionVersion, scope })) ?? null,
      providerRequestCount: provider?.requests?.length ?? null,
    }
    throw error
  }
}

async function decideApproval(label) {
  await clickByText('.approval-prompt:not(.full-access-warning) .approval-action', label)
  await harness.waitFor(async () => !(await approvalText()) || null, harness.actionTimeoutMs, 'approval dialog to close')
}

async function waitForReply(marker, label = marker) {
  return harness.waitFor(() => evaluate(`(() => {
    const turns = [...document.querySelectorAll('.assistant-turn')];
    const turn = turns.at(-1);
    const text = (turn?.textContent || '').replace(/\\s+/gu, ' ').trim();
    return text.includes(${JSON.stringify(marker)}) ? text : null;
  })()`), harness.actionTimeoutMs, `assistant reply ${label}`)
}

async function readSessions(locator) {
  const response = await harness.fetchJson(locator, '/sessions')
  assert.equal(response.ok, true, 'session list request failed')
  return response.body.sessions
}

async function waitForSessionMode(locator, sessionId, mode) {
  try {
    const sessions = await harness.waitFor(async () => {
      const items = await readSessions(locator)
      return items.find((session) => session.id === sessionId)?.mode === mode ? items : undefined
    }, harness.actionTimeoutMs, `session ${sessionId} to persist mode ${mode}`)
    return sessions.find((session) => session.id === sessionId)
  } catch (error) {
    const sessions = await readSessions(locator).catch(() => [])
    const state = {
      selectedMode: await selectedMode().catch(() => null),
      activeSessionTitle: await activeSessionTitle().catch(() => null),
      composerError: await evaluate(`document.querySelector('.composer-error')?.textContent?.trim() ?? null`).catch(() => null),
      persistedMode: sessions.find((session) => session.id === sessionId)?.mode ?? null,
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; permission mode state: ${JSON.stringify(state)}`)
  }
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function fileHash(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function waitForApprovalDenialRecovery(sessionId, callId) {
  return harness.waitFor(async () => {
    try {
      const source = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')
      const messages = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      const denied = messages.some((message) => message.role === 'tool'
        && message.content?.some((part) => part.type === 'tool_result'
          && part.result?.callId === callId && part.result?.ok === false))
      const clarification = messages.find((message) => message.role === 'assistant'
        && message.clarificationRequest?.kind === 'recovery_decision'
        && message.clarificationRequest?.sourceStage === 'recover'
        && message.clarificationRequest?.blockingReason?.includes(`tool invocation ${callId} is `))?.clarificationRequest
      return denied && clarification ? clarification : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }, harness.actionTimeoutMs, 'persisted recovery decision after approval denial')
}

async function waitForClarificationResponse(sessionId, requestId) {
  return harness.waitFor(async () => {
    try {
      const source = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')
      const messages = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      return messages.find((message) => message.role === 'user'
        && message.clarificationResponse?.requestId === requestId)?.clarificationResponse
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }, harness.actionTimeoutMs, 'persisted clarification response')
}

async function waitForClarificationAnswerCompletion(sessionId, requestId) {
  return harness.waitFor(async () => {
    try {
      const source = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')
      const messages = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      const response = messages.find((message) => message.role === 'user'
        && message.clarificationResponse?.requestId === requestId)
      if (!response?.runId) return undefined
      const finalMessage = messages.find((message) => message.role === 'assistant'
        && message.runId === response.runId && message.stage === 'finalize')
      if (!finalMessage) return undefined
      const text = finalMessage.content?.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
      return text ? { text, runId: response.runId } : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }, harness.actionTimeoutMs, 'completed Renderer clarification answer run')
}

async function waitForToolStatus(sessionId, callId, status) {
  return waitForToolInvocation(sessionId, callId, (invocation) => invocation.status === status,
    `tool ${callId} to record ${status}`)
}

async function waitForToolOutput(sessionId, callId) {
  return harness.waitFor(async () => {
    try {
      const source = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')
      const messages = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      for (const message of messages) {
        if (message.role !== 'tool') continue
        const result = message.content?.find((part) => part.type === 'tool_result' && part.result?.callId === callId)?.result
        if (result?.ok && typeof result.output === 'string') return result.output
      }
      return undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }, harness.actionTimeoutMs, `persisted host Shell output for ${callId}`)
}

async function waitForToolInvocation(sessionId, callId, predicate, label = `tool ${callId}`) {
  return harness.waitFor(async () => {
    const directory = join(dataDir, 'execution-logs')
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const log = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
        if (log.sessionId !== sessionId) continue
        const invocation = log.toolInvocations?.find((item) => item.callId === callId)
        if (invocation && predicate(invocation)) return invocation
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    return undefined
  }, harness.actionTimeoutMs, label)
}

async function launchDesktop() {
  const debuggingPort = await harness.reservePort()
  electron = await harness.startElectron({
    dataDir,
    chromiumDir,
    debuggingPort,
    logPath,
    extraArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  locator = await harness.waitForLocator(dataDir, electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator, 'park-offscreen')
  await delay(700)
  await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
  client = await harness.connectRenderer(debuggingPort)
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await harness.waitFor(() => evaluate(`Boolean(document.querySelector('.composer textarea')) || null`),
    harness.startTimeoutMs, 'composer')
  await harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
    return response?.body?.state === 'ready' ? response.body : undefined
  }, harness.startTimeoutMs, 'runtime readiness')
}

async function stopDesktop({ graceful = false } = {}) {
  try { client?.close() } catch { /* ignore closed debugger sessions */ }
  client = undefined
  if (electron) {
    if (graceful && locator) {
      await harness.desktopAction(locator, 'quit')
      await harness.waitForExit(electron)
    } else {
      await harness.forceTerminate(electron)
    }
  }
  electron = undefined
  locator = undefined
}

async function main() {
  await harness.assertBuildFresh()
  provider = await startElectronAcceptanceProvider()
  await Promise.all([
    mkdir(workplaceDir, { recursive: true }),
    mkdir(chromiumDir, { recursive: true }),
  ])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')
  await writeFile(outsideSentinel, 'outside sentinel stays unchanged\n', 'utf8')
  await writeFile(stalePath, 'before-external-change\n', 'utf8')
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: [{
    id: 'retired-permission-session-fixture', title: 'Retired permission fixture',
    createdAt: 1, lastMessageAt: 1, mode: 'full', scope: 'standalone',
  }] }, null, 2)}\n`, 'utf8')
  protectedSourceBytes = await readFile(protectedPath)
  const protectedHashBefore = createHash('sha256').update(protectedSourceBytes).digest('hex')

  await launchDesktop()

  assert.equal(await selectedMode(), '工作区写入', 'new draft should start in workspace-write on this Windows host')
  note('new conversation starts with workspace-write')
  const visibleSessions = await readSessions(locator)
  assert.equal(visibleSessions.some((session) => session.id === 'retired-permission-session-fixture'), false)
  const currentSessionIndex = JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'))
  assert.deepEqual(currentSessionIndex.sessions, [], 'retired permission records were retained in the current session index')
  const initialStatus = await evaluate(`document.querySelector('.composer-status')?.innerText ?? ''`)
  assert.doesNotMatch(initialStatus, /历史权限|迁移/u)
  note('unversioned retired permission records are discarded, without a migration notice or compatibility prompt')

  await click('.mode-picker-trigger', 'inspect public permission presets')
  await harness.waitFor(() => evaluate(`document.querySelector('.mode-picker-panel')?.getAttribute('aria-hidden') === 'false' || null`),
    harness.actionTimeoutMs, 'public permission preset list')
  const publicPermissionOptions = await evaluate(`Array.from(document.querySelectorAll('.mode-option')).map(option => option.getAttribute('aria-label') || '')`)
  assert.equal(publicPermissionOptions.length, 3)
  assert.deepEqual(publicPermissionOptions.map((label) => label.split(':')[0]), ['只读', '工作区写入', '完全访问'])
  assert.ok(publicPermissionOptions.every((label) => !/研究|受限/u.test(label)))
  await click('.mode-picker-trigger', 'close permission preset list')

  await chooseMode('只读')
  assert.equal(await selectedMode(), '只读')
  await typeAndSend('UX07-APPROVAL-ESCAPE-READONLY-DENY')
  const readOnlyPrompt = await waitForApproval('read-only write approval')
  assert.match(readOnlyPrompt, /当前为只读授权/u)
  assert.match(readOnlyPrompt, /允许写入文件/u)
  note('Renderer shows the read-only preset for a write approval')
  const inlineApproval = await evaluate(`(() => {
    const prompt = document.querySelector('.approval-inline .approval-prompt');
    const presence = prompt?.closest('.presence-layer');
    const input = document.querySelector('.composer textarea');
    return { role: prompt?.getAttribute('role'), position: presence ? getComputedStyle(presence).position : null,
      composerEnabled: input instanceof HTMLTextAreaElement && !input.disabled,
      focusStayedInComposer: document.activeElement === input };
  })()`)
  assert.deepEqual(inlineApproval, { role: 'region', position: 'static', composerEnabled: true, focusStayedInComposer: true })
  const approvalScreenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'inline-approval.png'), Buffer.from(approvalScreenshot.data, 'base64'))
  note('Agent approval stays inline without trapping focus or blocking the composer', inlineApproval)
  await decideApproval('拒绝')
  await waitForReply('runtime-continuity-anchor-4827', 'post-denial recovery prompt')
  const firstSession = await harness.waitFor(async () => {
    const sessions = await readSessions(locator)
    return sessions[0]?.id ? sessions[0] : undefined
  }, harness.actionTimeoutMs, 'first session persistence')
  const denialRecovery = await waitForApprovalDenialRecovery(firstSession.id, 'ux07-approval-write')
  await waitForToolStatus(firstSession.id, 'ux07-approval-write', 'approval_denied')
  assert.equal(await fileExists(workspaceWritePath), false, 'denied write created a workspace file')
  assert.equal(firstSession.mode, 'read-only')
  assert.equal(denialRecovery.kind, 'recovery_decision')
  assert.equal(denialRecovery.sourceStage, 'recover')
  note('read-only denial preserves the target and surfaces Runtime recovery for a user decision', { sessionId: firstSession.id })

  await click('button.sidebar-nav-button[aria-label="新对话"]', 'new conversation after denied run')
  await harness.waitFor(async () => (await selectedMode()) === '工作区写入' || null,
    harness.actionTimeoutMs, 'fresh conversation workspace-write mode')
  await typeAndSend('UX07-APPROVAL-ESCAPE-WORKSPACE-AUTO')
  await waitForReply('审批路径已结束')
  assert.equal(await readFile(workspaceWritePath, 'utf8'), 'This file must not exist after Escape denies approval.\n')
  const secondSession = await harness.waitFor(async () => {
    const sessions = await readSessions(locator)
    const session = sessions.find((candidate) => candidate.id !== firstSession.id)
    return session?.id ? session : undefined
  }, harness.actionTimeoutMs, 'second session persistence')
  await waitForToolStatus(secondSession.id, 'ux07-approval-write', 'succeeded')
  assert.equal(secondSession.mode, 'workspace-write')
  note('guarded workspace file write completes without an approval prompt in a fresh conversation', { sessionId: secondSession.id })

  await harness.waitFor(async () => (await activeSessionTitle()) === secondSession.title || null,
    harness.actionTimeoutMs, 'second conversation activation in the Renderer')
  await chooseMode('只读')
  await waitForSessionMode(locator, secondSession.id, 'read-only')
  await typeAndSend(P4_READ_CONTINUATION_MARKER)
  await waitForReply('只读授权下的 continuation 已完成')
  await waitForToolStatus(secondSession.id, 'p4-read-continuation', 'succeeded')
  assert.equal(await approvalText(), null, 'safe read continuation unexpectedly asked for approval')
  note('a downgraded workspace session continues with its persisted read-only boundary')

  await typeAndSend(`${P4_OUTSIDE_WRITE_MARKER}:${outsideSentinel}`)
  const outsidePrompt = await waitForApproval('out-of-workspace approval')
  assert.match(outsidePrompt, /当前为只读授权/u)
  assert.match(outsidePrompt, /允许写入文件/u)
  note('out-of-workspace write remains approval-gated after session downgrade')
  await decideApproval('拒绝')
  await waitForReply('runtime-continuity-anchor-4827', 'out-of-workspace denial recovery prompt')
  const outsideRecovery = await waitForApprovalDenialRecovery(secondSession.id, 'p4-outside-write')
  await waitForToolStatus(secondSession.id, 'p4-outside-write', 'approval_denied')
  assert.equal(outsideRecovery.kind, 'recovery_decision')
  assert.equal(await readFile(outsideSentinel, 'utf8'), 'outside sentinel stays unchanged\n')

  await click('button.sidebar-nav-button[aria-label="新对话"]', 'new conversation after denied boundary request')
  await harness.waitFor(async () => (await selectedMode()) === '工作区写入' || null,
    harness.actionTimeoutMs, 'fresh conversation after out-of-workspace denial')
  await provider.setDelay({ requestDelayMs: 3_000 })
  const requestStart = provider.requests.length
  await typeAndSend(P4_STALE_OBSERVATION_MARKER)
  const staleReadResultRequest = await harness.waitFor(() => provider.requests.slice(requestStart).find((request) => {
    const hasFixturePrompt = request.messages.some((message) => message.role === 'user'
      && message.content.includes(P4_STALE_OBSERVATION_MARKER))
    const hasObservedBytes = request.messages.some((message) => message.role === 'tool'
      && message.content.includes('before-external-change'))
    return hasFixturePrompt && hasObservedBytes
  }) || null, harness.actionTimeoutMs, 'provider request after the stale fixture read')
  staleObservationTimeline.push({
    event: 'provider-received-original-read-result',
    requestIndex: staleReadResultRequest.requestIndex,
    receivedAt: staleReadResultRequest.receivedAt,
    delayMs: staleReadResultRequest.delayMs,
  })
  staleObservationTimeline.push({ event: 'before-external-change-write', at: new Date().toISOString() })
  await writeFile(stalePath, 'after-external-change\n', 'utf8')
  assert.equal(await readFile(stalePath, 'utf8'), 'after-external-change\n', 'external fixture change was not durable before releasing the Provider response')
  staleObservationTimeline.push({ event: 'external-change-written-and-read-back', at: new Date().toISOString() })
  await provider.setDelay({ requestDelayMs: 0 })
  await waitForReply('过期观察后的修改已按运行时结果处理')
  const thirdSession = await harness.waitFor(async () => {
    const sessions = await readSessions(locator)
    return sessions.find((candidate) => ![firstSession.id, secondSession.id].includes(candidate.id))
  }, harness.actionTimeoutMs, 'third session persistence')
  await waitForToolStatus(thirdSession.id, 'p4-stale-read', 'succeeded')
  const staleEditInvocation = await waitForToolInvocation(
    thirdSession.id,
    'p4-stale-edit',
    (invocation) => ['failed', 'succeeded', 'hard_denied', 'approval_denied'].includes(invocation.status),
    'stale edit to reach a terminal status',
  )
  staleObservationTimeline.push({
    event: 'stale-edit-terminal',
    status: staleEditInvocation.status,
    proposedAt: staleEditInvocation.proposedAt,
    startedAt: staleEditInvocation.startedAt,
    endedAt: staleEditInvocation.endedAt,
  })
  assert.equal(staleEditInvocation.status, 'failed', `stale edit was not refused: ${JSON.stringify(staleEditInvocation)}`)
  assert.equal(await readFile(stalePath, 'utf8'), 'after-external-change\n')
  assert.equal(await approvalText(), null, 'stale edit unexpectedly asked the user to override the observation guard')
  staleProviderEvidence = provider.requests.slice(requestStart)
    .filter((request) => request.messages.some((message) => message.role === 'user'
      && message.content.includes(P4_STALE_OBSERVATION_MARKER)))
    .map((request) => ({
      requestIndex: request.requestIndex,
      receivedAt: request.receivedAt,
      delayMs: request.delayMs,
      respondedAt: request.respondedAt,
      toolResults: request.messages.filter((message) => message.role === 'tool')
        .map((message) => message.content.slice(0, 160)),
    }))
  note('stale file observation blocks the edit while preserving the external bytes')

  await typeAndSend(`${P4_PROTECTED_WRITE_MARKER}:${protectedPath}`)
  const activeSessionsAfterProtected = await readSessions(locator)
  const protectedSession = activeSessionsAfterProtected.find((session) => session.id !== firstSession.id && session.id !== secondSession.id)
  assert.ok(protectedSession?.id, 'protected target run did not create a session')
  await waitForToolStatus(protectedSession.id, 'p4-protected-write', 'hard_denied')
  assert.equal(await fileHash(protectedPath), protectedHashBefore, 'protected source changed during the denied write attempt')
  assert.equal(await approvalText(), null, 'protected source write unexpectedly offered an approval override')
  note('protected source target is hard-denied without changing its bytes')

  const protectedRecovery = await waitForApprovalDenialRecovery(protectedSession.id, 'p4-protected-write')
  assert.match(protectedRecovery.blockingReason, /p4-protected-write is hard_denied/u)
  await waitForReply(protectedRecovery.prompt.slice(0, 16), 'protected-write recovery prompt in Renderer')
  await typeAndSend('保留已完成工作并说明状态')
  const protectedRecoveryAnswer = await waitForClarificationResponse(protectedSession.id, protectedRecovery.id)
  assert.match(protectedRecoveryAnswer.answer, /保留已完成工作/u)
  const protectedRecoveryRun = await waitForClarificationAnswerCompletion(protectedSession.id, protectedRecovery.id)
  await waitForReply(protectedRecoveryRun.text.slice(0, 16), 'completed protected-write recovery answer')

  for (const id of ['FIRST', 'SECOND']) {
    await typeAndSend(`P4-V2-EXEC-${id}`)
    const prompt = await waitForApproval(`V2 shell approval ${id}`)
    assert.match(prompt, /当前用户的宿主环境运行/u)
    assert.match(prompt, /没有为 Agent Shell 提供操作系统级沙箱/u)
    assert.match(prompt, /工作区边界不会限制该命令/u)
    assert.match(prompt, /该命令默认仅批准本次/u)
    assert.match(prompt, /本对话允许这条命令/u)
    assert.doesNotMatch(prompt, /本对话允许(?!这条命令)/u)
    note(`V2 Agent Shell ${id} requires a new single-call decision and shows host risk`)
    await decideApproval('仅本次')
    await waitForReply(`P4-EXEC-${id}-DONE`)
    await waitForToolStatus(protectedSession.id, `p4-exec-${id}`, 'succeeded')
  }

  await typeAndSend('P4-V2-EXEC-BATCH')
  const batchPrompt = await waitForApproval('fixed Shell invocation batch approval')
  assert.match(batchPrompt, /p4-host-exec-batch-one/u)
  assert.match(batchPrompt, /p4-host-exec-batch-two/u)
  assert.match(batchPrompt, /powershell\.exe/u)
  assert.match(batchPrompt, /当前宿主用户：/u)
  assert.match(batchPrompt, /批准以上全部命令/u)
  assert.match(batchPrompt, /每条只能执行一次/u)
  assert.match(batchPrompt, /没有为 Agent Shell 提供操作系统级沙箱/u)
  note('Renderer lists both full concrete Shell calls and discloses host identity and one-batch scope')
  await decideApproval('批准以上全部命令')
  await waitForReply('P4-EXEC-BATCH-DONE')
  await waitForToolStatus(protectedSession.id, 'p4-exec-batch-one', 'succeeded')
  await waitForToolStatus(protectedSession.id, 'p4-exec-batch-two', 'succeeded')
  note('Main executes both approved batch invocations once and independently records success')

  await typeAndSend('P4-V2-REPEAT-FIRST')
  const repeatPrompt = await waitForApproval('eligible exact Shell repeat authorization')
  assert.match(repeatPrompt, /命令 1 \/ 1[\s\S]*pwd/u)
  assert.match(repeatPrompt, /本对话允许这条命令/u)
  assert.match(repeatPrompt, /最多再匹配 20 次或 30 分钟/u)
  assert.match(repeatPrompt, /没有 OS 级沙箱/u)
  assert.match(repeatPrompt, /工作区外文件、网络和子进程风险仍然存在/u)
  const repeatChoices = await evaluate(`({
    exact: [...document.querySelectorAll('.approval-action')].filter(button => button.textContent?.trim() === '本对话允许这条命令').length,
    generic: [...document.querySelectorAll('.approval-action')].filter(button => button.textContent?.trim() === '本对话允许').length,
  })`)
  assert.deepEqual(repeatChoices, { exact: 1, generic: 0 })
  note('Main offers only the exact fixed command choice and discloses expiry, host identity, and Shell risks')
  await decideApproval('本对话允许这条命令')
  await waitForReply('P4-REPEAT-FIRST-DONE')
  await waitForToolStatus(protectedSession.id, 'p4-repeat-first', 'succeeded')

  await typeAndSend('P4-V2-REPEAT-SECOND')
  await waitForReply('P4-REPEAT-SECOND-DONE')
  await waitForToolStatus(protectedSession.id, 'p4-repeat-second', 'succeeded')
  const secondPwdOutput = await waitForToolOutput(protectedSession.id, 'p4-repeat-second')
  assert.ok(secondPwdOutput.includes(workplaceDir), `PowerShell pwd output did not identify the isolated workspace: ${secondPwdOutput}`)
  assert.equal(await approvalText(), null, 'same exact Shell command unexpectedly asked again')
  note('a second sequential exact pwd invocation launched in PowerShell without another approval prompt')

  const removedManagementApi = await harness.fetchJson(locator,
    `/shell-repeat-authorizations?sessionId=${encodeURIComponent(protectedSession.id)}`)
  assert.equal(removedManagementApi.status, 404, 'Shell repeat authorization listing API is still exposed')
  note('Main no longer exposes an API for listing or revoking exact Shell authorizations')

  await click('.mode-picker-trigger', 'inspect permission menu for authorization-management controls')
  await harness.waitFor(() => evaluate(`document.querySelector('.mode-picker-panel')?.getAttribute('aria-hidden') === 'false' || null`),
    harness.actionTimeoutMs, 'permission menu opened')
  const repeatManagementControls = await evaluate(`({
    heading: [...document.querySelectorAll('.mode-picker-panel h1, .mode-picker-panel h2, .mode-picker-panel h3')]
      .some(node => node.textContent?.includes('当前对话允许重复执行的精确命令')),
    records: document.querySelectorAll('.shell-repeat-authorization, .shell-repeat-authorizations').length,
    revokeButtons: [...document.querySelectorAll('.mode-picker-panel button')]
      .filter(button => /撤销/u.test(button.textContent ?? '')).length,
  })`)
  assert.deepEqual(repeatManagementControls, { heading: false, records: 0, revokeButtons: 0 })
  await click('.mode-picker-trigger', 'close permission menu')
  note('the permission menu has no exact Shell authorization viewing or revocation entry')

  await chooseMode('只读')
  await waitForSessionMode(locator, protectedSession.id, 'read-only')
  await typeAndSend('P4-V2-REPEAT-READONLY')
  const downgradedRepeatPrompt = await waitForApproval('Shell approval after read-only permission downgrade')
  assert.match(downgradedRepeatPrompt, /当前为只读授权/u)
  assert.match(downgradedRepeatPrompt, /没有 OS 级沙箱/u)
  await decideApproval('仅本次')
  await waitForReply('P4-REPEAT-READONLY-DONE')
  await waitForToolStatus(protectedSession.id, 'p4-repeat-readonly', 'succeeded')
  note('read-only downgrade invalidates the previous exact grant and forces a fresh host Shell decision')

  await harness.waitFor(async () => (await activeSessionTitle()) === thirdSession.title || null,
    harness.actionTimeoutMs, 'third conversation activation in the Renderer')
  await chooseMode('完全访问')
  const fullWarning = await harness.waitFor(async () => evaluate(`(() => {
    const dialog = document.querySelector('.full-access-warning');
    if (!(dialog instanceof HTMLElement)) return null;
    const rect = dialog.getBoundingClientRect();
    return rect.width > 0 ? dialog.innerText.replace(/\\s+/gu, ' ').trim() : null;
  })()`), harness.actionTimeoutMs, 'full-access warning')
  assert.match(fullWarning, /内置工具可按 Main 当前权限策略访问更广范围的本地资源/u)
  assert.match(fullWarning, /Shell 与强制审批操作仍需逐次确认/u)
  assert.match(fullWarning, /当前用户的宿主环境运行，没有 OS 级沙箱/u)
  assert.match(fullWarning, /LS 会对内置工具执行核心源码保护检查/u)
  assert.match(fullWarning, /无法保证命令或其子进程不能绕过应用层检查/u)
  note('full-access requires its red confirmation and accurately describes host Shell limits')
  await clickByText('.full-access-warning .approval-action', '启用完全访问')
  await harness.waitFor(async () => (await selectedMode()) === '完全访问' || null,
    harness.actionTimeoutMs, 'confirmed full-access mode')
  await waitForSessionMode(locator, thirdSession.id, 'full-access')
  await harness.waitFor(() => evaluate(`!document.querySelector('.full-access-warning') || null`),
    harness.actionTimeoutMs, 'full-access confirmation to close')

  await click('button.sidebar-nav-button[aria-label="新对话"]', 'new conversation')
  await harness.waitFor(async () => (await selectedMode()) === '工作区写入' || null,
    harness.actionTimeoutMs, 'new draft permission default')
  await harness.waitFor(() => evaluate(`(() => {
    const transcriptIsEmpty = document.querySelectorAll('.message-with-meta.user').length === 0;
    const title = document.querySelector('.session-item.active .session-title')?.textContent?.trim();
    return transcriptIsEmpty && !title ? true : null;
  })()`), harness.actionTimeoutMs, 'new conversation draft activation')
  note('new conversation receives the guarded workspace-write default without inheriting full')
  await typeAndSend('P4-SECOND-SESSION-PERSISTENCE')
  await waitForReply('runtime-continuity-anchor-4827', 'second session completion')
  const fourthSession = await harness.waitFor(async () => {
    const sessions = await readSessions(locator)
    return sessions.find((session) => ![firstSession.id, secondSession.id, thirdSession.id].includes(session.id))
  }, harness.actionTimeoutMs, 'fourth session persistence')
  assert.ok(fourthSession?.id)
  assert.equal(fourthSession.mode, 'workspace-write')
  await harness.waitFor(async () => (await activeSessionTitle()) === fourthSession.title || null,
    harness.actionTimeoutMs, 'fourth conversation activation in the Renderer')
  note('workspace-write mode is persisted independently for the fourth conversation', { sessionId: fourthSession.id })

  await chooseMode('只读')
  await waitForSessionMode(locator, fourthSession.id, 'read-only')
  await clickSessionByTitle(firstSession.title, '只读')
  assert.equal(await selectedMode(), '只读')
  await clickSessionByTitle(secondSession.title, '只读')
  assert.equal(await selectedMode(), '只读')
  await clickSessionByTitle(thirdSession.title, '完全访问')
  assert.equal(await selectedMode(), '完全访问')
  await clickSessionByTitle(fourthSession.title, '只读')
  assert.equal(await selectedMode(), '只读')
  note('switching sessions restores each conversation’s persisted permission mode')

  await chooseMode('工作区写入')
  await waitForSessionMode(locator, fourthSession.id, 'workspace-write')
  await provider.setDelay({ promptContains: P4_CHECKPOINT_RESUME_EXEC_MARKER, delayMs: 5_000 })
  const checkpointRequestStart = provider.requests.length
  await typeAndSend(P4_CHECKPOINT_RESUME_EXEC_MARKER)
  await harness.waitFor(() => evaluate(`Boolean(document.querySelector('.composer-run-actions .send-round.stop')) || null`),
    harness.actionTimeoutMs, 'stop control for the in-flight checkpoint fixture')
  await harness.waitFor(() => provider.requests.slice(checkpointRequestStart).find((request) => (
    request.messages.some((message) => message.role === 'user'
      && message.content.includes(P4_CHECKPOINT_RESUME_EXEC_MARKER))
  )) || null, harness.actionTimeoutMs, 'checkpoint fixture request at the acceptance Provider')
  await click('.composer-run-actions .send-round.stop', 'stop in-flight checkpoint fixture')
  await provider.setDelay({ promptContains: 'P4-CHECKPOINT-CLEAR-DELAY', delayMs: 0 })
  const checkpoint = await harness.waitFor(async () => {
    let names
    try {
      names = await readdir(join(dataDir, 'run-checkpoints'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const candidates = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(await readFile(join(dataDir, 'run-checkpoints', name), 'utf8'))
        if (record.sessionId === fourthSession.id && record.resumeState) candidates.push(record)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  }, harness.startTimeoutMs, 'Runner-persisted checkpoint after stopping the live Renderer run')
  assert.ok(checkpoint?.id)
  assert.equal(checkpoint.resumeState.permissionPolicyId, 'research',
    'the legacy checkpoint permission snapshot should reflect workspace-write')
  const checkpointListing = await harness.fetchJson(locator, '/run-checkpoints')
  assert.equal(checkpointListing.ok, true, 'Main checkpoint discovery failed before restart')
  const checkpointSummary = checkpointListing.body.checkpoints.find((item) => item.id === checkpoint.id)
  assert.equal(checkpointSummary?.resumable, true, 'the stopped run checkpoint was not resumable')
  await harness.waitFor(() => evaluate(`!document.querySelector('.composer-run-actions .send-round.stop') || null`),
    harness.actionTimeoutMs, 'interrupted fixture run to settle')
  note('the live Renderer stop action created a resumable Main checkpoint from an in-flight run', {
    checkpointId: checkpoint.id,
    checkpointStage: checkpoint.currentStage,
    checkpointPermissionSnapshot: checkpoint.resumeState.permissionPolicyId,
  })

  await chooseMode('只读')
  await waitForSessionMode(locator, fourthSession.id, 'read-only')
  note('the persisted session is downgraded after checkpoint creation and before restart')
  await stopDesktop({ graceful: true })

  // The current runtime no longer writes waiting_user checkpoints. Seed that
  // documented compatibility shape from the real interrupted snapshot so the
  // following answer and resume happen through the actual startup Renderer.
  const checkpointPath = join(
    dataDir,
    'run-checkpoints',
    `${createHash('sha256').update(checkpoint.id, 'utf8').digest('hex')}.json`,
  )
  const legacyWaitingCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf8'))
  legacyWaitingCheckpoint.status = 'waiting_user'
  legacyWaitingCheckpoint.reason = 'run is waiting for user clarification'
  delete legacyWaitingCheckpoint.resumeState.lastError
  const clarificationRequest = {
    id: `${checkpoint.runId}:clarification`,
    kind: 'recovery_decision',
    sourceStage: 'execute',
    createdAt: new Date().toISOString(),
    originalRequest: P4_CHECKPOINT_RESUME_EXEC_MARKER,
    copySource: 'runtime_fallback',
    blockingReason: '验收夹具将真实中断现场整理为受支持的旧版等待补充信息形态。',
    questions: [{
      id: 'question-1',
      field: 'recoveryDecision',
      prompt: '请继续这次验收任务。',
      required: true,
    }],
  }
  legacyWaitingCheckpoint.resumeState.continuation = {
    version: 1,
    requestId: clarificationRequest.id,
    sourceStage: clarificationRequest.sourceStage,
  }
  await writeFile(checkpointPath, `${JSON.stringify(legacyWaitingCheckpoint, null, 2)}\n`, 'utf8')
  await appendFile(join(dataDir, 'sessions', `${fourthSession.id}.jsonl`), `${JSON.stringify({
    id: `${clarificationRequest.id}:message`,
    role: 'assistant',
    content: [{ type: 'text', text: `执行已停下，等待补充信息：${clarificationRequest.blockingReason}` }],
    timestamp: new Date().toISOString(),
    sessionId: fourthSession.id,
    clarificationRequest,
  })}\n`, 'utf8')
  note('the runtime-generated checkpoint is shaped as a supported legacy waiting-user record for Renderer recovery')

  await launchDesktop()
  const restoredSessions = await readSessions(locator)
  assert.equal(restoredSessions.find((session) => session.id === fourthSession.id)?.mode, 'read-only')
  const restoredCheckpointListing = await harness.fetchJson(locator, '/run-checkpoints')
  assert.equal(restoredCheckpointListing.ok, true, 'Main checkpoint discovery failed after restart')
  const restoredCheckpoint = restoredCheckpointListing.body.checkpoints.find((item) => item.id === checkpoint.id)
  assert.ok(restoredCheckpoint, `the interrupted checkpoint disappeared during restart: ${JSON.stringify(restoredCheckpointListing.body)}`)
  assert.equal(restoredCheckpoint.resumable, true,
    `the interrupted checkpoint became blocked during restart: ${JSON.stringify(restoredCheckpoint.blockers)}`)
  assert.equal(restoredCheckpoint.waitingForInput, true, 'the Renderer should show the legacy checkpoint answer flow')
  await harness.waitFor(() => evaluate(`Boolean(document.querySelector('.composer .send-round[aria-label="补充信息后继续任务"]')) || null`),
    harness.startTimeoutMs, 'conversation-local play action after restart')
  assert.equal(await evaluate(`Boolean(document.querySelector('.checkpoint-recovery-trigger, .checkpoint-recovery-layer'))`), false,
    'legacy recovery modal and floating launcher must be removed')
  const checkpointInput = await evaluate(`(() => {
    const textarea = document.querySelector('.composer textarea');
    const value = ${JSON.stringify(P4_CHECKPOINT_RESUME_EXEC_MARKER)};
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return textarea.value === value;
  })()`)
  assert.equal(checkpointInput, true)
  await harness.waitFor(() => evaluate(`Boolean(document.querySelector('.composer .send-round[aria-label="继续执行任务"]:not(:disabled)')) || null`),
    harness.actionTimeoutMs, 'enabled inline play action')
  await click('.composer .send-round[aria-label="继续执行任务"]', 'resume through the composer play action')
  const resumedShellPrompt = await waitForApproval('read-only Shell approval after checkpoint resume')
  assert.match(resumedShellPrompt, /当前为只读授权/u)
  assert.match(resumedShellPrompt, /当前用户的宿主环境运行/u)
  assert.match(resumedShellPrompt, /工作区边界不会限制该命令/u)
  assert.match(resumedShellPrompt, /该命令默认仅批准本次/u)
  assert.match(resumedShellPrompt, /本对话允许这条命令/u)
  assert.doesNotMatch(resumedShellPrompt, /本对话允许(?!这条命令)/u)
  note('startup checkpoint resume uses the downgraded session permission and still requires a fresh host Shell decision')
  await decideApproval('拒绝')
  await waitForToolStatus(fourthSession.id, 'p4-checkpoint-resume-exec', 'approval_denied')
  const resumedRecovery = await waitForApprovalDenialRecovery(fourthSession.id, 'p4-checkpoint-resume-exec')
  assert.match(resumedRecovery.blockingReason, /p4-checkpoint-resume-exec is approval_denied/u)

  report.ok = true
  report.environment = {
    platform: process.platform,
    node: process.version,
    electronPid: electron.pid,
    workspace: workplaceDir,
    sessionModes: (await readSessions(locator)).map(({ id, mode }) => ({ id, mode })),
    providerRequests: provider.requests.length,
    tempRoot: keepRoot ? root : undefined,
  }
}

async function clickSessionByTitle(title, mode) {
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-item')]
      .find((element) => element.querySelector('.session-title')?.textContent?.trim() === ${JSON.stringify(title)});
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`)
  assert.equal(clicked, true, `session not found in Renderer sidebar: ${title}`)
  await harness.waitFor(async () => (await selectedMode()) === mode || null, harness.actionTimeoutMs, `session mode ${mode} after switching`)
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Desktop Permission Acceptance Provider',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 60,
      models: ['permission-flow'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/permission-flow',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
    channels: { channels: [] },
    desktop: { closePolicy: 'always-background' },
  }
}

try {
  await main()
} catch (error) {
  failure = error
  report.error = String(error?.stack ?? error)
} finally {
  report.staleObservationTimeline = staleObservationTimeline
  if (staleProviderEvidence.length > 0) report.staleProviderRequests = staleProviderEvidence
  if (failure && provider) {
    report.providerRequestTail = provider.requests.slice(-8).map((request) => ({
      requestIndex: request.requestIndex,
      receivedAt: request.receivedAt,
      respondedAt: request.respondedAt,
      latestUser: request.messages.filter((message) => message.role === 'user').at(-1)?.content,
      response: request.responseSummary,
      toolResults: request.messages.filter((message) => message.role === 'tool').map((message) => message.content.slice(0, 160)),
    }))
  }
  try { client?.close() } catch { /* ignore */ }
  try { if (electron) await harness.forceTerminate(electron) } catch { /* keep the acceptance failure visible */ }
  try { await provider?.close() } catch { /* ignore */ }
  if (protectedSourceBytes) {
    try {
      const protectedNow = await readFile(protectedPath)
      if (!protectedNow.equals(protectedSourceBytes)) {
        await writeFile(protectedPath, protectedSourceBytes)
        report.safetyCleanup = 'Restored protected source bytes after a failed protection assertion.'
      }
    } catch { /* preserve the original acceptance failure */ }
  }
  if (!keepRoot) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  else await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (failure || report.ok !== true) process.exitCode = 1
