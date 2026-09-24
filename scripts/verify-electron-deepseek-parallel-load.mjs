import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
  startElectron,
  waitFor,
  waitForDesktop,
  waitForExit,
  waitForLocator,
  waitForMissing,
} from './lib/electron-deepseek-acceptance.mjs'
import { startDelayedHttpProxy } from './lib/delayed-http-proxy.mjs'

const PROXY_DELAY_MS = 3_500
const RUN_TIMEOUT_MS = Math.max(DEFAULT_RUN_TIMEOUT_MS, 180_000)
const TASK_A = taskFixture('parallel-a.txt', 'parallel-deepseek-anchor-a-6417')
const TASK_B = taskFixture('parallel-b.txt', 'parallel-deepseek-anchor-b-5824')
const GLOB_PROMPT = '请只使用 glob 工具读取当前工作区顶层条目，并简短说明名称，不要修改任何文件。'
const HOT_RELOAD_MARKER = 'parallel-hot-reload-marker-9306'
const HOT_RELOAD_PROMPT = `请只回复 ${HOT_RELOAD_MARKER}，不要调用工具。`
const MEMORY_GROWTH_BUDGET = {
  rssBytes: 256 * 1024 * 1024,
  heapUsedBytes: 128 * 1024 * 1024,
}

async function main() {
  let proxy
  let hotReloadModel
  const environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-deepseek-parallel-load-',
    maxModelCallsPerRun: 12,
    configureConfig: async (config) => {
      proxy = await startDelayedHttpProxy({
        upstreamBaseURL: config.providers[0].baseURL,
        delayMs: PROXY_DELAY_MS,
      })
      const initialModel = config.providers[0].models?.[0]
      hotReloadModel = initialModel === 'deepseek-v4-pro' ? 'deepseek-v4-flash' : 'deepseek-v4-pro'
      const primary = {
        ...config.providers[0],
        baseURL: proxy.baseURL,
        models: [...new Set([...(config.providers[0].models ?? []), hotReloadModel])],
      }
      config.providers = [primary]
      config.desktop.closePolicy = 'always-background'
      config.agents.defaults.timeoutSeconds = 180
      return config
    },
  })
  let electron
  let report

  try {
    await prepareWorkspace(environment.workplaceDir)
    electron = startElectron(environment)
    let locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)

    const startup = await acceptanceSnapshot(locator)
    assertIdleRuntime(startup, 'startup')
    const startupListenerCount = startup.runtime.activityListenerCount
    await verifySseReconnects(locator, startupListenerCount, 4)

    const taskATools = successfulToolBarrier(['write', 'read'])
    const taskBTools = successfulToolBarrier(['write', 'read'])
    const runA = startRunStream(
      locator,
      runBody(TASK_A.prompt, environment.workplaceDir),
      taskATools.observe,
    )
    const runB = startRunStream(
      locator,
      runBody(TASK_B.prompt, environment.workplaceDir),
      taskBTools.observe,
    )
    const runC = startRunStream(locator, runBody(GLOB_PROMPT, environment.workplaceDir))
    const [runAId, runBId, runCId] = await Promise.all([runA.started, runB.started, runC.started])
    await waitForRunIds(locator, [runAId, runBId, runCId])
    const initialParallel = await acceptanceSnapshot(locator)
    assertRuntimeCounts(initialParallel, {
      aggregatedActiveRunCount: 3,
      currentRunnerActiveRunCount: 3,
      retiredRunnerCount: 0,
      activitySourceCount: 1,
    }, 'initial parallel load')

    await desktopAction(locator, 'close')
    const hidden = await waitForAcceptance(locator, (snapshot) => (
      !snapshot.windowVisible && snapshot.runtime.aggregatedActiveRunCount >= 3
    ), 'hidden window with parallel runs')

    const hotRuntime = await postJson(locator, '/runtime', {
      model: `deepseek/${hotReloadModel}`,
      profile: 'coding',
    }, true)
    if (hotRuntime.model !== `deepseek/${hotReloadModel}` || hotRuntime.profile !== 'coding') {
      throw new Error(`runtime hot reload did not select the expected model/profile: ${safe(hotRuntime)}`)
    }

    const runD = startRunStream(locator, runBody(HOT_RELOAD_PROMPT, environment.workplaceDir))
    const runDId = await runD.started
    await waitForRunIds(locator, [runAId, runBId, runCId, runDId])
    const hotParallel = await acceptanceSnapshot(locator)
    assertRuntimeCounts(hotParallel, {
      aggregatedActiveRunCount: 4,
      currentRunnerActiveRunCount: 1,
      retiredRunnerCount: 1,
      activitySourceCount: 2,
    }, 'hot-reloaded parallel load')
    await waitForActiveRunSse(locator, (runs) => [runAId, runBId, runCId, runDId]
      .every((runId) => runs.some((run) => run.runId === runId)))
    await waitForListenerCount(locator, startupListenerCount)

    await Promise.all([
      waitForToolBarrier(taskATools, runA.completion, 'parallel task A'),
      waitForToolBarrier(taskBTools, runB.completion, 'parallel task B'),
    ])
    await controlRun(locator, runAId, 'pause')
    await controlRun(locator, runBId, 'interrupt')

    const [initialA, initialB, globRun, hotRun] = await Promise.all([
      runA.completion,
      runB.completion,
      runC.completion,
      runD.completion,
    ])
    assertRecoverableStop(initialA.result, 'paused parallel task A')
    assertRecoverableStop(initialB.result, 'interrupted parallel task B')
    assertCompletedTwoStepTask(initialA.result, TASK_A, 'parallel task A before pause', environment.workplaceDir)
    assertCompletedTwoStepTask(initialB.result, TASK_B, 'parallel task B before interrupt', environment.workplaceDir)
    assertSuccessfulRun(globRun.result, 'deepseek', environment.model, 'parallel glob task')
    assertSingleGlob(globRun.result)
    assertSuccessfulRun(hotRun.result, 'deepseek', hotReloadModel, 'hot-reloaded task')
    if (!hotRun.result.reply?.includes(HOT_RELOAD_MARKER)) {
      throw new Error(`hot-reloaded reply omitted its marker: ${safe(hotRun.result.reply)}`)
    }
    if ((hotRun.result.toolInvocations?.length ?? 0) !== 0) {
      throw new Error(`hot-reloaded response probe unexpectedly called tools: ${safe(hotRun.result.toolInvocations)}`)
    }
    assertModePermission(initialA.result, 'general', 'full', 'parallel task A')
    assertModePermission(initialB.result, 'general', 'full', 'parallel task B')
    assertModePermission(globRun.result, 'general', 'full', 'parallel glob task')
    assertModePermission(hotRun.result, 'coding', 'full', 'hot-reloaded task')

    const pausedFileA = await fileSnapshot(environment.workplaceDir, TASK_A.fileName)
    const interruptedFileB = await fileSnapshot(environment.workplaceDir, TASK_B.fileName)
    assertFileSnapshot(pausedFileA, TASK_A.code, 'parallel task A side effect')
    assertFileSnapshot(interruptedFileB, TASK_B.code, 'parallel task B side effect')

    await waitForIdleRuntime(locator, startupListenerCount)
    const restoredRuntime = await postJson(locator, '/runtime', {
      model: `deepseek/${environment.model}`,
      profile: 'coding',
    }, true)
    if (restoredRuntime.model !== `deepseek/${environment.model}`) {
      throw new Error(`runtime model was not restored before restart: ${safe(restoredRuntime)}`)
    }
    const preCrashSettled = await waitForIdleRuntime(locator, startupListenerCount)

    await forceTerminate(electron)
    electron = undefined

    electron = startElectron(environment)
    locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    const postRestart = await acceptanceSnapshot(locator)
    assertIdleRuntime(postRestart, 'post-restart')
    const restartListenerCount = postRestart.runtime.activityListenerCount
    const runtimeAfterRestart = await getJson(locator, '/runtime', true)
    if (runtimeAfterRestart.model !== `deepseek/${environment.model}`
      || runtimeAfterRestart.profile !== 'coding') {
      throw new Error(`runtime config did not survive restart: ${safe(runtimeAfterRestart)}`)
    }

    const checkpointA = await waitForCheckpoint(locator, initialA.result.runCheckpointId)
    const checkpointB = await waitForCheckpoint(locator, initialB.result.runCheckpointId)
    for (const [label, checkpoint] of [['A', checkpointA], ['B', checkpointB]]) {
      if (!checkpoint.resumable) throw new Error(`parallel checkpoint ${label} is not resumable: ${safe(checkpoint)}`)
    }

    const resumeA = observeRejection(readSse(
      locator,
      `/run-checkpoints/${encodeURIComponent(checkpointA.id)}/resume/stream`,
      { reason: 'parallel DeepSeek acceptance resume A' },
      RUN_TIMEOUT_MS,
    ))
    const resumeB = observeRejection(readSse(
      locator,
      `/run-checkpoints/${encodeURIComponent(checkpointB.id)}/resume/stream`,
      { reason: 'parallel DeepSeek acceptance resume B' },
      RUN_TIMEOUT_MS,
    ))
    const resumePeak = await waitForAcceptance(locator, (snapshot) => (
      snapshot.runtime.aggregatedActiveRunCount >= 2
    ), 'parallel checkpoint resumes')
    await desktopAction(locator, 'close')
    await waitForAcceptance(locator, (snapshot) => (
      !snapshot.windowVisible && snapshot.runtime.aggregatedActiveRunCount >= 2
    ), 'hidden window with parallel checkpoint resumes')

    const [resumedA, resumedB] = await Promise.all([resumeA, resumeB])
    assertSuccessfulRun(resumedA.result, 'deepseek', environment.model, 'resumed task A')
    assertSuccessfulRun(resumedB.result, 'deepseek', environment.model, 'resumed task B')
    assertReplyContainsTask(resumedA.result, TASK_A, 'resumed task A')
    assertReplyContainsTask(resumedB.result, TASK_B, 'resumed task B')
    assertNoRepeatedTools(resumedA.result, 'resumed task A')
    assertNoRepeatedTools(resumedB.result, 'resumed task B')
    assertModePermission(resumedA.result, 'general', 'full', 'resumed task A')
    assertModePermission(resumedB.result, 'general', 'full', 'resumed task B')
    assertUnchangedFile(pausedFileA, await fileSnapshot(environment.workplaceDir, TASK_A.fileName), 'resumed task A')
    assertUnchangedFile(interruptedFileB, await fileSnapshot(environment.workplaceDir, TASK_B.fileName), 'resumed task B')
    await assertSinglePersistedInbound(locator, resumedA.result.sessionId, TASK_A.prompt)
    await assertSinglePersistedInbound(locator, resumedB.result.sessionId, TASK_B.prompt)

    const recallA = startRunStream(locator, runBody(TASK_A.recallPrompt, environment.workplaceDir, resumedA.result.sessionId))
    const recallB = startRunStream(locator, runBody(TASK_B.recallPrompt, environment.workplaceDir, resumedB.result.sessionId))
    await Promise.all([recallA.started, recallB.started])
    await waitForAcceptance(locator, (snapshot) => (
      snapshot.runtime.aggregatedActiveRunCount >= 2
    ), 'parallel answer-level memory recalls')
    const [recalledA, recalledB] = await Promise.all([recallA.completion, recallB.completion])
    assertSuccessfulRun(recalledA.result, 'deepseek', environment.model, 'memory recall A')
    assertSuccessfulRun(recalledB.result, 'deepseek', environment.model, 'memory recall B')
    assertReplyContainsTask(recalledA.result, TASK_A, 'memory recall A')
    assertReplyContainsTask(recalledB.result, TASK_B, 'memory recall B')
    assertSupportedContinuity(recalledA.result, 'memory recall A')
    assertSupportedContinuity(recalledB.result, 'memory recall B')
    assertModePermission(recalledA.result, 'coding', 'full', 'memory recall A')
    assertModePermission(recalledB.result, 'coding', 'full', 'memory recall B')

    await desktopAction(locator, 'show')
    await waitForDesktop(locator)
    await waitForIdleRuntime(locator, restartListenerCount)
    await verifySseReconnects(locator, restartListenerCount, 8)
    const finalSettled = await waitForIdleRuntime(locator, restartListenerCount)
    assertBoundedMemoryGrowth(postRestart, finalSettled)

    const labeledResults = [
      ['initial_a', initialA.result],
      ['initial_b', initialB.result],
      ['glob', globRun.result],
      ['hot_reload', hotRun.result],
      ['resumed_a', resumedA.result],
      ['resumed_b', resumedB.result],
      ['recall_a', recalledA.result],
      ['recall_b', recalledB.result],
    ]
    const requests = uniqueRequestMetrics(labeledResults)
    assertLocalProviderAccounting(requests)
    const providerAccounting = summarizeProxyAccounting(proxy.requests)
    if (providerAccounting.forwardedWithoutUsage !== 0) {
      throw new Error(`forwarded Provider requests lack authoritative usage: ${safe(providerAccounting)}`)
    }
    const logs = await readExecutionLogs(environment.dataDir, labeledResults.map(([, result]) => result.runId))
    assertRuntimeResourceLogs(logs, labeledResults.length)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    report = {
      check: 'electron-deepseek-parallel-load',
      ok: true,
      provider: 'deepseek',
      model: environment.model,
      scenarios: [
        'parallel_active_run_sse',
        'sse_disconnect_reconnect_listener_release',
        'close_to_tray_with_parallel_runs',
        'model_and_profile_hot_reload_with_retired_runner',
        'parallel_write_read_side_effects',
        'pause_and_interrupt_after_completed_side_effects',
        'forced_termination_restart',
        'parallel_checkpoint_resume_without_repeating_tools',
        'parallel_answer_level_memory_continuity',
        'explicit_quit',
      ],
      runs: labeledResults.map(([label, result]) => ({
        label,
        runId: result.runId,
        sessionId: result.sessionId,
        status: result.status,
        durationMs: result.durationMs,
        modelCalls: result.modelRequests?.length ?? 0,
        toolInvocations: result.toolInvocations?.map((record) => ({
          toolName: record.toolName,
          status: record.status,
          approval: record.approval,
          durationMs: record.durationMs,
        })) ?? [],
        continuity: result.memoryContinuityAssessment,
      })),
      providerAccounting,
      resultObservedProviderTotals: sumObservedProviderUsage(requests),
      requests,
      resources: {
        startup: summarizeAcceptance(startup),
        initialParallel: summarizeAcceptance(initialParallel),
        hidden: summarizeAcceptance(hidden),
        hotParallel: summarizeAcceptance(hotParallel),
        preCrashSettled: summarizeAcceptance(preCrashSettled),
        postRestart: summarizeAcceptance(postRestart),
        resumePeak: summarizeAcceptance(resumePeak),
        finalSettled: summarizeAcceptance(finalSettled),
        executionLogs: logs.map((log) => ({
          runId: log.runId,
          status: log.status,
          runtimeResources: log.runtimeResources,
        })),
      },
      sseEvents: Object.fromEntries([
        ['initial_a', initialA.eventCounts],
        ['initial_b', initialB.eventCounts],
        ['glob', globRun.eventCounts],
        ['hot_reload', hotRun.eventCounts],
      ]),
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

function taskFixture(fileName, code) {
  return {
    fileName,
    code,
    // No TaskBook instruction: the second execution system is gone, so nothing
    // writes TaskBook steps for an ordinary run and asking the model to keep them
    // only invites a call to a tool this request does not admit. The two steps are
    // named explicitly instead, and the gate judges them by their artifacts.
    prompt: `这是一个标准复杂度的两步验收任务。文件名称是 ${fileName}，验收代号是 ${code}。第一步只使用 write 工具创建该文件，文件内容必须恰好等于验收代号；第二步只使用 read 工具重新读取该文件并核对内容。不要使用 exec、edit、glob 或其他工具。最终回答分别说明文件名称、验收代号和核对结果。`,
    recallPrompt: '你还记得上一轮保存的文件名称和验收代号吗？请分别回答，不要调用工具。',
  }
}

function runBody(text, workspace, sessionId) {
  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    permissionMode: 'full',
    workspace,
  }
}

