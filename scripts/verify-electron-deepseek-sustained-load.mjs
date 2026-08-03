// Real Electron + DeepSeek sustained background acceptance. The long-running
// work is a single bounded exec call, so elapsed time tests Runtime ownership
// without repeatedly spending Provider tokens.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_EXIT_TIMEOUT_MS,
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

const FIXTURE_SCRIPT = 'sustained-load-fixture.ps1'
const COUNT_FILE = 'sustained-execution-count.txt'
const PROGRESS_FILE = 'sustained-progress.log'
const PROGRESS_STATE_FILE = 'sustained-progress-state.json'
const PROOF_FILE = 'sustained-proof.json'
const ACCEPTANCE_CODE = 'sustained-deepseek-anchor-8426'
const RESOURCE_GROWTH_BUDGET = {
  rssBytes: 256 * 1024 * 1024,
  heapUsedBytes: 128 * 1024 * 1024,
  electronWorkingSetBytes: 512 * 1024 * 1024,
  activeHandleCount: 24,
  activeRequestCount: 8,
  electronProcessCount: 2,
}

const options = parseOptions(process.argv.slice(2))
const durationMs = options.durationSeconds * 1_000
const toolTimeoutMs = Math.min(30 * 60_000, durationMs + 120_000)
const runTimeoutMs = toolTimeoutMs + 240_000
const command = `& .\\${FIXTURE_SCRIPT} -DurationSeconds ${options.durationSeconds} -IntervalMilliseconds ${options.progressIntervalMs} -Anchor '${ACCEPTANCE_CODE}'`
const taskPrompt = `这是一次真实的持续后台任务验收。请只使用 exec 工具执行下面这一条命令，不能使用其他工具，也不能把命令拆成多次调用：\n${command}\n\n请保留一个 TaskBook 步骤；toolProposal.input.command 必须完整等于上面的命令，cwd 设为 "."，timeout_ms 设为 ${toolTimeoutMs}。该步骤 execution.mode 设为 serial、execution.sideEffect 设为 external、execution.resources 设为空数组。命令会在工作区内持续写入有界进度，并自行返回 JSON 结果。最终回答必须分别说明验收代号 ${ACCEPTANCE_CODE}、executionCount、ticks 和 completed 状态。`
const recallPrompt = `请根据上一轮真实完成结果，分别回答验收代号和 executionCount（用数字），不要调用工具。`

