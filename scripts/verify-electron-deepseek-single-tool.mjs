import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_EXIT_TIMEOUT_MS,
  createIsolatedDeepSeekEnvironment,
  desktopAction,
  forceTerminate,
  locatorRelativePath,
  removeEnvironment,
  runStream,
  startElectron,
  waitForDesktop,
  waitForExit,
  waitForLocator,
  waitForMissing,
} from './lib/electron-deepseek-acceptance.mjs'

const AUTONOMOUS_READ = process.argv.includes('--autonomous-read')
  || process.argv.includes('--provider-tool-loop')
const CHECK_NAME = AUTONOMOUS_READ
  ? 'electron-deepseek-autonomous-read'
  : 'electron-deepseek-single-tool'
const SCENARIO = AUTONOMOUS_READ
  ? 'llm_selected_single_read_only_glob'
  : 'explicit_single_read_only_glob'
const PROMPT = AUTONOMOUS_READ
  ? '请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。'
  : '请使用 glob 工具读取当前工作区顶层条目，只告诉我数量和名称，不要修改任何文件。'
const EXPECTED_ENTRIES = ['alpha.txt', 'beta.md', 'nested']
// Keep a little headroom for tokenizer/provider metadata while catching a
// regression toward the pre-optimization 1,021 prompt-token baseline.
const MAX_COMPACT_DECIDE_PROMPT_TOKENS = 500
const MAX_COMPACT_DECIDE_CONTEXT_CHARS = 2_200
const MAX_COMPACT_FINAL_PROMPT_TOKENS = 450
const MAX_COMPACT_FINAL_CONTEXT_CHARS = 2_000
const MAX_OPTIMIZED_TOTAL_PROMPT_TOKENS = 950
const MAX_AUTONOMOUS_READ_MODEL_CALLS = 2
// The autonomous path must remain materially below the former 2,325-prompt-token
// three-call baseline while keeping schemas, permissions, evidence, and VERIFY.
const MAX_AUTONOMOUS_DECIDE_PROMPT_TOKENS = 900
const MAX_AUTONOMOUS_FINAL_PROMPT_TOKENS = 450
const MAX_AUTONOMOUS_TOTAL_PROMPT_TOKENS = 1_400

