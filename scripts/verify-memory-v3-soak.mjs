import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  InjectionTier,
  MemoryV3,
  MemoryAtomStore,
  MemoryCatalog,
  MemoryEventJournal,
  MemoryRawRecordStore,
  MemoryOperationJournal,
  MemoryTree,
  MemoryV3MaintenanceWorker,
  MemoryV3StorageCoordinator,
  createMemoryV3ExperimentMarker,
  scoreMemoryCandidate,
} from '../packages/memory-tree/dist/index.js';
import { DEFAULT_CONFIG, saveConfig } from '../packages/config/dist/index.js';
import {
  createDeterministicEmbeddingEngine,
  embeddingReport,
  verifyMemoryV3RuntimeFeedback,
} from './lib/memory-v3-runtime-soak.mjs';

const SOAK_PROJECT_ENTITY_ID = 'project:memory-v3-soak';
const SOAK_CONCEPT_ENTITY_ID = 'concept:context-routing';
const SOAK_RELATION_ID = 'relation:memory-v3-soak:context-routing';
const SOAK_RELATION_RELEVANCE = 0.94;
const MIB = 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const rssBefore = process.memoryUsage().rss;
let rssPeak = rssBefore;
const embedding = await createSoakEmbedding(args);
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-soak-'));
assertIsolatedRoot(dataDir);

let runtime;
let report;
let eventSequence = 0;
let clock = Date.parse('2026-07-16T00:00:00.000Z');
const now = () => new Date(clock += 1_000);
const firstEvent = makeEvent('create', 'atom-000', 0);
const firstMutation = { kind: 'create', atom: makeAtom('atom-000', 0) };
let expectedRawRecordCount = 0;

