// Which startup stage grows with the size of the data root?
//
// The user-visible question is narrow: the send control stays disabled until
// `/runtime/readiness` reports `ready`, and on a real data root that publish was
// measured at 5.67 s against ~1.9-2.0 s on the synthetic cold-start profiles. Two
// data-scaled scans (attachment protection, session-index warm-up) were just moved
// off that path, so this script answers "what is still left that scales with data"
// with numbers instead of a guess.
//
// Method: launch the real Electron app against an isolated data root in
// `os.tmpdir()` with `LITTLESHEEP_BOOTSTRAP_TIMING=1`, poll `/runtime/readiness`
// until it reports `ready`, then read every `[bootstrap-timing]` entry back from
// the app's own stdout log. Wall clock is anchored on the parent's `spawn` call and
// cross-checked against the child's `process.uptime()` origin (`process-start`),
// which is the same anchor `measure-desktop-cold-start.mjs` uses.
//
// Three fixtures, and the reason each exists:
//
//   1. `synthetic-large` - a data root written in the shapes the app itself writes
//      (sessions/*.jsonl + sessions.json, run-checkpoints/<sha256(id)>.json with
//      resumeState.attachments, run-checkpoint-dispositions, durable-* stores,
//      execution-logs, attachment-cache/files + index.json, memory/, archive/,
//      projects/, backups/versioning/checkpoints). Every category is generated at
//      the scale the task asked for.
//   2. `small` - the same config and the same directory set with almost no data.
//      This is the control: large minus small is what "scales with data" means.
//      Both fixtures run with `versioning.enabled = true` (the real data root's
//      setting) so the comparison is not confounded by a feature being on in one
//      fixture and off in the other.
//   3. `real-copy` - an actual copy of a real user data root, when one is present.
//      The synthetic fixtures prove the mechanism at a controlled scale; the copy
//      is the only fixture whose file counts were produced by the product itself.
//
// The app is never sent a message: readiness is the whole measurement, because
// that is where the send gate lifts.
//
// Usage:
//   node scripts/measure-desktop-large-root-startup.mjs [--fixtures=synthetic-large,small,real-copy]
//                                                       [--runs=2] [--label=...]
//                                                       [--out=docs/reference/cold-start-baseline]
//                                                       [--real-root=<path>] [--keep]

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const READINESS_TIMEOUT_MS = 120_000
const READINESS_POLL_MS = 20
const TIMING_LOG_TIMEOUT_MS = 10_000
/** How many of the slowest stages one run keeps in its `topStages` list. */
const TOP_STAGE_COUNT = 40
/** Marks that measure their own overlapping work instead of a delta from the previous mark. */
const OVERLAPPING_STAGES = new Set([
  'runner-infra-durable-events-ready',
  'runner-infra-durable-inbox-ready',
  'runner-infra-durable-run-leases-ready',
  'runner-infra-durable-effect-leases-ready',
])

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const harness = createElectronHarness({
  startTimeoutMs: 180_000,
  actionTimeoutMs: 30_000,
  // The repository build is one commit behind HEAD (see `buildFreshness` in the
  // report), so the freshness assertion is recorded rather than enforced. It is
  // never silently skipped: the report carries the exact message.
  requireAppBuildManifest: false,
})
const label = readOption('label', 'unlabeled')
const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const keepRoots = process.argv.includes('--keep')
const runsPerFixture = Math.max(1, Number.parseInt(readOption('runs', '2'), 10))
const realRoot = resolve(readOption('real-root', join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.littlesheep')))
const requestedFixtures = readOption('fixtures', 'synthetic-large,synthetic-large-noversioning,small,real-copy')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined)
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number').sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// ---------------------------------------------------------------------------
// Fixture scale. `small` keeps the same directories and the same config, so the
// only difference between the two synthetic fixtures is how much data is there.
// ---------------------------------------------------------------------------

const LARGE_SCALE = {
  sessions: 1_200,
  messagesPerSession: 8,
  replyFingerprints: 200,
  checkpoints: 280,
  resumingDispositions: 20,
  leases: 300,
  effectLeases: 60,
  inbox: 300,
  eventPartitions: 120,
  executionLogs: 400,
  cacheObservations: 150,
  compactionOperations: 150,
  attachmentFiles: 360,
  memoryFiles: 260,
  manifests: 300,
  archivedSessions: 240,
  projects: 6,
}

const SMALL_SCALE = {
  sessions: 3,
  messagesPerSession: 2,
  replyFingerprints: 0,
  checkpoints: 0,
  resumingDispositions: 0,
  leases: 0,
  effectLeases: 0,
  inbox: 0,
  eventPartitions: 0,
  executionLogs: 0,
  cacheObservations: 0,
  compactionOperations: 0,
  attachmentFiles: 0,
  memoryFiles: 0,
  manifests: 0,
  archivedSessions: 0,
  projects: 1,
}

// ---------------------------------------------------------------------------
// Synthetic seeding, in the file shapes the product writes. Shapes were read from
// the real store codecs (`session-index.ts`, `run-checkpoint-codec.ts`,
// `durable-run-lease-store.ts`, `attachment-cache.ts`, `git-checkpoint.ts`).
// ---------------------------------------------------------------------------

async function seedSyntheticRoot({ dataDir, workspaceDir, scale, versioningEnabled }) {
  const startedAt = Date.now()
  const now = Date.now()
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(workspaceDir, 'README.md'), `# Large-root fixture\n\n${'正文段落。\n\n'.repeat(60)}`, 'utf8')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, { versioningEnabled }), null, 2)}\n`, 'utf8')

  const sessionIds = []
  const sessionIndex = []
  const sessionsDir = join(dataDir, 'sessions')
  await mkdir(join(sessionsDir, '.reply-fingerprints'), { recursive: true })
  await mkdir(join(sessionsDir, '.compactions'), { recursive: true })
  for (let index = 0; index < scale.sessions; index += 1) {
    const id = randomUUID()
    sessionIds.push(id)
    const lastMessageAt = now - index * 1_000
    sessionIndex.push({
      id,
      title: `大根夹具会话 ${index}`,
      createdAt: lastMessageAt - 60_000,
      lastMessageAt,
      mode: index % 3 === 0 ? 'full' : 'research',
      scope: 'standalone',
      workspacePath: workspaceDir,
    })
    await writeFile(join(sessionsDir, `${id}.jsonl`), buildSessionJsonl(id, index, scale.messagesPerSession), 'utf8')
    if (index < scale.replyFingerprints) {
      await writeFile(
        join(sessionsDir, '.reply-fingerprints', `${id}.sha256`),
        `${JSON.stringify({ type: 'littlesheep.reply-fingerprint-registry', version: 1 })}\n${sha256(`${id}:fingerprint`)}\n`,
        'utf8',
      )
    }
  }
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: sessionIndex }, null, 2)}\n`, 'utf8')

  // Run checkpoints: one directory entry per checkpoint, named sha256(id).json.
  const checkpointIds = []
  const checkpointRuns = []
  if (scale.checkpoints > 0) {
    const checkpointsDir = join(dataDir, 'run-checkpoints')
    const dispositionsDir = join(dataDir, 'run-checkpoint-dispositions')
    await mkdir(checkpointsDir, { recursive: true })
    await mkdir(dispositionsDir, { recursive: true })
    for (let index = 0; index < scale.checkpoints; index += 1) {
      const sessionId = sessionIds[index % sessionIds.length]
      const runId = randomUUID()
      const id = `run-checkpoint-${randomUUID()}`
      checkpointIds.push(id)
      checkpointRuns.push({ id, runId, sessionId })
      const resuming = index < scale.resumingDispositions
      const resumeRunId = `resume-${randomUUID()}`
      const attachments = [0, 1].map((position) => ({
        version: 1,
        attachmentId: `attachment-${index}-${position}`,
        cacheId: randomUUID(),
        contentHash: sha256(`attachment-${index}-${position}`),
        name: `fixture-${index}-${position}.md`,
        kind: position === 0 ? 'document' : 'file',
        mimeType: 'text/markdown',
        size: 4_096 + position,
        contextPath: join(workspaceDir, `fixture-${index}-${position}.md`),
      }))
      const checkpoint = {
        version: 1,
        id,
        runId,
        sessionId,
        status: index % 3 === 0 ? 'recoverable' : 'waiting_user',
        currentStage: 'execute',
        taskBookRevision: 0,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [randomUUID(), randomUUID()],
        sideEffects: [],
        loopBudget: {
          attemptsUsed: 1,
          elapsedMs: 900 + index,
          maxAttempts: 32,
          maxElapsedMs: 0,
          maxNoProgressRounds: 2,
          maxToolLoopIterations: 30,
          noProgressRounds: 0,
          toolLoopIterationsUsed: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: `message-${index}`,
          cwd: workspaceDir,
          model: 'fixture/fixture-model',
          origin: 'app',
          permissionPolicyId: 'research',
          reasoning: 'auto',
          behaviorModeId: 'general',
          availableToolNames: ['read', 'write', 'edit', 'grep', 'glob', 'memory_tree', 'exec'],
          attachmentCount: attachments.length,
          attachments,
          appliedTaskBookPatchIds: [],
          // Required by `validateResumeState`; the app rejects a checkpoint without
          // them, which is exactly the fixture defect the first run reported as
          // `diagnostics.invalidFiles = 256`.
          deferredRuntimeEvents: [],
          recoveryAttempts: 0,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
        },
        createdAt: new Date(now - index * 60_000).toISOString(),
        reason: 'fixture checkpoint waiting for the user',
      }
      await writeFile(join(checkpointsDir, `${sha256(id)}.json`), `${JSON.stringify(checkpoint)}\n`, 'utf8')
      await writeFile(join(dispositionsDir, `${sha256(id)}.json`), `${JSON.stringify({
        version: 1,
        checkpointId: id,
        status: resuming ? 'resuming' : 'completed',
        decidedAt: new Date(now - index * 60_000).toISOString(),
        updatedAt: new Date(now - index * 60_000).toISOString(),
        reason: resuming ? 'fixture resume in progress' : 'source run completed successfully',
        resultStatus: resuming ? undefined : 'ok',
        ...(resuming ? { resumeRunId } : {}),
        history: [{
          status: resuming ? 'resuming' : 'completed',
          at: new Date(now - index * 60_000).toISOString(),
          reason: resuming ? 'fixture resume in progress' : 'source run completed successfully',
        }],
      }, null, 2)}\n`, 'utf8')
    }
  }

  // Durable Harness stores.
  await writeDurableStores(dataDir, scale, sessionIds)

  // Execution logs: one JSON per run, the shape `reconcileCompletedRuns` reads.
  // The first N logs deliberately reuse the checkpoint run ids, because that is
  // what makes startup reconciliation read them at all.
  if (scale.executionLogs > 0) {
    const logsDir = join(dataDir, 'execution-logs')
    await mkdir(logsDir, { recursive: true })
    for (let index = 0; index < scale.executionLogs; index += 1) {
      const linked = checkpointRuns[index]
      const runId = linked?.runId ?? randomUUID()
      const sessionId = linked?.sessionId ?? sessionIds[index % sessionIds.length]
      const transcript = Array.from({ length: 12 }, (_, position) => ({
        role: position % 2 === 0 ? 'user' : 'assistant',
        content: `夹具执行记录 ${index} 第 ${position} 条，用于把单文件体积做到接近真实运行日志。`,
        at: new Date(now - index * 1_000).toISOString(),
      }))
      await writeFile(join(logsDir, `${runId}.json`), `${JSON.stringify({
        runId,
        sessionId,
        startedAt: new Date(now - index * 1_000).toISOString(),
        endedAt: new Date(now - index * 1_000 + 2_400).toISOString(),
        status: 'ok',
        model: 'fixture/fixture-model',
        inboundText: '夹具请求',
        reply: '夹具回复',
        ...(linked === undefined ? {} : { runCheckpointId: linked.id }),
        transcript,
      }, null, 2)}\n`, 'utf8')
    }
  }

  // Small per-record stores: cache observations and compaction operations.
  if (scale.cacheObservations > 0) {
    const dir = join(dataDir, 'cache-observations')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < scale.cacheObservations; index += 1) {
      await writeFile(join(dir, `${sha256(`observation-${index}`)}.json`), `${JSON.stringify({
        version: 1,
        storedAt: now - index * 1_000,
        scopeDigest: sha256(`scope-${index}`),
        entryFingerprint: sha256(`entry-${index}`),
        observation: { version: 1, usageSchemaVersion: 'llm-chat-usage.v1', adapter: 'llm-chat', provider: 'fixture', model: 'fixture-model', requestKind: 'run', requestIndex: index, modelRequestId: randomUUID() },
      })}\n`, 'utf8')
    }
  }
  if (scale.compactionOperations > 0) {
    const dir = join(dataDir, 'compaction-operations')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < scale.compactionOperations; index += 1) {
      await writeFile(join(dir, `${sha256(`compaction-${index}`)}.json`), `${JSON.stringify([{
        id: randomUUID(),
        sessionId: sessionIds[index % sessionIds.length],
        force: false,
        createdAt: new Date(now - index * 1_000).toISOString(),
        status: 'completed',
        startedAt: new Date(now - index * 1_000).toISOString(),
        coalescedRequests: 0,
        result: 'compacted',
        usage: { requestCount: 2, usageStatus: 'unavailable', retryRequests: 0 },
        settledAt: new Date(now - index * 1_000 + 90).toISOString(),
      }])}\n`, 'utf8')
    }
  }

  await seedAttachmentCache(dataDir, scale)
  await seedMemoryFiles(dataDir, scale)
  await seedBackupManifests(dataDir, scale)
  await seedMetadataIndexes(dataDir, workspaceDir, scale, sessionIndex, now)
  await mkdir(join(dataDir, 'skills'), { recursive: true })
  await mkdir(join(dataDir, 'experience'), { recursive: true })
  await mkdir(join(dataDir, 'config'), { recursive: true })
  await mkdir(join(dataDir, 'ui'), { recursive: true })
  await writeFile(join(dataDir, 'ui', 'desktop-window.json'), `${JSON.stringify({ version: 1, bounds: { x: 120, y: 80, width: 1440, height: 900 }, maximized: false }, null, 2)}\n`, 'utf8')
  await mkdir(join(dataDir, 'workspace'), { recursive: true })
  await writeFile(join(dataDir, 'workspace', 'layout.json'), `${JSON.stringify({ version: 2, updatedAt: new Date(now).toISOString(), snapshots: {} }, null, 2)}\n`, 'utf8')
  await writeFile(join(dataDir, 'workspace', 'artifacts.json'), `${JSON.stringify({ records: [] }, null, 2)}\n`, 'utf8')
  await mkdir(join(dataDir, 'workplace'), { recursive: true })
  await writeFile(join(dataDir, 'workplace', 'README.md'), '# workplace\n', 'utf8')
  return { seedMs: Date.now() - startedAt, sessionIds: sessionIds.length, checkpoints: checkpointIds.length }
}

