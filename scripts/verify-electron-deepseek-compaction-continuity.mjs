import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assessResponseMemoryContinuity } from '../packages/harness/dist/index.js'
import {
  DEFAULT_EXIT_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  createIsolatedDeepSeekEnvironment,
  desktopAction,
  forceTerminate,
  getJson,
  locatorRelativePath,
  removeEnvironment,
  runStream,
  startElectron,
  waitFor,
  waitForDesktop,
  waitForExit,
  waitForLocator,
  waitForMissing,
} from './lib/electron-deepseek-acceptance.mjs'
import { startDelayedHttpProxy } from './lib/delayed-http-proxy.mjs'

const RUN_TIMEOUT_MS = Math.max(DEFAULT_RUN_TIMEOUT_MS, 180_000)
const ACCEPTANCE_CODE = 'summary-deepseek-anchor-8427'
const ACCEPTANCE_COLOR = '雾松青'
const ACCEPTANCE_LIMIT = '17'
const ACCEPTANCE_SWITCH = '关闭'
const ACCEPTANCE_SEQUENCE = '先备份再发布'
const SEED_PROMPT = `请记住两个字段：代号是“${ACCEPTANCE_CODE}”，颜色是“${ACCEPTANCE_COLOR}”。本轮只回复“记录完成”，不要复述代号或颜色，不要调用工具；后续我追问时必须准确回答。`
const RECALL_PROMPT = '你还记得我上次要求保存的代号和颜色吗？请按“代号：...；颜色：...”回答，不要调用工具。'
const UPDATE_PROMPT = `请再记住三个不同形态的事实：上限是 ${ACCEPTANCE_LIMIT}，开关状态是“${ACCEPTANCE_SWITCH}”，操作顺序是“${ACCEPTANCE_SEQUENCE}”。本轮只回复“更新完成”，不要复述这些值，不要调用工具。`
const FINAL_RECALL_PROMPT = '请分别回答最初保存的代号和颜色，以及后来约定的上限、开关状态和操作顺序。不要调用工具。'
const MEMORY_GROWTH_BUDGET = {
  rssBytes: 256 * 1024 * 1024,
  heapUsedBytes: 128 * 1024 * 1024,
}

