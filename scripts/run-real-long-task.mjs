// Frozen real-long-task driver for the session-cumulative cache red line
// (docs/taskbooks/real-long-task-cache-taskbook-2026-09-22.md, LT-00 / LT-07).
//
// It runs one frozen task (scripts/lib/real-long-task-manifest.mjs) against the real
// DeepSeek provider inside an isolated data root: the frozen business turns run
// sequentially in ONE session, the session-cumulative H_ui (the ratio the DeepSeek
// Harness front end shows) is judged at the nodes frozen BEFORE the run, detached
// auxiliary calls stay visible in H_all, and the task's artifacts are verified in the
// seeded workspace. A sample below the red line is recorded, never hidden: the JSON
// report is written for every live run.
//
// Usage:  node scripts/run-real-long-task.mjs --task A1 [--attempt 1] [--keep-data] [--json <path>] [--report <path>]
//         node scripts/run-real-long-task.mjs --dry-run --task A1   # offline self-check
// Exit:   0 = acceptance passed && every frozen node complete && hitPercent >= 95 && every turn ok;
//         1 = any of those failed (the JSON report is still written); 2 = usage/argument error.
// Data:   the isolated root is deleted only when the run failed before any model call and
//         --keep-data was not passed; otherwise it is kept as baseline evidence (path on stdout).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import {
  DEFAULT_EXIT_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS, createIsolatedDeepSeekEnvironment, desktopAction, forceTerminate,
  locatorRelativePath, removeEnvironment, runStream, startElectron, waitForDesktop, waitForExit, waitForLocator, waitForMissing,
} from './lib/electron-deepseek-acceptance.mjs'
import { judgeNodes, projectSessions, readLedger } from './lib/session-cache-ledger.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_TIMEOUT_SECONDS = 300
const RUN_TIMEOUT_MS = Math.max(DEFAULT_RUN_TIMEOUT_MS, RUN_TIMEOUT_SECONDS * 1_000)
const ACCEPTANCE_TIMEOUT_MS = 120_000
const DETAIL_LIMIT = 400
const EXIT_RULE = 'acceptance 全部通过 && 每个冻结节点 availability=complete && hitPercent>=95 && 每个回合 status=ok'
const TIMEOUT_PATTERN = /timeout|timed out|超时/i
// A dropped connection is a transport failure, not a semantic one: a 28-turn run
// hit `TypeError: terminated` (undici's "connection closed before the response
// completed") and the old pattern called it semantic, so the whole long task
// stopped after five good turns.
const TRANSPORT_PATTERN = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|SSE|stream (ended|closed)|aborted|interrupted|terminated|other side closed|UND_ERR|premature close/i
const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g
const USAGE = '用法：node scripts/run-real-long-task.mjs --task <id> [--attempt <n>] [--keep-data]'
  + ' [--json <path>] [--report <path>] [--dry-run] [--compaction-threshold <n> --compaction-keep-recent <n>]\n'
  + '  --task 必填（A1/A2/B1/B2/C1/C2）；--attempt 正整数标签（默认 1）；--keep-data 始终保留隔离数据根；\n'
  + '  --json JSON 报告（默认 .codex_tmp/real-long-task-<id>-<attempt>.json）；--report 额外写 Markdown 摘要；\n'
  + '  --dry-run 只校验冻结清单并打印冻结计划，不建环境、不启 Electron、不联网；\n'
  + '  --compaction-threshold/--compaction-keep-recent 是**诊断专用**覆盖：冻结清单从未达到 100/20 阈值，\n'
  + '    只有压低阈值才能观察到真实压缩路径；报告会标记 diagnostic=true，此类运行不参与红线判定。'

let activeChild

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

async function main() {
  installInterruptHandler()
  const options = parseArgs(process.argv.slice(2))
  const manifest = await loadManifest()
  const { task, taskSet } = resolveTask(manifest, options.taskId)
  const plan = frozenPlanFor(manifest, task)
  assertFrozenManifest(manifest, task, taskSet)
  if (options.dryRun) return printDryRun(task, plan, manifest)
  const report = await runLive({ options, task, plan, manifest, taskSet })
  const paths = await writeReports(report, options)
  console.log(summaryLines(report, true).join('\n'))
  console.log(`JSON 报告：${paths.jsonPath}${paths.markdownPath ? `\nMarkdown 报告：${paths.markdownPath}` : ''}`)
  if (!report.ok) process.exitCode = 1
}

