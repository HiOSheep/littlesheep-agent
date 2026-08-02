import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_EXIT_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  apiUrl,
  authHeaders,
  createIsolatedDeepSeekEnvironment,
  desktopAction,
  forceTerminate,
  getJson,
  locatorRelativePath,
  postJson,
  readSse,
  removeEnvironment,
  runStream,
  startElectron,
  waitFor,
  waitForDesktop,
  waitForExit,
  waitForLocator,
  waitForMissing,
} from './lib/electron-deepseek-acceptance.mjs'

const FILE_NAME = 'background-proof.txt'
const ACCEPTANCE_CODE = 'deepseek-background-anchor-7319'
const TASK_PROMPT = `这是一个标准复杂度的两步验收任务，请在 TaskBook 中保留两个可分别验证的步骤。文件名称是 ${FILE_NAME}，验收代号是 ${ACCEPTANCE_CODE}。第一步只使用 write 工具创建该文件，文件内容必须恰好等于验收代号；第二步只使用 read 工具重新读取该文件并核对内容。不要使用 exec、edit、glob 或其他工具。最终回答说明文件名称、验收代号和核对结果。`
const RECALL_PROMPT = '你还记得上一轮保存的文件名称和验收代号吗？请分别回答，不要调用工具。'
const INTERRUPT_PROMPT = `请使用 read 工具重新读取 ${FILE_NAME}，核对验收代号后再回答。`

async function main() {
  const environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-deepseek-background-task-',
    maxModelCallsPerRun: 12,
    configureConfig(config) {
      config.desktop.closePolicy = 'always-background'
      return config
    },
  })
  let electron
  let report

  try {
    electron = startElectron(environment)
    let locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)

    const activeTaskFromSse = waitForActiveRunSse(locator)
    const pausedRunPromise = runStream(locator, {
      text: TASK_PROMPT,
      permissionMode: 'full',
      workspace: environment.workplaceDir,
    })
    const activeTask = await activeTaskFromSse

    await desktopAction(locator, 'close')
    await waitForHiddenActiveWindow(locator)

    const runtime = await postJson(locator, '/runtime', { profile: 'coding' }, true)
    if (runtime.profile !== 'coding') {
      throw new Error(`runtime profile hot reload did not select coding: ${safe(runtime)}`)
    }

    await controlRun(locator, activeTask.runId, 'pause')
    const paused = await pausedRunPromise
    assertRecoverableStop(paused.result, 'pause')
    const checkpointId = paused.result.runCheckpointId
    const pausedCheckpoint = await waitForCheckpoint(locator, checkpointId)
    if (!pausedCheckpoint.resumable || pausedCheckpoint.status !== 'paused') {
      throw new Error(`paused checkpoint is not resumable: ${safe(pausedCheckpoint)}`)
    }

    await forceTerminate(electron)
    electron = undefined

    electron = startElectron(environment)
    locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    const recoveredCheckpoint = await waitForCheckpoint(locator, checkpointId)
    if (!recoveredCheckpoint.resumable || recoveredCheckpoint.status !== 'paused') {
      throw new Error(`checkpoint did not survive forced restart: ${safe(recoveredCheckpoint)}`)
    }

    const resumed = await readSse(
      locator,
      `/run-checkpoints/${encodeURIComponent(checkpointId)}/resume/stream`,
      { reason: 'real DeepSeek background-task acceptance resume' },
      DEFAULT_RUN_TIMEOUT_MS,
    )
    assertSuccessfulDeepSeekRun(resumed.result, environment.model, 'resumed background task')
    assertTaskExecution(resumed.result)
    await assertWorkspaceResult(environment.workplaceDir)
    assertReplyContainsResult(resumed.result.reply)
    if (resumed.result.resolvedRunConfig?.behaviorModeId !== 'general'
      || resumed.result.resolvedRunConfig?.permissionPolicyId !== 'full') {
      throw new Error(`resumed run did not preserve its original profile/permission decision: ${safe(resumed.result.resolvedRunConfig)}`)
    }

    const recalled = await runStream(locator, {
      text: RECALL_PROMPT,
      sessionId: resumed.result.sessionId,
      permissionMode: 'full',
      workspace: environment.workplaceDir,
    })
    assertSuccessfulDeepSeekRun(recalled.result, environment.model, 'memory recall after resume')
    assertReplyContainsResult(recalled.result.reply)
    assertSupportedContinuity(recalled.result)
    if (recalled.result.resolvedRunConfig?.behaviorModeId !== 'coding'
      || recalled.result.resolvedRunConfig?.permissionPolicyId !== 'full') {
      throw new Error(`new run did not use hot-reloaded coding profile with independent full permission: ${safe(recalled.result.resolvedRunConfig)}`)
    }

    const interruptRunFromSse = waitForActiveRunSse(locator)
    const interruptingPromise = runStream(locator, {
      text: INTERRUPT_PROMPT,
      sessionId: resumed.result.sessionId,
      permissionMode: 'full',
      workspace: environment.workplaceDir,
    })
    const interruptRun = await interruptRunFromSse
    await controlRun(locator, interruptRun.runId, 'interrupt')
    const interrupted = await interruptingPromise
    assertRecoverableStop(interrupted.result, 'interrupt')

    const completedRequests = uniqueRequestMetrics([
      ['resumed', resumed.result],
      ['recall', recalled.result],
    ])
    assertCompletedProviderUsage(completedRequests)
    assertToolContinuationAccounting(completedRequests)
    const providerTotals = sumProviderUsage(completedRequests)
    const resumedRequests = requestMetrics('resumed', resumed.result)
    if (resumedRequests.length > 8) {
      throw new Error(`multi-step task exceeded the bounded model-call baseline: ${safe(resumedRequests.map((request) => request.purpose))}`)
    }

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    report = {
      check: 'electron-deepseek-background-task',
      ok: true,
      provider: 'deepseek',
      model: environment.model,
      scenarios: [
        'active_run_sse',
        'close_to_tray_while_active',
        'runtime_profile_hot_reload',
        'pause_checkpoint',
        'forced_termination_restart_resume',
        'two_step_write_read_side_effect',
        'answer_level_memory_continuity',
        'interrupt_checkpoint',
        'explicit_quit',
      ],
      task: {
        sessionId: resumed.result.sessionId,
        taskBookSteps: resumed.result.taskBook?.steps?.length ?? 0,
        executionSteps: resumed.result.taskExecution?.steps?.length ?? 0,
        durationMs: resumed.result.durationMs,
        modelCalls: resumedRequests.length,
        toolInvocations: resumed.result.toolInvocations?.map((record) => ({
          toolName: record.toolName,
          status: record.status,
          approval: record.approval,
          durationMs: record.durationMs,
        })) ?? [],
      },
      continuity: recalled.result.memoryContinuityAssessment,
      providerTotals,
      requests: completedRequests,
      interrupted: {
        status: interrupted.result.status,
        checkpointId: interrupted.result.runCheckpointId,
      },
      copiedChromiumFiles: environment.copiedChromiumFiles,
    }
  } finally {
    if (electron?.exitCode === null) await forceTerminate(electron)
    await removeEnvironment(environment.root)
  }

  console.log(JSON.stringify({
    ...report,
    isolatedDataRemoved: !existsSync(environment.root),
  }))
}