async function main() {
  let proxy
  const environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-deepseek-compaction-continuity-',
    maxModelCallsPerRun: 8,
    configureConfig: async (config) => {
      proxy = await startDelayedHttpProxy({
        upstreamBaseURL: config.providers[0].baseURL,
        delayMs: 0,
      })
      config.providers[0] = { ...config.providers[0], baseURL: proxy.baseURL }
      config.agents.defaults.timeoutSeconds = 180
      config.sessions = {
        writeLock: { acquireTimeoutMs: 60_000 },
        compaction: { threshold: 2, keepRecent: 1 },
      }
      return config
    },
  })
  let electron
  let report
  const electronLogs = []

  try {
    electron = startObservedElectron(environment, electronLogs)
    let locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    const initialProcess = await acceptanceSnapshot(locator)

    const seeded = await runStream(locator, runBody(SEED_PROMPT, environment.workplaceDir), RUN_TIMEOUT_MS)
    assertSuccessfulDeepSeekRun(seeded.result, environment.model, 'compaction seed')
    assertIncludes(seeded.result.reply, '记录完成', 'compaction seed reply')
    assertNotIncludes(seeded.result.reply, ACCEPTANCE_CODE, 'compaction seed reply')
    assertNotIncludes(seeded.result.reply, ACCEPTANCE_COLOR, 'compaction seed reply')
    const firstSession = await readSession(environment.dataDir, seeded.result.sessionId)
    const firstSummary = assertFirstCompaction(firstSession, seeded.result, electronLogs, proxy.requests)
    await assertSummaryProjection(environment.dataDir, seeded.result.sessionId, firstSummary)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    electron = startObservedElectron(environment, electronLogs)
    locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    const restartBaseline = await acceptanceSnapshot(locator)

    const proxyRequestCountBeforeRecall = proxy.requests.length
    proxy.disconnectNext()
    const recalled = await runStream(
      locator,
      runBody(RECALL_PROMPT, environment.workplaceDir, seeded.result.sessionId),
      RUN_TIMEOUT_MS,
    )
    const networkRecovery = assertNetworkDisconnectRecovery(
      proxy.requests.slice(proxyRequestCountBeforeRecall),
    )
    assertSuccessfulDeepSeekRun(recalled.result, environment.model, 'post-compaction recall')
    assertIncludes(recalled.result.reply, ACCEPTANCE_CODE, 'post-compaction recall reply')
    assertIncludes(recalled.result.reply, ACCEPTANCE_COLOR, 'post-compaction recall reply')
    const firstRecallContext = assertAnswerBasedSummaryContinuity({
      result: recalled.result,
      prompt: RECALL_PROMPT,
      expectedValues: [ACCEPTANCE_CODE, ACCEPTANCE_COLOR],
      summary: firstSummary,
      compactedMessageIds: [firstSession.messages[0].id],
      retainedMessageIds: [firstSession.messages[1].id],
    })

    const secondSession = await readSession(environment.dataDir, recalled.result.sessionId)
    const secondSummary = assertIncrementalCompaction(secondSession, firstSummary, recalled.result, {
      label: 'first recall compaction',
      expectedMessageCount: 4,
      expectedDepth: 2,
      expectedEndMessageIndex: 2,
      expectedValues: [ACCEPTANCE_CODE, ACCEPTANCE_COLOR],
    })
    const negativeControls = assertNegativeControls({
      result: recalled.result,
      firstSummary,
      acknowledgement: firstSession.messages[1],
      inbound: secondSession.messages.find((message) => (
        message.runId === recalled.result.runId && message.role === 'user'
      )),
    })

    const updated = await runStream(
      locator,
      runBody(UPDATE_PROMPT, environment.workplaceDir, seeded.result.sessionId),
      RUN_TIMEOUT_MS,
    )
    assertSuccessfulDeepSeekRun(updated.result, environment.model, 'multi-shape memory update')
    assertIncludes(updated.result.reply, '更新完成', 'multi-shape memory update reply')
    for (const value of [ACCEPTANCE_LIMIT, ACCEPTANCE_SWITCH, ACCEPTANCE_SEQUENCE]) {
      assertNotIncludes(updated.result.reply, value, 'multi-shape memory update reply')
    }
    const thirdSession = await readSession(environment.dataDir, updated.result.sessionId)
    const thirdSummary = assertIncrementalCompaction(thirdSession, secondSummary, updated.result, {
      label: 'multi-shape update compaction',
      expectedMessageCount: 6,
      expectedDepth: 3,
      expectedEndMessageIndex: 4,
      expectedValues: [
        ACCEPTANCE_CODE,
        ACCEPTANCE_COLOR,
        ACCEPTANCE_LIMIT,
        ACCEPTANCE_SWITCH,
        ACCEPTANCE_SEQUENCE,
      ],
    })

    const beforeSecondRestart = await waitForIdle(locator)
    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    electron = startObservedElectron(environment, electronLogs)
    locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    const secondRestartBaseline = await acceptanceSnapshot(locator)

    const finalRecalled = await runStream(
      locator,
      runBody(FINAL_RECALL_PROMPT, environment.workplaceDir, seeded.result.sessionId),
      RUN_TIMEOUT_MS,
    )
    assertSuccessfulDeepSeekRun(finalRecalled.result, environment.model, 'multi-compaction final recall')
    for (const value of [
      ACCEPTANCE_CODE,
      ACCEPTANCE_COLOR,
      ACCEPTANCE_LIMIT,
      ACCEPTANCE_SWITCH,
      ACCEPTANCE_SEQUENCE,
    ]) {
      assertIncludes(finalRecalled.result.reply, value, 'multi-compaction final recall reply')
    }
    const finalRecallContext = assertAnswerBasedSummaryContinuity({
      result: finalRecalled.result,
      prompt: FINAL_RECALL_PROMPT,
      expectedValues: [
        ACCEPTANCE_CODE,
        ACCEPTANCE_COLOR,
        ACCEPTANCE_LIMIT,
        ACCEPTANCE_SWITCH,
        ACCEPTANCE_SEQUENCE,
      ],
      summary: thirdSummary,
      compactedMessageIds: thirdSession.messages.slice(0, 5).map((message) => message.id),
      retainedMessageIds: [thirdSession.messages[5].id],
    })
    const finalSession = await readSession(environment.dataDir, finalRecalled.result.sessionId)
    const latestSummary = assertIncrementalCompaction(finalSession, thirdSummary, finalRecalled.result, {
      label: 'final recall compaction',
      expectedMessageCount: 8,
      expectedDepth: 3,
      expectedEndMessageIndex: 6,
      expectedValues: [
        ACCEPTANCE_CODE,
        ACCEPTANCE_COLOR,
        ACCEPTANCE_LIMIT,
        ACCEPTANCE_SWITCH,
        ACCEPTANCE_SEQUENCE,
      ],
    })

    const settled = await waitForIdle(locator)
    const resourceGrowth = assertBoundedMemoryGrowth(secondRestartBaseline, settled)
    const labeledResults = [
      ['seed_and_compact', seeded.result],
      ['restart_network_recovery_and_recall', recalled.result],
      ['multi_shape_update', updated.result],
      ['second_restart_and_final_recall', finalRecalled.result],
    ]
    const requests = labeledResults.flatMap(([label, result]) => requestMetrics(label, result))
    assertLocalProviderAccounting(requests)
    const providerAccounting = summarizeProxyAccounting(proxy.requests)
    assertProxyAccounting(providerAccounting, requests)
    const executionLogs = await readExecutionLogs(
      environment.dataDir,
      labeledResults.map(([, result]) => result.runId),
    )
    assertExecutionLogs(executionLogs, [recalled.result, finalRecalled.result])

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    report = {
      check: 'electron-deepseek-compaction-continuity',
      ok: true,
      provider: 'deepseek',
      model: environment.model,
      scenario: 'multi_compaction_cross_restart_answer_continuity_with_network_recovery',
      networkRecovery,
      currentPromptContainedPriorValues: [
        ACCEPTANCE_CODE,
        ACCEPTANCE_COLOR,
        ACCEPTANCE_LIMIT,
        ACCEPTANCE_SWITCH,
        ACCEPTANCE_SEQUENCE,
      ].some((value) => FINAL_RECALL_PROMPT.includes(value)),
      finalAnswerContainedEveryPriorValue: true,
      continuity: finalRecalled.result.memoryContinuityAssessment,
      compaction: {
        threshold: 2,
        keepRecent: 1,
        first: summaryMetrics(firstSummary),
        second: summaryMetrics(secondSummary),
        third: summaryMetrics(thirdSummary),
        latest: summaryMetrics(latestSummary),
        originalTranscriptMessageCount: finalSession.messages.length,
        originalTranscriptPreserved: finalSession.messages.some((message) => (
          message.id === firstSession.messages[0].id
          && messageText(message).includes(ACCEPTANCE_CODE)
          && messageText(message).includes(ACCEPTANCE_COLOR)
        )),
      },
      causalContext: {
        firstRecall: firstRecallContext,
        finalRecall: finalRecallContext,
      },
      negativeControls,
      runs: labeledResults.map(([label, result]) => runMetrics(label, result)),
      providerAccounting,
      observedProviderTotals: sumProviderUsage(requests),
      resources: {
        initialProcess: summarizeProcess(initialProcess),
        restartBaseline: summarizeProcess(restartBaseline),
        beforeSecondRestart: summarizeProcess(beforeSecondRestart),
        secondRestartBaseline: summarizeProcess(secondRestartBaseline),
        settled: summarizeProcess(settled),
        growth: resourceGrowth,
        executionLogs: executionLogs.map((log) => ({
          runId: log.runId,
          status: log.status,
          runtimeResources: log.runtimeResources,
        })),
      },
      copiedChromiumFiles: environment.copiedChromiumFiles,
    }
  } finally {
    if (electron?.exitCode === null) await forceTerminate(electron)
    await proxy?.close().catch(() => undefined)
    await removeEnvironment(environment.root)
  }

  console.log(JSON.stringify({
    ...report,
    isolatedDataRemoved: !existsSync(environment.root),
  }))
}

