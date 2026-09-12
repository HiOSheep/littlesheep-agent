// Real shadow/next comparison on a live Provider.
//
// Runs the same fixed task set once with the durable Harness in shadow mode and
// once in next mode, collects each path's production cache-quality report from
// the Local App API, and compares them with compareHarnessPaths. Everything
// runs against an isolated data root so the user's sessions are untouched.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/verify-harness-path-comparison.mjs
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs'
import { compareHarnessPaths } from '../packages/harness/dist/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'packages', 'app')
const START_TIMEOUT_MS = 90_000
const RUN_TIMEOUT_MS = 180_000
const POLICIES = ['full', 'research', 'restricted']
const OUTPUT_PATH = join(repoRoot, '.codex_tmp', 'harness-path-comparison.json')

const ROUNDS = Number(process.env.LITTLESHEEP_COMPARISON_ROUNDS ?? 2)

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
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
  const model = process.env.LITTLESHEEP_COMPARISON_MODEL?.trim() || 'deepseek/deepseek-flash'

  const paths = {}
  const roots = []
  try {
    for (const mode of ['shadow', 'next']) {
      const run = await runPath({ mode, apiKey, model })
      roots.push(run.root)
      paths[mode] = run
    }

    const comparison = compareHarnessPaths([
      { label: 'shadow', report: paths.shadow.report },
      { label: 'next', report: paths.next.report },
    ])
    const output = {
      check: 'harness-path-comparison',
      ok: true,
      model,
      taskCount: TASKS.length,
      rounds: ROUNDS,
      paths: {
        shadow: summarize(paths.shadow),
        next: summarize(paths.next),
      },
      comparison,
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
  }
}

async function runPath({ mode, apiKey, model }) {
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
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, model, mode), null, 2)}\n`, 'utf8')

  const executable = resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true })
  const { createWriteStream } = await import('node:fs')
  const log = createWriteStream(logPath, { flags: 'a' })
  const env = { ...process.env, LITTLESHEEP_DATA_DIR: dataDir, DEEPSEEK_API_KEY: apiKey }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ['.', `--user-data-dir=${chromiumDir}`], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })

  try {
    const locator = await waitForLocator(join(dataDir, 'runtime', 'local-app-api.json'))
    const baseUrl = `http://${locator.host}:${locator.port}`
    const runs = []
    const sessions = []
    // A same-session turn that ends in `waiting_user` blocks the next turn, so a
    // failed run rotates to a fresh session instead of poisoning the rest of
    // the batch. Every session still contributes its own production report.
    for (let round = 0; round < ROUNDS; round += 1) {
      let sessionId = null
      for (const [index, text] of TASKS.entries()) {
        sessionId ??= `verify-path-${mode}-r${round}-s${sessions.length}-${randomUUID().slice(0, 6)}`
        const startedAt = Date.now()
        const response = await fetchJson(`${baseUrl}/run`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${locator.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            text,
            requestKey: `${mode}-round-${round}-task-${index}`,
            workspace: workplaceDir,
          }),
          signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
        })
        runs.push({
          round,
          index,
          status: response.status,
          durationMs: Date.now() - startedAt,
          replyLength: replyLength(response.payload),
          ...(response.ok ? {} : { error: describeError(response.payload) }),
        })
        if (response.status !== 200) {
          sessions.push({ sessionId, round, lastTaskIndex: index })
          sessionId = null
        }
      }
      if (sessionId) sessions.push({ sessionId, round, lastTaskIndex: TASKS.length - 1 })
    }

    const sessionReports = []
    for (const session of sessions) {
      const reported = await readCacheQuality({
        baseUrl,
        locator,
        sessionId: session.sessionId,
        workplaceDir,
        dataDir,
      })
      sessionReports.push({ ...session, ...reported })
    }
    const report = aggregateReports(sessionReports.map((item) => item.report))
    return {
      root,
      dataDir,
      logPath,
      runs,
      sessions: sessionReports.map((item) => ({
        sessionId: item.sessionId,
        round: item.round,
        lastTaskIndex: item.lastTaskIndex,
        policy: item.policy,
        requestCount: item.report?.requestCount ?? 0,
      })),
      report,
      observationFiles: sessionReports.reduce((total, item) => total + item.observationFiles, 0),
    }
  } catch (error) {
    child.kill()
    throw new Error(`[${mode}] ${error instanceof Error ? error.message : String(error)} (log: ${logPath})`)
  } finally {
    child.kill()
    await waitForExit(child, 20_000).catch(() => undefined)
    log.end()
  }
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

function summarize(path) {
  return {
    sessions: path.sessions,
    sessionCount: path.sessions.length,
    rounds: ROUNDS,
    runCount: path.runs.length,
    failedRuns: path.runs.filter((run) => run.status !== 200).length,
    medianRunMs: median(path.runs.map((run) => run.durationMs)),
    emptyReplies: path.runs.filter((run) => run.replyLength === 0).length,
    runs: path.runs,
    releaseGate: path.report.releaseGate,
    provider: path.report.provider,
    policies: path.policies,
    observationFiles: path.observationFiles,
    latency: path.report.latency,
    verification: path.report.verification,
  }
}

function buildConfig(workplaceDir, model, mode) {
  return {
    version: 1,
    providers: [{
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