async function prepareWorkspace(workplaceDir) {
  await mkdir(join(workplaceDir, 'parallel-fixture'), { recursive: true })
  await Promise.all([
    writeFile(join(workplaceDir, 'glob-alpha.txt'), 'alpha\n', 'utf8'),
    writeFile(join(workplaceDir, 'parallel-fixture', 'nested.txt'), 'nested\n', 'utf8'),
  ])
}

function startRunStream(locator, body, onEvent) {
  let startedResolved = false
  let resolveStarted
  let rejectStarted
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  const completion = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
    const eventCounts = {}
    try {
      const response = await fetch(apiUrl(locator, '/run/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`SSE /run/stream failed: ${response.status}`)
      let buffer = ''
      let result
      let streamError
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        while (true) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const event = parseSseBlock(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (!event) continue
          eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1
          onEvent?.(event)
          if (event.event === 'start' && typeof event.data?.runId === 'string' && !startedResolved) {
            startedResolved = true
            resolveStarted(event.data.runId)
          }
          if (event.event === 'result') result = event.data
          if (event.event === 'error') streamError = event.data?.error ?? 'unknown SSE error'
        }
      }
      if (streamError) throw new Error(`/run/stream: ${streamError}`)
      if (!result) throw new Error('/run/stream ended without a result')
      return { result, eventCounts }
    } catch (error) {
      if (!startedResolved) rejectStarted(error)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })()
  // Runs are started and awaited in separate phases. Observe both rejections
  // immediately so Node does not terminate before the owning phase can report
  // the original SSE failure with its scenario context.
  void started.catch(() => undefined)
  void completion.catch(() => undefined)
  return { started, completion }
}