try {
  runtime = openRuntime();
  assert.deepEqual((await initializeRuntime(runtime)).failed, []);
  await installRelationshipGraph(runtime);

  for (let index = 0; index < args.atoms; index += 1) {
    const event = index === 0 ? firstEvent : makeEvent('create', atomId(index), index);
    const mutation = index === 0
      ? firstMutation
      : { kind: 'create', atom: makeAtom(atomId(index), index) };
    await runtime.coordinator.apply(event, mutation);
    expectedRawRecordCount += 1;
  }

  const availabilityRecovery = await verifyEmbeddingAvailabilityRecovery(runtime, args.atoms);
  const initialEmbeddingDrain = await drainEmbeddingWork(runtime, args.atoms, 'initial atom indexing');
  const relationshipRouting = await verifyRelationshipRouting(runtime);
  const embeddingBoundaries = await verifyEmbeddingBoundaries(runtime);
  expectedRawRecordCount += 2;
  sampleRss();

  await applyMutation(runtime, 'archive', atomId(20), async (atom) => ({
    kind: 'archive', atomId: atom.id, expectedRevision: atom.revision,
  }));
  expectedRawRecordCount += 1;
  await applyMutation(runtime, 'restore', atomId(20), async (atom) => ({
    kind: 'restore', atomId: atom.id, expectedRevision: atom.revision,
  }));
  expectedRawRecordCount += 1;

  const mergeTarget = await requiredAtom(runtime, atomId(31));
  const mergeSource = await requiredAtom(runtime, atomId(30));
  await runtime.coordinator.apply(makeEvent('merge', mergeTarget.id, 30), {
    kind: 'merge',
    targetAtomId: mergeTarget.id,
    targetExpectedRevision: mergeTarget.revision,
    targetPatch: { mergedFromAtomIds: [mergeSource.id] },
    sourceAtomId: mergeSource.id,
    sourceExpectedRevision: mergeSource.revision,
    sourcePatch: {
      status: 'tombstone',
      merge: {
        intoAtomId: mergeTarget.id,
        at: now().toISOString(),
        reason: 'Soak verification duplicate projection.',
      },
    },
  });
  expectedRawRecordCount += 1;
  const lifecycleEmbeddingDrain = await drainEmbeddingWork(runtime, 1, 'archive and restore lifecycle');
  assert.equal(runtime.catalog.getAtom(mergeSource.id)?.embeddingStatus, 'disabled');

  const restartEmbeddingDrains = [];
  for (let restart = 0; restart < args.restarts; restart += 1) {
    await closeRuntime(runtime);
    runtime = openRuntime();
    const recovery = await initializeRuntime(runtime);
    assert.deepEqual(recovery.failed, []);
    assert.equal(await runtime.atomStore.count(), args.atoms);
    assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
    assert.equal(runtime.catalog.integrityCheck(), 'ok');

    for (let update = 0; update < 6; update += 1) {
      const index = 40 + ((restart * 6 + update) % Math.max(1, args.atoms - 40));
      await applyUpdate(runtime, atomId(index), {
        summary: `Restart ${restart + 1} verified this projection at update ${update + 1}.`,
        lastUsefulAt: now().toISOString(),
      }, `restart-${restart + 1}`);
      expectedRawRecordCount += 1;
    }
    restartEmbeddingDrains.push(await drainEmbeddingWork(
      runtime,
      Math.min(6, args.atoms - 40),
      `restart ${restart + 1} semantic updates`,
    ));
    sampleRss();
  }

  const recoveryAtomId = 'atom-recovery';
  await closeRuntime(runtime);
  let injectedFailure = false;
  runtime = openRuntime((checkpoint, context) => {
    if (!injectedFailure && checkpoint === 'raw-record-captured' && context.eventId.includes('fault')) {
      injectedFailure = true;
      throw new Error('Intentional soak fault after raw record capture.');
    }
  });
  assert.deepEqual((await initializeRuntime(runtime)).failed, []);
  await assert.rejects(
    runtime.coordinator.apply(
      makeEvent('fault', recoveryAtomId, args.atoms + 1),
      { kind: 'create', atom: makeAtom(recoveryAtomId, args.atoms + 1) },
    ),
    /intentional soak fault/iu,
  );
  expectedRawRecordCount += 1;
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
  assert.equal(await runtime.atomStore.read(recoveryAtomId), undefined);

  await closeRuntime(runtime);
  runtime = openRuntime();
  const recovered = await initializeRuntime(runtime);
  assert.deepEqual(recovered.failed, []);
  assert(recovered.recoveredEventIds.some((id) => id.includes('fault')));
  assert(await runtime.atomStore.read(recoveryAtomId));
  const recoveryEmbeddingDrain = await drainEmbeddingWork(runtime, 1, 'projection-record-only crash recovery');

  const firstRecordBefore = await runtime.rawRecordStore.get(firstEvent.id);
  assert(firstRecordBefore);
  await assert.rejects(
    runtime.rawRecordStore.capture(firstEvent, {
      ...firstMutation,
      atom: { ...firstMutation.atom, summary: 'Conflicting rewrite must be rejected.' },
    }),
    /already exists with different content/iu,
  );
  const firstRecordAfter = await runtime.rawRecordStore.get(firstEvent.id);
  assert.equal(firstRecordAfter?.contentHash, firstRecordBefore.contentHash);
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);

  const catalogPath = runtime.catalog.dbPath;
  await closeRuntime(runtime);
  await removeCatalogFiles(catalogPath);
  runtime = openRuntime();
  const rebuilt = await initializeRuntime(runtime);
  assert.deepEqual(rebuilt.failed, []);
  assert.equal(rebuilt.rebuiltCatalog, true);
  assert.equal(runtime.catalog.countAtoms(), args.atoms + 1);
  assert.equal(runtime.catalog.integrityCheck(), 'ok');
  const rebuiltEmbeddingDrain = await drainEmbeddingWork(runtime, args.atoms, 'catalog disaster rebuild');
  assert.equal(runtime.catalog.embeddingStatusCounts().disabled, 0);
  assert.equal(runtime.catalog.embeddingStatusCounts().pending, 0);
  assert.equal(runtime.catalog.embeddingStatusCounts().ready, args.atoms);
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
  assert((await runtime.eventJournal.count()) <= args.maxCommittedJournalRecords);
  assert((await countFiles(runtime.operationJournal.rootDir, '.operation.json')) <= args.maxCommittedJournalRecords);
  assert.deepEqual(await runtime.eventJournal.listOutstanding(), []);
  assert.deepEqual(await runtime.operationJournal.listOutstanding(), []);

  const workingSet = await verifyWorkingSet(args.runs);
  const runtimeFeedback = await verifyMemoryV3RuntimeFeedback({
    dataDir,
    feedbackEvents: args.feedbackEvents,
    embeddingBatchSize: args.embeddingBatch,
    now,
  });
  sampleRss();
  assert(
    rssPeak <= args.maxRssMiB * MIB,
    `Memory v3 soak RSS ${formatMiB(rssPeak)} MiB exceeded the ${args.maxRssMiB} MiB limit.`,
  );
  if (args.prepareUi) await prepareUiEvaluationRoot();
  if (embedding.networkAttempts) assert.equal(embedding.networkAttempts(), 0);
  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    isolatedDataRoot: dataDir,
    inputs: args,
    storage: {
      rawRecords: await runtime.rawRecordStore.count(),
      atomFiles: await runtime.atomStore.count(),
      catalogAtoms: runtime.catalog.countAtoms(),
      catalogIntegrity: runtime.catalog.integrityCheck(),
      eventJournalRecords: await runtime.eventJournal.count(),
      operationJournalRecords: await countFiles(runtime.operationJournal.rootDir, '.operation.json'),
      catalogRebuiltFromAtoms: rebuilt.rebuiltCatalog,
      rawRecordOnlyCrashRecovered: Boolean(await runtime.atomStore.read(recoveryAtomId)),
      entities: await runtime.graphStore.countEntities(),
      relations: await runtime.graphStore.countRelations(),
    },
    embedding: {
      mode: embedding.mode,
      engine: embedding.engine.descriptor,
      assetVerification: embedding.assetVerification,
      availabilityRecovery,
      total: embeddingReport(embedding.stats),
      initialDrain: initialEmbeddingDrain,
      metadataAndSemanticBoundaries: embeddingBoundaries,
      inactiveLifecycleDrain: lifecycleEmbeddingDrain,
      restartDrains: restartEmbeddingDrains,
      recoveryDrain: recoveryEmbeddingDrain,
      rebuildDrain: rebuiltEmbeddingDrain,
      status: runtime.catalog.embeddingStatusCounts(),
      offlineAssertion: embedding.networkAttempts
        ? { enabled: true, blockedNetworkAttempts: embedding.networkAttempts() }
        : { enabled: false, blockedNetworkAttempts: 0 },
    },
    relationshipRouting,
    runtimeFeedback,
    workingSet,
    uiEvaluationPrepared: args.prepareUi,
    timingMs: Math.round(performance.now() - startedAt),
    rssBytes: {
      before: rssBefore,
      after: process.memoryUsage().rss,
      delta: process.memoryUsage().rss - rssBefore,
      peak: rssPeak,
      limit: args.maxRssMiB * MIB,
    },
    cleanup: args.keep ? 'kept by request' : 'removed after verification',
  };
} finally {
  try {
    await closeRuntime(runtime);
  } finally {
    try {
      await embedding.dispose();
    } finally {
      if (!args.keep) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
assert(report);
report.embedding.lifecycle = embedding.lifecycleReport();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function prepareUiEvaluationRoot() {
  assert(args.keep, '--prepare-ui requires --keep so the Electron process can use the isolated data root.');
  await createMemoryV3ExperimentMarker(dataDir);
  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.workspace = join(dataDir, 'workplace');
  await mkdir(config.agents.defaults.workspace, { recursive: true });
  await saveConfig(config, join(dataDir, 'config.json'));
}

function openRuntime(onCheckpoint) {
  const atomStore = new MemoryAtomStore({ dataDir, now });
  const catalog = new MemoryCatalog({ dataDir, embeddingEngine: embedding.engine });
  const graphStore = new MemoryV3.MemoryV3GraphStore({ dataDir, catalog });
  const eventJournal = new MemoryEventJournal({
    dataDir,
    now,
    maxCommittedRecords: args.maxCommittedJournalRecords,
    maxTotalRecords: 2_000,
  });
  const operationJournal = new MemoryOperationJournal({
    dataDir,
    now,
    maxCommittedRecords: args.maxCommittedJournalRecords,
    maxTotalRecords: 2_000,
  });
  const rawRecordStore = new MemoryRawRecordStore({ dataDir, now });
  const maintenance = new MemoryV3MaintenanceWorker({
    atomStore,
    catalog,
    eventJournal,
    embeddingBatchSize: args.embeddingBatch,
    now,
  });
  return {
    atomStore,
    catalog,
    graphStore,
    eventJournal,
    maintenance,
    operationJournal,
    rawRecordStore,
    coordinator: new MemoryV3StorageCoordinator({
      atomStore,
      catalog,
      eventJournal,
      operationJournal,
      rawRecordStore,
      onCheckpoint,
    }),
    closed: false,
  };
}

async function initializeRuntime(value) {
  await value.graphStore.initialize();
  return value.coordinator.initialize();
}

async function closeRuntime(value) {
  if (!value || value.closed) return;
  value.closed = true;
  await value.maintenance.shutdown();
  value.catalog.close();
}

async function installRelationshipGraph(value) {
  const createdAt = now().toISOString();
  await value.graphStore.upsertEntity({
    version: 1,
    id: SOAK_PROJECT_ENTITY_ID,
    type: 'project',
    owner: { kind: 'user', id: 'memory-v3-soak-user' },
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    externalKey: 'memory-v3-soak',
    label: 'Memory v3 soak project',
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  await value.graphStore.upsertEntity({
    version: 1,
    id: SOAK_CONCEPT_ENTITY_ID,
    type: 'concept',
    owner: { kind: 'agent', id: 'littlesheep' },
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    externalKey: 'memory-v3-soak:context-routing',
    label: 'Context routing',
    aliases: ['atom injection'],
    status: 'active',
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  await value.graphStore.upsertRelation({
    version: 1,
    id: SOAK_RELATION_ID,
    fromEntityId: SOAK_PROJECT_ENTITY_ID,
    toEntityId: SOAK_CONCEPT_ENTITY_ID,
    type: 'depends-on',
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    source: { kind: 'tool', id: 'verify-memory-v3-soak' },
    sourceRefs: [],
    evidenceRefs: ['soak:relationship-routing'],
    confidence: 0.92,
    authorityScope: {
      kind: 'tool-evidence',
      scope: 'project',
      scopeKey: 'memory-v3-soak',
      topics: ['memory-v3', 'context-routing'],
    },
    relevance: SOAK_RELATION_RELEVANCE,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

async function drainEmbeddingWork(value, expectedIndexed, label) {
  const callsBefore = embedding.stats.calls;
  const textsBefore = embedding.stats.texts;
  const batchOffset = embedding.stats.batches.length;
  const result = await value.maintenance.startBackgroundDrain();
  assert.equal(result.aborted, false, `${label} was unexpectedly aborted.`);
  assert.equal(result.stalled, false, `${label} stalled before the catalog became idle.`);
  assert.equal(result.indexed, expectedIndexed, `${label} indexed an unexpected number of atoms.`);
  assert.equal(result.last?.due.failures.length ?? 0, 0, `${label} produced due-event failures.`);
  assert.equal(result.last?.embeddings.failures.length ?? 0, 0, `${label} produced embedding failures.`);
  assert.equal(value.catalog.countEmbeddingWork(), 0, `${label} left active embedding work behind.`);
  const batches = embedding.stats.batches.slice(batchOffset);
  assert(batches.every((size) => size <= args.embeddingBatch), `${label} exceeded the embedding batch limit.`);
  return {
    passes: result.passes,
    indexed: result.indexed,
    calls: embedding.stats.calls - callsBefore,
    texts: embedding.stats.texts - textsBefore,
    batches,
    maxBatch: batches.length > 0 ? Math.max(...batches) : 0,
  };
}

async function verifyEmbeddingAvailabilityRecovery(value, expectedPending) {
  if (!embedding.controls) return { exercised: false };
  const callsBefore = embedding.stats.calls;
  embedding.controls.setAvailable(false);
  const unavailable = await value.maintenance.startBackgroundDrain();
  assert.equal(unavailable.aborted, false);
  assert.equal(unavailable.stalled, true);
  assert.equal(unavailable.indexed, 0);
  assert.equal(unavailable.last?.embeddings.unavailable, true);
  assert.equal(unavailable.last?.embeddings.remaining, expectedPending);
  assert.equal(value.catalog.countEmbeddingWork(), expectedPending);
  assert.equal(embedding.stats.calls, callsBefore);
  embedding.controls.setAvailable(true);
  return {
    exercised: true,
    unavailablePasses: unavailable.passes,
    indexedWhileUnavailable: unavailable.indexed,
    retainedPending: value.catalog.countEmbeddingWork(),
    embedCallsWhileUnavailable: embedding.stats.calls - callsBefore,
  };
}

async function verifyRelationshipRouting(value) {
  const linkedId = atomId(1);
  const unlinkedId = atomId(args.relatedAtoms + 1);
  const linked = await requiredAtom(value, linkedId);
  const unlinked = await requiredAtom(value, unlinkedId);
  const evaluatedAt = now().toISOString();
  const before = value.catalog.relationRelevanceForAtoms([linkedId, unlinkedId], evaluatedAt);
  assert.equal(before.get(linkedId), SOAK_RELATION_RELEVANCE);
  assert.equal(before.has(unlinkedId), false);
  const linkedScore = comparableScore(linked, before.get(linkedId) ?? 0.5, evaluatedAt);
  const unlinkedScore = comparableScore(unlinked, before.get(unlinkedId) ?? 0.5, evaluatedAt);
  assert(linkedScore.score > unlinkedScore.score, 'An active high-relevance relation did not improve candidate ordering.');

  const callsBefore = embedding.stats.calls;
  const relation = await value.graphStore.getRelation(SOAK_RELATION_ID);
  assert(relation);
  const updatedRelevance = 0.68;
  await value.graphStore.upsertRelation({
    ...relation,
    relevance: updatedRelevance,
    revision: relation.revision + 1,
    updatedAt: now().toISOString(),
  });
  const after = value.catalog.relationRelevanceForAtoms([linkedId, unlinkedId], now().toISOString());
  const adjustedScore = comparableScore(linked, after.get(linkedId) ?? 0.5, evaluatedAt);
  assert.equal(after.get(linkedId), updatedRelevance);
  assert(adjustedScore.score < linkedScore.score);
  assert.equal(embedding.stats.calls, callsBefore);
  assert.equal(value.catalog.countEmbeddingWork(), 0);
  return {
    linkedAtoms: args.relatedAtoms,
    linkedAtomId: linkedId,
    unlinkedAtomId: unlinkedId,
    relationRelevance: { before: before.get(linkedId), after: after.get(linkedId) },
    score: { linkedBefore: linkedScore.score, linkedAfter: adjustedScore.score, unlinked: unlinkedScore.score },
    relationMetadataTriggeredEmbedding: false,
  };
}

async function verifyEmbeddingBoundaries(value) {
  const metadataAtomId = atomId(10);
  const beforeMetadata = value.catalog.getAtom(metadataAtomId);
  assert(beforeMetadata);
  const callsBeforeMetadata = embedding.stats.calls;
  await applyUpdate(value, metadataAtomId, { parentId: atomId(2) }, 'move');
  const afterMetadata = value.catalog.getAtom(metadataAtomId);
  assert(afterMetadata);
  assert.equal(afterMetadata.embeddingHash, beforeMetadata.embeddingHash);
  assert.equal(afterMetadata.embeddingStatus, 'ready');
  assert.equal(embedding.stats.calls, callsBeforeMetadata);
  assert.equal(value.catalog.countEmbeddingWork(), 0);

  const semanticAtomId = atomId(11);
  const beforeSemantic = value.catalog.getAtom(semanticAtomId);
  assert(beforeSemantic);
  await applyUpdate(value, semanticAtomId, {
    summary: 'Semantic content changed and therefore requires a fresh local vector.',
  }, 'semantic-update');
  const pendingSemantic = value.catalog.getAtom(semanticAtomId);
  assert(pendingSemantic);
  assert.notEqual(pendingSemantic.embeddingHash, beforeSemantic.embeddingHash);
  assert.equal(pendingSemantic.embeddingStatus, 'pending');
  const failedCallsBefore = embedding.stats.failedCalls ?? 0;
  embedding.controls?.failNextEmbed();
  const semanticDrain = await drainEmbeddingWork(value, 1, 'semantic atom update');
  assert.equal(value.catalog.getAtom(semanticAtomId)?.embeddingStatus, 'ready');
  const transientFailures = (embedding.stats.failedCalls ?? 0) - failedCallsBefore;
  if (embedding.controls) assert.equal(transientFailures, 1);
  return {
    metadataAtomId,
    metadataEmbeddingHashStable: afterMetadata.embeddingHash === beforeMetadata.embeddingHash,
    metadataTriggeredEmbedding: embedding.stats.calls !== callsBeforeMetadata + semanticDrain.calls,
    semanticAtomId,
    semanticEmbeddingHashChanged: pendingSemantic.embeddingHash !== beforeSemantic.embeddingHash,
    transientFailureRecovery: {
      exercised: Boolean(embedding.controls),
      injectedFailures: transientFailures,
      recoveredInSameDrain: Boolean(embedding.controls) ? semanticDrain.indexed === 1 : undefined,
    },
    semanticDrain,
  };
}

function comparableScore(atom, relationshipRelevance, evaluatedAt) {
  return scoreMemoryCandidate({
    atom,
    now: evaluatedAt,
    scopeMatch: 1,
    taskRelevance: 0.8,
    authorityMatch: 1,
    verifiedUsefulness: 2 / 3,
    routingRelevance: 0.5,
    relationshipRelevance,
    decayHalfLifeDays: 45,
    requiredByCurrentUser: false,
    safetyCritical: false,
  });
}

async function createSoakEmbedding(options) {
  if (options.embedding === 'deterministic') {
    const deterministic = createDeterministicEmbeddingEngine('catalog');
    let disposed = false;
    return {
      mode: 'deterministic',
      ...deterministic,
      assetVerification: undefined,
      controls: undefined,
      networkAttempts: undefined,
      async dispose() { disposed = true; },
      lifecycleReport: () => ({ disposed }),
    };
  }

  const [{ LocalTransformersEmbeddingEngine, verifyLocalEmbeddingModel }, modelRootDir] = await Promise.all([
    import('../packages/embedding/dist/index.js'),
    resolveEmbeddingModelRoot(options.embeddingModelRoot),
  ]);
  const verification = await verifyLocalEmbeddingModel(options.embeddingModel, modelRootDir);
  if (!verification.available) {
    throw new Error(
      `Local embedding model is incomplete: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`,
    );
  }
  const base = new LocalTransformersEmbeddingEngine({
    model: options.embeddingModel,
    modelRootDir,
    batchSize: options.embeddingBatch,
  });
  const stats = {
    calls: 0,
    texts: 0,
    batches: [],
    failedCalls: 0,
    durationMs: 0,
    availabilityChecks: 0,
  };
  let available = true;
  let failNextEmbed = false;
  let blockedNetworkAttempts = 0;
  let disposed = false;
  let disposeDurationMs = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the Memory v3 local embedding soak.');
  };

  return {
    mode: 'local-transformers',
    stats,
    assetVerification: {
      available: verification.available,
      modelRoot: verification.modelRoot,
      missing: verification.missing,
      invalid: verification.invalid,
      totalBytes: verification.totalBytes,
    },
    engine: {
      descriptor: base.descriptor,
      async isAvailable() {
        stats.availabilityChecks += 1;
        return available && await base.isAvailable();
      },
      async embed(request) {
        stats.calls += 1;
        stats.texts += request.texts.length;
        stats.batches.push(request.texts.length);
        const started = performance.now();
        try {
          if (failNextEmbed) {
            failNextEmbed = false;
            throw new Error('Intentional transient local embedding failure.');
          }
          return await base.embed(request);
        } catch (error) {
          stats.failedCalls += 1;
          throw error;
        } finally {
          stats.durationMs += performance.now() - started;
          sampleRss();
        }
      },
    },
    controls: {
      setAvailable(value) { available = Boolean(value); },
      failNextEmbed() { failNextEmbed = true; },
    },
    networkAttempts: () => blockedNetworkAttempts,
    async dispose() {
      const started = performance.now();
      try {
        await base.dispose();
      } finally {
        disposeDurationMs = performance.now() - started;
        disposed = true;
        globalThis.fetch = originalFetch;
        sampleRss();
      }
    },
    lifecycleReport: () => ({
      disposed,
      disposeDurationMs: Math.round(disposeDurationMs * 10_000) / 10_000,
      availabilityChecks: stats.availabilityChecks,
    }),
  };
}

async function resolveEmbeddingModelRoot(explicitRoot) {
  if (explicitRoot) return resolve(explicitRoot);
  const { loadBranding, resolveDataDir } = await import('../packages/branding/dist/index.js');
  return join(resolveDataDir(await loadBranding()), 'models', 'embedding');
}

function sampleRss() {
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}

function formatMiB(bytes) {
  return Math.round(bytes / MIB * 10) / 10;
}

async function applyUpdate(value, id, patch, label) {
  return applyMutation(value, label, id, async (atom) => ({
    kind: 'update',
    atomId: atom.id,
    expectedRevision: atom.revision,
    patch,
  }));
}

async function applyMutation(value, label, id, mutation) {
  const atom = await requiredAtom(value, id);
  return value.coordinator.apply(makeEvent(label, id, atom.revision), await mutation(atom));
}

async function requiredAtom(value, id) {
  const atom = await value.atomStore.read(id);
  assert(atom, `Missing expected atom ${id}.`);
  return atom;
}

function makeAtom(id, index) {
  const parentIndex = index > 0 ? Math.floor((index - 1) / 8) : undefined;
  const timestamp = now().toISOString();
  const relationshipLinked = index > 0 && index <= args.relatedAtoms;
  return {
    id,
    domain: 'project',
    branch: 'project',
    parentId: parentIndex === undefined ? undefined : atomId(parentIndex),
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    tier: InjectionTier.T2_RELEVANT,
    statementKind: 'factual-claim',
    epistemicStatus: 'verified',
    authorityScope: {
      kind: 'tool-evidence',
      scope: 'project',
      scopeKey: 'memory-v3-soak',
      topics: ['memory-v3', 'soak'],
    },
    assertedBy: { kind: 'tool', id: 'verify-memory-v3-soak' },
    sourceRefs: [],
    evidenceRefs: [`soak:${id}`],
    entityRefs: relationshipLinked ? [SOAK_PROJECT_ENTITY_ID, SOAK_CONCEPT_ENTITY_ID] : [],
    relationRefs: relationshipLinked ? [SOAK_RELATION_ID] : [],
    title: index === 0 ? 'Special alpha retention root' : `Soak atom ${index}`,
    summary: index === 0
      ? 'Project memory catalog root for special alpha retention.'
      : `Durable atomic projection ${index}.`,
    content: index === 0
      ? 'The special alpha project uses a raw record store and a rebuildable local memory catalog.'
      : `Atomic project record ${index} remains recoverable across restarts.`,
    retrievalKeys: index === 0
      ? ['special', 'alpha', 'retention', 'memory', 'catalog']
      : ['soak', 'project', `atom-${index}`],
    importance: 0.7,
    confidence: 0.95,
    basePriority: index === 0 ? 0.95 : 0.5,
    verifiedUsefulness: { useful: 1, notUseful: 0, conflicts: 0, stale: 0, lastOutcome: 'useful' },
    feedbackRevision: 1,
    lastUsefulAt: timestamp,
    lastVerifiedAt: timestamp,
    reason: 'Memory v3 isolated soak verification.',
    sourceRunIds: ['run-memory-v3-soak'],
    sourceStages: ['tool'],
    status: 'active',
    resolutionStatus: 'resolved',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeEvent(kind, id, index) {
  const sequence = String(++eventSequence).padStart(5, '0');
  const timestamp = now().toISOString();
  return {
    version: 1,
    id: `soak-${kind}-${sequence}`,
    idempotencyKey: `memory-v3-soak:${kind}:${sequence}`,
    kind: kind === 'fault' ? 'tool-evidence' : 'user-statement',
    domain: 'project',
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    atomId: kind === 'create' || kind === 'fault' ? undefined : id,
    source: { kind: 'tool', id: 'verify-memory-v3-soak' },
    occurredAt: timestamp,
    observedAt: timestamp,
    evidenceRefs: [`soak-event:${sequence}`],
    payload: { kind, atomId: id, index },
  };
}

async function verifyWorkingSet(runCount) {
  const fragments = [
    {
      id: 'working-target',
      title: 'Special alpha retention',
      summary: 'Exact project memory needed for the first user request.',
      content: 'The special alpha project keeps raw records and rebuildable atom projections.',
      keys: ['special', 'alpha', 'retention'],
      priority: 10,
    },
    {
      id: 'working-other',
      title: 'Unrelated display preference',
      summary: 'A lower relevance memory atom.',
      content: 'The interface uses a dark gray background.',
      keys: ['display', 'interface'],
      priority: 2,
    },
    {
      id: 'working-third',
      title: 'Channel connector',
      summary: 'External channels are optional plugins.',
      content: 'External channels do not control the local agent runtime.',
      keys: ['channel', 'plugin'],
      priority: 1,
    },
  ];
  const branch = {
    id: 'project',
    kind: 'project',
    displayName: 'Project memory',
    purpose: 'Project-specific durable memory.',
    whenToUse: 'The current request concerns one project.',
    searchHints: ['project', 'memory'],
    async getIndex(context) {
      return {
        branchId: 'project',
        displayName: 'Project memory',
        summary: 'Isolated working-set verification index.',
        entries: fragments.map((fragment) => ({
          id: fragment.id,
          title: fragment.title,
          summary: fragment.summary,
          searchKeys: fragment.keys,
          hasChildren: false,
        })),
        generatedAt: context.now.toISOString(),
        source: 'memory-v3-soak',
      };
    },
    async expand(_context, request) {
      const selected = fragments.filter((fragment) => !request.nodeId || fragment.id === request.nodeId);
      return {
        branchId: 'project',
        fragments: selected.slice(0, request.limit ?? 12).map(toFragment),
        truncated: false,
      };
    },
    async search(_context, request) {
      const query = request.query.toLocaleLowerCase();
      return fragments
        .filter((fragment) => [fragment.title, fragment.summary, ...fragment.keys].join(' ').toLocaleLowerCase().includes(query))
        .map(toFragment);
    },
  };
  const tree = new MemoryTree({
    totalRunTokenBudget: 1_000,
    perBranchTokenBudget: 600,
    maxRetainedLedgers: 16,
  });
  tree.register(branch);

  tree.beginRun({
    runId: 'working-set-main',
    sessionId: 'session-working-set-main',
    query: 'Recall the special alpha retention memory catalog.',
    recentHistory: [],
    workspace: dataDir,
  });
  const primed = await tree.prime('working-set-main', { maxAtoms: 2, tokenBudget: 300, query: 'special alpha retention' });
  assert(primed.fragments.some((fragment) => fragment.id === 'working-target'));
  assert(primed.fragments.length <= 2);
  const released = await tree.release('working-set-main', ['working-target']);
  assert.deepEqual(released.releasedAtomIds, ['working-target']);
  assert(released.freedTokens > 0);
  const readmitted = await tree.expand('working-set-main', {
    branchId: 'project',
    nodeId: 'working-target',
    limit: 1,
    tokenBudget: 200,
  });
  assert.deepEqual(readmitted.fragments.map((fragment) => fragment.id), ['working-target']);
  const releasedAgain = await tree.release('working-set-main', ['working-target']);
  assert.deepEqual(releasedAgain.releasedAtomIds, ['working-target']);
  const readmittedAgain = await tree.expand('working-set-main', {
    branchId: 'project',
    nodeId: 'working-target',
    limit: 1,
    tokenBudget: 200,
  });
  assert.deepEqual(readmittedAgain.fragments.map((fragment) => fragment.id), ['working-target']);
  tree.finishRun('working-set-main');

  for (let index = 0; index < runCount; index += 1) {
    const runId = `working-set-retained-${String(index).padStart(4, '0')}`;
    tree.beginRun({
      runId,
      sessionId: `session-${index}`,
      query: 'project memory',
      recentHistory: [],
      workspace: dataDir,
    });
    await tree.branchIndex(runId, 'project');
    await tree.expand(runId, { branchId: 'project', nodeId: 'working-target', limit: 1, tokenBudget: 160 });
    tree.finishRun(runId);
  }
  const retained = tree.listLedgers(200);
  assert.equal(retained.length, Math.min(16, runCount + 1));
  if (runCount > 16) assert.equal(tree.getLedger('working-set-retained-0000'), undefined);
  return {
    initialAtomIds: primed.fragments.map((fragment) => fragment.id),
    releasedTokens: released.freedTokens,
    readmitted: readmittedAgain.fragments.map((fragment) => fragment.id),
    retainedLedgers: retained.length,
    requestedRuns: runCount,
  };
}

function toFragment(fragment) {
  return {
    id: fragment.id,
    branchId: 'project',
    tier: InjectionTier.T2_RELEVANT,
    priority: fragment.priority,
    content: fragment.content,
    tokenEstimate: Math.ceil(fragment.content.length / 4),
    truncatable: true,
    dedupKey: fragment.id,
    matchReason: 'Memory v3 soak working-set candidate.',
    metadata: {
      source: 'memory-v3-soak',
      kind: 'indexed',
      generatedAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

async function removeCatalogFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    await rm(candidate, { force: true });
  }
}

async function countFiles(root, suffix) {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}

function atomId(index) {
  return `atom-${String(index).padStart(3, '0')}`;
}

function assertIsolatedRoot(path) {
  const normalized = resolve(path);
  const tempRoot = resolve(tmpdir());
  assert(normalized.startsWith(`${tempRoot}\\`) || normalized.startsWith(`${tempRoot}/`));
  assert(normalized.includes('littlesheep-memory-v3-soak-'));
  assert(!normalized.toLocaleLowerCase().endsWith('\\.littlesheep'));
}

function parseArgs(values) {
  const options = {
    atoms: 120,
    restarts: 4,
    runs: 96,
    embedding: 'deterministic',
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingModelRoot: undefined,
    feedbackEvents: 128,
    relatedAtoms: 32,
    embeddingBatch: 16,
    maxRssMiB: 384,
    maxCommittedJournalRecords: 8,
    keep: false,
    prepareUi: false,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--atoms=')) options.atoms = integer(value, '--atoms=', 48, 1_000);
    else if (value.startsWith('--restarts=')) options.restarts = integer(value, '--restarts=', 1, 20);
    else if (value.startsWith('--runs=')) options.runs = integer(value, '--runs=', 1, 2_000);
    else if (value.startsWith('--embedding=')) options.embedding = value.slice('--embedding='.length);
    else if (value.startsWith('--embedding-model=')) options.embeddingModel = value.slice('--embedding-model='.length);
    else if (value.startsWith('--embedding-model-root=')) options.embeddingModelRoot = resolve(value.slice('--embedding-model-root='.length));
    else if (value.startsWith('--feedback-events=')) options.feedbackEvents = integer(value, '--feedback-events=', 64, 2_000);
    else if (value.startsWith('--related-atoms=')) options.relatedAtoms = integer(value, '--related-atoms=', 1, 998);
    else if (value.startsWith('--embedding-batch=')) options.embeddingBatch = integer(value, '--embedding-batch=', 1, 256);
    else if (value.startsWith('--max-rss-mib=')) options.maxRssMiB = integer(value, '--max-rss-mib=', 64, 4_096);
    else if (value === '--keep') options.keep = true;
    else if (value === '--prepare-ui') options.prepareUi = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.embedding !== 'deterministic' && options.embedding !== 'local') {
    throw new Error('embedding must be deterministic or local.');
  }
  if (options.embeddingModel !== 'bge-small-zh-v1.5' && options.embeddingModel !== 'multilingual-e5-small') {
    throw new Error('embedding-model must be bge-small-zh-v1.5 or multilingual-e5-small.');
  }
  options.relatedAtoms = Math.min(options.relatedAtoms, options.atoms - 2);
  return options;
}

function integer(value, prefix, minimum, maximum) {
  const parsed = Number(value.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${prefix.slice(2, -1)} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
