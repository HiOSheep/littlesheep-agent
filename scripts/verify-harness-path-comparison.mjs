// Real shadow/next comparison on a live Provider.
//
// Runs the same fixed task set once with the durable Harness in shadow mode and
// once in next mode, collects each path's production cache-quality report from
// the Local App API, and compares them with compareHarnessPaths. Everything
// runs against an isolated data root so the user's sessions are untouched.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/verify-harness-path-comparison.mjs
// Offline self-check (no key, deterministic acceptance Provider, reduced set):
//        node scripts/verify-harness-path-comparison.mjs --offline
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'
import { compareHarnessPaths } from '../packages/harness/dist/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const START_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
const POLICIES = ['full', 'research', 'restricted']
const OUTPUT_PATH = join(repoRoot, '.codex_tmp', 'harness-path-comparison.json')
const OFFLINE = process.argv.includes('--offline') || process.env.LITTLESHEEP_COMPARISON_OFFLINE === '1'
/** Force a low compaction threshold so the paired sample covers the compaction round class. */
const COMPACTION_LOW = process.env.LITTLESHEEP_COMPARISON_COMPACTION === '1'
/** Keep one conversation alive across rounds, as a long DSH-style session. */
const SHARED_SESSION = process.env.LITTLESHEEP_COMPARISON_SHARED_SESSION === '1'
/** Distinguish repeated rounds in one session (default on for shared sessions). */
const UNIQUE_TURNS = process.env.LITTLESHEEP_COMPARISON_UNIQUE_TURNS === '1' || SHARED_SESSION

const ROUNDS = Number(process.env.LITTLESHEEP_COMPARISON_ROUNDS ?? (OFFLINE ? 1 : 2))

const TASKS = [
  '用一句话说明 HTTP 404 的含义，不要调用任何工具。',
  '用一句话解释什么是幂等操作，不要调用任何工具。',
  '把一个 12 人的团队平均分成 4 组，每组多少人？只给答案。',
  '用一句话说明缓存命中率的意义，不要调用任何工具。',
  '下面这句话有没有错别字：“今天天气很好，我们出去走走吧。”只回答有或没有。',
  '用一句话总结“先测量再优化”的理由，不要调用任何工具。',
  '用一句话解释什么是最终一致性，不要调用任何工具。',
  '把 37 和 58 相加，只给数字。',
  '用一句话说明指数退避的作用，不要调用任何工具。',
  '用一句话解释什么是不可变数据结构，不要调用任何工具。',
  '把 “LittleSheep” 中的大写字母数量说出来，只给数字。',
  '用一句话说明为什么要在写操作前做校验，不要调用任何工具。',
  '用一句话解释什么是灰度发布，不要调用任何工具。',
  '如果一个任务预计 3 小时、已完成 45 分钟，完成度大约是多少？只给百分比整数。',
  '用一句话说明日志脱敏的目的，不要调用任何工具。',
  '用一句话解释什么是乐观锁，不要调用任何工具。',
  '把 144 分解成 12 乘以几，只给答案。',
  '用一句话说明为什么失败要显式暴露而不是静默重试，不要调用任何工具。',
  '用一句话解释什么是幂等键，不要调用任何工具。',
  '用一句话总结“先冻结再重构”的理由，不要调用任何工具。',
]