function successfulToolBarrier(expectedNames) {
  const expected = new Set(expectedNames)
  const observed = new Set()
  let resolveBarrier
  const promise = new Promise((resolve) => {
    resolveBarrier = resolve
  })
  return {
    expectedNames: [...expected],
    observedNames: observed,
    promise,
    observe(event) {
      if (event.event !== 'tool_end' || event.data?.ok !== true || !expected.has(event.data?.name)) return
      observed.add(event.data.name)
      if (observed.size === expected.size) resolveBarrier([...observed])
    },
  }
}

function waitForToolBarrier(barrier, completion, label) {
  return Promise.race([
    barrier.promise,
    completion.then(({ result }) => {
      throw new Error(`${label} ended before all expected tools completed: ${safe({
        expected: barrier.expectedNames,
        observed: [...barrier.observedNames],
        result,
      })}`)
    }),
  ])
}

async function waitForRunIds(locator, runIds) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/active-runs').catch(() => undefined)
    return runIds.every((runId) => payload?.runs?.some((run) => run.runId === runId))
      ? payload.runs
      : undefined
  }, 60_000, `active runs ${runIds.join(', ')}`)
}

function controlRun(locator, runId, action) {
  return postJson(locator, `/application/active-runs/${encodeURIComponent(runId)}/control`, {
    action,
    reason: `parallel DeepSeek acceptance ${action}`,
  }, true)
}