function parseArgs(argv) {
  const options = { attempt: 1, keepData: false, dryRun: false }
  const flags = {
    '--task': 'taskId',
    '--attempt': 'attempt',
    '--json': 'json',
    '--report': 'report',
    '--compaction-threshold': 'compactionThreshold',
    '--compaction-keep-recent': 'compactionKeepRecent',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--keep-data' || name === '--dry-run') {
      options[name === '--keep-data' ? 'keepData' : 'dryRun'] = true
      continue
    }
    if (!flags[name] || index + 1 >= argv.length) throw new CliError(`未知参数或缺少取值：${name}\n${USAGE}`)
    options[flags[name]] = argv[++index]
  }
  if (typeof options.taskId !== 'string' || options.taskId.trim() === '') throw new CliError(`缺少必填参数 --task\n${USAGE}`)
  options.taskId = options.taskId.trim()
  if (!/^[1-9][0-9]*$/.test(String(options.attempt))) throw new CliError(`--attempt 必须是正整数，当前为 ${options.attempt}`)
  options.attempt = Number(options.attempt)
  for (const [flag, key] of [['--compaction-threshold', 'compactionThreshold'], ['--compaction-keep-recent', 'compactionKeepRecent']]) {
    if (options[key] === undefined) continue
    if (!/^[1-9][0-9]*$/.test(String(options[key]))) throw new CliError(`${flag} 必须是正整数，当前为 ${options[key]}`)
    options[key] = Number(options[key])
  }
  return options
}

const FROZEN_EXPORTS = ['FROZEN_PROVIDER', 'FROZEN_MODEL', 'FROZEN_CONFIG', 'longTaskById', 'frozenPlanFor', 'validateManifest']

async function loadManifest() {
  let manifest
  try {
    manifest = await import('./lib/real-long-task-manifest.mjs')
  } catch (error) {
    throw new CliError(`无法加载冻结任务清单 scripts/lib/real-long-task-manifest.mjs：${errorText(error)}`)
  }
  const missing = FROZEN_EXPORTS.filter((name) => manifest[name] === undefined)
  if (missing.length > 0) throw new CliError(`冻结任务清单缺少导出：${missing.join(', ')}`)
  // The long-interval set is optional and additive: it shares the frozen provider,
  // model and configuration, and exists because the three-turn frozen tasks never
  // reach the session-compaction threshold.
  let longInterval
  try {
    longInterval = await import('./lib/long-interval-task.mjs')
  } catch {
    longInterval = undefined
  }
  return { ...manifest, longInterval }
}

/** An unknown id is a usage error: list the frozen ids instead of a stack trace. */
function resolveTask(manifest, taskId) {
  try {
    return { task: manifest.longTaskById(taskId), taskSet: 'frozen' }
  } catch {
    if (manifest.longInterval?.longIntervalTaskById) {
      try {
        return { task: manifest.longInterval.longIntervalTaskById(taskId), taskSet: 'long-interval' }
      } catch {
        // fall through to the usage error below
      }
    }
    const known = [
      ...(manifest.REAL_LONG_TASKS?.map((task) => task?.id).filter(Boolean) ?? []),
      ...(manifest.longInterval?.LONG_INTERVAL_TASKS?.map((task) => task?.id).filter(Boolean) ?? []),
    ].join(' / ') || '（清单未导出任务集合）'
    throw new CliError(`未知的 --task id：${taskId}；已知 id：${known}`)
  }
}

function frozenPlanFor(manifest, task) {
  try {
    return manifest.frozenPlanFor(task)
  } catch (error) {
    throw new CliError(`冻结计划不可用（任务 ${task?.id}）：${errorText(error)}`)
  }
}