function runBody(text, workspace, sessionId) {
  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    permissionMode: 'full',
    workspace,
  }
}

function startObservedElectron(environment, logs) {
  const child = startElectron({ ...environment, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      logs.push(...Buffer.from(chunk).toString('utf8').split(/\r?\n/u).filter(Boolean))
      if (logs.length > 200) logs.splice(0, logs.length - 200)
    })
  }
  return child
}

async function readSession(dataDir, sessionId) {
  const raw = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')
  const records = raw.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
  const header = records.shift()
  if (header?.type !== 'metadata' || !header.metadata) {
    throw new Error(`session ${sessionId} has no valid metadata header`)
  }
  return { metadata: header.metadata, messages: records }
}

function assertFirstCompaction(session, result, electronLogs, proxyRequests) {
  if (session.messages.length !== 2
    || session.messages[0]?.role !== 'user'
    || session.messages[1]?.role !== 'assistant') {
    throw new Error(`first compacted transcript is unexpected: ${safe(session.messages.map(messageShape))}`)
  }
  const [seedMessage, acknowledgement] = session.messages
  assertIncludes(messageText(seedMessage), ACCEPTANCE_CODE, 'preserved seed message')
  assertIncludes(messageText(seedMessage), ACCEPTANCE_COLOR, 'preserved seed message')
  assertNotIncludes(messageText(acknowledgement), ACCEPTANCE_CODE, 'recent acknowledgement')
  assertNotIncludes(messageText(acknowledgement), ACCEPTANCE_COLOR, 'recent acknowledgement')

  const summary = session.metadata.compaction
  if (summary?.version !== 2
    || summary.collapsedCount !== 1
    || summary.sourceStartMessageId !== seedMessage.id
    || summary.sourceEndMessageId !== seedMessage.id
    || summary.cache?.compressionDepth !== 1
    || !summary.sourceRunIds?.includes(result.runId)) {
    throw new Error(`first versioned compaction is invalid: ${safe({
      summary,
      messages: session.messages.map(messageShape),
      requests: requestMetrics('seed_diagnostic', result),
      continuity: result.memoryContinuityAssessment,
      electronLogs,
      proxyRequests,
    })}`)
  }
  assertIncludes(summary.summary, '代号', `first summary label (${summary.summary})`)
  assertIncludes(summary.summary, '颜色', `first summary label (${summary.summary})`)
  assertIncludes(summary.summary, ACCEPTANCE_CODE, `first summary (${safe(summary.summary)})`)
  assertIncludes(summary.summary, ACCEPTANCE_COLOR, `first summary (${safe(summary.summary)})`)
  const compactionRequests = (result.modelRequests ?? []).filter((request) => (
    request.callContract?.purpose === 'session_compaction'
  ))
  if (compactionRequests.length !== 1) {
    throw new Error(`seed run did not make exactly one session_compaction request: ${safe(compactionRequests)}`)
  }
  return summary
}