async function waitForCheckpoint(locator, checkpointId) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/run-checkpoints', true).catch(() => undefined)
    return payload?.checkpoints?.find((checkpoint) => checkpoint.id === checkpointId)
  }, 30_000, `checkpoint ${checkpointId}`)
}

async function acceptanceSnapshot(locator) {
  const payload = await getJson(locator, '/application/acceptance', true)
  const snapshot = payload?.snapshot
  if (!snapshot?.process || !snapshot?.runtime) {
    throw new Error(`desktop acceptance diagnostics are unavailable: ${safe(payload)}`)
  }
  return snapshot
}

function waitForAcceptance(locator, predicate, label) {
  return waitFor(async () => {
    const snapshot = await acceptanceSnapshot(locator).catch(() => undefined)
    return snapshot && predicate(snapshot) ? snapshot : undefined
  }, 60_000, label)
}

function waitForListenerCount(locator, expected) {
  return waitForAcceptance(
    locator,
    (snapshot) => snapshot.runtime.activityListenerCount === expected,
    `activity listener count ${expected}`,
  )
}

async function waitForIdleRuntime(locator, expectedListenerCount) {
  return waitForAcceptance(locator, (snapshot) => (
    snapshot.runtime.aggregatedActiveRunCount === 0
    && snapshot.runtime.currentRunnerActiveRunCount === 0
    && snapshot.runtime.retiredRunnerCount === 0
    && snapshot.runtime.activitySourceCount === 1
    && snapshot.runtime.activityListenerCount === expectedListenerCount
  ), 'idle runtime resource ownership')
}