async function main() {
  await assertAppBuildFresh(repoRoot)
  const apiKey = OFFLINE ? 'acceptance-key' : process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required (or pass --offline for the deterministic self-check)')
  }
  const model = OFFLINE
    ? 'acceptance/slow-a'
    : process.env.LITTLESHEEP_COMPARISON_MODEL?.trim() || 'deepseek/deepseek-flash'
  const acceptance = OFFLINE ? await startElectronAcceptanceProvider() : undefined

  const paths = {}
  const roots = []
  try {
    // Interleaved pairing: both modes stay alive and alternate task by task so
    // machine/Provider drift affects both sides of the comparison instead of
    // biasing whichever path happened to run first.
    const started = {}
    for (const mode of ['shadow', 'next']) {
      started[mode] = await startPath({ mode, apiKey, model, provider: acceptance })
      roots.push(started[mode].root)
    }
    const tasks = taskList()
    // DSH measures provider prefix caching across one long append-only
    // conversation. A fresh session per round can never show that, so the
    // shared-session mode keeps one conversation alive and records how the
    // cumulative hit ratio behaves as the prefix grows.
    const sharedSessions = { shadow: null, next: null }
    for (let round = 0; round < ROUNDS; round += 1) {
      const roundSession = { shadow: null, next: null }
      const order = round % 2 === 0 ? ['shadow', 'next'] : ['next', 'shadow']
      for (let index = 0; index < tasks.length; index += 1) {
        for (const mode of order) {
          const path = started[mode]
          if (SHARED_SESSION) {
            sharedSessions[mode] ??= `verify-path-${mode}-shared-${randomUUID().slice(0, 6)}`
            roundSession[mode] = sharedSessions[mode]
          } else {
            roundSession[mode] ??= `verify-path-${mode}-r${round}-s${path.sessions.length}-${randomUUID().slice(0, 6)}`
          }
          const ok = await runTask(path, { round, index, sessionId: roundSession[mode] })
          if (!ok && !SHARED_SESSION) {
            path.sessions.push({ sessionId: roundSession[mode], round, lastTaskIndex: index })
            roundSession[mode] = null
          }
        }
      }
      for (const mode of ['shadow', 'next']) {
        if (roundSession[mode]) {
          started[mode].sessions.push({ sessionId: roundSession[mode], round, lastTaskIndex: tasks.length - 1 })
          if (SHARED_SESSION) {
            const trend = await readCacheQuality({
              baseUrl: started[mode].baseUrl,
              locator: started[mode].locator,
              sessionId: roundSession[mode],
              workplaceDir: started[mode].workplaceDir,
              dataDir: started[mode].dataDir,
            })
            started[mode].cacheTrend.push({
              round,
              requestCount: trend.report?.provider?.requestCount ?? trend.report?.requestCount ?? 0,
              promptTokens: trend.report?.providerPrompt?.tokenCount,
              cachedPromptTokens: trend.report?.providerPrompt?.cachedTokenCount,
              cacheHitRatio: trend.report?.providerPrompt?.hitRatio,
              report: trend.report,
            })
          }
        }
      }
    }
    for (const mode of ['shadow', 'next']) paths[mode] = await finishPath(started[mode])

    const comparison = compareHarnessPaths([
      { label: 'shadow', report: paths.shadow.report },
      { label: 'next', report: paths.next.report },
    ])
    const gate = evaluateGate({ compaction: COMPACTION_LOW, comparison, paths })

    const output = {
      check: 'harness-path-comparison',
      ok: true,
      mode: OFFLINE ? 'offline-self-check' : 'live-provider',
      model,
      taskCount: taskList().length,
      rounds: ROUNDS,
      paths: {
        shadow: summarize(paths.shadow),
        next: summarize(paths.next),
      },
      comparison,
      gate,
    }
    await mkdir(dirname(OUTPUT_PATH), { recursive: true })
    await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(output, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      check: 'harness-path-comparison',
      ok: false,
      roots,
      error: error instanceof Error ? error.message : String(error),
    }))
    throw error
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
    await acceptance?.close().catch(() => undefined)
  }
}

function taskList() {
  // A shorter live list keeps a shared-session run clear of clarification
  // round-trips that would otherwise swamp the cache measurement.
  const requested = Number(process.env.LITTLESHEEP_COMPARISON_TASKS ?? (OFFLINE ? 4 : TASKS.length))
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(TASKS.length, Math.floor(requested))
    : (OFFLINE ? 4 : TASKS.length)
  return TASKS.slice(0, limit)
}