async function waitForActiveRunSse(locator) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(apiUrl(locator, '/application/active-runs/stream'), {
      headers: authHeaders(locator),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`active run SSE failed: ${response.status}`)
    }
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (!event) continue
        if (event.event === 'error') {
          throw new Error(`active run SSE error: ${event.data?.error ?? 'unknown error'}`)
        }
        const run = event.event === 'active_runs' ? event.data?.runs?.[0] : undefined
        if (run) return run
      }
    }
    throw new Error('active run SSE ended before publishing a run')
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out waiting for active run SSE')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

async function waitForHiddenActiveWindow(locator) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/acceptance', true).catch(() => undefined)
    const snapshot = payload?.snapshot
    return snapshot
      && !snapshot.windowVisible
      && snapshot.activeRunCount >= 1
      ? snapshot
      : undefined
  }, 30_000, 'hidden Electron window with an active DeepSeek run')
}

async function waitForCheckpoint(locator, checkpointId) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/run-checkpoints', true).catch(() => undefined)
    return payload?.checkpoints?.find((checkpoint) => checkpoint.id === checkpointId)
  }, 30_000, `checkpoint ${checkpointId}`)
}

function controlRun(locator, runId, action) {
  return postJson(locator, `/application/active-runs/${encodeURIComponent(runId)}/control`, {
    action,
    reason: `real DeepSeek acceptance ${action}`,
  }, true)
}

function assertRecoverableStop(result, label) {
  if (result?.status !== 'aborted' || !result.runCheckpointId) {
    throw new Error(`${label} did not produce a recoverable checkpoint: ${safe(result)}`)
  }
}