async function verifySseReconnects(locator, baselineListenerCount, cycles) {
  for (let index = 0; index < cycles; index += 1) {
    await waitForActiveRunSse(locator, () => true)
    await waitForListenerCount(locator, baselineListenerCount)
  }
}

async function waitForActiveRunSse(locator, predicate) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(apiUrl(locator, '/application/active-runs/stream'), {
      headers: authHeaders(locator),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`active run SSE failed: ${response.status}`)
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const event = parseSseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (!event) continue
        if (event.event === 'error') throw new Error(`active run SSE error: ${event.data?.error ?? 'unknown error'}`)
        if (event.event === 'active_runs' && predicate(event.data?.runs ?? [])) return event.data.runs
      }
    }
    throw new Error('active run SSE ended before the expected snapshot')
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function assertIdleRuntime(snapshot, label) {
  assertRuntimeCounts(snapshot, {
    aggregatedActiveRunCount: 0,
    currentRunnerActiveRunCount: 0,
    retiredRunnerCount: 0,
    activitySourceCount: 1,
  }, label)
  for (const key of ['rssBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes']) {
    if (!Number.isSafeInteger(snapshot.process[key]) || snapshot.process[key] < 0) {
      throw new Error(`${label} has invalid process resource ${key}: ${safe(snapshot.process)}`)
    }
  }
}