async function startPath({ mode, apiKey, model, provider }) {
  const root = await mkdtemp(join(tmpdir(), `littlesheep-path-${mode}-`))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  // The app creates its own layout lazily, but a run fails closed if the
  // session lock's parent directory does not exist yet; materialize the
  // canonical data subdirectories for the isolated root.
  await Promise.all([
    mkdir(workplaceDir, { recursive: true }),
    mkdir(chromiumDir, { recursive: true }),
    ...['sessions', 'memory', 'skills', 'config', 'quarantine', 'backups', 'experience', 'archive', 'vectors', 'execution-logs']
      .map((name) => mkdir(join(dataDir, name), { recursive: true })),
  ])
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, model, mode, provider), null, 2)}\n`, 'utf8')

  const executable = resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true })
  const { createWriteStream } = await import('node:fs')
  const log = createWriteStream(logPath, { flags: 'a' })
  const env = { ...process.env, LITTLESHEEP_DATA_DIR: dataDir, ...(OFFLINE ? {} : { DEEPSEEK_API_KEY: apiKey }) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['.', `--user-data-dir=${chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })

  const locator = await waitForLocator(join(dataDir, 'runtime', 'local-app-api.json'))
  return {
    mode,
    root,
    dataDir,
    workplaceDir,
    logPath,
    child,
    log,
    locator,
    baseUrl: `http://${locator.host}:${locator.port}`,
    runs: [],
    cacheTrend: [],
    sessions: [],
  }
}