async function assertSummaryProjection(dataDir, sessionId, summary) {
  const path = join(
    dataDir,
    'sessions',
    '.compactions',
    digest(sessionId),
    'records',
    `${digest(summary.id)}.compaction.json`,
  )
  const projection = JSON.parse(await readFile(path, 'utf8'))
  if (projection.id !== summary.id
    || projection.sourceHash !== summary.sourceHash
    || projection.lineageHash !== summary.lineageHash) {
    throw new Error(`durable compaction projection differs from session metadata: ${safe(projection)}`)
  }
}

function assertIncrementalCompaction(session, previousSummary, result, expectations) {
  if (session.messages.length !== expectations.expectedMessageCount) {
    throw new Error(`${expectations.label} transcript lost original messages: ${session.messages.length}`)
  }
  const latest = session.metadata.compaction
  const previousDepth = previousSummary?.version === 2
    ? previousSummary.cache?.compressionDepth
    : previousSummary
      ? 1
      : undefined
  const expectedPreviousSummaryId = previousDepth === 3 ? undefined : previousSummary.id
  if (latest?.version !== 2
    || latest.id === previousSummary.id
    || latest.previousSummaryId !== expectedPreviousSummaryId
    || latest.cache?.compressionDepth !== expectations.expectedDepth
    || !latest.sourceSummaryIds?.includes(previousSummary.id)
    || latest.sourceSummaryIds.length > 3
    || latest.mergedSummaryCount !== (previousSummary.mergedSummaryCount ?? 1) + 1
    || latest.sourceEndMessageId !== session.messages[expectations.expectedEndMessageIndex]?.id
    || !latest.sourceRunIds?.includes(result.runId)) {
    throw new Error(`${expectations.label} lineage is invalid: ${safe(latest)}`)
  }
  for (const value of expectations.expectedValues) {
    assertIncludes(latest.summary, value, `${expectations.label} summary`)
  }
  return latest
}