function buildConfig(workspaceDir, versioningEnabled = true) {
  return {
    version: 1,
    providers: [{
      id: 'fixture',
      name: 'Fixture Provider',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'fixture-key-not-a-credential',
      models: [{ id: 'fixture-model', name: 'Fixture Model', contextWindow: 128_000 }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'fixture/fixture-model',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 15,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    // v2 matches the real data root this measurement is about; v3 needs a SQLite
    // catalog plus a local embedding model that a synthetic fixture cannot fake.
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    // On for `synthetic-large`/`small`, because the real root has it on: this is the
    // setting that decides whether the shadow-Git preimage/commit path runs during
    // bootstrap. `synthetic-large-noversioning` is the same data with it off, so the
    // unattributed bootstrap gap can be attributed to a cause instead of a guess.
    versioning: { enabled: versioningEnabled, maxCheckpoints: 256 },
  }
}

function buildSessionJsonl(sessionId, index, messagesPerSession) {
  const lines = [JSON.stringify({
    type: 'metadata',
    metadata: {
      model: 'fixture/fixture-model',
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      messageCount: messagesPerSession,
      origin: 'app',
    },
  })]
  for (let position = 0; position < messagesPerSession; position += 1) {
    const role = position % 2 === 0 ? 'user' : 'assistant'
    lines.push(JSON.stringify({
      id: randomUUID(),
      role,
      content: [{
        type: 'text',
        text: role === 'user'
          ? `夹具第 ${index} 个会话的第 ${position} 条用户消息：这是一段用于把会话文件做到真实体积的正文。${'补充正文。'.repeat(160)}`
          : `夹具第 ${index} 个会话的第 ${position} 条助手回复：同样是一段有长度的正文，保证每条消息都不是几十字节。${'补充正文。'.repeat(160)}`,
      }],
      timestamp: new Date(Date.now() - index * 60_000 + position * 1_000).toISOString(),
      sessionId,
      runId: randomUUID(),
    }))
  }
  return `${lines.join('\n')}\n`
}

async function writeDurableStores(dataDir, scale, sessionIds) {
  const now = Date.now()
  const iso = (offset) => new Date(now - offset).toISOString()

  if (scale.leases > 0) {
    const dir = join(dataDir, 'durable-run-leases')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < scale.leases; index += 1) {
      const sessionId = sessionIds[index % sessionIds.length]
      const runId = randomUUID()
      await writeFile(join(dir, `${sha256(`${sessionId}\u0000${runId}`)}.json`), `${JSON.stringify({
        version: 1,
        sessionId,
        runId,
        status: 'released',
        attempts: 1 + (index % 3),
        createdAt: iso(index * 60_000),
        updatedAt: iso(index * 60_000 - 500),
        acquiredAt: iso(index * 60_000 - 100),
        releasedAt: iso(index * 60_000 - 500),
      })}\n`, 'utf8')
    }
  }

  if (scale.effectLeases > 0) {
    const dir = join(dataDir, 'durable-effect-leases')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < scale.effectLeases; index += 1) {
      const sessionId = sessionIds[index % sessionIds.length]
      const runId = `effect-${sha256(`effect-${index}`)}`
      await writeFile(join(dir, `${sha256(`${sessionId}\u0000${runId}`)}.json`), `${JSON.stringify({
        version: 1,
        sessionId,
        runId,
        status: 'released',
        attempts: 1,
        createdAt: iso(index * 60_000),
        updatedAt: iso(index * 60_000 - 200),
        acquiredAt: iso(index * 60_000 - 50),
        releasedAt: iso(index * 60_000 - 200),
      })}\n`, 'utf8')
    }
  }

  if (scale.inbox > 0) {
    const dir = join(dataDir, 'durable-inbox')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < scale.inbox; index += 1) {
      const sessionId = sessionIds[index % sessionIds.length]
      const runId = randomUUID()
      const commandId = `${runId}:user-input`
      await writeFile(join(dir, `${sha256(commandId)}.json`), `${JSON.stringify({
        version: 1,
        commandId,
        idempotencyKey: commandId,
        type: 'user_input_appended',
        source: 'app',
        status: 'completed',
        sessionId,
        runId,
        payload: { contentLength: 20 + index, messageId: randomUUID() },
        resultEventIds: [commandId],
        attempts: 1,
        enqueuedAt: iso(index * 60_000),
        updatedAt: iso(index * 60_000 - 300),
      })}\n`, 'utf8')
    }
  }

  if (scale.eventPartitions > 0) {
    const eventsRoot = join(dataDir, 'durable-events')
    await mkdir(eventsRoot, { recursive: true })
    for (let index = 0; index < scale.eventPartitions; index += 1) {
      const sessionId = sessionIds[index % sessionIds.length]
      const runId = randomUUID()
      const partition = join(eventsRoot, sha256(`${sessionId}\u0000${runId}`))
      await mkdir(partition, { recursive: true })
      const reply = { reply: '夹具历史回复', replyFingerprint: `fixture-${runId}`, modelRequestId: `fixture-model-${runId}` }
      const events = [
        [1, 'run_accepted', { fixture: 'large-root' }],
        [2, 'final_reply_proposed', reply],
        [3, 'final_reply_settled', reply],
        [4, 'run_completed', { fixture: 'large-root' }],
      ]
      for (const [cursor, type, payload] of events) {
        const eventId = `${sessionId}:${runId}:${type}:${cursor}`
        const event = {
          version: 1,
          eventId,
          idempotencyKey: eventId,
          sessionId,
          runId,
          cursor,
          type,
          source: 'runtime',
          occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, cursor)).toISOString(),
          payload,
        }
        await writeFile(join(partition, `${String(cursor).padStart(12, '0')}-${sha256(eventId)}.json`), `${JSON.stringify(event)}\n`, 'utf8')
      }
    }
  }
}

