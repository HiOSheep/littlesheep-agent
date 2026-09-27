import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import {
  MEMORY_REPOSITORY_LOCATOR_FILE,
  MemoryAtomStore,
  MemoryRepository,
  MemoryV2ToV3MigrationManager,
} from '../packages/memory-tree/dist/index.js';
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  getLocalEmbeddingModel,
  verifyLocalEmbeddingModel,
} from '../packages/embedding/dist/index.js';
import { createRunner } from '../packages/runner/dist/index.js';

const args = parseArgs(process.argv.slice(2));
const sourceDataDir = resolve(args.dataDir);
const sourceMemoryDir = join(sourceDataDir, 'memory-tree');
const isolatedDataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-readiness-'));
const isolatedMemoryDir = join(isolatedDataDir, 'memory-tree');
const startedAt = performance.now();
const embeddingModelRootDir = join(sourceDataDir, 'models', 'embedding');
assertIsolatedRoot(isolatedDataDir);

let repository;
let report;
try {
  const sourceManager = new MemoryV2ToV3MigrationManager({ dataDir: sourceDataDir });
  const sourceBefore = await sourceManager.preflight();
  assertPreflightReady(sourceBefore, 'source');
  const embeddingSpec = getLocalEmbeddingModel(DEFAULT_LOCAL_EMBEDDING_MODEL);
  const embeddingVerification = await verifyLocalEmbeddingModel(
    DEFAULT_LOCAL_EMBEDDING_MODEL,
    embeddingModelRootDir,
  );

  await cp(sourceMemoryDir, isolatedMemoryDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => shouldCopyMemoryV2Path(sourceMemoryDir, source),
  });

  const isolatedManager = new MemoryV2ToV3MigrationManager({ dataDir: isolatedDataDir });
  const isolatedBefore = await isolatedManager.preflight();
  assertPreflightReady(isolatedBefore, 'isolated copy');
  assertSameSource(sourceBefore, isolatedBefore, 'The isolated Memory v2 copy differs from its source.');

  const sourceAfterCopy = await sourceManager.preflight();
  assertSameSource(sourceBefore, sourceAfterCopy, 'Memory v2 changed while its isolated copy was created.');

  const migrated = await isolatedManager.migrate();
  assert.equal(migrated.locator.activeBackend, 'v3');
  assert.equal(migrated.migration.sourceIndexHash, sourceBefore.source.indexHash);
  assert.equal(migrated.migration.sourceManifestHash, sourceBefore.source.manifestHash);
  assert.equal(migrated.migration.nodeCount, sourceBefore.source.nodeCount);
  assert.equal(migrated.migration.resourceCount, sourceBefore.source.resourceCount);

  repository = new MemoryRepository({ dataDir: isolatedDataDir, backend: 'v3' });
  await repository.initialize();
  const firstSnapshot = await repository.snapshot();
  const firstStatus = await repository.management.status();
  const firstAtomMetrics = await assertV3Repository(firstSnapshot, firstStatus, sourceBefore);
  repository.close();
  repository = undefined;

  repository = new MemoryRepository({ dataDir: isolatedDataDir, backend: 'v3' });
  await repository.initialize();
  const restartSnapshot = await repository.snapshot();
  const restartStatus = await repository.management.status();
  const restartAtomMetrics = await assertV3Repository(restartSnapshot, restartStatus, sourceBefore);
  assert.deepEqual(restartAtomMetrics, firstAtomMetrics);
  repository.close();
  repository = undefined;

  const rolledBack = await isolatedManager.rollback();
  assert.equal(rolledBack.activeBackend, 'v2');
  assert.equal(rolledBack.previousBackend, 'v3');
  const isolatedAfterRollback = await isolatedManager.preflight();
  assertPreflightReady(isolatedAfterRollback, 'rolled-back isolated copy');
  assertSameSource(sourceBefore, isolatedAfterRollback, 'Rollback changed the isolated Memory v2 source.');
  const runtimeAcceptance = await verifyPostMigrationRuntime(isolatedManager, isolatedDataDir);

  const sourceAfterVerification = await sourceManager.preflight();
  assertSameSource(
    sourceBefore,
    sourceAfterVerification,
    'Memory v2 changed while migration readiness was being verified.',
  );

  report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: {
      fileCount: sourceBefore.source.fileCount,
      totalBytes: sourceBefore.source.totalBytes,
      nodeCount: sourceBefore.source.nodeCount,
      resourceCount: sourceBefore.source.resourceCount,
      indexHash: sourceBefore.source.indexHash,
      manifestHash: sourceBefore.source.manifestHash,
    },
    storage: sourceBefore.storage,
    embedding: {
      modelId: embeddingSpec.id,
      available: embeddingVerification.available,
      requiredBytes: embeddingSpec.files.reduce((sum, file) => sum + file.bytes, 0),
      verifiedBytes: embeddingVerification.totalBytes,
      missing: embeddingVerification.missing,
      invalid: embeddingVerification.invalid,
    },
    migration: {
      validationHash: migrated.migration.validationHash,
      activeBackendVerified: 'v3',
      restartVerified: true,
      catalogIntegrity: restartStatus.catalog?.integrity,
      catalogAtomCount: restartStatus.catalog?.atomCount,
      publicAtomCount: restartAtomMetrics.publicAtomCount,
      internalRootCount: restartAtomMetrics.internalRootCount,
      rollbackVerified: true,
    },
    runtimeAcceptance,
    sourceUnchanged: true,
    isolatedCloneRemoved: true,
    timingMs: Math.round(performance.now() - startedAt),
  };
} finally {
  repository?.close();
  await rm(isolatedDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function assertPreflightReady(preflight, label) {
  assert.equal(preflight.locator.activeBackend, 'v2', `${label} is not using Memory v2.`);
  assert.equal(preflight.canMigrate, true, preflight.blockers.join('; ') || `${label} cannot migrate.`);
  assert.deepEqual(preflight.blockers, []);
  assert(preflight.source, `${label} has no readable Memory v2 source.`);
  assert(preflight.storage, `${label} has no storage readiness evidence.`);
}

function assertSameSource(expected, actual, message) {
  assert(expected.source && actual.source, message);
  assert.deepEqual(actual.source, expected.source, message);
}

async function assertV3Repository(snapshot, status, sourcePreflight) {
  const nodeCount = Object.values(snapshot.nodes).filter((node) => !node.isBranchRoot).length;
  const resourceCount = Object.keys(snapshot.resources).length;
  assert.equal(status.backendKind, 'v3');
  assert.equal(status.storageKind, 'atom-catalog');
  assert.equal(status.catalog?.integrity, 'ok');
  assert.equal(nodeCount, sourcePreflight.source.nodeCount);
  assert.equal(resourceCount, sourcePreflight.source.resourceCount);
  const atomStore = new MemoryAtomStore({ dataDir: isolatedDataDir });
  const scan = await atomStore.initialize();
  assert.deepEqual(scan.issues, []);
  const publicAtomIds = new Set(
    Object.values(snapshot.nodes)
      .filter((node) => !node.isBranchRoot)
      .map((node) => node.id),
  );
  const internalRoots = scan.entries.filter((entry) => isInternalScopeRoot(entry.id));
  const unexpected = scan.entries.filter((entry) => (
    !publicAtomIds.has(entry.id) && !isInternalScopeRoot(entry.id)
  ));
  assert.deepEqual(unexpected.map((entry) => entry.id), []);
  assert.equal(scan.entries.length, publicAtomIds.size + internalRoots.length);
  assert.equal(status.catalog?.atomCount, scan.entries.length);
  return {
    publicAtomCount: publicAtomIds.size,
    internalRootCount: internalRoots.length,
    totalAtomCount: scan.entries.length,
  };
}

function isInternalScopeRoot(atomId) {
  return atomId.startsWith('v3-scope-root:')
    || ['long-term:root', 'daily:root', 'project:root', 'experience:root'].includes(atomId);
}

function shouldCopyMemoryV2Path(root, source) {
  const path = relative(root, source).replace(/\\/gu, '/');
  if (!path) return true;
  const first = path.split('/')[0];
  return first !== 'v3'
    && first !== 'migrations'
    && path !== MEMORY_REPOSITORY_LOCATOR_FILE;
}

function assertIsolatedRoot(path) {
  const normalized = resolve(path);
  const tempRoot = resolve(tmpdir());
  assert(normalized.startsWith(`${tempRoot}${sep}`));
  assert(normalized.includes('littlesheep-memory-v3-readiness-'));
}

async function verifyPostMigrationRuntime(manager, dataDir) {
  const migration = await manager.migrate();
  assert.equal(migration.locator.activeBackend, 'v3');
  const workspace = join(dataDir, 'workplace');
  await mkdir(workspace, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.workspace = workspace;
  // The Runner derives its approval mode from the container root, which is the bootstrap directory.
  // Without one the approval callback is unavailable and the approval-gated `memory_write` is refused
  // before it runs — the gate would then measure the harness, not the migrated write path.
  const bootstrapDir = join(dataDir, 'bootstrap');
  await mkdir(bootstrapDir, { recursive: true });
  await writeFile(
    join(bootstrapDir, 'AGENTS.md'),
    'Isolated post-migration acceptance environment. Keep every action inside the supplied workspace.\n',
    'utf8',
  );
  const previousDataDir = process.env.LITTLESHEEP_DATA_DIR;
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  const runId = 'memory-v3-runtime-acceptance';
  const marker = 'Migrated runtime acceptance marker';
  let first;
  let restored;
  try {
    first = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      bootstrapDir,
      llm: makeMockLlm([
        // The user's own message carries the memory instruction, so the model has a legitimate
        // `user-request` basis. The runtime reads that message itself and the write tool checks it.
        toolCallResponse('migrated-write', 'memory_write', {
          reasonKind: 'user-request',
          summary: marker,
          content: `The migrated runtime acceptance marker is ${marker}.`,
          retrievalKeys: ['migrated', 'runtime', 'acceptance', marker],
          reason: 'The user asked for this to be remembered in this run.',
          // Long-term/global is the form the controlled tool can complete on its own: a project write
          // needs a `scopeKey` only the workspace resource path (not the model) can supply.
          branch: 'long-term',
          confidence: 0.95,
          importance: 0.85,
        }),
        textResponse('The isolated migrated runtime completed its verification step.'),
      ]),
      skillsDirs: [],
      runTimeoutMs: 30_000,
    });
    const result = await first.run({
      runId,
      origin: 'app',
      // The isolated acceptance runs in full mode: `memory_write` is approval-gated in the other
      // modes, and this gate is about the post-migration write path, not the approval prompt.
      permissionPolicyId: 'full',
      workspaceContext: { boundaryKind: 'agent_workplace' },
      text: [
        'Verify the isolated migrated Memory v3 runtime without external tools.',
        `请记住：迁移后的验收标记是 ${marker}。这条指令就是用户要求长期保存该标记的原话。`,
      ].join('\n'),
      cwd: workspace,
    });
    assert.equal(result.status, 'ok', result.error ?? String(result.reply ?? ''));
    // Durable memory comes from the controlled tool, not from an automatic settlement stage: the run
    // must have committed a `tool`-stage write of this run, and the retired stages must not appear.
    const trace = new Set((await first.replay(runId))?.trace?.filter((entry) => entry.ok).map((entry) => entry.name) ?? []);
    for (const stage of ['enter', 'execute', 'finalize']) {
      assert(trace.has(stage), `The post-migration run did not complete ${stage}.`);
    }
    for (const retired of ['decide', 'evolve', 'capture']) {
      assert(!trace.has(retired), `The post-migration run ran the retired ${retired} stage.`);
    }
    const replay = await first.replay(runId);
    const toolSummary = (replay?.toolCalls ?? [])
      .map((record) => `${record.call.name}:${record.result.ok ? 'ok' : (record.result.meta?.errorKind ?? 'failed')}:${(record.result.error ?? '').slice(0, 120)}`)
      .join(' | ') || 'none';
    const writtenNode = (await first.infra.memoryRepository.listNodes('long-term'))
      .find((node) => node.sourceRunIds.includes(runId));
    assert(writtenNode,
      `The migrated runtime persisted no durable memory for its own run; tool calls=${toolSummary}`);
    const memoryWrite = await first.infra.memoryRepository.management.inspectNode(writtenNode.id, 'D3');
    assert(memoryWrite.atom.sourceStages?.includes('tool'),
      `The migrated runtime did not persist a controlled tool write: sourceStages=${(memoryWrite.atom.sourceStages ?? []).join(',')}`);
    assert(
      `${memoryWrite.atom.summary}\n${memoryWrite.atom.content}`.includes(marker),
      'The migrated runtime did not persist the marker the user asked it to remember.',
    );
    const firstMessages = await first.sessionManager.read(result.sessionId);
    assert(firstMessages.some((message) => message.role === 'user'));
    assert(firstMessages.some((message) => message.role === 'assistant'));

    await first.shutdown();
    first = undefined;
    restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      bootstrapDir,
      llm: makeMockLlm([]),
      skillsDirs: [],
      runTimeoutMs: 30_000,
    });
    assert.equal((await restored.infra.memoryRepository.getNode(writtenNode.id))?.summary, marker);
    const restoredMessages = await restored.sessionManager.read(result.sessionId);
    assert.deepEqual(restoredMessages.map((message) => message.id), firstMessages.map((message) => message.id));

    const navigationRunId = 'memory-v3-runtime-navigation';
    await restored.infra.memoryService.beginRun({
      runId: navigationRunId,
      sessionId: result.sessionId,
      query: 'migrated runtime acceptance',
      recentHistory: [],
      workspace,
      autoPrime: false,
    });
    const index = await restored.infra.memoryService.branchIndex(navigationRunId, 'long-term');
    assert(index.entries.some((entry) => entry.id === writtenNode.id));
    const expansion = await restored.infra.memoryService.expand(navigationRunId, {
      branchId: 'long-term',
      nodeId: writtenNode.id,
      limit: 1,
      tokenBudget: 800,
    });
    assert(expansion.fragments.some((fragment) => fragment.id === writtenNode.id));
    const released = await restored.infra.memoryService.release(navigationRunId, [writtenNode.id]);
    assert.deepEqual(released.releasedAtomIds, [writtenNode.id]);
    const search = await restored.infra.memoryService.deepSearch(navigationRunId, {
      branchId: 'long-term',
      query: 'migrated runtime acceptance',
      limit: 5,
      tokenBudget: 800,
    });
    assert(search.fragments.some((fragment) => fragment.id === writtenNode.id));
    await restored.infra.memoryService.finishRun(navigationRunId);

    const validateActiveV3 = (source, sourceManifestHash) => (
      restored.infra.memoryRepository.management.validateMigrationSource(source, sourceManifestHash)
    );
    const rollbackPreflight = await manager.preflight({ validateActiveV3 });
    assert.equal(rollbackPreflight.rollback?.sourceUnchanged, true);
    assert.equal(rollbackPreflight.rollback?.activeV3Unchanged, false);
    assert.equal(rollbackPreflight.rollbackAvailable, false);
    await assert.rejects(
      manager.requestRollback({ validateActiveV3 }),
      /differs|lose data/iu,
    );
    assert.equal((await manager.status()).pendingRollback, undefined);
    return {
      runStatus: result.status,
      sessionMessageCount: restoredMessages.length,
      controlledWriteAtomsPersisted: 1,
      controlledWriteSourceStages: [...(memoryWrite.atom.sourceStages ?? [])],
      retiredStagesAbsent: true,
      restartRecovered: true,
      indexedNavigationVerified: true,
      ftsRetrievalVerified: true,
      rollbackBlockedAfterAuthoritativeWrite: true,
    };
  } finally {
    await first?.shutdown().catch(() => undefined);
    await restored?.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
    else process.env.LITTLESHEEP_DATA_DIR = previousDataDir;
  }
}

function makeMockLlm(responses) {
  const queue = [...responses];
  const requests = [];
  const chat = async (request) => {
    requests.push(request);
    const response = queue.shift();
    if (!response) {
      // The request count makes an exhausted queue actionable: it says how far the run got.
      throw new Error(`Unexpected LLM request during Memory v3 runtime acceptance (#${requests.length}).`);
    }
    return response;
  };
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      if (response.content) onDelta({ type: 'delta', delta: response.content });
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}

function textResponse(content) {
  return { content, toolCalls: [], finishReason: 'stop' };
}

/** A model turn that asks for the controlled durable write instead of an automatic settlement. */
function toolCallResponse(id, name, args) {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function parseArgs(values) {
  let dataDir = process.env.LITTLESHEEP_DATA_DIR?.trim();
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--data-dir=')) dataDir = value.slice('--data-dir='.length).trim();
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!dataDir) {
    throw new Error('Provide --data-dir=<LittleSheep data root> or LITTLESHEEP_DATA_DIR.');
  }
  return { dataDir };
}