function assertFrozenManifest(manifest, task, taskSet) {
  if (taskSet === 'long-interval') {
    const result = manifest.longInterval?.validateLongIntervalManifest?.()
    if (!result?.ok) {
      throw new CliError(`长区间任务清单校验失败：\n- ${(result?.errors ?? ['缺少 validateLongIntervalManifest']).join('\n- ')}`)
    }
    return
  }
  const full = manifest.validateManifest()
  const single = manifest.validateManifest([task])
  const errors = [
    ...(full?.ok ? [] : full?.errors ?? ['validateManifest() 返回值缺少 errors']),
    ...(single?.ok ? [] : single?.errors ?? ['validateManifest([task]) 返回值缺少 errors']),
  ]
  if (errors.length > 0) throw new CliError(`冻结任务清单校验失败：\n- ${errors.join('\n- ')}`)
}

function planView(plan, manifest) {
  return {
    taskId: plan.taskId ?? null, provider: manifest.FROZEN_PROVIDER, model: plan.model ?? manifest.FROZEN_MODEL,
    config: manifest.FROZEN_CONFIG,
    turns: plan.turns.map((entry) => ({ turn: entry.turn, promptChars: entry.prompt.length })),
    nodes: plan.nodes.map((node) => ({ id: node.id, turn: node.turn, label: node.label })),
    acceptance: plan.acceptance.map((check) => check.label),
    workspaceFiles: plan.workspaceSeed.map((file) => file.path),
  }
}

function printDryRun(task, plan, manifest) {
  const { FROZEN_CONFIG: config, FROZEN_PROVIDER: provider } = manifest
  const target = (check) => (check.kind === 'command' ? ` — ${check.argv.join(' ')}（期望退出码 ${check.expectExitCode}）`
    : check.kind === 'file_exists' ? ` — ${check.path}` : ` — ${check.path}「${head(check.text, 32)}」`)
  console.log([
    'dry-run：validateManifest() 通过，冻结清单与任务 id 有效。',
    `任务：${task.id}（类别 ${task.classId}）${task.title}`,
    `provider=${provider} model=${plan.model} requiresWeb=${task.requiresWeb}`,
    `冻结配置：maxModelCallsPerRun=${config.maxModelCallsPerRun} contextCompressionThresholdRatio=${config.contextCompressionThresholdRatio}`
      + ` compaction=threshold ${config.compaction.threshold} / keepRecent ${config.compaction.keepRecent} / background ${config.compaction.background}`,
    `工作区种子（${plan.workspaceSeed.length}）：${plan.workspaceSeed.map((file) => file.path).join(' / ')}`,
    `回合（${plan.turns.length}）：`,
    ...plan.turns.map((entry) => `  ${entry.turn}. ${head(entry.prompt, 72)}`),
    `冻结节点（${plan.nodes.length}）：`,
    ...plan.nodes.map((node) => `  第 ${node.turn} 回合 ${node.id}：${node.label}`),
    `验收（${plan.acceptance.length}）：`,
    ...plan.acceptance.map((check) => `  [${check.kind}] ${check.label}${target(check)}`),
    'dry-run 未创建隔离数据根、未启动 Electron、未访问网络。',
  ].join('\n'))
}