async function seedAttachmentCache(dataDir, scale) {
  const root = join(dataDir, 'attachment-cache')
  const filesDir = join(root, 'files')
  await mkdir(filesDir, { recursive: true })
  const entries = {}
  for (let index = 0; index < scale.attachmentFiles; index += 1) {
    const id = randomUUID()
    const body = Buffer.from(`夹具附件 ${index}\n${'附件正文。'.repeat(160)}`, 'utf8')
    const contentHash = createHash('sha256').update(body).digest('hex')
    const fileName = `${id}.md`
    await writeFile(join(filesDir, fileName), body)
    entries[id] = {
      id,
      fileName,
      originalName: `fixture-${index}.md`,
      mimeType: 'text/markdown',
      size: body.byteLength,
      contentHash,
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
      lastAccessedAt: new Date(Date.now() - index * 60_000).toISOString(),
    }
  }
  await writeFile(join(root, 'index.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

async function seedMemoryFiles(dataDir, scale) {
  if (scale.memoryFiles === 0) {
    await mkdir(join(dataDir, 'memory'), { recursive: true })
    return
  }
  const daily = join(dataDir, 'memory', 'daily')
  const longTerm = join(dataDir, 'memory', 'long-term')
  await mkdir(daily, { recursive: true })
  await mkdir(longTerm, { recursive: true })
  const dailyCount = Math.ceil(scale.memoryFiles * 0.75)
  for (let index = 0; index < dailyCount; index += 1) {
    const day = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10)
    await writeFile(join(daily, `${day}.md`), `# ${day}\n\n${`- 夹具记忆条目 ${index}：一段用于让记忆文件具有真实体积的正文。\n`}`, 'utf8')
  }
  for (let index = dailyCount; index < scale.memoryFiles; index += 1) {
    await writeFile(join(longTerm, `atom-${index}.md`), `# 长期记忆 ${index}\n\n${'记忆正文。'.repeat(30)}\n`, 'utf8')
  }
  await writeFile(join(dataDir, 'MEMORY.md'), `# MEMORY\n\n${'夹具长期记忆正文。\n'.repeat(60)}`, 'utf8')
}

async function seedBackupManifests(dataDir, scale) {
  const manifestsDir = join(dataDir, 'backups', 'versioning', 'checkpoints')
  await mkdir(manifestsDir, { recursive: true })
  for (let index = 0; index < scale.manifests; index += 1) {
    const id = randomUUID()
    const createdAt = new Date(Date.now() - index * 3_600_000).toISOString()
    await writeFile(join(manifestsDir, `${id}.json`), `${JSON.stringify({
      version: 1,
      id,
      reason: index % 2 === 0 ? 'run-complete' : 'shutdown-freeze',
      status: 'complete',
      createdAt,
      completedAt: createdAt,
      data: { repositoryId: 'littlesheep-data', commit: sha256(`commit-${index}`).slice(0, 40), trackedPathCount: 1_000 + index },
      warningCodes: [],
    }, null, 2)}\n`, 'utf8')
  }
}

async function seedMetadataIndexes(dataDir, workspaceDir, scale, sessionIndex, now) {
  await mkdir(join(dataDir, 'archive'), { recursive: true })
  await writeFile(join(dataDir, 'archive', 'index.json'), `${JSON.stringify({
    projects: [],
    sessions: sessionIndex.slice(0, scale.archivedSessions).map((session, index) => ({
      ...session,
      archivedAt: now - index * 60_000,
    })),
  }, null, 2)}\n`, 'utf8')

  await mkdir(join(dataDir, 'projects'), { recursive: true })
  await writeFile(join(dataDir, 'projects', 'index.json'), `${JSON.stringify({
    projects: Array.from({ length: scale.projects }, (_, index) => ({
      id: `project-${randomUUID()}`,
      name: `夹具项目 ${index}`,
      path: join(workspaceDir, `project-${index}`),
      createdAt: new Date(now - index * 86_400_000).toISOString(),
      lastActiveAt: new Date(now - index * 3_600_000).toISOString(),
      identityVersion: 2,
      previousPaths: [],
      pathUpdatedAt: new Date(now - index * 3_600_000).toISOString(),
    })),
  }, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function inventory(root) {
  const entries = []
  let totalFiles = 0
  let totalBytes = 0
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name)
    if (entry.isFile()) {
      const info = await stat(path).catch(() => undefined)
      entries.push({ path: entry.name, kind: 'file', files: 1, bytes: info?.size ?? 0 })
      totalFiles += 1
      totalBytes += info?.size ?? 0
      continue
    }
    if (!entry.isDirectory()) continue
    let files = 0
    let bytes = 0
    const stack = [path]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const child of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const childPath = join(current, child.name)
        if (child.isDirectory()) {
          stack.push(childPath)
          continue
        }
        if (!child.isFile()) continue
        const info = await stat(childPath).catch(() => undefined)
        files += 1
        bytes += info?.size ?? 0
      }
    }
    entries.push({ path: entry.name, kind: 'directory', files, bytes })
    totalFiles += files
    totalBytes += bytes
  }
  entries.sort((left, right) => right.files - left.files)
  return { totalFiles, totalBytes, entries }
}

// ---------------------------------------------------------------------------
// One launch
// ---------------------------------------------------------------------------

async function readReadiness(locator) {
  const response = await fetch(harness.apiUrl(locator, '/runtime/readiness'), {
    headers: harness.authHeaders(locator),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  return response.json().catch(() => undefined)
}

/** Read the app's own timing log until the readiness mark has been flushed. */
async function readTimings(logPath, expectStage = 'execution-ready') {
  const deadline = Date.now() + TIMING_LOG_TIMEOUT_MS
  let entries = []
  while (Date.now() < deadline) {
    entries = await harness.readBootstrapTimings(logPath).catch(() => [])
    if (entries.some((entry) => entry.stage === expectStage)) return entries
    await delay(50)
  }
  return entries
}

/**
 * Where the time between two named marks is not explained by the later mark's own
 * duration.
 *
 * Main-process marks are sequential awaits, so `processUptimeMs(n) - processUptimeMs(n-1)`
 * is that stage's real cost and `durationMs` should account for it. When it does not,
 * the wait belongs to work no mark names - which is exactly where a data-scaled cost
 * hides. Renderer marks are excluded: they are IPC events, not steps the boot path
 * awaits, and they interleave with the main process by design.
 */
function analyzeGaps(stages, readyUptimeMs) {
  const considered = stages
    .filter((entry) => typeof entry.stage === 'string' && !entry.stage.startsWith('renderer-'))
    .filter((entry) => typeof entry.processUptimeMs === 'number')
    .filter((entry) => typeof readyUptimeMs !== 'number' || entry.processUptimeMs <= readyUptimeMs + 1)
    .sort((left, right) => left.processUptimeMs - right.processUptimeMs)
  const gaps = []
  for (let index = 1; index < considered.length; index += 1) {
    const previous = considered[index - 1]
    const current = considered[index]
    // Those four marks describe one overlapped await: their order is completion
    // order, so a delta between two of them is scheduling, not a wait to explain.
    if (OVERLAPPING_STAGES.has(previous.stage) && OVERLAPPING_STAGES.has(current.stage)) continue
    // A mark that measures its own overlapping work cannot be subtracted from the
    // gap the way a delta-from-previous mark can.
    const explainedByLater = OVERLAPPING_STAGES.has(current.stage) ? 0 : (current.durationMs ?? 0)
    const gapMs = current.processUptimeMs - previous.processUptimeMs
    gaps.push({
      from: previous.stage,
      to: current.stage,
      fromUptimeMs: previous.processUptimeMs,
      toUptimeMs: current.processUptimeMs,
      gapMs: round(gapMs),
      laterStageDurationMs: current.durationMs ?? null,
      unattributedMs: round(Math.max(0, gapMs - explainedByLater)),
    })
  }
  return gaps.filter((gap) => gap.gapMs >= 20).sort((left, right) => right.unattributedMs - left.unattributedMs)
}

async function runOneLaunch({ fixtureId, dataDir, root, launch, scale }) {
  const chromiumDir = join(root, `chromium-${fixtureId}-${launch}`)
  const logPath = join(root, `electron-${fixtureId}-${launch}.log`)
  const debuggingPort = await harness.reservePort()
  let child
  let spawnRequestedAt = 0
  try {
    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: { LITTLESHEEP_BOOTSTRAP_TIMING: '1' },
      onSpawn: ({ spawnRequestedAt: at }) => { spawnRequestedAt = at },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    const locatorAt = Date.now()

    let readyAt
    let readiness
    let probes = 0
    const deadline = Date.now() + READINESS_TIMEOUT_MS
    while (Date.now() < deadline) {
      probes += 1
      const state = await readReadiness(locator)
      if (state?.state === 'ready') {
        readyAt = Date.now()
        readiness = state
        break
      }
      if (state?.state === 'failed') {
        readiness = state
        readyAt = Date.now()
        break
      }
      await delay(READINESS_POLL_MS)
    }
    const timings = await readTimings(logPath)
    // The app's own origin anchor: `process.uptime()` starts at process creation,
    // so subtracting it from the parent's spawn instant recovers the real start.
    const processStart = timings.find((entry) => entry.stage === 'process-start')?.processUptimeMs
    const processCreatedAt = typeof processStart === 'number' ? spawnRequestedAt - processStart : spawnRequestedAt
    const stages = timings.map((entry, index) => ({ index, ...entry }))
    const durationStages = stages.filter((entry) => typeof entry.durationMs === 'number' && entry.durationMs >= 0)
    const topStages = [...durationStages].sort((left, right) => right.durationMs - left.durationMs).slice(0, TOP_STAGE_COUNT)
    const readyUptimeMs = stages.find((entry) => entry.stage === 'execution-ready')?.processUptimeMs
    const bootstrapStartUptimeMs = stages.find((entry) => entry.stage === 'bootstrap-start')?.processUptimeMs
    const gaps = analyzeGaps(stages, readyUptimeMs)

    // The app's own reader is the proof the fixture is well formed; a fixture the
    // product cannot parse would make every stage number below meaningless.
    const checkpoints = await harness.fetchJson(locator, '/run-checkpoints').catch((error) => ({ error: String(error) }))
    const log = await readFile(logPath, 'utf8').catch(() => '')
    const logFacts = {
      attachmentProtectionCheckpoints: stages.find((entry) => entry.stage === 'attachment-protection-checkpoints')?.durationMs ?? null,
      attachmentProtection: stages.find((entry) => entry.stage === 'attachment-protection')?.durationMs ?? null,
      attachmentProtectionAtUptimeMs: stages.find((entry) => entry.stage === 'attachment-protection')?.processUptimeMs ?? null,
      recoveredRuns: (log.match(/\[durable-harness\] recovered /gu) ?? []).length,
      recoveryNotices: (log.match(/\[durable-harness\]/gu) ?? []).length,
      checkpointScanCapped: /Checkpoint scan capped/u.test(log),
      versioningWarnings: (log.match(/versioning:/gu) ?? []).length,
      runnerWarnings: (log.match(/runner:/gu) ?? []).length,
      attachmentsWarnings: (log.match(/\[attachments\]/gu) ?? []).length,
      // A second `execution-start`/`observability-ready` pair means the Runner was
      // built twice (a failed attempt followed by the retry controller), which would
      // make this launch's numbers a sum of two attempts rather than one start.
      runnerBuilds: stages.filter((entry) => entry.stage === 'execution-start').length,
      readinessRetries: (log.match(/\[retry\]/gu) ?? []).length,
      readinessFailures: (log.match(/\[readiness\]/gu) ?? []).length,
      timingEntries: timings.length,
    }
    return {
      fixtureId,
      launch,
      warm: launch > 1,
      pid: child.pid,
      ok: readiness?.state === 'ready',
      readinessState: readiness?.state ?? null,
      readinessPhase: readiness?.phase ?? null,
      probes,
      spawnToLocatorMs: round(locatorAt - spawnRequestedAt),
      spawnToReadyMs: readyAt === undefined ? undefined : round(readyAt - spawnRequestedAt),
      processCreateToReadyMs: readyAt === undefined ? undefined : round(readyAt - processCreatedAt),
      processStartedAfterSpawnMs: round(spawnRequestedAt - processCreatedAt),
      readyUptimeMs,
      bootstrapStartUptimeMs,
      bootstrapToReadyMs: typeof readyUptimeMs === 'number' && typeof bootstrapStartUptimeMs === 'number'
        ? round(readyUptimeMs - bootstrapStartUptimeMs)
        : undefined,
      stagedSumBeforeReadyMs: round(durationStages
        .filter((entry) => typeof readyUptimeMs !== 'number' || entry.processUptimeMs <= readyUptimeMs)
        .reduce((total, entry) => total + entry.durationMs, 0)),
      scale,
      stages,
      topStages,
      gaps,
      runCheckpointsApi: {
        status: checkpoints?.status ?? null,
        error: checkpoints?.error,
        keys: checkpoints?.body && typeof checkpoints.body === 'object' ? Object.keys(checkpoints.body) : [],
        listed: Array.isArray(checkpoints?.body?.checkpoints) ? checkpoints.body.checkpoints.length : undefined,
        diagnostics: checkpoints?.body?.diagnostics ?? undefined,
      },
      logFacts,
    }
  } finally {
    if (child?.exitCode === null) await harness.forceTerminate(child)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixturePlan(id) {
  if (id === 'synthetic-large') return { id, kind: 'synthetic', scale: LARGE_SCALE, versioningEnabled: true }
  // Same data, versioning off: the A/B that turns the unattributed bootstrap gap
  // into an attributed one.
  if (id === 'synthetic-large-noversioning') return { id, kind: 'synthetic', scale: LARGE_SCALE, versioningEnabled: false }
  if (id === 'small') return { id, kind: 'synthetic', scale: SMALL_SCALE, versioningEnabled: true }
  if (id === 'real-copy') return { id, kind: 'copy', source: realRoot }
  throw new Error(`unknown fixture: ${id}`)
}

async function prepareFixture(plan) {
  const root = await mkdtemp(join(tmpdir(), `littlesheep-large-root-${plan.id}-`))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const startedAt = Date.now()
  if (plan.kind === 'synthetic') {
    const seeded = await seedSyntheticRoot({
      dataDir,
      workspaceDir,
      scale: plan.scale,
      versioningEnabled: plan.versioningEnabled,
    })
    return { root, dataDir, workspaceDir, prepareMs: Date.now() - startedAt, seed: seeded }
  }
  if (!existsSync(plan.source)) throw new Error(`no real data root at ${plan.source}`)
  await mkdir(workspaceDir, { recursive: true })
  await cp(plan.source, dataDir, { recursive: true, force: true, errorOnExist: false })
  // The copied locator belongs to whatever process wrote it; the harness matches on
  // pid, but a stale file left in the tree is not something to measure around.
  await rm(join(dataDir, 'runtime'), { recursive: true, force: true })
  return { root, dataDir, workspaceDir, prepareMs: Date.now() - startedAt, seed: { copiedFrom: plan.source } }
}

async function readBuildFreshness() {
  try {
    const result = await assertAppBuildFresh(repoRoot)
    return { status: 'fresh', detail: result }
  } catch (error) {
    return { status: 'stale', message: error instanceof Error ? error.message : String(error) }
  }
}

async function readMachine() {
  const electron = await readFile(join(repoRoot, 'packages/app/node_modules/electron/package.json'), 'utf8')
    .then((text) => JSON.parse(text).version)
    .catch(() => undefined)
  return {
    platform: `${process.platform} ${process.arch}`,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    electron,
  }
}

/**
 * Stage-by-stage comparison of two synthetic fixtures that differ only in how much
 * data they hold. `scalesWithData` is a heuristic flag, not a verdict: a stage is
 * flagged when the large fixture is at least 20 ms slower *and* at least twice the
 * small fixture's median, which is the smallest difference this sample size can
 * honestly call a scaling stage rather than noise.
 */
function compareFixtures(large, small) {
  if (!large || !small) return undefined
  const stageNames = [...new Set([
    ...large.runs.flatMap((run) => run.stages.map((entry) => entry.stage)),
    ...small.runs.flatMap((run) => run.stages.map((entry) => entry.stage)),
  ])]
  const rows = stageNames.map((stage) => {
    const largeRuns = large.runs.filter((run) => run.ok)
    const smallRuns = small.runs.filter((run) => run.ok)
    const largeMedian = median(largeRuns.flatMap((run) => run.stages.filter((entry) => entry.stage === stage).map((entry) => entry.durationMs)))
    const smallMedian = median(smallRuns.flatMap((run) => run.stages.filter((entry) => entry.stage === stage).map((entry) => entry.durationMs)))
    const deltaMs = largeMedian === undefined || smallMedian === undefined ? undefined : round(largeMedian - smallMedian)
    const scalesWithData = typeof deltaMs === 'number' && deltaMs >= 20
      && (smallMedian === undefined || largeMedian >= Math.max(2 * smallMedian, smallMedian + 20))
    return { stage, largeMedianMs: round(largeMedian), smallMedianMs: round(smallMedian), deltaMs, scalesWithData }
  })
  rows.sort((left, right) => (right.deltaMs ?? -Infinity) - (left.deltaMs ?? -Infinity))
  // The same comparison for the unattributed gaps: a wait no mark names cannot be
  // found by comparing stage durations at all.
  const gapKeys = [...new Set([
    ...large.runs.flatMap((run) => run.gaps.map((gap) => `${gap.from} -> ${gap.to}`)),
    ...small.runs.flatMap((run) => run.gaps.map((gap) => `${gap.from} -> ${gap.to}`)),
  ])]
  const gapRows = gapKeys.map((key) => {
    const largeMedian = median(large.runs.flatMap((run) => run.gaps.filter((gap) => `${gap.from} -> ${gap.to}` === key).map((gap) => gap.unattributedMs)))
    const smallMedian = median(small.runs.flatMap((run) => run.gaps.filter((gap) => `${gap.from} -> ${gap.to}` === key).map((gap) => gap.unattributedMs)))
    const deltaMs = largeMedian === undefined || smallMedian === undefined ? undefined : round(largeMedian - smallMedian)
    return {
      gap: key,
      largeMedianUnattributedMs: round(largeMedian),
      smallMedianUnattributedMs: round(smallMedian),
      deltaMs,
      scalesWithData: typeof deltaMs === 'number' && deltaMs >= 20
        && (smallMedian === undefined || largeMedian >= Math.max(2 * smallMedian, smallMedian + 20)),
    }
  })
  gapRows.sort((left, right) => (right.deltaMs ?? -Infinity) - (left.deltaMs ?? -Infinity))
  return {
    largeFixture: large.id,
    smallFixture: small.id,
    spawnToReadyMs: {
      large: large.runs.map((run) => run.spawnToReadyMs),
      small: small.runs.map((run) => run.spawnToReadyMs),
      largeMedianMs: round(median(large.runs.map((run) => run.spawnToReadyMs))),
      smallMedianMs: round(median(small.runs.map((run) => run.spawnToReadyMs))),
    },
    heuristic: 'scalesWithData = (largeMedian - smallMedian >= 20ms) AND (largeMedian >= max(2 x smallMedian, smallMedian + 20ms))',
    stages: rows,
    scalingStages: rows.filter((row) => row.scalesWithData),
    constantStages: rows.filter((row) => !row.scalesWithData && typeof row.deltaMs === 'number' && Math.abs(row.deltaMs) < 20),
    unattributedGaps: gapRows,
    scalingGaps: gapRows.filter((row) => row.scalesWithData),
  }
}

/**
 * Static attribution: which code each measured stage or gap belongs to, read from
 * the source at the commit recorded above. Kept next to the numbers so the report
 * cannot claim a cause the line references do not support.
 */
const CODE_ATTRIBUTION = [
  {
    measured: 'unattributed gap: runner-infra-observability-ready -> runner-infra-durable-events-ready',
    scalesWith: 'every file in DATA_ROOT_DIRS, plus every manifest in backups/versioning/checkpoints, but only when config.versioning.enabled is true',
    awaitedBeforeReady: true,
    code: [
      'packages/runner/src/infra.ts:282 `await versioning?.initialize()` - inside createRunner, before readiness',
      'packages/snapshot/src/git-checkpoint.ts:467 initializeInternal()',
      'packages/snapshot/src/git-checkpoint.ts:470 + :532-545 recoverPendingManifests(): readdir + readFile + JSON.parse of EVERY file in backups/versioning/checkpoints',
      'packages/snapshot/src/git-checkpoint.ts:472 + :510 -> packages/snapshot/src/git-checkpoint-files.ts:51-73 collectDataFileStats(): recursive walk of DATA_ROOT_DIRS (git-checkpoint-files.ts:26-35: archive, experience, memory, memory-tree, projects, sessions, skills, workspace) with an lstat per file',
      'packages/snapshot/src/git-checkpoint.ts:473 -> packages/snapshot/src/git-client.ts:93-113 commitPaths(): an exists() per path, then `git add -A -f` in batches, then a commit',
      'packages/snapshot/src/git-checkpoint.ts:488-489 writeManifest + pruneManifests() -> :548-554 readdir + stat of every manifest',
    ],
  },
  {
    measured: 'runner-infra-durable-events-ready / -inbox-ready / -run-leases-ready / -effect-leases-ready',
    scalesWith: 'one parsed record per file in durable-events, durable-inbox, durable-run-leases, durable-effect-leases',
    awaitedBeforeReady: true,
    code: [
      'packages/runner/src/infra.ts:319 `await buildDurableHarnessInfrastructure(...)`',
      'packages/runner/src/durable-harness-infrastructure.ts:50-66 - the four initialize() calls run overlapped (Promise.allSettled), which is why each mark carries its own duration',
      'packages/runner/src/durable-event-store.ts:93 initialize() (partition listing at :226)',
      'packages/runner/src/durable-inbox-store.ts:77 initialize() (readdir + parse at :347)',
      'packages/runner/src/durable-run-lease-store.ts:72 initialize() -> :226 readLeases() parses EVERY lease file',
      'packages/runner/src/durable-effect-lease-store.ts (same shape as the run-lease store)',
    ],
  },
  {
    measured: 'execution-ready (the whole runner-ready -> readiness.ready() window)',
    scalesWith: 'the number of run checkpoints and dispositions, and one execution-log read per checkpoint run id',
    awaitedBeforeReady: true,
    code: [
      'packages/app/src/main/index.ts:479 `await server?.setRunner(created)`, then :490 readiness.ready()',
      'packages/app/src/main/local-app-api/run-routes.ts:103 RunRouter.create -> :111 `await recoverDurableRuns(..., "queue")` (the event-partition pass on :112 is `void`ed - the earlier fix)',
      'packages/app/src/main/local-app-api/run-routes.ts:117 `await ...recoverInterruptedResumes(...)` -> packages/runner/src/run-checkpoint-control.ts:72 -> controller.listResumingDispositions() -> packages/runner/src/run-checkpoint-disposition-store.ts:75 and :103 (readdir + parse)',
      'packages/app/src/main/local-app-api/run-routes.ts:125 `await ...reconcileCompletedRuns(...)` -> packages/runner/src/run-checkpoint-control.ts:59 checkpointStore.list() -> packages/runner/src/run-checkpoint-store.ts:203 -> packages/runner/src/run-checkpoint-scan.ts:76-120 (readdir, a stat per file, parse of up to maxReadEntries = 256 newest) and an executionLogStore.read per checkpoint run id at run-checkpoint-control.ts:63',
    ],
  },
  {
    measured: 'attachment-protection / attachment-protection-checkpoints',
    scalesWith: 'up to 128 checkpoints plus every file in attachment-cache/files',
    awaitedBeforeReady: false,
    code: [
      'packages/app/src/main/attachment-protection.ts:22-55 - started from packages/app/src/main/local-app-api-server.ts:99, where `.settled` is stored and never awaited',
    ],
  },
  {
    measured: 'session-index-ready',
    scalesWith: 'nothing during bootstrap: the read itself happens on the first route that needs it',
    awaitedBeforeReady: false,
    code: ['packages/app/src/main/index.ts:312 `void sessionIndex.list().catch(...)`'],
  },
  {
    measured: 'data-root-ready',
    scalesWith: 'nothing measured: DataRootMigrationManager.prepareForBootstrap() had no pending operation in either fixture',
    awaitedBeforeReady: true,
    code: ['packages/app/src/main/index.ts:249 `await dataRootManager.prepareForBootstrap()`'],
  },
]

async function main() {
  const startedAt = new Date()
  const machine = await readMachine()
  const buildFreshness = await readBuildFreshness()
  const head = await readFile(join(repoRoot, '.git', 'HEAD'), 'utf8').catch(() => undefined)
  const report = {
    check: 'desktop-large-root-startup',
    label,
    measuredAt: startedAt.toISOString(),
    question: 'Which startup stage grows with the size of the data root, up to /runtime/readiness = ready?',
    method: [
      'Real Electron app (repository entry) launched against an isolated data root in os.tmpdir()',
      'with LITTLESHEEP_BOOTSTRAP_TIMING=1; the send gate lifts at /runtime/readiness = ready, so the',
      'measurement stops there and no message is ever sent. spawnToReadyMs is parent wall clock from the',
      'spawn call to the first probe that saw `ready`; processCreateToReadyMs re-anchors on the child\'s own',
      '`process-start` uptime entry. Stage durations are the app\'s own [bootstrap-timing] entries.',
    ],
    environment: machine,
    buildFreshness,
    codeAttribution: CODE_ATTRIBUTION,
    ...(head === undefined ? {} : { gitHeadFile: head.trim() }),
    fixtures: [],
    gaps: [],
  }

  for (const id of requestedFixtures) {
    const plan = fixturePlan(id)
    const prepared = await prepareFixture(plan)
    const fixture = {
      id,
      kind: plan.kind,
      ...(plan.kind === 'copy'
        ? { copiedFrom: plan.source }
        : { scale: plan.scale, versioningEnabled: plan.versioningEnabled }),
      temporaryRoot: prepared.root,
      prepareMs: prepared.prepareMs,
      ...(prepared.seed === undefined ? {} : { seed: prepared.seed }),
      runs: [],
    }
    try {
      fixture.inventory = await inventory(prepared.dataDir)
      for (let launch = 1; launch <= runsPerFixture; launch += 1) {
        const run = await runOneLaunch({
          fixtureId: id,
          dataDir: prepared.dataDir,
          root: prepared.root,
          launch,
          scale: fixture.scale,
        })
        fixture.runs.push(run)
        console.log(`[large-root] ${id} launch ${launch}: spawnToReady=${run.spawnToReadyMs}ms ok=${run.ok} top=${run.topStages.slice(0, 3).map((entry) => `${entry.stage}:${entry.durationMs}`).join(' ')}`)
      }
    } catch (error) {
      fixture.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      console.error(`[large-root] ${id} failed: ${fixture.error}`)
    } finally {
      report.fixtures.push({ ...fixture, temporaryRoot: keepRoots ? prepared.root : undefined })
      if (!keepRoots) {
        await harness.removeTemporaryRoot(prepared.root).catch((error) => {
          report.gaps.push(`temporary root for ${id} was not removed: ${error.message}`)
        })
      }
    }
  }

  const byId = Object.fromEntries(report.fixtures.map((fixture) => [fixture.id, fixture]))
  report.comparison = compareFixtures(byId['synthetic-large'], byId.small) ?? null
  report.realCopy = byId['real-copy']
    ? {
      spawnToReadyMs: byId['real-copy'].runs.map((run) => run.spawnToReadyMs),
      topStages: byId['real-copy'].runs.map((run) => run.topStages.slice(0, 5)),
      inventoryTotals: byId['real-copy'].inventory === undefined
        ? undefined
        : { files: byId['real-copy'].inventory.totalFiles, bytes: byId['real-copy'].inventory.totalBytes },
    }
    : null

  const withVersioning = byId['synthetic-large']
  const withoutVersioning = byId['synthetic-large-noversioning']
  report.versioningExperiment = withVersioning === undefined || withoutVersioning === undefined
    ? null
    : {
      note: [
        'Same seeded data root, same scale, same config except config.versioning.enabled.',
        'This is the experiment that attributes the unattributed bootstrap gap: if the gap',
        'collapses with versioning off, the shadow-Git bootstrap is what scales with data.',
      ],
      bootstrapGap: {
        withVersioning: withVersioning.runs.map((run) => run.gaps[0]?.unattributedMs ?? null),
        withoutVersioning: withoutVersioning.runs.map((run) => run.gaps[0]?.unattributedMs ?? null),
        withVersioningGapFrom: withVersioning.runs.map((run) => (run.gaps[0] ? `${run.gaps[0].from} -> ${run.gaps[0].to}` : null)),
        withoutVersioningGapFrom: withoutVersioning.runs.map((run) => (run.gaps[0] ? `${run.gaps[0].from} -> ${run.gaps[0].to}` : null)),
      },
      spawnToReadyMs: {
        withVersioning: withVersioning.runs.map((run) => run.spawnToReadyMs),
        withoutVersioning: withoutVersioning.runs.map((run) => run.spawnToReadyMs),
      },
      executionReadyStageMs: {
        withVersioning: withVersioning.runs.map((run) => run.stages.find((entry) => entry.stage === 'execution-ready')?.durationMs ?? null),
        withoutVersioning: withoutVersioning.runs.map((run) => run.stages.find((entry) => entry.stage === 'execution-ready')?.durationMs ?? null),
      },
    }

  report.gaps.push(
    'The synthetic fixtures are written by this script in the shapes the product writes, not by the product;',
    'the app\'s own reader is what proves they are parseable (/run-checkpoints is read after readiness).',
    'The app build is one commit behind HEAD (see buildFreshness); the differing commits touch packages/snapshot',
    'preimage reuse and per-run send-to-first-token timing, neither of which is on the bootstrap path.',
    'readiness is observed by polling at 20 ms, so spawnToReadyMs carries up to ~20 ms of observation lag.',
    'memory v3 is not exercised by the synthetic fixtures (it needs a SQLite catalog and a local embedding',
    'model); the real-copy fixture reflects whatever backend that data root actually uses.',
  )

  await mkdir(outDir, { recursive: true })
  const jsonPath = join(outDir, 'desktop-large-root-startup.json')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    ok: report.fixtures.every((fixture) => fixture.error === undefined && fixture.runs.every((run) => run.ok)),
    jsonPath,
    spawnToReady: Object.fromEntries(report.fixtures.map((fixture) => [fixture.id, fixture.runs.map((run) => run.spawnToReadyMs)])),
    topStages: Object.fromEntries(report.fixtures.map((fixture) => [
      fixture.id,
      fixture.runs.map((run) => run.topStages.slice(0, 5).map((entry) => `${entry.stage}=${entry.durationMs}ms`)),
    ])),
    scalingStages: report.comparison?.scalingStages ?? null,
    scalingGaps: report.comparison?.scalingGaps ?? null,
    largestGaps: Object.fromEntries(report.fixtures.map((fixture) => [
      fixture.id,
      fixture.runs.map((run) => run.gaps.slice(0, 3).map((gap) => `${gap.from}->${gap.to}=${gap.unattributedMs}ms`)),
    ])),
  }, null, 2))
  if (!report.fixtures.every((fixture) => fixture.error === undefined && fixture.runs.every((run) => run.ok))) {
    process.exitCode = 1
  }
}

await main()