async function main() {
  let hotReloadModel
  const environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-deepseek-sustained-load-',
    maxModelCallsPerRun: 10,
    runTimeoutSeconds: Math.ceil(runTimeoutMs / 1_000),
    toolInvocationTimeoutMs: toolTimeoutMs,
    configureConfig(config) {
      const initialModel = config.providers[0].models?.[0]
      hotReloadModel = initialModel === 'deepseek-v4-pro' ? 'deepseek-v4-flash' : 'deepseek-v4-pro'
      config.providers[0].models = [...new Set([...(config.providers[0].models ?? []), hotReloadModel])]
      config.desktop.closePolicy = 'always-background'
      config.agents.defaults.timeoutSeconds = Math.ceil(runTimeoutMs / 1_000)
      config.tools.invocationTimeoutMs = toolTimeoutMs
      return config
    },
  })
  let electron
  let activeMonitor
  let activeRunSseSummary
  let report

  try {
    await writeFixtureScript(environment.workplaceDir)
    const fixtureBefore = await fileSnapshot(environment.workplaceDir, FIXTURE_SCRIPT)

    electron = startElectron(environment)
    let locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)

    const startup = await acceptanceSnapshot(locator)
    assertIdleRuntime(startup, 'startup')
    const startupListenerCount = startup.runtime.activityListenerCount

    activeMonitor = startActiveRunMonitor(locator)
    await activeMonitor.ready
    await waitForListenerCount(locator, startupListenerCount + 1)

    const run = startBoundedRunStream(locator, runBody(taskPrompt, environment.workplaceDir), runTimeoutMs)
    const runId = await run.started
    await waitForRunIds(locator, [runId])
    const progressStarted = await waitForProgressStart(environment.workplaceDir)
    const observedStartedAtMs = Date.parse(progressStarted.startedAt)
    if (!Number.isFinite(observedStartedAtMs)) {
      throw new Error(`fixture start time is invalid: ${safe(progressStarted)}`)
    }

    await desktopAction(locator, 'close')
    const hidden = await waitForAcceptance(locator, (snapshot) => (
      !snapshot.windowVisible && snapshot.runtime.aggregatedActiveRunCount === 1
    ), 'hidden window with sustained task')

    const hotRuntime = await postJson(locator, '/runtime', {
      model: `deepseek/${hotReloadModel}`,
      profile: 'coding',
    }, true)
    if (hotRuntime.profile !== 'coding' || hotRuntime.model !== `deepseek/${hotReloadModel}`) {
      throw new Error(`runtime profile hot reload failed: ${safe(hotRuntime)}`)
    }
    const hotReloaded = await waitForAcceptance(locator, (snapshot) => (
      snapshot.runtime.aggregatedActiveRunCount === 1
      && snapshot.runtime.currentRunnerActiveRunCount === 0
      && snapshot.runtime.retiredRunnerCount === 1
      && snapshot.runtime.activitySourceCount === 2
      && snapshot.runtime.activityListenerCount === startupListenerCount + 1
    ), 'hot-reloaded runtime retaining the sustained task')

    const resources = createResourceAggregate({
      expectedListenerCount: startupListenerCount + 1,
      maxSourceCount: 2,
      maxRetiredRunnerCount: 1,
    })
    const observedCompletion = observeCompletion(run.completion)
    const transientPauseAtMs = observedStartedAtMs + Math.max(2_000, Math.floor(durationMs * 0.2))
    const finalPauseAtMs = observedStartedAtMs + Math.max(5_000, Math.floor(durationMs * 0.7))
    let transientPauseRequestedAt
    let resumedAt
    let transientPausedRun
    let resumedRun
    let pauseRequestedAt
    while (!observedCompletion.done()) {
      const [snapshot, progress] = await Promise.all([
        acceptanceSnapshot(locator),
        readProgressState(environment.workplaceDir).catch(() => undefined),
      ])
      resources.add(snapshot, progress)
      if (!transientPauseRequestedAt && Date.now() >= transientPauseAtMs) {
        const outcome = await controlRun(locator, runId, 'pause')
        if (outcome.outcome?.kind !== 'accepted') {
          throw new Error(`transient pause request was not accepted: ${safe(outcome)}`)
        }
        transientPausedRun = await waitForActiveRunControlStatus(locator, runId, 'pause_requested')
        transientPauseRequestedAt = new Date().toISOString()

        const resumeOutcome = await controlRun(locator, runId, 'resume')
        if (resumeOutcome.outcome?.kind !== 'accepted') {
          throw new Error(`in-process resume request was not accepted: ${safe(resumeOutcome)}`)
        }
        resumedRun = await waitForActiveRunControlStatus(locator, runId, 'running')
        resumedAt = new Date().toISOString()
      }
      if (resumedAt && !pauseRequestedAt && Date.now() >= finalPauseAtMs) {
        const outcome = await controlRun(locator, runId, 'pause')
        if (outcome.outcome?.kind !== 'accepted') {
          throw new Error(`final pause request was not accepted: ${safe(outcome)}`)
        }
        await waitForActiveRunControlStatus(locator, runId, 'pause_requested')
        pauseRequestedAt = new Date().toISOString()
      }
      await Promise.race([observedCompletion.settled, delay(options.sampleIntervalMs)])
    }
    const initial = await observedCompletion.value()
    if (!transientPauseRequestedAt || !resumedAt || !transientPausedRun || !resumedRun) {
      throw new Error('sustained run finished before the in-process pause/resume cycle completed')
    }
    if (!pauseRequestedAt) throw new Error('sustained run finished before the pause request boundary')
    assertPausedSustainedRun(initial.result, environment.model)
    resources.add(await acceptanceSnapshot(locator), await readProgressState(environment.workplaceDir))
    resources.assertHealthy()

    const taskArtifacts = await sustainedArtifactSnapshot(environment.workplaceDir)
    assertSustainedArtifacts(taskArtifacts, options.durationSeconds, options.progressIntervalMs)
    assertUnchangedFile(fixtureBefore, await fileSnapshot(environment.workplaceDir, FIXTURE_SCRIPT), 'fixture script')
    if (!activeMonitor.summary().observedRunIds.includes(runId)
      || activeMonitor.summary().maxActiveRuns < 1
      || activeMonitor.summary().eventCount < 2) {
      throw new Error(`active-run SSE did not continuously observe the task: ${safe(activeMonitor.summary())}`)
    }

    activeRunSseSummary = activeMonitor.summary()
    await activeMonitor.stop()
    activeMonitor = undefined
    await waitForListenerCount(locator, startupListenerCount)
    const preCrashSettled = await waitForIdleRuntime(locator, startupListenerCount)
    assertBoundedResourceGrowth(startup, preCrashSettled, 'pre-crash sustained idle')

    const restoredRuntime = await postJson(locator, '/runtime', {
      model: `deepseek/${environment.model}`,
      profile: 'coding',
    }, true)
    if (restoredRuntime.model !== `deepseek/${environment.model}`
      || restoredRuntime.profile !== 'coding') {
      throw new Error(`checkpoint-compatible runtime restore failed: ${safe(restoredRuntime)}`)
    }
    const preCrashRestored = await waitForIdleRuntime(locator, startupListenerCount)
    assertBoundedResourceGrowth(startup, preCrashRestored, 'pre-crash restored runtime idle')
    const checkpointBeforeRestart = await waitForCheckpoint(locator, initial.result.runCheckpointId)
    if (!checkpointBeforeRestart.resumable || checkpointBeforeRestart.status !== 'paused') {
      throw new Error(`sustained checkpoint is not resumable after restoring its model: ${safe(checkpointBeforeRestart)}`)
    }

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
      throw new Error(`checkpoint-compatible runtime configuration did not survive restart: ${safe(runtimeAfterRestart)}`)
    }

    const checkpoint = await waitForCheckpoint(locator, initial.result.runCheckpointId)
    if (!checkpoint.resumable || checkpoint.status !== 'paused') {
      throw new Error(`sustained checkpoint is not resumable after restart: ${safe(checkpoint)}`)
    }
    const resumed = await readSse(
      locator,
      `/run-checkpoints/${encodeURIComponent(checkpoint.id)}/resume/stream`,
      { reason: 'real DeepSeek sustained-load acceptance resume' },
      runTimeoutMs,
    )
    assertSuccessfulRun(resumed.result, environment.model, 'resumed sustained task')
    assertReplyContainsFacts(resumed.result.reply, 'resumed sustained task')
    assertNoRepeatedTools(resumed.result, 'resumed sustained task')
    assertModePermission(resumed.result, 'general', 'full', 'resumed sustained task')
    assertUnchangedArtifacts(taskArtifacts, await sustainedArtifactSnapshot(environment.workplaceDir), 'checkpoint resume')
    await assertSinglePersistedInbound(locator, resumed.result.sessionId, taskPrompt)

    const recallRuntime = await postJson(locator, '/runtime', {
      model: `deepseek/${hotReloadModel}`,
      profile: 'coding',
    }, true)
    if (recallRuntime.model !== `deepseek/${hotReloadModel}` || recallRuntime.profile !== 'coding') {
      throw new Error(`memory-recall model switch failed: ${safe(recallRuntime)}`)
    }
    const preRecallSettled = await waitForIdleRuntime(locator, restartListenerCount)

    const recalled = await runStream(locator, runBody(
      recallPrompt,
      environment.workplaceDir,
      resumed.result.sessionId,
    ), runTimeoutMs)
    assertSuccessfulRun(recalled.result, hotReloadModel, 'sustained task memory recall')
    assertReplyContainsFacts(recalled.result.reply, 'sustained task memory recall')
    assertSupportedContinuity(
      recalled.result,
      'sustained task memory recall',
      resumed.result.reply,
    )
    assertModePermission(recalled.result, 'coding', 'full', 'sustained task memory recall')
    if ((recalled.result.toolInvocations?.length ?? 0) !== 0) {
      throw new Error(`memory recall unexpectedly used tools: ${safe(recalled.result.toolInvocations)}`)
    }

    await waitForIdleRuntime(locator, restartListenerCount)
    const finalSettled = await acceptanceSnapshot(locator)
    assertIdleRuntime(finalSettled, 'final settled runtime')
    assertBoundedResourceGrowth(postRestart, finalSettled, 'post-restart settled runtime')
    assertUnchangedArtifacts(taskArtifacts, await sustainedArtifactSnapshot(environment.workplaceDir), 'memory recall')

    const labeledResults = [
      ['paused', initial.result],
      ['resumed', resumed.result],
      ['recall', recalled.result],
    ]
    const requests = uniqueRequestMetrics(labeledResults)
    assertCompletedProviderUsage(requests)
    const logs = await readExecutionLogs(environment.dataDir, labeledResults.map(([, result]) => result.runId))
    assertRuntimeResourceLogs(logs, labeledResults.length)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    const toolRecord = initial.result.toolInvocations?.find((record) => record.toolName === 'exec')
    report = {
      check: 'electron-deepseek-sustained-load',
      ok: true,
      evidenceClass: options.durationSeconds >= 60 ? 'minutes-scale' : 'diagnostic-short-run',
      provider: 'deepseek',
      model: environment.model,
      hotReloadModel,
      configuredDurationSeconds: options.durationSeconds,
      progressIntervalMs: options.progressIntervalMs,
      sampleIntervalMs: options.sampleIntervalMs,
      scenarios: [
        'single_real_exec_sustained_work',
        'bounded_resource_sampling',
        'active_run_sse_continuous_observation',
        'close_to_tray_while_running',
        'model_and_profile_hot_reload_with_retired_runner',
        'in_process_pause_resume_without_stopping_tool',
        'pause_requested_during_tool_and_applied_at_safe_boundary',
        'checkpoint_model_restored_before_restart',
        'forced_termination_restart',
        'checkpoint_resume_without_repeating_side_effect',
        'cross_model_answer_level_memory_recall',
        'answer_level_memory_continuity',
        'listener_runner_handle_and_memory_release',
        'explicit_quit',
      ],
      task: {
        runId: initial.result.runId,
        sessionId: initial.result.sessionId,
        status: initial.result.status,
        checkpointId: initial.result.runCheckpointId,
        transientPauseRequestedAt,
        transientPauseStatus: transientPausedRun.controlStatus,
        resumedAt,
        resumedStatus: resumedRun.controlStatus,
        pauseRequestedAt,
        toolDurationMs: toolRecord?.durationMs,
        taskBookSteps: initial.result.taskBook?.steps?.length ?? 0,
        executionSteps: initial.result.taskExecution?.steps?.length ?? 0,
        modelCallsBeforePause: initial.result.modelRequests?.length ?? 0,
        modelCallPurposesBeforePause: initial.result.modelRequests?.map((request) => request.callContract?.purpose ?? request.stage) ?? [],
        toolInvocations: initial.result.toolInvocations?.map((record) => ({
          toolName: record.toolName,
          status: record.status,
          approval: record.approval,
          durationMs: record.durationMs,
        })) ?? [],
      },
      artifacts: {
        executionCount: taskArtifacts.executionCount,
        progressLines: taskArtifacts.progressLines,
        progress: taskArtifacts.progress,
        proof: taskArtifacts.proof,
        hashes: taskArtifacts.files.map((file) => ({ fileName: file.fileName, sha256: file.sha256, size: file.size })),
      },
      activeRunSse: activeRunSseSummary,
      sampling: resources.summary(),
      continuity: recalled.result.memoryContinuityAssessment,
      providerAccounting: summarizeProviderAccounting(requests),
      requests,
      resources: {
        startup: summarizeAcceptance(startup),
        hidden: summarizeAcceptance(hidden),
        hotReloaded: summarizeAcceptance(hotReloaded),
        preCrashSettled: summarizeAcceptance(preCrashSettled),
        preCrashRestored: summarizeAcceptance(preCrashRestored),
        postRestart: summarizeAcceptance(postRestart),
        preRecallSettled: summarizeAcceptance(preRecallSettled),
        finalSettled: summarizeAcceptance(finalSettled),
        executionLogs: logs.map((log) => ({
          runId: log.runId,
          status: log.status,
          runtimeResources: log.runtimeResources,
        })),
      },
      copiedChromiumFiles: environment.copiedChromiumFiles,
    }
  } finally {
    await activeMonitor?.stop().catch(() => undefined)
    if (electron?.exitCode === null) await forceTerminate(electron)
    await removeEnvironment(environment.root)
  }

  console.log(JSON.stringify({
    ...report,
    isolatedDataRemoved: !existsSync(environment.root),
  }))
}