async function runLive({ options, task, plan, manifest, taskSet = 'frozen' }) {
  const startedAt = Date.now()
  // A diagnostic override exists only to observe the real compaction path: the
  // frozen configuration (100/20) is never reached by these tasks, so the frozen
  // runs show `no-new-range` attempts and no summarizer call. Diagnostic runs are
  // marked in the report and never count as acceptance evidence.
  const diagnostic = options.compactionThreshold !== undefined || options.compactionKeepRecent !== undefined
  const config = diagnostic
    ? {
      ...manifest.FROZEN_CONFIG,
      compaction: {
        ...manifest.FROZEN_CONFIG.compaction,
        ...(options.compactionThreshold === undefined ? {} : { threshold: options.compactionThreshold }),
        ...(options.compactionKeepRecent === undefined ? {} : { keepRecent: options.compactionKeepRecent }),
      },
    }
    : manifest.FROZEN_CONFIG
  const report = {
    check: 'real-long-task', ok: false, taskId: task.id, classId: task.classId, title: task.title, dataRootPath: null,
    attempt: options.attempt, provider: manifest.FROZEN_PROVIDER, model: manifest.FROZEN_MODEL, frozenPlan: planView(plan, manifest),
    taskSet,
    diagnostic,
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationMs: 0,
    environment: { created: false, rootName: null, seededFiles: [], kept: false, removed: false, keepReason: null },
    turns: [], sessionId: null, turnStopReason: null, error: null, cleanupProblems: [], nodes: [], nodeJudgement: null,
    session: null, auxiliary: null, all: null, unattributed: null, ledgerCoverage: null, acceptance: [],
    conclusion: { met: false, target: null, exitRule: EXIT_RULE, reasons: [] },
  }
  let environment
  let electron
  let locator
  try {
    await assertAppBuildFresh(repoRoot)
    environment = await createIsolatedDeepSeekEnvironment({
      prefix: 'littlesheep-real-long-task-',
      model: manifest.FROZEN_MODEL,
      maxModelCallsPerRun: config.maxModelCallsPerRun,
      runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
      configureConfig: (base) => {
        base.agents.defaults.contextCompressionThresholdRatio = config.contextCompressionThresholdRatio
        base.agents.defaults.timeoutSeconds = RUN_TIMEOUT_SECONDS
        base.sessions = { writeLock: { acquireTimeoutMs: 60_000 }, compaction: { ...config.compaction } }
        return base
      },
    })
    report.environment.created = true
    report.environment.rootName = basename(environment.root)
    report.dataRootPath = environment.root
    report.environment.seededFiles = await materializeWorkspace(environment.workplaceDir, plan.workspaceSeed)
    electron = startElectron({ dataDir: environment.dataDir, chromiumDir: environment.chromiumDir, stdio: 'ignore' })
    activeChild = electron
    locator = await waitForLocator(environment.dataDir, electron.pid)
    await waitForDesktop(locator)
    let sessionId
    for (const entry of plan.turns) {
      const record = await runTurn({ locator, workspace: environment.workplaceDir, prompt: entry.prompt, sessionId, turn: entry.turn })
      report.turns.push(record)
      sessionId ??= record.sessionId
      // Only a timeout / transport abort may be survived so the remaining frozen
      // turns still produce evidence; any other failure stops and is reported.
      if (record.ok || record.continuable) continue
      report.turnStopReason = `第 ${entry.turn} 回合以非超时/传输错误失败（${record.failureKind}），按策略停止后续回合`
      break
    }
  } catch (error) {
    report.error = { kind: errorKind(error), message: errorText(error).slice(0, DETAIL_LIMIT * 2) }
  } finally {
    activeChild = undefined
    report.cleanupProblems = await stopElectron({ electron, locator, dataDir: environment?.dataDir })
  }
  if (!environment) return finishReport(report, startedAt)

  try {
    collectLedgerEvidence(report, { plan, environment })
  } catch (error) {
    report.error ??= { kind: errorKind(error), message: `账本评估失败：${errorText(error)}`.slice(0, DETAIL_LIMIT * 2) }
  }
  report.acceptance = evaluateAcceptance(plan.acceptance, environment.workplaceDir)
  // A run that reached the provider keeps its root as baseline evidence; only a
  // failure before any model call may delete it (and never under --keep-data).
  if (options.keepData || report.turns.length > 0) {
    Object.assign(report.environment, {
      kept: true,
      keepReason: options.keepData ? '--keep-data 要求保留' : '已发生模型调用：保留基线与账本证据',
    })
  } else {
    const removed = await removeEnvironment(environment.root).then(() => true, () => false)
    Object.assign(report.environment, {
      removed, kept: !removed,
      keepReason: removed ? '运行在任何模型调用之前失败，按策略删除隔离数据根' : '删除隔离数据根失败',
    })
  }
  return finishReport(report, startedAt)
}

function finishReport(report, startedAt) {
  conclude(report)
  report.durationMs = Date.now() - startedAt
  report.finishedAt = new Date().toISOString()
  return report
}

