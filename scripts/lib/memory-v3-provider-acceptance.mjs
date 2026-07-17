import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  InjectionTier,
  MemoryRepository,
  createMemoryV3ExperimentMarker,
} from '../../packages/memory-tree/dist/index.js';
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  verifyLocalEmbeddingModel,
} from '../../packages/embedding/dist/index.js';
import { createRunner } from '../../packages/runner/dist/index.js';

export async function runMemoryV3ProviderAcceptance(options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-provider-'));
  assertIsolatedRoot(dataDir);
  const workspace = join(dataDir, 'workplace');
  const bootstrapDir = join(dataDir, 'bootstrap');
  const marker = `LS-MV3-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const firstRunId = `memory-v3-provider-primary-${randomUUID()}`;
  const recallRunId = `memory-v3-provider-recall-${randomUUID()}`;
  const previousDataDir = process.env.LITTLESHEEP_DATA_DIR;
  let first;
  let restored;
  try {
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(bootstrapDir, { recursive: true })]);
    await writeSyntheticBootstrap(bootstrapDir);
    const embeddingAssets = await copyEmbeddingAssets(options.sourceDataDir, dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    process.env.LITTLESHEEP_DATA_DIR = dataDir;

    const config = structuredClone(options.config);
    config.memory.repositoryBackend = 'v3';
    config.agents.defaults.workspace = workspace;
    config.agents.defaults.model = options.modelRef;
    config.agents.defaults.reasoning = options.reasoning;

    first = await createRunner({
      config,
      branding: options.branding,
      model: options.modelRef,
      bootstrapDir,
      skillsDirs: [],
      approve: async () => true,
      runTimeoutMs: options.timeoutMs,
    });
    const seed = await first.infra.memoryRepository.write({
      branch: 'long-term',
      parentNodeId: MemoryRepository.branchRootId('long-term'),
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: '真实 Provider Memory v3 验收标记',
      content: `当前隔离验收使用的项目标记是 ${marker}。`,
      retrievalKeys: ['真实 provider', 'memory v3', '验收标记', marker],
      sourceRunId: 'memory-v3-provider-seed',
      sourceStage: 'tool',
      evidenceRefs: [`provider-acceptance:${marker}`],
      importance: 0.96,
      confidence: 0.99,
      reason: '为真实 Provider 的首轮索引注入提供可验证的合成事实。',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3', 'provider-acceptance'] },
        assertedBy: { kind: 'tool', id: 'verify-memory-v3-provider' },
      },
    });
    assert.equal(seed.decision, 'created', seed.reason);
    assert(seed.node);
    const seedBefore = await requiredInspection(first, seed.node.id);

    const primary = await first.run({
      runId: firstRunId,
      origin: 'test',
      cwd: workspace,
      permissionPolicyId: 'full',
      reasoning: options.reasoning,
      profile: 'general',
      workspaceContext: { boundaryKind: 'default' },
      text: [
        '这是隔离的 Memory v3 验收任务。',
        '请从已经注入的记忆中找出“真实 Provider Memory v3 验收标记”，不要猜测。',
        '用该标记形成一条明确的项目决策，并在最终回答中原样写出标记。',
        '请把该决策沉淀为项目记忆，并记录本轮完成观察。',
        '本任务不需要访问网络、系统外部目录或用户真实文件。',
      ].join('\n'),
    });
    assert.equal(primary.status, 'ok', primary.error ?? primary.reply);
    const primaryLog = await requiredLog(first, firstRunId);
    assertMemoryEnteredContext(primaryLog, seed.node.id);
    assertProviderUsage(primaryLog, options.providerId);
    assertRequiredTrace(primaryLog);
    assertReplyUsesMarker(primary.reply, marker, 'primary');
    const committedStages = committedMemoryStages(primaryLog);
    assert(committedStages.has('evolve'), 'The real Provider run did not commit an EVOLVE memory intent.');
    assert(committedStages.has('capture'), 'The real Provider run did not commit a CAPTURE memory intent.');

    const projectNode = (await first.infra.memoryRepository.listNodes('project', workspace))
      .find((node) => node.sourceRunIds.includes(firstRunId) && `${node.summary}\n${node.content}`.includes(marker));
    const dailyNode = (await first.infra.memoryRepository.listNodes('daily', workspace))
      .find((node) => node.sourceRunIds.includes(firstRunId));
    assert(projectNode, 'The real Provider run did not persist the marker as project memory.');
    assert(dailyNode, 'The real Provider run did not persist a CAPTURE observation.');
    const projectInspection = await requiredInspection(first, projectNode.id);
    assert(projectInspection.atom.sourceRefs.some((ref) => ref.includes(firstRunId)));
    assert((projectInspection.projectionRecords?.length ?? 0) > 0);
    const seedAfterPrimary = await requiredInspection(first, seed.node.id);
    assert(seedAfterPrimary.atom.feedbackRevision > seedBefore.atom.feedbackRevision);

    const firstMessages = await first.sessionManager.read(primary.sessionId);
    assert(firstMessages.some((message) => message.role === 'user'));
    assert(firstMessages.some((message) => message.role === 'assistant'));
    await first.shutdown();
    first = undefined;

    restored = await createRunner({
      config,
      branding: options.branding,
      model: options.modelRef,
      bootstrapDir,
      skillsDirs: [],
      approve: async () => true,
      runTimeoutMs: options.timeoutMs,
    });
    assert.equal((await restored.infra.memoryRepository.getNode(projectNode.id))?.summary, projectNode.summary);
    assert.equal((await restored.infra.memoryRepository.getNode(dailyNode.id))?.summary, dailyNode.summary);
    const restoredMessages = await restored.sessionManager.read(primary.sessionId);
    assert.deepEqual(restoredMessages.map((message) => message.id), firstMessages.map((message) => message.id));
    const projectBeforeRecall = await requiredInspection(restored, projectNode.id);

    const recall = await restored.run({
      runId: recallRunId,
      origin: 'test',
      cwd: workspace,
      permissionPolicyId: 'full',
      reasoning: options.reasoning,
      profile: 'general',
      workspaceContext: { boundaryKind: 'default' },
      text: '请从当前项目记忆中回答：真实 Provider Memory v3 验收标记是什么？只回答标记本身。',
    });
    assert.equal(recall.status, 'ok', recall.error ?? recall.reply);
    const recallLog = await requiredLog(restored, recallRunId);
    assertMemoryEnteredContext(recallLog, projectNode.id);
    assertProviderUsage(recallLog, options.providerId);
    assertReplyUsesMarker(recall.reply, marker, 'recall');
    const projectAfterRecall = await requiredInspection(restored, projectNode.id);
    assert(projectAfterRecall.atom.feedbackRevision > projectBeforeRecall.atom.feedbackRevision);

    const repositoryStatus = await restored.infra.memoryRepository.management.status();
    assert.equal(repositoryStatus.catalog?.integrity, 'ok');
    assert.equal(repositoryStatus.catalog?.embedding.pending, 0);
    assert.equal(repositoryStatus.catalog?.embedding.failed, 0);
    const conversationSources = await countFiles(join(dataDir, 'memory-tree', 'v3', 'conversation-sources'), '.conversation-source.json');
    const projectionRecords = await countFiles(join(dataDir, 'memory-tree', 'v3', 'raw-records'), '.raw-record.json');
    const commitReceipts = await countFiles(join(dataDir, 'memory-tree', 'v3', 'raw-record-commits'), '.commit.json');
    assert(conversationSources >= 4);
    assert(projectionRecords >= 3);
    assert(commitReceipts >= 3);

    return {
      ok: true,
      provider: options.providerId,
      model: options.modelRef,
      reasoning: options.reasoning,
      marker,
      primary: summarizeRun(primary, primaryLog),
      recall: summarizeRun(recall, recallLog),
      memory: {
        seedAtomId: seed.node.id,
        projectAtomId: projectNode.id,
        dailyAtomId: dailyNode.id,
        seedFeedbackRevision: seedAfterPrimary.atom.feedbackRevision,
        projectFeedbackRevision: projectAfterRecall.atom.feedbackRevision,
        conversationSources,
        projectionRecords,
        commitReceipts,
        restartRecovered: true,
        newSessionRecallVerified: true,
      },
      embedding: {
        model: DEFAULT_LOCAL_EMBEDDING_MODEL,
        copiedBytes: embeddingAssets.totalBytes,
        ready: repositoryStatus.catalog?.embedding.ready,
        pending: repositoryStatus.catalog?.embedding.pending,
        failed: repositoryStatus.catalog?.embedding.failed,
      },
      isolatedDataRootRemoved: true,
    };
  } finally {
    await first?.shutdown().catch(() => undefined);
    await restored?.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
    else process.env.LITTLESHEEP_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function copyEmbeddingAssets(sourceDataDir, targetDataDir) {
  const sourceRoot = join(sourceDataDir, 'models', 'embedding');
  const verification = await verifyLocalEmbeddingModel(DEFAULT_LOCAL_EMBEDDING_MODEL, sourceRoot);
  assert(verification.available, 'The active data root has no verified local BGE model.');
  const targetRoot = join(targetDataDir, 'models', 'embedding');
  const targetRevision = join(targetRoot, relative(sourceRoot, verification.modelRoot));
  await mkdir(targetRevision, { recursive: true });
  await cp(verification.modelRoot, targetRevision, { recursive: true, force: false });
  const copied = await verifyLocalEmbeddingModel(DEFAULT_LOCAL_EMBEDDING_MODEL, targetRoot);
  assert(copied.available, 'The isolated BGE copy failed verification.');
  return copied;
}

async function writeSyntheticBootstrap(root) {
  const files = {
    'AGENTS.md': 'You are LittleSheep in an isolated acceptance run. Follow the normal workflow, verify claims, and keep all actions inside the supplied workspace.',
    'SOUL.md': 'Be precise, concise, and evidence based.',
    'USER.md': 'The user is running a synthetic Memory v3 Provider acceptance test.',
    'PHILOSOPHY.md': 'Persist only verified, task-relevant information.',
    'TOOLS.md': 'Use only tools that are necessary for the current isolated task.',
    'MEMORY.md': 'No private user memory is included in this acceptance environment.',
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), `${content}\n`, 'utf8')));
}

async function requiredInspection(runner, atomId) {
  const inspection = await runner.infra.memoryRepository.management.inspectNode(atomId, 'D3');
  assert(inspection?.atom);
  return inspection;
}

async function requiredLog(runner, runId) {
  const log = await runner.replay(runId);
  assert(log, `Execution log was not persisted for ${runId}.`);
  return log;
}

function assertMemoryEnteredContext(log, atomId) {
  const accessRecords = log.memoryAccess?.records ?? [];
  assert(
    accessRecords.some((record) => record.fragmentIds?.includes(atomId) && record.tokensUsed > 0),
    `Memory access ledger did not admit atom ${atomId}; actions=${accessRecords.map((record) => `${record.action}:${record.status}:${record.fragmentIds?.join(',') ?? ''}`).join('|')}`,
  );
  assert(
    log.memoryKnownState?.references.some((reference) => reference.atomId === atomId && reference.decision === 'adopted'),
    `Memory KnownState did not adopt atom ${atomId}.`,
  );
}

function assertProviderUsage(log, providerId) {
  const snapshots = log.contextSnapshots ?? [];
  assert(snapshots.some((snapshot) => snapshot.provider === providerId));
  assert(snapshots.some((snapshot) => snapshot.providerUsage?.source === 'provider'
    && snapshot.providerUsage.promptTokens > 0));
}

function assertReplyUsesMarker(reply, marker, phase) {
  assert(
    reply.includes(marker),
    `${phase} Provider reply did not use the injected marker; safe reply excerpt: ${safeReplyExcerpt(reply)}`,
  );
}

function safeReplyExcerpt(reply) {
  return JSON.stringify(String(reply)
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 240));
}

function assertRequiredTrace(log) {
  const stages = new Set(log.trace.filter((entry) => entry.ok).map((entry) => entry.name));
  for (const stage of ['ENTER', 'CLASSIFY', 'DECIDE', 'EXECUTE', 'VERIFY', 'EVOLVE', 'CAPTURE', 'FINALIZE']) {
    assert(stages.has(stage), `The real Provider run did not complete ${stage}.`);
  }
}

function committedMemoryStages(log) {
  return new Set((log.memoryIntentDecisions ?? [])
    .filter((decision) => decision.decision === 'committed')
    .map((decision) => decision.stage));
}

function summarizeRun(result, log) {
  const providerUsage = (log.contextSnapshots ?? [])
    .map((snapshot) => snapshot.providerUsage)
    .filter(Boolean);
  return {
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    durationMs: log.durationMs,
    modelRequests: log.modelRequests?.length ?? 0,
    providerPromptTokens: providerUsage.reduce((sum, usage) => sum + usage.promptTokens, 0),
    providerCompletionTokens: providerUsage.reduce((sum, usage) => sum + usage.completionTokens, 0),
    committedMemoryStages: [...committedMemoryStages(log)].sort(),
  };
}

async function countFiles(root, suffix) {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}

function assertIsolatedRoot(path) {
  const normalized = resolve(path);
  assert(normalized.startsWith(`${resolve(tmpdir())}${sep}`));
  assert(normalized.includes('littlesheep-memory-v3-provider-'));
}