function parseOptions(args) {
  const values = {
    durationSeconds: 120,
    sampleIntervalMs: 1_000,
    progressIntervalMs: 1_000,
  }
  for (const arg of args) {
    const [name, rawValue] = arg.split('=', 2)
    if (name === '--duration-seconds') values.durationSeconds = boundedInteger(rawValue, 15, 1_200, name)
    else if (name === '--sample-ms') values.sampleIntervalMs = boundedInteger(rawValue, 250, 10_000, name)
    else if (name === '--progress-ms') values.progressIntervalMs = boundedInteger(rawValue, 250, 10_000, name)
    else throw new Error(`unsupported argument: ${arg}`)
  }
  return values
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

async function writeFixtureScript(workplaceDir) {
  const script = `param(
  [Parameter(Mandatory = $true)][int]$DurationSeconds,
  [Parameter(Mandatory = $true)][int]$IntervalMilliseconds,
  [Parameter(Mandatory = $true)][string]$Anchor
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$countPath = Join-Path (Get-Location) '${COUNT_FILE}'
$progressPath = Join-Path (Get-Location) '${PROGRESS_FILE}'
$statePath = Join-Path (Get-Location) '${PROGRESS_STATE_FILE}'
$proofPath = Join-Path (Get-Location) '${PROOF_FILE}'
$executionCount = 0
if (Test-Path -LiteralPath $countPath) {
  [void][int]::TryParse(([IO.File]::ReadAllText($countPath)).Trim(), [ref]$executionCount)
}
$executionCount += 1
[IO.File]::WriteAllText($countPath, [string]$executionCount, $utf8)
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$ticks = [Math]::Max(1, [Math]::Ceiling(($DurationSeconds * 1000.0) / $IntervalMilliseconds))
[IO.File]::WriteAllText($progressPath, "start|$startedAt|$Anchor|$executionCount" + [Environment]::NewLine, $utf8)
$state = [ordered]@{ anchor = $Anchor; executionCount = $executionCount; tick = 0; totalTicks = $ticks; startedAt = $startedAt; completed = $false }
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), $utf8)
for ($tick = 1; $tick -le $ticks; $tick += 1) {
  Start-Sleep -Milliseconds $IntervalMilliseconds
  $sampledAt = [DateTimeOffset]::UtcNow.ToString('o')
  [IO.File]::AppendAllText($progressPath, "tick|$tick|$sampledAt" + [Environment]::NewLine, $utf8)
  $state = [ordered]@{ anchor = $Anchor; executionCount = $executionCount; tick = $tick; totalTicks = $ticks; startedAt = $startedAt; sampledAt = $sampledAt; completed = $false }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), $utf8)
}
$endedAt = [DateTimeOffset]::UtcNow.ToString('o')
$proof = [ordered]@{ anchor = $Anchor; executionCount = $executionCount; ticks = $ticks; startedAt = $startedAt; endedAt = $endedAt; completed = $true }
$payload = $proof | ConvertTo-Json -Compress
[IO.File]::WriteAllText($proofPath, $payload, $utf8)
$state = [ordered]@{ anchor = $Anchor; executionCount = $executionCount; tick = $ticks; totalTicks = $ticks; startedAt = $startedAt; sampledAt = $endedAt; endedAt = $endedAt; completed = $true }
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Compress), $utf8)
[IO.File]::AppendAllText($progressPath, "done|$ticks|$endedAt" + [Environment]::NewLine, $utf8)
Write-Output $payload
`
  await writeFile(join(workplaceDir, FIXTURE_SCRIPT), script, 'utf8')
}

function runBody(text, workspace, sessionId) {
  return {
    text,
    ...(sessionId ? { sessionId } : {}),
    permissionMode: 'full',
    workspace,
  }
}

function startBoundedRunStream(locator, body, timeoutMs) {
  let startedResolved = false
  let resolveStarted
  let rejectStarted
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  const completion = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const eventCounts = Object.create(null)
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
          incrementBoundedCounter(eventCounts, event.event)
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
  void started.catch(() => undefined)
  void completion.catch(() => undefined)
  return { started, completion }
}

function observeCompletion(promise) {
  let done = false
  let outcome
  let resolveSettled
  const settled = new Promise((resolve) => { resolveSettled = resolve })
  promise.then(
    (value) => {
      outcome = { ok: true, value }
      done = true
      resolveSettled()
    },
    (error) => {
      outcome = { ok: false, error }
      done = true
      resolveSettled()
    },
  )
  return {
    done: () => done,
    settled,
    async value() {
      await settled
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },
  }
}

function startActiveRunMonitor(locator) {
  const controller = new AbortController()
  let stopped = false
  let readyResolved = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const state = {
    eventCount: 0,
    maxActiveRuns: 0,
    observedRunIds: new Set(),
    lastPublishedAt: undefined,
  }
  const completion = (async () => {
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
          if (event.event !== 'active_runs') continue
          const runs = Array.isArray(event.data?.runs) ? event.data.runs : []
          state.eventCount += 1
          state.maxActiveRuns = Math.max(state.maxActiveRuns, runs.length)
          state.lastPublishedAt = new Date().toISOString()
          for (const run of runs) {
            if (state.observedRunIds.size >= 16) break
            if (typeof run?.runId === 'string') state.observedRunIds.add(run.runId)
          }
          if (!readyResolved) {
            readyResolved = true
            resolveReady()
          }
        }
      }
      if (!stopped) throw new Error('active run SSE ended unexpectedly')
    } catch (error) {
      if (!stopped) {
        if (!readyResolved) rejectReady(error)
        throw error
      }
    }
  })()
  void ready.catch(() => undefined)
  void completion.catch(() => undefined)
  return {
    ready,
    summary: () => ({
      eventCount: state.eventCount,
      maxActiveRuns: state.maxActiveRuns,
      observedRunIds: [...state.observedRunIds],
      lastPublishedAt: state.lastPublishedAt,
    }),
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      await completion.catch(() => undefined)
    },
  }
}