function assertAnswerBasedSummaryContinuity({
  result,
  prompt,
  expectedValues,
  summary,
  compactedMessageIds,
  retainedMessageIds,
}) {
  if (expectedValues.some((value) => prompt.includes(value))) {
    throw new Error('recall prompt leaked the expected historical values')
  }
  const assessment = result.memoryContinuityAssessment
  if (assessment?.status !== 'supported'
    || assessment.method !== 'answer-evidence-v1'
    || assessment.sources?.explicitContinuationRequest !== true
    || assessment.sources?.sessionSummary !== true
    || !assessment.matchedSources?.includes('session_summary')
    || assessment.matchedSources?.includes('recent_history')
    || assessment.matchedSources?.includes('active_memory_atom')) {
    throw new Error(`final answer was not supported exclusively by the causal session summary: ${safe(assessment)}`)
  }
  if ((result.toolInvocations?.length ?? 0) !== 0) {
    throw new Error(`post-compaction recall unexpectedly called tools: ${safe(result.toolInvocations)}`)
  }

  const provenance = result.replyProvenance
  const request = (result.modelRequests ?? []).find((candidate) => candidate.id === provenance?.modelRequestId)
  const snapshot = (result.contextSnapshots ?? []).find((candidate) => candidate.id === request?.contextSnapshotId)
  if (!provenance || !request || !snapshot || snapshot.itemsTruncated) {
    throw new Error('final reply lacks a complete causal request snapshot')
  }
  const included = snapshot.items.filter((item) => item.disposition === 'included')
  const summaryItem = included.find((item) => (
    item.kind === 'summary_memory'
    && item.source.kind === 'memory'
    && item.source.id === summary.id
  ))
  if (!summaryItem) throw new Error('the versioned session summary did not enter the final reply request')
  const recentIds = included
    .filter((item) => item.kind === 'recent_message' && item.source.kind === 'message')
    .map((item) => item.source.id)
  const leakedCompactedIds = compactedMessageIds.filter((id) => recentIds.includes(id))
  if (leakedCompactedIds.length > 0) {
    throw new Error(`compacted messages still entered the final reply request as recent history: ${safe(leakedCompactedIds)}`)
  }
  const missingRetainedIds = retainedMessageIds.filter((id) => !recentIds.includes(id))
  if (missingRetainedIds.length > 0) {
    throw new Error(`keepRecent messages were not represented in causal Context: ${safe({ recentIds, missingRetainedIds })}`)
  }
  return {
    replyRequestIndex: request.requestIndex,
    replyPurpose: request.callContract?.purpose,
    contextSnapshotId: snapshot.id,
    includedItemCount: included.length,
    includedKinds: countBy(included, (item) => item.kind),
    summaryId: summary.id,
    summaryCharacters: summaryItem.characterCount,
    recentMessageIds: recentIds,
    compactedMessageCount: compactedMessageIds.length,
    compactedMessagesExcluded: true,
    retainedMessageCount: retainedMessageIds.length,
    localPromptTokens: snapshot.localTokenLedger?.accuracy === 'exact'
      ? snapshot.localTokenLedger.promptTokens
      : undefined,
    providerPromptTokens: snapshot.providerUsage?.promptTokens,
    providerCompletionTokens: snapshot.providerUsage?.completionTokens,
    calibration: snapshot.providerUsage?.localCalibration?.status,
  }
}