async function main() {
  const environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-deepseek-single-tool-',
    maxModelCallsPerRun: AUTONOMOUS_READ ? MAX_AUTONOMOUS_READ_MODEL_CALLS : 4,
  })
  let electron
  let report

  try {
    await prepareFixture(environment.workplaceDir)
    const before = await snapshotTree(environment.workplaceDir)
    electron = startElectron(environment)
    const locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)

    const streamed = await runStream(locator, {
      text: PROMPT,
      permissionMode: 'full',
      workspace: environment.workplaceDir,
    })
    const after = await snapshotTree(environment.workplaceDir)
    const requests = requestMetrics(streamed.result)
    assertSuccessfulRun(streamed.result, environment.model, requests, AUTONOMOUS_READ)
    assertSingleGlobExecution(streamed.result)
    assertStructuralVerification(streamed.result)
    assertWorkspaceUnchanged(before, after)
    assertReply(streamed.result.reply)
    assertProviderUsage(requests)
    if (AUTONOMOUS_READ) assertAutonomousReadPath(requests)
    else assertOptimizedPath(requests)

    await desktopAction(locator, 'quit')
    await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
    await waitForMissing(join(environment.dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    electron = undefined

    report = {
      check: CHECK_NAME,
      ok: true,
      provider: 'deepseek',
      model: environment.model,
      scenario: SCENARIO,
      prompt: PROMPT,
      result: {
        status: streamed.result.status,
        durationMs: streamed.result.durationMs,
        modelCalls: requests.length,
        toolCalls: streamed.result.toolInvocations.length,
        verification: streamed.result.verificationHistory.at(-1),
        behaviorMode: streamed.result.resolvedRunConfig.behaviorModeId,
        permissionPolicy: streamed.result.resolvedRunConfig.permissionPolicyId,
        replyProvenance: streamed.result.replyProvenance,
        memoryContinuity: streamed.result.memoryContinuityAssessment,
      },
      providerTotals: sumProviderUsage(requests),
      efficiency: {
        promptTokens: requests.reduce(
          (total, request) => total + (request.providerPromptTokens ?? 0),
          0,
        ),
        completionTokens: requests.reduce(
          (total, request) => total + (request.providerCompletionTokens ?? 0),
          0,
        ),
        modelCalls: requests.length,
        toolCalls: streamed.result.toolInvocations.length,
        regressionCeilings: AUTONOMOUS_READ
          ? {
              modelCalls: MAX_AUTONOMOUS_READ_MODEL_CALLS,
              decidePromptTokens: MAX_AUTONOMOUS_DECIDE_PROMPT_TOKENS,
              finalPromptTokens: MAX_AUTONOMOUS_FINAL_PROMPT_TOKENS,
              totalPromptTokens: MAX_AUTONOMOUS_TOTAL_PROMPT_TOKENS,
            }
          : {
              decidePromptTokens: MAX_COMPACT_DECIDE_PROMPT_TOKENS,
              finalPromptTokens: MAX_COMPACT_FINAL_PROMPT_TOKENS,
              totalPromptTokens: MAX_OPTIMIZED_TOTAL_PROMPT_TOKENS,
            },
      },
      requests,
      toolInvocations: streamed.result.toolInvocations.map((record) => ({
        toolName: record.toolName,
        status: record.status,
        approval: record.approval,
        durationMs: record.durationMs,
      })),
      sseEvents: summarizeEvents(streamed.events),
      workspaceDigest: after.digest,
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

async function prepareFixture(workplaceDir) {
  await mkdir(join(workplaceDir, 'nested'), { recursive: true })
  await Promise.all([
    writeFile(join(workplaceDir, 'alpha.txt'), 'alpha\n', 'utf8'),
    writeFile(join(workplaceDir, 'beta.md'), '# beta\n', 'utf8'),
    writeFile(join(workplaceDir, 'nested', 'ignored.txt'), 'nested\n', 'utf8'),
  ])
}

async function snapshotTree(root) {
  const entries = []
  async function walk(current, prefix = '') {
    const children = await readdir(current, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name
      if (child.isDirectory()) {
        entries.push({ path: `${relative}/`, kind: 'directory' })
        await walk(join(current, child.name), relative)
      } else if (child.isFile()) {
        const bytes = await readFile(join(current, child.name))
        entries.push({
          path: relative,
          kind: 'file',
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  await walk(root)
  return {
    entries,
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}

function assertSuccessfulRun(result, model, requests, autonomousRead) {
  if (result?.status !== 'ok') throw new Error(`single-tool run failed: ${safe(result)}`)
  if (result.replyProvenance?.source !== 'llm'
    || result.replyProvenance.provider !== 'deepseek'
    || result.replyProvenance.model !== model) {
    throw new Error(`final reply is not traceable to the expected DeepSeek model: ${safe(result.replyProvenance)}`)
  }
  if (result.resolvedRunConfig?.behaviorModeId !== 'general'
    || result.resolvedRunConfig?.permissionPolicyId !== 'full') {
    throw new Error(`behavior profile and permission policy are not orthogonal: ${safe(result.resolvedRunConfig)}`)
  }
  if (!result.taskBook || result.taskBook.steps?.length !== 1) {
    throw new Error(`single-tool run did not retain one valid TaskBook step: ${safe(result.taskBook)}`)
  }
  const step = result.taskBook.steps[0]
  if (autonomousRead) {
    if (step?.toolProposal?.name !== 'glob'
      || step?.tools?.length !== 1
      || step.tools[0] !== 'glob') {
      throw new Error(`autonomous read did not retain the DECIDE glob proposal: ${safe({
        step,
        requests,
      })}`)
    }
  } else if (step?.toolProposal?.name !== 'glob') {
    throw new Error(`single-tool run did not retain the DECIDE glob proposal: ${safe({
      step,
      decideRequest: requests.find((request) => request.purpose === 'decide_explicit_tool'),
    })}`)
  }
  const expectedReplyPurpose = 'execute_final_reply'
  if (result.replyProvenance?.purpose !== expectedReplyPurpose) {
    throw new Error(`single-tool final reply came from an unexpected API call: ${safe({
      expectedReplyPurpose,
      provenance: result.replyProvenance,
    })}`)
  }
}

function assertSingleGlobExecution(result) {
  const invocations = result.toolInvocations ?? []
  if (invocations.length !== 1
    || invocations[0]?.toolName !== 'glob'
    || invocations[0]?.status !== 'succeeded') {
    throw new Error(`expected exactly one successful glob invocation: ${safe(invocations)}`)
  }
  if (invocations[0].approval?.decision !== 'not_required') {
    throw new Error(`container-local read unexpectedly required approval: ${safe(invocations[0].approval)}`)
  }
  const step = result.taskExecution?.steps?.[0]
  if (result.taskExecution?.status !== 'done'
    || step?.status !== 'done'
    || step.toolCallIds?.length !== 1
    || step.toolResults?.length !== 1
    || step.toolResults[0]?.ok !== true) {
    throw new Error(`TaskBook execution evidence is incomplete: ${safe(result.taskExecution)}`)
  }
}

function assertStructuralVerification(result) {
  const verification = result.verificationHistory?.at(-1)
  if (verification?.source !== 'structural' || verification.verdict !== 'pass') {
    throw new Error(`single-tool task did not use structural verification: ${safe(verification)}`)
  }
}

function assertWorkspaceUnchanged(before, after) {
  if (before.digest !== after.digest) {
    throw new Error(`read-only run changed the workspace: before=${before.digest}; after=${after.digest}`)
  }
}

function assertReply(reply) {
  if (typeof reply !== 'string') throw new Error('single-tool reply is missing')
  for (const entry of EXPECTED_ENTRIES) {
    if (!reply.includes(entry)) throw new Error(`single-tool reply omitted ${entry}: ${reply}`)
  }
  if (!/(?:3|三)\s*(?:个|項|项|entries|items)?/iu.test(reply)) {
    throw new Error(`single-tool reply did not report three top-level entries: ${reply}`)
  }
}

function requestMetrics(result) {
  const snapshots = new Map((result.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]))
  return (result.modelRequests ?? []).map((request) => {
    const snapshot = request.contextSnapshotId ? snapshots.get(request.contextSnapshotId) : undefined
    const includedItems = (snapshot?.items ?? [])
      .filter((item) => item.disposition === 'included')
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        characterCount: item.characterCount,
        source: item.source,
      }))
    return {
      index: request.requestIndex,
      purpose: request.callContract?.purpose ?? request.stage,
      stage: request.stage,
      totalMessageCount: request.totalMessageCount,
      toolNames: request.toolNames,
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
      includedCharacterCount: includedItems.reduce(
        (total, item) => total + (item.characterCount ?? 0),
        0,
      ),
      includedItems,
      explicitToolContractIncluded: snapshot?.items?.some((item) => (
        item.disposition === 'included'
        && item.source?.kind === 'workflow'
        && item.source.id === 'explicit-tool-proposal-contract'
      )) ?? false,
      compactReadContractIncluded: snapshot?.items?.some((item) => (
        item.disposition === 'included'
        && item.source?.kind === 'workflow'
        && item.source.id === 'compact-read-only-decision-contract'
      )) ?? false,
    }
  })
}

function assertProviderUsage(requests) {
  if (requests.length === 0) throw new Error('single-tool run recorded no model requests')
  for (const request of requests) {
    if (!Number.isSafeInteger(request.providerPromptTokens) || request.providerPromptTokens <= 0
      || !Number.isSafeInteger(request.providerCompletionTokens) || request.providerCompletionTokens < 0) {
      throw new Error(`request ${request.index} is missing authoritative Provider usage: ${safe(request)}`)
    }
    if (request.localAccuracy === 'exact' && request.calibration !== 'exact_match') {
      throw new Error(`request ${request.index} local exact count drifted from Provider usage: ${safe(request)}`)
    }
    if (request.localAccuracy !== 'exact'
      || request.calibration !== 'exact_match'
      || request.localPromptTokens !== request.providerPromptTokens) {
      throw new Error(`request ${request.index} was not locally exact against Provider usage: ${safe(request)}`)
    }
    if ((request.toolNames?.length ?? 0) !== 0) {
      throw new Error(`request ${request.index} unexpectedly used Provider tool protocol: ${safe({
        request,
        requests,
      })}`)
    }
  }
}

function assertAutonomousReadPath(requests) {
  const purposes = requests.map((request) => request.purpose)
  if (requests.length !== MAX_AUTONOMOUS_READ_MODEL_CALLS
    || purposes[0] !== 'decide'
    || purposes[1] !== 'execute_final_reply') {
    throw new Error(`unexpected autonomous-read model-call sequence: ${safe(purposes)}`)
  }
  const decide = requests[0]
  if (!decide.compactReadContractIncluded) {
    throw new Error(`autonomous DECIDE omitted the compact read contract: ${safe(decide)}`)
  }
  if (decide.providerPromptTokens > MAX_AUTONOMOUS_DECIDE_PROMPT_TOKENS) {
    throw new Error(`autonomous DECIDE exceeded its measured ceiling: ${safe(decide)}`)
  }
  const finalReply = requests[1]
  if (finalReply.providerPromptTokens > MAX_AUTONOMOUS_FINAL_PROMPT_TOKENS) {
    throw new Error(`autonomous final reply exceeded its measured ceiling: ${safe(finalReply)}`)
  }
  const totalPromptTokens = requests.reduce(
    (total, request) => total + (request.providerPromptTokens ?? 0),
    0,
  )
  if (totalPromptTokens > MAX_AUTONOMOUS_TOTAL_PROMPT_TOKENS) {
    throw new Error(`autonomous read prompt cost regressed beyond its measured ceiling: ${safe({
      totalPromptTokens,
      requests,
    })}`)
  }
  assertCompactContext(decide, 'autonomous DECIDE')
}

function assertOptimizedPath(requests) {
  const purposes = requests.map((request) => request.purpose)
  if (requests.length !== 2
    || purposes[0] !== 'decide_explicit_tool'
    || purposes[1] !== 'execute_final_reply') {
    throw new Error(`unexpected optimized model-call sequence: ${safe(purposes)}`)
  }
  const decide = requests[0]
  if (decide.providerPromptTokens > MAX_COMPACT_DECIDE_PROMPT_TOKENS
    || decide.includedCharacterCount > MAX_COMPACT_DECIDE_CONTEXT_CHARS) {
    throw new Error(`compact DECIDE exceeded its measured cost ceiling: ${safe(decide)}`)
  }
  const finalReply = requests[1]
  if (finalReply.providerPromptTokens > MAX_COMPACT_FINAL_PROMPT_TOKENS
    || finalReply.includedCharacterCount > MAX_COMPACT_FINAL_CONTEXT_CHARS) {
    throw new Error(`compact final reply exceeded its measured cost ceiling: ${safe(finalReply)}`)
  }
  const totalPromptTokens = requests.reduce(
    (total, request) => total + (request.providerPromptTokens ?? 0),
    0,
  )
  if (totalPromptTokens > MAX_OPTIMIZED_TOTAL_PROMPT_TOKENS) {
    throw new Error(`optimized single-tool prompt cost regressed: ${safe({ totalPromptTokens, requests })}`)
  }
  assertCompactContext(decide, 'compact explicit DECIDE')
}

function assertCompactContext(request, label) {
  const forbiddenIds = new Set([
    'core-flow',
    'tooling',
    'memory-root-index',
    'output-directives',
    'bootstrap:AGENTS.md',
    'bootstrap:USER.md',
    'bootstrap:TOOLS.md',
  ])
  const forbiddenKinds = new Set(['memory_index', 'memory_fragment', 'summary_memory', 'recent_message'])
  const forbidden = request.includedItems.filter((item) => (
    forbiddenIds.has(item.id) || forbiddenKinds.has(item.kind)
  ))
  if (forbidden.length > 0) {
    throw new Error(`${label} retained unrelated Context: ${safe(forbidden)}`)
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

function summarizeEvents(events) {
  const counts = {}
  for (const event of events) counts[event.event] = (counts[event.event] ?? 0) + 1
  return counts
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
    check: CHECK_NAME,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