async function materializeWorkspace(workspace, seed) {
  const written = []
  for (const file of seed) {
    const absolute = workspacePath(workspace, file.path)
    await mkdir(dirname(absolute), { recursive: true })
    // A fresh temp root: an existing file with different content is a driver bug,
    // not a user edit, so refuse instead of silently overwriting it.
    if (!existsSync(absolute)) await writeFile(absolute, file.content, 'utf8')
    else if (await readFile(absolute, 'utf8') !== file.content) {
      throw new Error(`冻结种子文件与隔离工作区里已有内容不一致：${file.path}`)
    }
    written.push(file.path)
  }
  return written
}

function workspacePath(workspace, relativePath) {
  const absolute = resolve(workspace, relativePath)
  const inside = relative(workspace, absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`路径越出隔离工作区：${relativePath}`)
  return absolute
}

async function runTurn({ locator, workspace, prompt, sessionId, turn }) {
  const startedAt = Date.now()
  const body = { text: prompt, ...(sessionId ? { sessionId } : {}), permissionMode: 'full', workspace }
  let result
  let error
  try {
    ({ result } = await runStream(locator, body, RUN_TIMEOUT_MS))
  } catch (cause) {
    error = cause
  }
  const status = typeof result?.status === 'string' ? result.status : (error ? 'error' : 'unknown')
  const failure = !error && status === 'ok' ? undefined : classifyTurnFailure({ error, result })
  return {
    turn, status, ok: failure === undefined, durationMs: Date.now() - startedAt, failureKind: failure?.kind ?? null,
    runId: result?.runId ?? null, sessionId: result?.sessionId ?? sessionId ?? null,
    replyLength: typeof result?.reply === 'string' ? result.reply.length : 0,
    continuable: failure === undefined || failure.continuable, error: failure?.message ?? null,
  }
}

function classifyTurnFailure({ error, result }) {
  const message = [
    error ? `${errorKind(error)}: ${errorText(error)}` : undefined,
    describeError(result?.error),
    typeof result?.failureKind === 'string' ? result.failureKind : undefined,
    typeof result?.status === 'string' ? `status=${result.status}` : undefined,
  ].filter(Boolean).join(' | ').slice(0, 800) || 'run did not succeed'
  const kind = TIMEOUT_PATTERN.test(message) ? 'timeout' : TRANSPORT_PATTERN.test(message) ? 'transport' : 'semantic'
  return { kind, continuable: kind !== 'semantic', message }
}

/** Clean quit first (quit → exit → locator gone), force kill as the fallback. */
async function stopElectron({ electron, locator, dataDir }) {
  const problems = []
  if (!electron) return problems
  try {
    if (locator && dataDir && electron.exitCode === null) {
      await desktopAction(locator, 'quit')
      await waitForExit(electron, DEFAULT_EXIT_TIMEOUT_MS)
      await waitForMissing(join(dataDir, locatorRelativePath), DEFAULT_EXIT_TIMEOUT_MS)
    }
  } catch (error) {
    problems.push(`Electron 未干净退出：${errorText(error)}`.slice(0, DETAIL_LIMIT))
  } finally {
    if (electron.exitCode === null) {
      await forceTerminate(electron).catch((error) => problems.push(`强制终止 Electron 失败：${errorText(error)}`.slice(0, DETAIL_LIMIT)))
    }
  }
  return problems
}