function createResourceAggregate(expectations) {
  const metricNames = [
    'rssBytes',
    'heapUsedBytes',
    'activeHandleCount',
    'activeRequestCount',
    'electronWorkingSetBytes',
    'electronPrivateBytes',
    'electronProcessCount',
    'activeRunCount',
    'retiredRunnerCount',
    'sourceCount',
    'listenerCount',
    'progressTick',
  ]
  const minimum = Object.fromEntries(metricNames.map((name) => [name, Number.POSITIVE_INFINITY]))
  const maximum = Object.fromEntries(metricNames.map((name) => [name, Number.NEGATIVE_INFINITY]))
  let first
  let last
  let count = 0
  let previousTick = -1
  const violations = []
  return {
    add(snapshot, progress) {
      const sample = flattenSample(snapshot, progress)
      if (!first) first = sample
      last = sample
      count += 1
      for (const name of metricNames) {
        const value = sample[name]
        if (!Number.isFinite(value) || value < 0) rememberViolation(`${name} is invalid: ${value}`)
        minimum[name] = Math.min(minimum[name], value)
        maximum[name] = Math.max(maximum[name], value)
      }
      if (sample.progressTick < previousTick) rememberViolation(`progress tick regressed from ${previousTick} to ${sample.progressTick}`)
      previousTick = Math.max(previousTick, sample.progressTick)
      if (sample.activeRunCount > 1) rememberViolation(`active run count exceeded 1: ${sample.activeRunCount}`)
      if (sample.sourceCount > expectations.maxSourceCount) rememberViolation(`activity source count exceeded ${expectations.maxSourceCount}: ${sample.sourceCount}`)
      if (sample.retiredRunnerCount > expectations.maxRetiredRunnerCount) rememberViolation(`retired runner count exceeded ${expectations.maxRetiredRunnerCount}: ${sample.retiredRunnerCount}`)
      if (sample.listenerCount > expectations.expectedListenerCount) rememberViolation(`activity listener count exceeded ${expectations.expectedListenerCount}: ${sample.listenerCount}`)
    },
    assertHealthy() {
      if (count < 2) throw new Error(`sustained sampling retained too few aggregate samples: ${count}`)
      if (violations.length > 0) throw new Error(`sustained resource sampling failed: ${safe(violations)}`)
    },
    summary() {
      return {
        sampleCount: count,
        first,
        last,
        minimum,
        maximum,
        violations,
      }
    },
  }

  function rememberViolation(message) {
    if (violations.length < 16 && !violations.includes(message)) violations.push(message)
  }
}