function assertSuccessfulDeepSeekRun(result, model, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safe(result)}`)
  if (result.replyProvenance?.source !== 'llm'
    || result.replyProvenance.provider !== 'deepseek'
    || result.replyProvenance.model !== model) {
    throw new Error(`${label} reply is not traceable to the expected DeepSeek model: ${safe(result.replyProvenance)}`)
  }
}

function assertTaskExecution(result) {
  if ((result.taskBook?.steps?.length ?? 0) < 2) {
    throw new Error(`DeepSeek did not preserve a two-step TaskBook: ${safe(result.taskBook)}`)
  }
  if (result.taskExecution?.status !== 'done'
    || (result.taskExecution?.steps?.length ?? 0) < 2
    || result.taskExecution.steps.some((step) => step.status !== 'done' || step.error)) {
    throw new Error(`multi-step execution did not complete cleanly: ${safe(result.taskExecution)}`)
  }
  const invocations = result.toolInvocations ?? []
  const successfulNames = invocations
    .filter((record) => record.status === 'succeeded')
    .map((record) => record.toolName)
  if (successfulNames.filter((name) => name === 'write').length !== 1
    || successfulNames.filter((name) => name === 'read').length !== 1
    || successfulNames.some((name) => name !== 'write' && name !== 'read')) {
    throw new Error(`expected exactly one successful write and read with no extra tools: ${safe(invocations)}`)
  }
  if (invocations.some((record) => record.approval?.decision !== 'not_required')) {
    throw new Error(`full permission unexpectedly requested per-tool approval: ${safe(invocations)}`)
  }
  if (!(result.sideEffects ?? []).some((effect) => effect.status === 'succeeded')) {
    throw new Error(`write side effect was not recorded as succeeded: ${safe(result.sideEffects)}`)
  }
}

async function assertWorkspaceResult(workplaceDir) {
  const entries = (await readdir(workplaceDir)).sort()
  if (!entries.includes(FILE_NAME)) {
    throw new Error(`expected workspace file is missing: ${safe(entries)}`)
  }
  const content = await readFile(join(workplaceDir, FILE_NAME), 'utf8')
  if (content !== ACCEPTANCE_CODE) {
    throw new Error(`workspace file content mismatch: ${safe(content)}`)
  }
}

function assertReplyContainsResult(reply) {
  if (typeof reply !== 'string' || !reply.includes(FILE_NAME) || !reply.includes(ACCEPTANCE_CODE)) {
    throw new Error(`reply omitted the accepted file name or code: ${safe(reply)}`)
  }
}

function assertSupportedContinuity(result) {
  const assessment = result.memoryContinuityAssessment
  if (assessment?.status !== 'supported'
    || !assessment.matchedSources?.some((source) => source === 'recent_history' || source === 'session_summary')) {
    throw new Error(`memory recall was not supported by the final answer: ${safe({
      reply: result.reply,
      assessment,
    })}`)
  }
}

function requestMetrics(runLabel, result) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  return (result.modelRequests ?? []).map((request) => {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    return {
      key: request.id ?? `${runLabel}:${request.requestIndex}`,
      runLabel,
      index: request.requestIndex,
      purpose: request.callContract?.purpose ?? request.stage,
      stage: request.stage,
      totalMessageCount: request.totalMessageCount,
      toolNames: request.toolNames ?? [],
      localAccuracy: snapshot?.localTokenLedger?.accuracy,
      localPromptTokens: snapshot?.localTokenLedger?.accuracy === 'exact'
        ? snapshot.localTokenLedger.promptTokens
        : undefined,
      localUnavailableReason: snapshot?.localTokenLedger?.accuracy === 'unavailable'
        ? snapshot.localTokenLedger.reason
        : undefined,
      providerPromptTokens: snapshot?.providerUsage?.promptTokens,
      providerCompletionTokens: snapshot?.providerUsage?.completionTokens,
      providerTotalTokens: snapshot?.providerUsage?.totalTokens,
      calibration: snapshot?.providerUsage?.localCalibration?.status,
    }
  })
}

function uniqueRequestMetrics(results) {
  const unique = new Map()
  for (const [label, result] of results) {
    for (const request of requestMetrics(label, result)) unique.set(request.key, request)
  }
  return [...unique.values()].sort((left, right) => left.index - right.index)
}

function assertCompletedProviderUsage(requests) {
  if (requests.length === 0) throw new Error('completed DeepSeek runs recorded no model requests')
  for (const request of requests) {
    if (!Number.isSafeInteger(request.providerPromptTokens) || request.providerPromptTokens <= 0
      || !Number.isSafeInteger(request.providerCompletionTokens) || request.providerCompletionTokens < 0) {
      throw new Error(`request ${request.key} is missing Provider usage: ${safe(request)}`)
    }
    if (request.localAccuracy === 'exact'
      && (request.calibration !== 'exact_match'
        || request.localPromptTokens !== request.providerPromptTokens)) {
      throw new Error(`request ${request.key} local exact count drifted from Provider usage: ${safe(request)}`)
    }
  }
}

function assertToolContinuationAccounting(requests) {
  const toolRequests = requests.filter((request) => request.toolNames.length > 0)
  if (toolRequests.length < 2) {
    throw new Error(`multi-step task did not record tool-enabled request costs: ${safe(requests)}`)
  }
  if (toolRequests.some((request) => request.localAccuracy !== 'unavailable'
    || !/tool-enabled requests/iu.test(request.localUnavailableReason ?? ''))) {
    throw new Error(`uncalibrated tool requests did not fail local exact counting closed: ${safe(toolRequests)}`)
  }
}

function sumProviderUsage(requests) {
  return requests.reduce((totals, request) => ({
    promptTokens: totals.promptTokens + (request.providerPromptTokens ?? 0),
    completionTokens: totals.completionTokens + (request.providerCompletionTokens ?? 0),
    totalTokens: totals.totalTokens + (request.providerTotalTokens
      ?? (request.providerPromptTokens ?? 0) + (request.providerCompletionTokens ?? 0)),
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 })
}

function parseSseBlock(block) {
  let event = 'message'
  const data = []
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (data.length === 0) return undefined
  return { event, data: JSON.parse(data.join('\n')) }
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
    check: 'electron-deepseek-background-task',
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