function assertNegativeControls({ result, firstSummary, acknowledgement, inbound }) {
  if (!inbound) throw new Error('post-compaction recall inbound message is missing')
  const base = {
    inbound,
    history: [acknowledgement],
    sessionSummary: firstSummary,
    modelRequests: result.modelRequests,
    contextSnapshots: result.contextSnapshots,
    replyProvenance: result.replyProvenance,
  }
  const partial = assessResponseMemoryContinuity({
    ...base,
    reply: `代号：${ACCEPTANCE_CODE}；颜色没有回答。`,
  })
  const wrong = assessResponseMemoryContinuity({
    ...base,
    reply: '代号：summary-deepseek-wrong；颜色：亮黄色。',
  })
  const amnesia = assessResponseMemoryContinuity({
    ...base,
    reply: `我无法回忆上一轮，但代号是 ${ACCEPTANCE_CODE}，颜色是 ${ACCEPTANCE_COLOR}。`,
  })
  const summaryOmitted = assessResponseMemoryContinuity({
    ...base,
    reply: result.reply,
    contextSnapshots: omitSummaryFromSnapshots(result.contextSnapshots, firstSummary.id),
  })
  for (const [name, assessment] of Object.entries({ partial, wrong, amnesia, summaryOmitted })) {
    if (assessment.status === 'supported' || assessment.matchedSources.includes('session_summary')) {
      throw new Error(`negative continuity control ${name} produced a false positive: ${safe(assessment)}`)
    }
  }
  return Object.fromEntries(Object.entries({ partial, wrong, amnesia, summaryOmitted }).map(([name, assessment]) => [
    name,
    {
      status: assessment.status,
      matchedSources: assessment.matchedSources,
      missingSignals: assessment.missingSignals,
    },
  ]))
}

function omitSummaryFromSnapshots(snapshots, summaryId) {
  return structuredClone(snapshots ?? []).map((snapshot) => ({
    ...snapshot,
    items: snapshot.items.map((item) => (
      item.kind === 'summary_memory' && item.source?.kind === 'memory' && item.source.id === summaryId
        ? { ...item, disposition: 'omitted', omissionReason: 'budget' }
        : item
    )),
  }))
}