function flattenSample(snapshot, progress) {
  return {
    sampledAt: snapshot.sampledAt,
    rssBytes: snapshot.process.rssBytes,
    heapUsedBytes: snapshot.process.heapUsedBytes,
    activeHandleCount: snapshot.process.activeHandleCount,
    activeRequestCount: snapshot.process.activeRequestCount,
    electronWorkingSetBytes: snapshot.electron.workingSetBytes,
    electronPrivateBytes: snapshot.electron.privateBytes,
    electronProcessCount: snapshot.electron.processCount,
    activeRunCount: snapshot.runtime.aggregatedActiveRunCount,
    retiredRunnerCount: snapshot.runtime.retiredRunnerCount,
    sourceCount: snapshot.runtime.activitySourceCount,
    listenerCount: snapshot.runtime.activityListenerCount,
    progressTick: Number.isSafeInteger(progress?.tick) ? progress.tick : 0,
  }
}

async function waitForProgressStart(workplaceDir) {
  return waitFor(async () => {
    const state = await readProgressState(workplaceDir).catch(() => undefined)
    return state?.anchor === ACCEPTANCE_CODE && state.executionCount === 1 ? state : undefined
  }, 60_000, 'sustained exec progress start')
}

async function readProgressState(workplaceDir) {
  return parseJsonFile(join(workplaceDir, PROGRESS_STATE_FILE))
}