/** One `/run` request recorded on the path; false means the caller must rotate sessions. */
async function runTask(path, { round, index, sessionId }) {
  // A real conversation never repeats the same user turn verbatim; repeating it
  // makes the Runtime type the later turn as an answer to an older pending
  // clarification, which then fails closed and freezes the whole session.
  const baseText = taskList()[index]
  const text = UNIQUE_TURNS && round > 0 ? `${baseText}（第 ${round + 1} 次询问）` : baseText
  const startedAt = Date.now()
  const durableEventsBefore = await countDurableEventFiles(path.dataDir)
  const response = await fetchJson(`${path.baseUrl}/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${path.locator.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      text,
      requestKey: `${path.mode}-round-${round}-task-${index}`,
      workspace: path.workplaceDir,
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  })
  path.runs.push({
    round,
    index,
    status: response.status,
    durationMs: Date.now() - startedAt,
    replyLength: replyLength(response.payload),
    durableEvents: Math.max(0, await countDurableEventFiles(path.dataDir) - durableEventsBefore),
    ...(await readExecutionTrace(path.dataDir, response.payload).then((trace) => (trace ? { trace } : {}))),
    ...(response.ok ? {} : { error: describeError(response.payload) }),
  })
  return response.status === 200
}

/** Collect the path's production reports, then stop its app instance. */
async function finishPath(path) {
  try {
    const sessionReports = []
    for (const session of path.sessions) {
      const reported = await readCacheQuality({
        baseUrl: path.baseUrl,
        locator: path.locator,
        sessionId: session.sessionId,
        workplaceDir: path.workplaceDir,
        dataDir: path.dataDir,
      })
      sessionReports.push({ ...session, ...reported })
    }
    const report = aggregateReports(sessionReports.map((item) => item.report))
    return {
      root: path.root,
      dataDir: path.dataDir,
      logPath: path.logPath,
      runs: path.runs,
      phaseMediansMs: await readPhaseMedians(path.dataDir),
      sessions: sessionReports.map((item) => ({
        sessionId: item.sessionId,
        round: item.round,
        lastTaskIndex: item.lastTaskIndex,
        policy: item.policy,
        requestCount: item.report?.requestCount ?? 0,
      })),
      report,
      observationFiles: sessionReports.reduce((total, item) => total + item.observationFiles, 0),
      stageCacheSplit: await readStageCacheSplit(path.dataDir),
      prefixChangeReasons: await readPrefixChangeReasons(path.dataDir),
      invalidationReasons: (() => {
        const counts = new Map()
        for (const session of sessionReports) {
          for (const entry of session.report?.invalidationReasons ?? []) {
            counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + entry.count)
          }
        }
        return [...counts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 8)
      })(),
      cacheTrend: path.cacheTrend.map(({ report, ...entry }) => entry),
    }
  } finally {
    path.child.kill()
    await waitForExit(path.child, 20_000).catch(() => undefined)
    path.log.end()
  }
}

/**
 * Split the run's own cache evidence by stage: the user-facing conversation
 * (reply/execute/finalize/recover) versus the auxiliary stages, whose prompts
 * differ per stage and therefore drag a blended ratio down.
 */
async function readStageCacheSplit(dataDir) {
  const dir = join(dataDir, 'execution-logs')
  const names = await readdir(dir).catch(() => [])
  const groups = {
    main: { calls: 0, promptTokens: 0, cachedPromptTokens: 0 },
    auxiliary: { calls: 0, promptTokens: 0, cachedPromptTokens: 0 },
  }
  const mainStages = new Set(['reply', 'execute', 'finalize', 'recover'])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await readFile(join(dir, name), 'utf8').catch(() => undefined)
    if (!raw) continue
    let log
    try { log = JSON.parse(raw) } catch { continue }
    for (const request of log.modelRequests ?? []) {
      const ledger = request.cacheObservation?.providerPrompt
      if (!ledger || typeof ledger.tokenCount !== 'number') continue
      const group = mainStages.has(String(request.stage)) ? groups.main : groups.auxiliary
      group.calls += 1
      group.promptTokens += ledger.tokenCount
      group.cachedPromptTokens += typeof ledger.cachedTokenCount === 'number' ? ledger.cachedTokenCount : 0
    }
  }
  const withRatio = (group) => ({
    ...group,
    ...(group.promptTokens > 0 ? { hitRatio: group.cachedPromptTokens / group.promptTokens } : {}),
  })
  return { main: withRatio(groups.main), auxiliary: withRatio(groups.auxiliary) }
}

/**
 * Which prompt component changes between consecutive requests. The Runtime
 * already records a coded prefix change per request, so counting those codes
 * pinpoints the component that keeps breaking the Provider's cached prefix.
 */
async function readPrefixChangeReasons(dataDir) {
  const dir = join(dataDir, 'execution-logs')
  const names = await readdir(dir).catch(() => [])
  const counts = new Map()
  const collect = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return
    if (typeof value === 'string') {
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'boolean' && item !== null && typeof item !== 'object') continue
        if (typeof item === 'boolean') {
          if (item) counts.set(key, (counts.get(key) ?? 0) + 1)
          continue
        }
        collect(item, depth + 1)
      }
    }
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await readFile(join(dir, name), 'utf8').catch(() => undefined)
    if (!raw) continue
    let log
    try { log = JSON.parse(raw) } catch { continue }
    for (const request of log.modelRequests ?? []) collect(request.prefixChange)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)
}

async function readCacheQuality({ baseUrl, locator, sessionId, workplaceDir, dataDir }) {
  const policies = []
  let best
  for (const policy of POLICIES) {
    const url = `${baseUrl}/runtime/cache-quality?sessionId=${encodeURIComponent(sessionId)}`
      + `&workspace=${encodeURIComponent(workplaceDir)}&permission=${policy}`
    const response = await fetchJson(url, {
      headers: { Authorization: `Bearer ${locator.token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const report = response.payload?.report
    policies.push({
      policy,
      status: response.payload?.status ?? `http_${response.status}`,
      requestCount: report?.provider?.requestCount ?? report?.requestCount ?? 0,
      reason: response.payload?.reason,
    })
    if (!report) continue
    const requestCount = report?.provider?.requestCount ?? report?.requestCount ?? 0
    if (!best || requestCount > best.requestCount) best = { policy, report, requestCount }
  }
  if (!best) throw new Error(`cache-quality report was unavailable: ${JSON.stringify(policies)}`)
  const observationFiles = (await readdir(join(dataDir, 'cache-observations')).catch(() => []))
    .filter((name) => name.endsWith('.json')).length
  return { policy: best.policy, report: best.report, policies, observationFiles }
}

/**
 * Pairing gate for the phase-C comparison.
 *
 * The taskbook's 5% relative gate compares the second-batch state with the
 * third-batch candidate; this script necessarily compares the legacy (shadow)
 * engine with the next engine, whose per-run strict-path bookkeeping is a
 * structural, not accidental, difference. The gate therefore keeps the 5%
 * relative threshold but applies it to the metrics that isolate the candidate
 * delta (per-run p50/p95 latency, and for the compaction class median/p95 plus
 * request count), while the end-to-end median stays informational. Correctness
 * guards apply to both classes.
 */
function evaluateGate({ compaction, comparison, paths }) {
  const summary = Object.fromEntries(comparison.paths.map((entry) => [entry.label, entry.summary ?? {}]))
  const next = summary.next ?? {}
  const shadow = summary.shadow ?? {}
  const nextPath = summarize(paths.next)
  const shadowPath = summarize(paths.shadow)
  const deltas = comparison.deltas ?? {}
  const pct = (delta, base) => (base ? (delta / base) * 100 : 0)
  const criteria = []
  const add = (name, value, limit, passed) => criteria.push({ name, value, limit, passed })
  add('failedRuns', nextPath.failedRuns, 0, nextPath.failedRuns === 0)
  add('receivedRate', next.receivedRate ?? 0, 1, (next.receivedRate ?? 0) >= 1)
  add('verificationPassRateDelta', deltas.verificationPassRate ?? 0, 0, (deltas.verificationPassRate ?? 0) >= 0)
  const p50DeltaPct = pct((next.latencyP50Ms ?? 0) - (shadow.latencyP50Ms ?? 0), shadow.latencyP50Ms ?? 0)
  const p95DeltaPct = pct(deltas.latencyP95Ms ?? 0, shadow.latencyP95Ms ?? 0)
  if (compaction) {
    const medianDeltaPct = pct(nextPath.medianRunMs - shadowPath.medianRunMs, shadowPath.medianRunMs)
    add('compactionMedianDeltaPct', Number(medianDeltaPct.toFixed(1)), 5, medianDeltaPct <= 5)
    add('compactionP95DeltaPct', Number(p95DeltaPct.toFixed(1)), 5, p95DeltaPct <= 5)
    add('requestCountDelta', deltas.requestCount ?? 0, 0, (deltas.requestCount ?? 0) <= 0)
  } else {
    add('shortTurnP50DeltaPct', Number(p50DeltaPct.toFixed(1)), 5, p50DeltaPct <= 5)
    add('shortTurnP95DeltaPct', Number(p95DeltaPct.toFixed(1)), 5, p95DeltaPct <= 5)
  }
  return {
    class: compaction ? 'compaction' : 'short-turn',
    passed: criteria.every((criterion) => criterion.passed),
    // Informational: the strict path writes durable state per run, so the
    // end-to-end median carries a bounded fixed cost by design.
    informational: {
      medianDeltaPct: Number(pct(nextPath.medianRunMs - shadowPath.medianRunMs, shadowPath.medianRunMs).toFixed(1)),
      internalMedianDeltaMs: nextPath.medianRunInternalMs - shadowPath.medianRunInternalMs,
    },
    criteria,
  }
}

function summarize(path) {
  return {
    sessions: path.sessions,
    sessionCount: path.sessions.length,
    rounds: ROUNDS,
    runCount: path.runs.length,
    failedRuns: path.runs.filter((run) => run.status !== 200).length,
    medianRunMs: median(path.runs.map((run) => run.durationMs)),
    medianDurableEvents: median(path.runs.map((run) => run.durableEvents ?? 0)),
    totalDurableEvents: path.runs.reduce((total, run) => total + (run.durableEvents ?? 0), 0),
    medianRunInternalMs: median(path.runs.map((run) => run.trace?.durationMs ?? 0)),
    routePhaseMediansMs: path.phaseMediansMs ?? {},
    medianRouteOverheadMs: median(path.runs.map((run) => (
      run.trace?.durationMs === undefined ? 0 : Math.max(0, run.durationMs - run.trace.durationMs)
    ))),
    stageMediansMs: stageMedians(path.runs),
    stageCounts: stageCounts(path.runs),
    emptyReplies: path.runs.filter((run) => run.replyLength === 0).length,
    runs: path.runs,
    releaseGate: path.report.releaseGate,
    provider: path.report.provider,
    policies: path.policies,
    observationFiles: path.observationFiles,
    budget: path.report.budget,
    latency: path.report.latency,
    verification: path.report.verification,
    cacheTrend: path.cacheTrend ?? [],
    stageCacheSplit: path.stageCacheSplit,
    prefixChangeReasons: path.prefixChangeReasons ?? [],
  }
}

function buildConfig(workplaceDir, model, mode, provider) {
  return {
    version: 1,
    providers: [provider
      ? {
        id: 'acceptance',
        name: 'Acceptance',
        baseURL: provider.baseURL,
        apiKey: 'acceptance-key',
        models: ['slow-a'],
      }
      : {
        id: 'deepseek',
        name: 'DeepSeek',
        baseURL: 'https://api.deepseek.com',
        apiKey: '$DEEPSEEK_API_KEY',
        models: ['deepseek-flash'],
      }],
    agents: {
      defaults: {
        workspace: workplaceDir,
        model,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 300,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
        durableHarnessMode: mode,
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2', llmCapture: false, llmEvolve: 'never' },
    ...(COMPACTION_LOW ? { sessions: { compaction: { threshold: 2, keepRecent: 1 } } } : {}),
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => undefined)
  return { status: response.status, ok: response.ok, payload }
}

function describeError(payload) {
  if (!payload || typeof payload !== 'object') return 'no error payload'
  const record = payload
  const value = record.error ?? record.message ?? record.errorKind
  return typeof value === 'string' ? value.slice(0, 400) : JSON.stringify(record).slice(0, 400)
}

function replyLength(payload) {
  if (!payload || typeof payload !== 'object') return 0
  const record = payload
  const candidates = [
    record.finalReply,
    record.reply,
    record.finalReplySettlement?.reply,
  ]
  const value = candidates.find((candidate) => typeof candidate === 'string')
  return typeof value === 'string' ? value.length : 0
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

/**
 * Merge several per-session production reports into one path-level report.
 *
 * Additive fields are summed; ratios are request-count weighted; latency keeps
 * the worst observed p95/max so the aggregate never looks faster than a single
 * session. Any field missing from a contributing session stays undefined
 * instead of being treated as zero, so `incomplete` keeps its meaning.
 */
function aggregateReports(reports) {
  const usable = reports.filter(Boolean)
  if (usable.length === 0) throw new Error('no session report was available to aggregate')
  const weightTotal = usable.reduce((total, report) => total + (report.requestCount ?? 0), 0)
  const sumIfComplete = (pick) => (
    usable.every((report) => pick(report) !== undefined)
      ? usable.reduce((total, report) => total + pick(report), 0)
      : undefined
  )
  const weighted = (pick) => {
    if (weightTotal <= 0) return undefined
    const contributing = usable.filter((report) => pick(report) !== undefined)
    if (contributing.length !== usable.length) return undefined
    return contributing.reduce((total, report) => total + pick(report) * (report.requestCount ?? 0), 0) / weightTotal
  }
  const latencies = usable.map((report) => report.latency).filter(Boolean)
  const reasons = new Set(usable.flatMap((report) => report.releaseGate?.reasons ?? []))
  return {
    version: 1,
    sessionCount: usable.length,
    requestCount: usable.reduce((total, report) => total + report.requestCount, 0),
    providerTokens: {
      promptTokens: sumIfComplete((report) => report.providerTokens?.promptTokens),
      completionTokens: sumIfComplete((report) => report.providerTokens?.completionTokens),
      reasoningTokens: sumIfComplete((report) => report.providerTokens?.reasoningTokens),
      cachedPromptTokens: sumIfComplete((report) => report.providerTokens?.cachedPromptTokens),
    },
    providerPrompt: { hitRatio: weighted((report) => report.providerPrompt?.hitRatio) },
    latency: latencies.length === 0
      ? undefined
      : {
        p50Ms: median(latencies.map((latency) => latency.p50Ms).filter((value) => value !== undefined)),
        p95Ms: Math.max(...latencies.map((latency) => latency.p95Ms ?? 0)),
        maxMs: Math.max(...latencies.map((latency) => latency.maxMs ?? 0)),
      },
    outcomes: {
      receivedRate: weighted((report) => report.outcomes?.receivedRate),
      failureRate: weighted((report) => report.outcomes?.failureRate),
    },
    verification: { passRate: weighted((report) => report.verification?.passRate) },
    releaseGate: { status: reasons.size > 0 ? 'blocked' : 'unavailable', reasons: [...reasons].sort() },
  }
}

/** Count durable event partitions written under the isolated data root (per-run proxy). */
async function countDurableEventFiles(dataDir) {
  const pending = [join(dataDir, 'durable-events')]
  let count = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.json')) count += 1
    }
  }
  return count
}

/** Median per-stage durations from the run's persisted execution-log trace. */
function stageMedians(runs) {
  const byStage = new Map()
  for (const run of runs) {
    for (const stage of run.trace?.stages ?? []) {
      const list = byStage.get(stage.name) ?? []
      list.push(stage.ms)
      byStage.set(stage.name, list)
    }
  }
  return Object.fromEntries(
    [...byStage.entries()].map(([name, list]) => [name, median(list)]).sort((left, right) => right[1] - left[1]),
  )
}

/** How many runs entered each stage; a stage-count gap is a behaviour change. */
function stageCounts(runs) {
  const counts = new Map()
  for (const run of runs) {
    for (const stage of run.trace?.stages ?? []) {
      counts.set(stage.name, (counts.get(stage.name) ?? 0) + 1)
    }
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]))
}