function assertRuntimeCounts(snapshot, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (snapshot.runtime[key] !== value) {
      throw new Error(`${label} runtime ${key} expected ${value}, received ${snapshot.runtime[key]}: ${safe(snapshot.runtime)}`)
    }
  }
}

function assertRecoverableStop(result, label) {
  if (result?.status !== 'aborted' || !result.runCheckpointId) {
    throw new Error(`${label} did not produce a recoverable checkpoint: ${safe(result)}`)
  }
}

function assertSuccessfulRun(result, provider, model, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safe(result)}`)
  if (result.replyProvenance?.source !== 'llm'
    || result.replyProvenance.provider !== provider
    || result.replyProvenance.model !== model) {
    throw new Error(`${label} reply provenance is invalid: ${safe(result.replyProvenance)}`)
  }
}

/**
 * The two fixture steps completed, judged by what the run actually did.
 *
 * This used to require `taskBook.steps` and `taskExecution.steps` with a
 * `toolProposal` per step. The TaskBook step executor and its proposal
 * bookkeeping were deleted with the second execution system, so nothing writes
 * those records for an ordinary run any more and the assertion could never pass —
 * measured when this gate was re-run: every clause was unsatisfiable while the
 * run itself had done the work. The evidence that survives is the artifact and the
 * invocation record, which is what a concurrency check needs anyway.
 */
function assertCompletedTwoStepTask(result, fixture, label, workspaceRoot) {
  const invocations = result.toolInvocations ?? []
  const successfulNames = invocations
    .filter((record) => record.status === 'succeeded')
    .map((record) => record.toolName)
  if (successfulNames.filter((name) => name === 'write').length !== 1
    || successfulNames.filter((name) => name === 'read').length !== 1
    || successfulNames.some((name) => name !== 'write' && name !== 'read')) {
    throw new Error(`${label} did not execute exactly one write and read: ${safe(invocations)}`)
  }
  if (invocations.some((record) => record.approval?.decision !== 'not_required')) {
    throw new Error(`${label} unexpectedly requested approval inside the LS container: ${safe(invocations)}`)
  }
  if (!(result.sideEffects ?? []).some((effect) => effect.status === 'succeeded')) {
    throw new Error(`${label} lacks a completed side-effect record: ${safe(result.sideEffects)}`)
  }
  const written = join(workspaceRoot, fixture.fileName)
  if (!existsSync(written)) {
    throw new Error(`${label} never created ${fixture.fileName}`)
  }
  const content = readFileSync(written, 'utf8').trim()
  if (content !== fixture.code) {
    throw new Error(`${label} wrote ${JSON.stringify(content)} instead of the fixture code`)
  }
  if (!fixture.fileName || !fixture.code) throw new Error(`${label} fixture is invalid`)
}

function assertSingleGlob(result) {
  const invocations = result.toolInvocations ?? []
  if (invocations.length !== 1
    || invocations[0]?.toolName !== 'glob'
    || invocations[0]?.status !== 'succeeded'
    || invocations[0]?.approval?.decision !== 'not_required') {
    throw new Error(`parallel glob task did not execute exactly once: ${safe(invocations)}`)
  }
}

function assertModePermission(result, behaviorMode, permissionPolicy, label) {
  if (result.resolvedRunConfig?.behaviorModeId !== behaviorMode
    || result.resolvedRunConfig?.permissionPolicyId !== permissionPolicy) {
    throw new Error(`${label} mixed behavior profile and permission policy: ${safe(result.resolvedRunConfig)}`)
  }
}

function assertReplyContainsTask(result, fixture, label) {
  const reply = result.reply
  if (typeof reply !== 'string' || !reply.includes(fixture.fileName) || !reply.includes(fixture.code)) {
    throw new Error(`${label} reply omitted ${fixture.fileName} or ${fixture.code}: ${safe({
      reply,
      classification: result.classification,
      replyProvenance: result.replyProvenance,
      trace: result.trace,
      continuity: result.memoryContinuityAssessment,
    })}`)
  }
}

function assertNoRepeatedTools(result, label) {
  if ((result.toolInvocations?.length ?? 0) !== 0) {
    throw new Error(`${label} repeated completed checkpoint tools: ${safe(result.toolInvocations)}`)
  }
}

function assertSupportedContinuity(result, label) {
  const assessment = result.memoryContinuityAssessment
  if (assessment?.status !== 'supported'
    || !assessment.matchedSources?.some((source) => source === 'recent_history' || source === 'session_summary')) {
    throw new Error(`${label} is not supported by its final answer: ${safe({
      reply: result.reply,
      assessment,
    })}`)
  }
}

async function fileSnapshot(workplaceDir, fileName) {
  const path = join(workplaceDir, fileName)
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)])
  return {
    path,
    content: bytes.toString('utf8'),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function assertFileSnapshot(snapshot, expectedContent, label) {
  if (snapshot.content !== expectedContent) {
    throw new Error(`${label} content mismatch: ${safe(snapshot)}`)
  }
}

function assertUnchangedFile(before, after, label) {
  if (before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed a completed side effect during resume: ${safe({ before, after })}`)
  }
}