async function parseJsonFile(path) {
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '').trim()
  return JSON.parse(text)
}

async function sustainedArtifactSnapshot(workplaceDir) {
  const [countText, progressText, progress, proof, files] = await Promise.all([
    readFile(join(workplaceDir, COUNT_FILE), 'utf8'),
    readFile(join(workplaceDir, PROGRESS_FILE), 'utf8'),
    readProgressState(workplaceDir),
    parseJsonFile(join(workplaceDir, PROOF_FILE)),
    Promise.all([COUNT_FILE, PROGRESS_FILE, PROGRESS_STATE_FILE, PROOF_FILE]
      .map((fileName) => fileSnapshot(workplaceDir, fileName))),
  ])
  return {
    executionCount: Number(countText.replace(/^\uFEFF/u, '').trim()),
    progressLines: progressText.trim().split(/\r?\n/u).filter(Boolean).length,
    progress,
    proof,
    files,
  }
}

function assertSustainedArtifacts(snapshot, configuredDurationSeconds, intervalMs) {
  const expectedTicks = Math.max(1, Math.ceil((configuredDurationSeconds * 1_000) / intervalMs))
  if (snapshot.executionCount !== 1
    || snapshot.proof?.anchor !== ACCEPTANCE_CODE
    || snapshot.proof?.executionCount !== 1
    || snapshot.proof?.ticks !== expectedTicks
    || snapshot.proof?.completed !== true
    || snapshot.progress?.anchor !== ACCEPTANCE_CODE
    || snapshot.progress?.executionCount !== 1
    || snapshot.progress?.tick !== expectedTicks
    || snapshot.progress?.totalTicks !== expectedTicks
    || snapshot.progress?.completed !== true
    || snapshot.progressLines !== expectedTicks + 2) {
    throw new Error(`sustained artifacts are inconsistent: ${safe({ snapshot, expectedTicks })}`)
  }
}