function collectLedgerEvidence(report, { plan, environment }) {
  const ledger = readLedger(environment.dataDir)
  const sessionKey = report.turns.find((turn) => turn.sessionId)?.sessionId
    ?? ledger.runs.find((run) => run.runId === report.turns.find((turn) => turn.runId)?.runId)?.sessionId
  // The frozen nodes live on turns, so the ledger plan carries one entry per turn;
  // a turn without a runId is still passed so its node is reported as missing
  // instead of silently dropping out of the cumulative sum.
  const nodeByTurn = new Map(plan.nodes.map((node) => [node.turn, node]))
  const frozenTurns = plan.turns.map((entry, index) => ({
    turn: entry.turn, id: nodeByTurn.get(entry.turn)?.id ?? `turn-${entry.turn}`,
    label: nodeByTurn.get(entry.turn)?.label, runId: report.turns[index]?.runId,
  }))
  const projection = projectSessions(ledger, { turnsBySession: sessionKey ? { [sessionKey]: frozenTurns } : {} })
  const session = projection.sessions.find((entry) => entry.sessionId === sessionKey)
  report.sessionId = sessionKey ?? null
  report.session = session
    ? { sessionId: session.sessionId, hUiPercent: session.sessionProjection.hitPercent ?? null, ...totalsView(session.sessionProjection) }
    : null
  report.auxiliary = session ? totalsView(session.auxiliary) : null
  report.all = session ? totalsView(session.all) : null
  report.unattributed = totalsView(projection.unattributed)
  report.ledgerCoverage = projection.coverage
  report.nodes = (session?.nodes ?? []).map((node) => ({
    ...node, label: node.label ?? null, runId: node.runId ?? null, hitPercent: node.hitPercent ?? null, withinTarget: node.withinTarget ?? null,
  }))
  // A node whose turn never ran is not a measurement failure: the run stopped
  // earlier. Judging it below target would report failures that were never
  // measured, so those nodes are listed separately.
  const executedTurns = new Set(report.turns.filter((turn) => turn.runId).map((turn) => turn.turn))
  const judged = report.nodes.filter((node) => executedTurns.has(node.turn))
  const notEvaluated = report.nodes
    .filter((node) => !executedTurns.has(node.turn))
    .map((node) => ({ id: node.id, turn: node.turn, reason: 'turn-not-run' }))
  report.nodeJudgement = { ...judgeNodes(judged), notEvaluated }
}

function totalsView(totals) {
  return {
    requests: totals.requests, measuredRequests: totals.measuredRequests, requestsWithoutUsage: totals.requestsWithoutUsage,
    input: totals.input, cached: totals.cached, uncached: totals.uncached, hitPercent: totals.hitPercent ?? null,
  }
}

function evaluateAcceptance(checks, workspace) {
  return checks.map((check) => {
    const base = { label: check.label, kind: check.kind }
    if (check.kind === 'command') return evaluateCommand(check, workspace, base)
    try {
      const absolute = workspacePath(workspace, check.path)
      const exists = existsSync(absolute) && statSync(absolute).isFile()
      if (check.kind === 'file_exists') return { ...base, ok: exists, detail: exists ? check.path : `缺少文件 ${check.path}` }
      const content = readFileSync(absolute, 'utf8')
      const includes = content.includes(check.text)
      if (check.kind === 'file_contains' ? includes : !includes) return { ...base, ok: true, detail: check.path }
      return { ...base, ok: false, detail: `${check.path} ${includes ? '仍包含' : '缺少'}「${head(check.text, 48)}」` }
    } catch (error) {
      // A missing artifact fails every file check: file_contains and
      // file_not_contains both presuppose that the artifact was delivered.
      const detail = error?.code === 'ENOENT' ? `缺少文件 ${check.path}` : `检查失败：${errorText(error)}`
      return { ...base, ok: false, detail: detail.slice(0, DETAIL_LIMIT) }
    }
  })
}

function evaluateCommand(check, workspace, base) {
  const [command, ...args] = check.argv
  const expect = check.expectExitCode ?? 0
  const timeoutMs = check.timeoutMs ?? ACCEPTANCE_TIMEOUT_MS
  try {
    execFileSync(command, args, { cwd: workspace, timeout: timeoutMs, stdio: 'pipe' })
    return expect === 0 ? { ...base, ok: true, detail: '退出码 0' } : { ...base, ok: false, detail: `退出码 0，期望 ${expect}` }
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : undefined
    const output = tail(bufferText(error?.stderr) || bufferText(error?.stdout) || errorText(error), DETAIL_LIMIT)
    if (status !== undefined && status === expect) return { ...base, ok: true, detail: `退出码 ${status}（与期望一致）：${output}` }
    const detail = error?.signal ? `命令被信号 ${error.signal} 终止（timeout=${timeoutMs}ms）`
      : status === undefined ? `命令未运行：${output}` : `退出码 ${status}，期望 ${expect}：${output}`
    return { ...base, ok: false, detail: detail.slice(0, DETAIL_LIMIT) }
  }
}