function assertSuccessfulDeepSeekRun(result, model, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safe(result)}`)
  if (result.replyProvenance?.source !== 'llm'
    || result.replyProvenance.provider !== 'deepseek'
    || result.replyProvenance.model !== model) {
    throw new Error(`${label} reply is not traceable to ${model}: ${safe(result.replyProvenance)}`)
  }
  if (result.resolvedRunConfig?.permissionPolicyId !== 'full'
    || result.resolvedRunConfig?.behaviorModeId !== 'general') {
    throw new Error(`${label} changed behavior/profile semantics: ${safe(result.resolvedRunConfig)}`)
  }
}

function requestMetrics(runLabel, result) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  return (result.modelRequests ?? []).map((request) => {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    return {
      key: request.id ?? `${result.runId}:${request.requestIndex}`,
      runLabel,
      index: request.requestIndex,
      purpose: request.callContract?.purpose ?? request.stage,
      stage: request.stage,
      localAccuracy: snapshot?.localTokenLedger?.accuracy,
      localPromptTokens: snapshot?.localTokenLedger?.accuracy === 'exact'
        ? snapshot.localTokenLedger.promptTokens
        : undefined,
      providerPromptTokens: snapshot?.providerUsage?.promptTokens,
      providerCompletionTokens: snapshot?.providerUsage?.completionTokens,
      providerTotalTokens: snapshot?.providerUsage?.totalTokens,
      calibration: snapshot?.providerUsage?.localCalibration?.status,
      contextItems: snapshot?.items.length,
      includedContextItems: snapshot?.items.filter((item) => item.disposition === 'included').length,
      includedKinds: snapshot ? countBy(
        snapshot.items.filter((item) => item.disposition === 'included'),
        (item) => item.kind,
      ) : {},
    }
  })
}

function assertLocalProviderAccounting(requests) {
  if (requests.length === 0) throw new Error('compaction continuity acceptance recorded no model requests')
  for (const request of requests) {
    if (!Number.isSafeInteger(request.providerPromptTokens)
      || !Number.isSafeInteger(request.providerCompletionTokens)
      || !Number.isSafeInteger(request.localPromptTokens)
      || request.localAccuracy !== 'exact'
      || !['exact_match', 'within_tolerance'].includes(request.calibration)) {
      throw new Error(`request ${request.key} lacks calibrated exact local token accounting: ${safe(request)}`)
    }
  }
}

function summarizeProxyAccounting(requests) {
  const forwarded = requests.filter((request) => request.forwarded)
  const withUsage = forwarded.filter((request) => request.usage)
  const injectedDisconnects = requests.filter((request) => request.injectedFault === 'disconnect')
  const unexpectedUnforwarded = requests.filter((request) => (
    !request.forwarded && request.injectedFault !== 'disconnect'
  ))
  return {
    attemptedRequests: requests.length,
    forwardedRequests: forwarded.length,
    forwardedWithoutUsage: forwarded.filter((request) => !request.usage).length,
    injectedDisconnects: injectedDisconnects.length,
    unexpectedUnforwarded: unexpectedUnforwarded.length,
    promptTokens: withUsage.reduce((total, request) => total + request.usage.promptTokens, 0),
    completionTokens: withUsage.reduce((total, request) => total + request.usage.completionTokens, 0),
    totalTokens: withUsage.reduce((total, request) => total + request.usage.totalTokens, 0),
    requests: requests.map((request) => ({
      id: request.id,
      model: request.model,
      status: request.status,
      forwarded: request.forwarded,
      aborted: request.aborted,
      injectedFault: request.injectedFault,
      usage: request.usage,
      durationMs: elapsedMs(request.startedAt, request.completedAt),
    })),
  }
}

function assertProxyAccounting(accounting, requests) {
  if (accounting.forwardedWithoutUsage !== 0
    || accounting.forwardedRequests !== requests.length
    || accounting.injectedDisconnects !== 1
    || accounting.unexpectedUnforwarded !== 0
    || accounting.attemptedRequests !== requests.length + accounting.injectedDisconnects) {
    throw new Error(`Provider proxy accounting differs from recorded model requests: ${safe(accounting)}`)
  }
  const observed = sumProviderUsage(requests)
  if (accounting.promptTokens !== observed.promptTokens
    || accounting.completionTokens !== observed.completionTokens
    || accounting.totalTokens !== observed.totalTokens) {
    throw new Error(`Provider proxy totals differ from Context snapshots: ${safe({ accounting, observed })}`)
  }
}

function assertNetworkDisconnectRecovery(requests) {
  const [disconnected, recovered] = requests
  if (requests.length < 2
    || disconnected?.injectedFault !== 'disconnect'
    || disconnected.forwarded
    || disconnected.aborted
    || recovered?.forwarded !== true
    || recovered.status !== 200
    || recovered.model !== disconnected.model
    || recovered.stream !== disconnected.stream) {
    throw new Error(`post-restart recall did not recover from the injected disconnect: ${safe(requests)}`)
  }
  return {
    injectedRequestId: disconnected.id,
    recoveredRequestId: recovered.id,
    failedAttemptReachedProvider: false,
    recoveredAttemptReachedProvider: true,
    model: recovered.model,
    stream: recovered.stream,
    additionalProviderTokensFromFailedAttempt: 0,
  }
}

function sumProviderUsage(requests) {
  return requests.reduce((totals, request) => ({
    promptTokens: totals.promptTokens + (request.providerPromptTokens ?? 0),
    completionTokens: totals.completionTokens + (request.providerCompletionTokens ?? 0),
    totalTokens: totals.totalTokens + (request.providerTotalTokens ?? 0),
    requests: totals.requests + 1,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 })
}

function runMetrics(label, result) {
  return {
    label,
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    durationMs: result.durationMs,
    modelCalls: result.modelRequests?.length ?? 0,
    purposes: result.modelRequests?.map((request) => request.callContract?.purpose ?? request.stage) ?? [],
    toolInvocations: result.toolInvocations?.length ?? 0,
    continuity: result.memoryContinuityAssessment?.status,
    continuitySources: result.memoryContinuityAssessment?.matchedSources ?? [],
    requests: requestMetrics(label, result),
  }
}

async function acceptanceSnapshot(locator) {
  return (await getJson(locator, '/application/acceptance', true)).snapshot
}

function waitForIdle(locator) {
  return waitFor(async () => {
    const snapshot = await acceptanceSnapshot(locator)
    return snapshot.runtime.aggregatedActiveRunCount === 0
      && snapshot.runtime.currentRunnerActiveRunCount === 0
      && snapshot.runtime.retiredRunnerCount === 0
      ? snapshot
      : undefined
  }, 30_000, 'idle Electron runtime after compacted recall')
}

function assertBoundedMemoryGrowth(baseline, settled) {
  const rssBytes = settled.process.rssBytes - baseline.process.rssBytes
  const heapUsedBytes = settled.process.heapUsedBytes - baseline.process.heapUsedBytes
  if (rssBytes > MEMORY_GROWTH_BUDGET.rssBytes || heapUsedBytes > MEMORY_GROWTH_BUDGET.heapUsedBytes) {
    throw new Error(`compaction continuity exceeded the memory growth budget: ${safe({
      baseline: baseline.process,
      settled: settled.process,
      rssBytes,
      heapUsedBytes,
      budget: MEMORY_GROWTH_BUDGET,
    })}`)
  }
  return {
    rssBytes,
    heapUsedBytes,
    rssMiB: roundMiB(rssBytes),
    heapUsedMiB: roundMiB(heapUsedBytes),
    budgetRssMiB: roundMiB(MEMORY_GROWTH_BUDGET.rssBytes),
    budgetHeapUsedMiB: roundMiB(MEMORY_GROWTH_BUDGET.heapUsedBytes),
  }
}

async function readExecutionLogs(dataDir, runIds) {
  return Promise.all(runIds.map(async (runId) => (
    JSON.parse(await readFile(join(dataDir, 'execution-logs', `${runId}.json`), 'utf8'))
  )))
}

function assertExecutionLogs(logs, recalledResults) {
  if (logs.length !== 4) throw new Error(`expected four execution logs, received ${logs.length}`)
  for (const log of logs) {
    if (!log.runtimeResources?.start || !log.runtimeResources?.end) {
      throw new Error(`execution log ${log.runId} lacks runtime resource observations`)
    }
  }
  for (const result of recalledResults) {
    const recallLog = logs.find((log) => log.runId === result.runId)
    if (recallLog?.memoryContinuityAssessment?.status !== 'supported'
      || !recallLog.memoryContinuityAssessment.matchedSources?.includes('session_summary')) {
      throw new Error(`execution log lost answer-level summary continuity: ${safe(recallLog)}`)
    }
  }
}

function summaryMetrics(summary) {
  return {
    id: summary.id,
    version: summary.version,
    collapsedCount: summary.collapsedCount,
    compressionDepth: summary.cache?.compressionDepth,
    mergedSummaryCount: summary.mergedSummaryCount,
    previousSummaryId: summary.previousSummaryId,
    sourceSummaryIds: summary.sourceSummaryIds,
    sourceRunIds: summary.sourceRunIds,
    sourceHash: summary.sourceHash,
    lineageHash: summary.lineageHash,
    summaryCharacters: summary.summary.length,
  }
}

function summarizeProcess(snapshot) {
  return {
    sampledAt: snapshot.sampledAt,
    rssBytes: snapshot.process.rssBytes,
    heapUsedBytes: snapshot.process.heapUsedBytes,
    rssMiB: roundMiB(snapshot.process.rssBytes),
    heapUsedMiB: roundMiB(snapshot.process.heapUsedBytes),
    activeRuns: snapshot.runtime.aggregatedActiveRunCount,
    retiredRunners: snapshot.runtime.retiredRunnerCount,
    activitySources: snapshot.runtime.activitySourceCount,
    activityListeners: snapshot.runtime.activityListenerCount,
  }
}

function messageShape(message) {
  return { id: message.id, role: message.role, runId: message.runId, text: messageText(message) }
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function countBy(values, key) {
  return values.reduce((counts, value) => {
    const name = key(value)
    counts[name] = (counts[name] ?? 0) + 1
    return counts
  }, {})
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function elapsedMs(startedAt, completedAt) {
  const start = Date.parse(startedAt ?? '')
  const end = Date.parse(completedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}

function roundMiB(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

function assertIncludes(value, expected, label) {
  if (typeof value !== 'string' || !value.includes(expected)) {
    throw new Error(`${label} did not include ${expected}`)
  }
}

function assertNotIncludes(value, expected, label) {
  if (typeof value === 'string' && value.includes(expected)) {
    throw new Error(`${label} unexpectedly included ${expected}`)
  }
}

function safe(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-deepseek-compaction-continuity',
    ok: false,
    errorKind: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message.slice(0, 8_000) : String(error).slice(0, 8_000),
  }))
  process.exitCode = 1
})