function assertPausedSustainedRun(result, model) {
  if (result?.status !== 'aborted' || !result.runCheckpointId) {
    throw new Error(`pause did not produce a recoverable sustained checkpoint: ${safe(result)}`)
  }
  const invocations = result.toolInvocations ?? []
  const execRecords = invocations.filter((record) => record.toolName === 'exec')
  if (invocations.length !== 1
    || execRecords.length !== 1
    || execRecords[0].status !== 'succeeded'
    || execRecords[0].approval?.decision !== 'not_required'
    || !Number.isFinite(execRecords[0].durationMs)
    || execRecords[0].durationMs < durationMs * 0.85) {
    throw new Error(`sustained task did not execute exactly one successful long exec: ${safe(invocations)}`)
  }
  if (result.taskExecution?.status !== 'done'
    || result.taskExecution.steps?.length !== 1
    || result.taskExecution.steps[0]?.status !== 'done') {
    throw new Error(`sustained TaskBook step did not finish before the pause boundary: ${safe(result.taskExecution)}`)
  }
  if (result.runtimeControl?.state !== 'paused'
    || (result.runtimeControl.eventIds?.length ?? 0) < 3) {
    throw new Error(`pause/resume/pause events were not applied at the safe boundary: ${safe(result.runtimeControl)}`)
  }
  const sideEffects = result.sideEffects ?? []
  if (sideEffects.length !== 1
    || sideEffects[0]?.toolName !== 'exec'
    || sideEffects[0]?.status !== 'succeeded'
    || sideEffects[0]?.effectKind !== 'external') {
    throw new Error(`sustained exec side effect is not durably complete: ${safe(sideEffects)}`)
  }
  const proposal = result.taskBook?.steps?.[0]?.toolProposal
  if (proposal?.name !== 'exec'
    || proposal.input?.command !== command
    || proposal.input?.timeout_ms !== toolTimeoutMs) {
    throw new Error(`DeepSeek did not retain the exact sustained exec proposal: ${safe(proposal)}`)
  }
  const purposes = result.modelRequests?.map((request) => request.callContract?.purpose ?? request.stage) ?? []
  if (purposes.length !== 1 || purposes[0] !== 'decide') {
    throw new Error(`sustained task used extra Provider calls before pause: ${safe({
      purposes,
      classification: result.classification,
      resolvedRunConfig: result.resolvedRunConfig,
      taskBook: result.taskBook,
      taskExecution: result.taskExecution,
      toolInvocations: result.toolInvocations,
    })}`)
  }
  assertModePermission(result, 'general', 'full', 'sustained task before pause')
  if (result.replyProvenance || result.reply?.trim()) {
    throw new Error(`paused run published a premature user-facing reply: ${safe({ reply: result.reply, provenance: result.replyProvenance })}`)
  }
  const decision = requestMetrics('paused', result)
  if (decision.length !== 1 || decision[0]?.provider !== 'deepseek' || decision[0]?.model !== model) {
    throw new Error(`sustained DECIDE request provenance is invalid: ${safe(decision)}`)
  }
}

function assertSuccessfulRun(result, model, label) {
  if (result?.status !== 'ok') throw new Error(`${label} failed: ${safe(result)}`)
  if (result.replyProvenance?.source !== 'llm'
    || result.replyProvenance.provider !== 'deepseek'
    || result.replyProvenance.model !== model) {
    throw new Error(`${label} reply provenance is invalid: ${safe(result.replyProvenance)}`)
  }
}

function assertReplyContainsFacts(reply, label) {
  if (typeof reply !== 'string'
    || !reply.includes(ACCEPTANCE_CODE)
    || !/(?:executionCount\D{0,12}1|执行次数\D{0,12}1|一次)/iu.test(reply)) {
    throw new Error(`${label} omitted the sustained acceptance code or executionCount=1: ${safe(reply)}`)
  }
}

function assertNoRepeatedTools(result, label) {
  if ((result.toolInvocations?.length ?? 0) !== 0) {
    throw new Error(`${label} repeated completed checkpoint tools: ${safe(result.toolInvocations)}`)
  }
}

function assertSupportedContinuity(result, label, sourceReply) {
  const assessment = result.memoryContinuityAssessment
  if (assessment?.status !== 'supported'
    || !assessment.matchedSources?.some((source) => source === 'recent_history' || source === 'session_summary')) {
    throw new Error(`${label} is not supported by its final answer: ${safe({ sourceReply, reply: result.reply, assessment })}`)
  }
}

function assertModePermission(result, behaviorMode, permissionPolicy, label) {
  if (result.resolvedRunConfig?.behaviorModeId !== behaviorMode
    || result.resolvedRunConfig?.permissionPolicyId !== permissionPolicy) {
    throw new Error(`${label} mixed behavior profile and permission policy: ${safe(result.resolvedRunConfig)}`)
  }
}

