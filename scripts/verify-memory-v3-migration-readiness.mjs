import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
      llm: makeMockLlm([
        textResponse('{"type":"problem","confidence":0.9,"reason":"runtime acceptance"}'),
        textResponse('{"plan":[{"description":"verify migrated runtime","tools":[]}]}'),
        textResponse('The isolated migrated runtime completed its verification step.'),
        textResponse('{"verdict":"pass","reason":"isolated runtime goal achieved"}'),
        textResponse(JSON.stringify({ memories: [{
          branch: 'project',
          parentNodeId: 'project:root',
          scope: 'workspace',
          summary: marker,
          content: 'The migrated Memory v3 repository accepted an EVOLVE write through the real Runner path.',
          retrievalKeys: ['migrated', 'runtime', 'acceptance'],
          importance: 0.8,
          confidence: 0.95,
          reason: 'Verified by the isolated post-migration Runner acceptance flow.',
        }], createSkill: null })),
        textResponse(JSON.stringify({ observations: [{
          summary: 'Migrated runtime run completed',
          content: 'The isolated post-migration Runner completed and persisted its CAPTURE record.',
          retrievalKeys: ['migrated', 'runtime', 'capture'],
          importance: 0.5,
          confidence: 0.95,
          reason: 'The Runner returned an accepted result in the isolated migrated data root.',
        }] })),
      ]),
      skillsDirs: [],
      runTimeoutMs: 30_000,
    });
    const result = await first.run({
      runId,
      origin: 'app',
      text: 'Verify the isolated migrated Memory v3 runtime without external tools.',
      cwd: workspace,
    });
    assert.equal(result.status, 'ok');
    const projectNode = (await first.infra.memoryRepository.listNodes('project'))
      .find((node) => node.sourceRunIds.includes(runId));
    const dailyNode = (await first.infra.memoryRepository.listNodes('daily'))
      .find((node) => node.sourceRunIds.includes(runId));
    assert(projectNode, 'The migrated runtime did not persist its EVOLVE atom.');
    assert(dailyNode, 'The migrated runtime did not persist its CAPTURE atom.');
    const firstMessages = await first.sessionManager.read(result.sessionId);
    assert(firstMessages.some((message) => message.role === 'user'));
    assert(firstMessages.some((message) => message.role === 'assistant'));

    await first.shutdown();
    first = undefined;
    restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([]),
      skillsDirs: [],
      runTimeoutMs: 30_000,
    });
    assert.equal((await restored.infra.memoryRepository.getNode(projectNode.id))?.summary, marker);
    assert.equal((await restored.infra.memoryRepository.getNode(dailyNode.id))?.summary, 'Migrated runtime run completed');
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
    const index = await restored.infra.memoryService.branchIndex(navigationRunId, 'project');
    assert(index.entries.some((entry) => entry.id === projectNode.id));
    const expansion = await restored.infra.memoryService.expand(navigationRunId, {
      branchId: 'project',
      nodeId: projectNode.id,
      limit: 1,
      tokenBudget: 800,
    });
    assert(expansion.fragments.some((fragment) => fragment.id === projectNode.id));
    const released = await restored.infra.memoryService.release(navigationRunId, [projectNode.id]);
    assert.deepEqual(released.releasedAtomIds, [projectNode.id]);
    const search = await restored.infra.memoryService.deepSearch(navigationRunId, {
      branchId: 'project',
      query: 'migrated runtime acceptance',
      limit: 5,
      tokenBudget: 800,
    });
    assert(search.fragments.some((fragment) => fragment.id === projectNode.id));
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
      evolveAtomsPersisted: 1,
      captureAtomsPersisted: 1,
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
  const chat = async () => {
    const response = queue.shift();
    if (!response) throw new Error('Unexpected LLM request during Memory v3 runtime acceptance.');
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