async function assertSinglePersistedInbound(locator, sessionId, prompt) {
  const payload = await getJson(locator, `/sessions/${encodeURIComponent(sessionId)}/messages?limit=240`, true)
  const count = (payload.messages ?? []).filter((message) => (
    message.role === 'user' && messageText(message) === prompt
  )).length
  if (count !== 1) throw new Error(`checkpoint resume persisted the original inbound ${count} times`)
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function requestMetrics(runLabel, result) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  return (result.modelRequests ?? []).map((request) => {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    return {
      key: request.id ?? `${result.runId}:${request.requestIndex}`,
      runLabel,
      runStatus: result.status,
      index: request.requestIndex,
      purpose: request.callContract?.purpose ?? request.stage,
      stage: request.stage,
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
  return [...unique.values()].sort((left, right) => (
    left.runLabel.localeCompare(right.runLabel) || left.index - right.index
  ))
}

function assertLocalProviderAccounting(requests) {
  const observed = requests.filter((request) => Number.isSafeInteger(request.providerPromptTokens))
  if (observed.length === 0) throw new Error('parallel DeepSeek acceptance recorded no Provider usage')
  for (const request of observed) {
    if (!Number.isSafeInteger(request.providerCompletionTokens) || request.providerCompletionTokens < 0
      || request.localAccuracy !== 'exact'
      || request.calibration !== 'exact_match'
      || request.localPromptTokens !== request.providerPromptTokens) {
      throw new Error(`request ${request.key} is not locally exact against Provider usage: ${safe(request)}`)
    }
  }
}

function summarizeProxyAccounting(requests) {
  const forwarded = requests.filter((request) => request.forwarded)
  const withUsage = forwarded.filter((request) => request.usage)
  return {
    attemptedRequests: requests.length,
    forwardedRequests: forwarded.length,
    abortedBeforeForward: requests.filter((request) => request.aborted && !request.forwarded).length,
    forwardedWithoutUsage: forwarded.filter((request) => !request.usage).length,
    promptTokens: withUsage.reduce((total, request) => total + request.usage.promptTokens, 0),
    completionTokens: withUsage.reduce((total, request) => total + request.usage.completionTokens, 0),
    totalTokens: withUsage.reduce((total, request) => total + request.usage.totalTokens, 0),
    requests: requests.map((request) => ({
      id: request.id,
      model: request.model,
      delayMs: request.delayMs,
      forwarded: request.forwarded,
      aborted: request.aborted,
      status: request.status,
      usage: request.usage,
      startedAt: request.startedAt,
      forwardedAt: request.forwardedAt,
      completedAt: request.completedAt,
    })),
  }
}

function sumObservedProviderUsage(requests) {
  return requests.reduce((totals, request) => ({
    promptTokens: totals.promptTokens + (request.providerPromptTokens ?? 0),
    completionTokens: totals.completionTokens + (request.providerCompletionTokens ?? 0),
    totalTokens: totals.totalTokens + (request.providerTotalTokens ?? 0),
    requestsWithUsage: totals.requestsWithUsage + (Number.isSafeInteger(request.providerPromptTokens) ? 1 : 0),
    requestsWithoutUsage: totals.requestsWithoutUsage + (Number.isSafeInteger(request.providerPromptTokens) ? 0 : 1),
  }), {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requestsWithUsage: 0,
    requestsWithoutUsage: 0,
  })
}

async function readExecutionLogs(dataDir, runIds) {
  const root = join(dataDir, 'execution-logs')
  const available = new Set(await readdir(root))
  const logs = []
  for (const runId of runIds) {
    const file = `${runId}.json`
    if (!available.has(file)) throw new Error(`execution log is missing for ${runId}`)
    logs.push(JSON.parse(await readFile(join(root, file), 'utf8')))
  }
  return logs
}

function assertRuntimeResourceLogs(logs, expectedCount) {
  if (logs.length !== expectedCount) throw new Error(`expected ${expectedCount} execution logs, received ${logs.length}`)
  for (const log of logs) {
    const resources = log.runtimeResources
    if (!resources?.start || !resources?.end) {
      throw new Error(`execution log ${log.runId} lacks runtime resource samples`)
    }
    for (const sample of [resources.start, resources.end]) {
      if (!Number.isSafeInteger(sample.rssBytes) || sample.rssBytes <= 0
        || !Number.isSafeInteger(sample.heapUsedBytes) || sample.heapUsedBytes <= 0) {
        throw new Error(`execution log ${log.runId} has invalid runtime resource data: ${safe(resources)}`)
      }
    }
  }
}

function assertBoundedMemoryGrowth(baseline, settled) {
  const rssGrowth = settled.process.rssBytes - baseline.process.rssBytes
  const heapGrowth = settled.process.heapUsedBytes - baseline.process.heapUsedBytes
  if (rssGrowth > MEMORY_GROWTH_BUDGET.rssBytes || heapGrowth > MEMORY_GROWTH_BUDGET.heapUsedBytes) {
    throw new Error(`bounded parallel load exceeded the memory growth budget: ${safe({
      baseline: baseline.process,
      settled: settled.process,
      rssGrowth,
      heapGrowth,
      budget: MEMORY_GROWTH_BUDGET,
    })}`)
  }
}

function summarizeAcceptance(snapshot) {
  return {
    sampledAt: snapshot.sampledAt,
    windowVisible: snapshot.windowVisible,
    process: snapshot.process,
    runtime: snapshot.runtime,
  }
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

function observeRejection(promise) {
  void promise.catch(() => undefined)
  return promise
}

main().catch((error) => {
  console.error(JSON.stringify({
    check: 'electron-deepseek-parallel-load',
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