async function fileSnapshot(workplaceDir, fileName) {
  const path = join(workplaceDir, fileName)
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)])
  return {
    fileName,
    content: bytes.toString('utf8'),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function assertUnchangedFile(before, after, label) {
  if (before.sha256 !== after.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed unexpectedly: ${safe({ before, after })}`)
  }
}

function assertUnchangedArtifacts(before, after, label) {
  if (before.executionCount !== after.executionCount) {
    throw new Error(`${label} changed the execution count: ${safe({ before: before.executionCount, after: after.executionCount })}`)
  }
  const afterByName = new Map(after.files.map((file) => [file.fileName, file]))
  for (const file of before.files) {
    const candidate = afterByName.get(file.fileName)
    if (!candidate) throw new Error(`${label} removed ${file.fileName}`)
    assertUnchangedFile(file, candidate, `${label} ${file.fileName}`)
  }
}

async function waitForRunIds(locator, runIds) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/active-runs').catch(() => undefined)
    return runIds.every((runId) => payload?.runs?.some((run) => run.runId === runId))
      ? payload.runs
      : undefined
  }, 60_000, `active runs ${runIds.join(', ')}`)
}

async function waitForActiveRunControlStatus(locator, runId, controlStatus) {
  return waitFor(async () => {
    const payload = await getJson(locator, '/application/active-runs').catch(() => undefined)
    const run = payload?.runs?.find((candidate) => candidate.runId === runId)
    return run?.controlStatus === controlStatus ? run : undefined
  }, 10_000, `active run ${runId} control status ${controlStatus}`)
}

function controlRun(locator, runId, action) {
  return postJson(locator, `/application/active-runs/${encodeURIComponent(runId)}/control`, {
    action,
    reason: `real DeepSeek sustained-load acceptance ${action}`,
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
  if (!snapshot?.process || !snapshot?.electron || !snapshot?.runtime) {
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

function waitForIdleRuntime(locator, expectedListenerCount) {
  return waitForAcceptance(locator, (snapshot) => (
    snapshot.runtime.aggregatedActiveRunCount === 0
    && snapshot.runtime.currentRunnerActiveRunCount === 0
    && snapshot.runtime.retiredRunnerCount === 0
    && snapshot.runtime.activitySourceCount === 1
    && snapshot.runtime.activityListenerCount === expectedListenerCount
  ), 'idle sustained runtime resource ownership')
}

function assertIdleRuntime(snapshot, label) {
  const expected = {
    aggregatedActiveRunCount: 0,
    currentRunnerActiveRunCount: 0,
    retiredRunnerCount: 0,
    activitySourceCount: 1,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (snapshot.runtime[key] !== value) {
      throw new Error(`${label} runtime ${key} expected ${value}, received ${snapshot.runtime[key]}: ${safe(snapshot.runtime)}`)
    }
  }
  for (const value of [
    snapshot.process.rssBytes,
    snapshot.process.heapUsedBytes,
    snapshot.process.activeHandleCount,
    snapshot.process.activeRequestCount,
    snapshot.electron.processCount,
    snapshot.electron.workingSetBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} has invalid resource data: ${safe(snapshot)}`)
  }
}

function assertBoundedResourceGrowth(baseline, settled, label) {
  const growth = {
    rssBytes: settled.process.rssBytes - baseline.process.rssBytes,
    heapUsedBytes: settled.process.heapUsedBytes - baseline.process.heapUsedBytes,
    electronWorkingSetBytes: settled.electron.workingSetBytes - baseline.electron.workingSetBytes,
    activeHandleCount: settled.process.activeHandleCount - baseline.process.activeHandleCount,
    activeRequestCount: settled.process.activeRequestCount - baseline.process.activeRequestCount,
    electronProcessCount: settled.electron.processCount - baseline.electron.processCount,
  }
  for (const [key, value] of Object.entries(growth)) {
    if (value > RESOURCE_GROWTH_BUDGET[key]) {
      throw new Error(`${label} exceeded ${key} growth budget: ${safe({ growth, budget: RESOURCE_GROWTH_BUDGET, baseline, settled })}`)
    }
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
      provider: request.provider,
      model: request.model,
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

function assertCompletedProviderUsage(requests) {
  if (requests.length === 0) throw new Error('sustained acceptance recorded no Provider requests')
  for (const request of requests) {
    if (request.provider !== 'deepseek'
      || !Number.isSafeInteger(request.providerPromptTokens)
      || request.providerPromptTokens <= 0
      || !Number.isSafeInteger(request.providerCompletionTokens)
      || request.providerCompletionTokens < 0) {
      throw new Error(`request ${request.key} lacks authoritative DeepSeek usage: ${safe(request)}`)
    }
    if (request.localAccuracy === 'exact'
      && (request.calibration !== 'exact_match' || request.localPromptTokens !== request.providerPromptTokens)) {
      throw new Error(`request ${request.key} local exact count drifted from Provider usage: ${safe(request)}`)
    }
  }
}

function summarizeProviderAccounting(requests) {
  return requests.reduce((totals, request) => ({
    requests: totals.requests + 1,
    promptTokens: totals.promptTokens + (request.providerPromptTokens ?? 0),
    completionTokens: totals.completionTokens + (request.providerCompletionTokens ?? 0),
    totalTokens: totals.totalTokens + (request.providerTotalTokens ?? 0),
  }), { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
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

function summarizeAcceptance(snapshot) {
  return {
    sampledAt: snapshot.sampledAt,
    windowVisible: snapshot.windowVisible,
    process: snapshot.process,
    electron: snapshot.electron,
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

function incrementBoundedCounter(counters, name) {
  if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1
  else if (Object.keys(counters).length < 32) counters[name] = 1
  else counters.__other = (counters.__other ?? 0) + 1
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    check: 'electron-deepseek-sustained-load',
    ok: false,
    configuredDurationSeconds: options.durationSeconds,
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