function conclude(report) {
  const reasons = []
  const add = (condition, message) => condition && reasons.push(message)
  add(report.error, `运行错误：${report.error?.message}`)
  add(report.turns.length === 0, '没有任何回合运行（隔离环境或 Electron 未就绪）')
  for (const turn of report.turns) add(!turn.ok, `第 ${turn.turn} 回合未成功（${turn.status}/${turn.failureKind}）：${turn.error ?? '无错误详情'}`)
  add(report.turnStopReason, report.turnStopReason)
  reasons.push(...report.cleanupProblems)
  const judgement = report.nodeJudgement
  add(!judgement || report.nodes.length === 0, '冻结节点没有被评估（会话或账本缺少可归属的请求）')
  for (const failure of judgement?.failures ?? []) {
    // Only a below-target node carries a ratio comparison; an incomplete node has no
    // verdict at all, so printing "< 95%" next to its partial ratio would lie.
    const percent = typeof failure.hitPercent !== 'number' ? ''
      : failure.reason === 'below target' ? `：累计 ${formatPercent(failure.hitPercent)} < ${judgement.target}%`
        : `：累计 ${formatPercent(failure.hitPercent)}（usage 不完整，不参与判定）`
    reasons.push(`冻结节点 ${failure.id}（第 ${failure.turn} 回合）${failure.reason}${percent}`)
  }
  for (const node of judgement?.notEvaluated ?? []) {
    reasons.push(`冻结节点 ${node.id}（第 ${node.turn} 回合）未评估：该回合没有运行`)
  }
  for (const check of report.acceptance) add(!check.ok, `验收未通过（${check.kind}）${check.label}${check.detail ? `：${check.detail}` : ''}`)
  report.ok = reasons.length === 0
  report.conclusion = {
    met: report.ok, target: judgement?.target ?? null,
    nodeConclusion: judgement?.conclusion ?? null, exitRule: EXIT_RULE, reasons,
  }
}

/** One line list shared by the stdout report and the Markdown summary. */
function summaryLines(report, includeDataRoot) {
  const { config, turns, nodes, acceptance, workspaceFiles } = report.frozenPlan
  const lines = [
    `真实长任务 ${report.taskId} 第 ${report.attempt} 次尝试：${report.title}`,
    `provider=${report.provider} model=${report.model} 类别=${report.classId} 耗时=${report.durationMs}ms`,
    ...(report.diagnostic
      ? ['⚠️ 诊断运行：压缩阈值已被命令行覆盖，只用于观察真实压缩路径，不参与红线判定。']
      : []),
    `冻结配置：maxModelCallsPerRun=${config.maxModelCallsPerRun} contextCompressionThresholdRatio=${config.contextCompressionThresholdRatio}`
      + ` compaction=${config.compaction.threshold}/${config.compaction.keepRecent}/background:${config.compaction.background}`,
    `冻结计划：${turns.length} 回合 / ${nodes.length} 节点（${nodes.map((node) => `${node.id}@回合${node.turn}`).join(', ')}）`
      + ` / ${acceptance.length} 验收；工作区种子 ${workspaceFiles.join(', ')}`,
    '回合结果：',
    ...(report.turns.length === 0 ? ['  （没有任何回合运行）'] : report.turns.map((turn) => (
      `  [${turn.ok ? 'ok  ' : 'FAIL'}] 回合 ${turn.turn} status=${turn.status} ${turn.durationMs}ms`
      + ` 回复=${turn.replyLength}字 run=${turn.runId ?? '-'}${turn.failureKind ? ` failureKind=${turn.failureKind}` : ''}`
    ))),
    `会话 H_ui（session projection）：${formatPercent(report.session?.hUiPercent)}（请求 ${report.session?.requests ?? 0}，缺 usage ${report.session?.requestsWithoutUsage ?? '-'}）`
      + `；辅助调用 ${report.auxiliary?.requests ?? 0} 次；H_all：${formatPercent(report.all?.hitPercent)}`,
    `冻结节点（会话累计 H_ui 红线 ${report.conclusion.target ?? 95}%）：`,
    ...(report.nodes.length === 0 ? ['  （冻结节点未被评估）'] : report.nodes.map((node) => (
      `  [${node.withinTarget === true ? 'PASS' : 'FAIL'}] ${node.id}@回合${node.turn} 累计=${formatPercent(node.hitPercent)}`
      + ` ${node.availability}${node.label ? ` ${node.label}` : ''}`
    ))),
    `验收（${report.acceptance.filter((check) => check.ok).length}/${report.acceptance.length} 通过）：`,
    ...report.acceptance.map((check) => `  [${check.ok ? 'ok  ' : 'FAIL'}] (${check.kind}) ${check.label}${check.detail ? ` — ${check.detail}` : ''}`),
    `结论：${report.ok ? 'met（达标）' : 'not met（未达标）'}`,
    ...report.conclusion.reasons.map((reason) => `  - ${reason}`),
  ]
  if (report.environment.removed) lines.push('隔离数据根已在模型调用前按策略删除。')
  else if (includeDataRoot && report.environment.kept && report.dataRootPath) lines.push(`隔离数据根已保留（如需清理请手动删除）：${report.dataRootPath}`)
  return lines
}