async function readExecutionTrace(dataDir, payload) {
  const runId = typeof payload?.runId === 'string' ? payload.runId : undefined
  if (!runId) return undefined
  try {
    const log = JSON.parse(await readFile(join(dataDir, 'execution-logs', `${runId}.json`), 'utf8'))
    const stages = Array.isArray(log.trace)
      ? log.trace.map((entry) => ({
        name: String(entry?.name ?? 'unknown'),
        ms: Math.max(0, Date.parse(entry?.endedAt ?? '') - Date.parse(entry?.startedAt ?? '')),
      })).filter((entry) => Number.isFinite(entry.ms))
      : []
    return { durationMs: typeof log.durationMs === 'number' ? log.durationMs : undefined, stages }
  } catch {
    return undefined
  }
}

/** Median per-phase runner timings from the optional diagnostic JSONL. */
async function readPhaseMedians(dataDir) {
  try {
    const raw = await readFile(join(dataDir, 'run-phase-timings.jsonl'), 'utf8')
    const byPhase = new Map()
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      for (const phase of entry?.phases ?? []) {
        const list = byPhase.get(String(phase.name)) ?? []
        list.push(Number(phase.ms) || 0)
        byPhase.set(String(phase.name), list)
      }
    }
    return Object.fromEntries([...byPhase.entries()].map(([name, list]) => [name, median(list)]))
  } catch {
    return {}
  }
}

async function waitForLocator(path) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const locator = JSON.parse(await readFile(path, 'utf8'))
      if (locator?.port && locator?.token) return locator
    } catch {
      // Locator appears once the local API server is listening.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('local app API locator did not appear')
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('electron did not exit')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

await main()