async function writeReports(report, options) {
  const clean = createSanitizer(report)(report)
  const jsonPath = options.json
    ? resolve(process.cwd(), options.json)
    : join(repoRoot, '.codex_tmp', `real-long-task-${report.taskId}-${report.attempt}.json`)
  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  if (!options.report) return { jsonPath, markdownPath: undefined }
  const markdownPath = resolve(process.cwd(), options.report)
  await mkdir(dirname(markdownPath), { recursive: true })
  const body = summaryLines(clean, false).slice(1).map((line) => (line.startsWith('  ')
    ? `  - ${line.trim().replace(/^- /u, '')}`
    : `- ${line}`))
  await writeFile(markdownPath, `# 真实长任务 ${report.taskId} 第 ${report.attempt} 次尝试：${report.ok ? 'met' : 'not met'}\n\n${body.join('\n')}\n`, 'utf8')
  return { jsonPath, markdownPath }
}

/**
 * The JSON report must never carry an API key or an absolute user path: the isolated
 * root becomes `<temp-root>` (artifact paths are workspace-relative in the frozen
 * manifest) and the repository root `<repo>`.
 */
function createSanitizer(report) {
  const root = report.dataRootPath
  const pairs = root ? [
    [join(root, 'data', 'workplace'), '<temp-root>/data/workplace'],
    [join(root, 'chromium'), '<temp-root>/chromium'],
    [join(root, 'data'), '<temp-root>/data'],
    [root, '<temp-root>'],
  ] : []
  const replacements = [...pairs, [repoRoot, '<repo>']]
    .flatMap(([path, token]) => [[path, token], [path.replaceAll('\\', '/'), token]])
    .sort((left, right) => right[0].length - left[0].length)
  const scrub = (value, depth = 0) => {
    if (typeof value === 'string') {
      let result = value
      for (const [path, token] of replacements) result = result.split(path).join(token)
      return result.replace(API_KEY_PATTERN, 'sk-<redacted>')
    }
    if (value === null || typeof value !== 'object' || depth > 8) return value
    if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry, depth + 1)]))
  }
  return scrub
}

function installInterruptHandler() {
  const handler = () => {
    const child = activeChild
    activeChild = undefined
    console.error('\n收到中断信号，正在终止 Electron…')
    void (child ? forceTerminate(child) : Promise.resolve()).catch(() => undefined).finally(() => process.exit(130))
  }
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
}

const formatPercent = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : 'unavailable')
const errorKind = (error) => (error instanceof Error ? error.name : typeof error)
const bufferText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '')
const errorText = (error) => (error instanceof Error ? error.message : typeof error === 'string' ? error : safeJson(error))
const head = (value, limit) => {
  const single = String(value ?? '').replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}
const tail = (value, limit) => {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed
}

function describeError(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    for (const key of ['message', 'error', 'reason']) {
      if (typeof value[key] === 'string') return value[key]
    }
    return safeJson(value)
  }
  return value === undefined || value === null ? undefined : String(value)
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

await main().catch((error) => {
  console.error(`${error instanceof CliError ? '' : `${errorKind(error)}: `}${errorText(error)}`)
  process.exitCode = error instanceof CliError ? error.exitCode : 1
})
