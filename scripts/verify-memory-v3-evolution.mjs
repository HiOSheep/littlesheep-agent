import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_BRANCH_SPECS,
  InjectionTier,
  MemoryRepository,
  MemoryService,
  MemoryTree,
  MemoryWriteService,
  TreeMemoryBranch,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import {
  LocalTransformersEmbeddingEngine,
  verifyLocalEmbeddingModel,
} from '../packages/embedding/dist/index.js';

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const rssBefore = process.memoryUsage().rss;
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-evolution-'));
assertIsolatedRoot(dataDir);
const workspace = join(dataDir, 'workspace');
await mkdir(workspace, { recursive: true });

let runtime;
let baseEngine;
let report;
let failure;
let blockedNetworkAttempts = 0;
const originalFetch = globalThis.fetch;

try {
  const modelRootDir = await resolveEmbeddingModelRoot(args.modelRoot);
  const verification = await verifyLocalEmbeddingModel(args.model, modelRootDir);
  if (!verification.available) {
    throw new Error(`Local model is incomplete: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the Memory v3 evolution acceptance.');
  };

  baseEngine = new LocalTransformersEmbeddingEngine({
    model: args.model,
    modelRootDir,
    batchSize: args.embeddingBatch,
  });
  const embedding = instrumentEmbedding(baseEngine);
  await createMemoryV3ExperimentMarker(dataDir);
  runtime = await openRuntime(dataDir, embedding.engine, args.embeddingBatch);

  const writes = await runtime.service.writeMany(fixtureIntents());
  const rejectedWrites = writes.filter((write) => write.decision !== 'created' || !write.node);
  assert.equal(rejectedWrites.length, 0, `Stage 10 fixtures must remain separate: ${JSON.stringify(rejectedWrites)}`);
  const ids = Object.fromEntries(writes.map((write) => [write.intentId, write.node.id]));
  const targetId = requiredId(ids, 'stage10-target');
  const controlId = requiredId(ids, 'stage10-control');
  const conflictId = requiredId(ids, 'stage10-conflict');
  const initialInspection = await requiredInspection(runtime.repository, targetId);
  const initialEmbeddingCalls = embedding.stats.calls;

  const workingSet = await verifyWorkingSet(runtime.service, {
    targetId,
    workspace,
  });
  const conflictFeedback = await verifyUnseenConflictDoesNotMutate(runtime, conflictId);
  const evolution = await verifyFeedbackEvolution(runtime, {
    targetId,
    controlId,
    initialInspection,
  });
  assert.equal(embedding.stats.calls, initialEmbeddingCalls);

  await runtime.repository.shutdown();
  runtime = await openRuntime(dataDir, embedding.engine, args.embeddingBatch);
  const restartedInspection = await requiredInspection(runtime.repository, targetId);
  const restartedRanking = await rankedCandidates(runtime.repository, evolution.currentAt);
  const restartedTarget = requiredCandidate(restartedRanking, targetId);
  assert.deepEqual(restartedInspection.atom.routingFeedback, evolution.finalInspection.atom.routingFeedback);
  assert.deepEqual(restartedInspection.atom.verifiedUsefulness, evolution.finalInspection.atom.verifiedUsefulness);
  assert.equal(restartedInspection.atom.confidence, initialInspection.atom.confidence);
  assert.equal(restartedInspection.atom.content, initialInspection.atom.content);
  assert.equal(restartedInspection.catalog.embeddingHash, initialInspection.catalog.embeddingHash);
  assert.equal(restartedInspection.catalog.embeddingStatus, 'ready');
  assert.equal(restartedTarget.atom.id, targetId);
  assert.equal(embedding.stats.calls, initialEmbeddingCalls);

  const deepSearch = await verifyRestartedDeepSearch(runtime.service, {
    targetId,
    workspace,
  }, embedding.stats);
  assert.equal(blockedNetworkAttempts, 0);
  assert.equal(deepSearch.queryEmbeddingCalls, 1);
  assert.equal(embedding.stats.calls, initialEmbeddingCalls + 1);

  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    model: {
      id: args.model,
      descriptor: embedding.engine.descriptor,
      assetBytes: verification.totalBytes,
    },
    corpus: { atoms: writes.length, targetId, controlId, conflictId },
    workingSet,
    conflictFeedback,
    evolution: {
      immediateRanking: evolution.immediateRanking.map((candidate) => candidate.atom.id),
      decayedRanking: evolution.decayedRanking.map((candidate) => candidate.atom.id),
      routingRecoveredRanking: evolution.routingRecoveredRanking.map((candidate) => candidate.atom.id),
      verifiedRanking: evolution.verifiedRanking.map((candidate) => candidate.atom.id),
      routingRelevance: evolution.routingRelevance,
      verifiedUsefulDelta: evolution.verifiedUsefulDelta,
      confidenceUnchanged: evolution.finalInspection.atom.confidence === initialInspection.atom.confidence,
      contentUnchanged: evolution.finalInspection.atom.content === initialInspection.atom.content,
      vectorHashUnchanged: evolution.finalInspection.catalog.embeddingHash === initialInspection.catalog.embeddingHash,
      restartPreserved: true,
    },
    deepSearch,
    embedding: {
      ...embedding.stats,
      durationMs: round(embedding.stats.durationMs),
      blockedNetworkAttempts,
    },
    resources: {
      durationMs: round(performance.now() - startedAt),
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      rssLimit: args.maxRssMiB * 1024 * 1024,
    },
    cleanup: args.keep ? 'kept by request' : 'removed after verification',
  };
  assert(report.resources.rssAfter <= report.resources.rssLimit);
} catch (error) {
  failure = error;
} finally {
  try { await runtime?.repository.shutdown(); } catch (error) { failure ??= error; }
  try { await baseEngine?.dispose(); } catch (error) { failure ??= error; }
  globalThis.fetch = originalFetch;
  if (!args.keep) {
    try {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failure ??= error;
    }
  }
}

if (report) {
  process.stdout.write(`${JSON.stringify({
    ...report,
    isolatedDataRootRetained: args.keep ? dataDir : undefined,
  }, null, 2)}\n`);
}
if (failure) throw failure;

async function openRuntime(root, embeddingEngine, maxEmbeddingBatchSize) {
  const repository = new MemoryRepository({
    dataDir: root,
    backend: 'v3',
    v3: { embeddingEngine, maxEmbeddingBatchSize },
  });
  await repository.initialize();
  const tree = new MemoryTree({
    rootIndexMaxChars: 1_600,
    totalRunTokenBudget: 3_200,
    perBranchTokenBudget: 1_200,
  });
  for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
  const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
  const service = new MemoryService({ tree, repository, writer, dataDir: root, rootIndexMaxChars: 1_600 });
  return { repository, service };
}

async function verifyWorkingSet(service, input) {
  const runId = 'stage10-working-set';
  const start = await service.beginRun({
    runId,
    sessionId: 'stage10-working-set-session',
    query: 'dynamic working set atom release readmission context routing',
    recentHistory: [],
    workspace: input.workspace,
  });
  assert(start.initialContext?.atomIds.includes(input.targetId));
  const released = await service.release(runId, [input.targetId]);
  const releasedReference = requiredReference(released.knownState, input.targetId);
  assert.equal(releasedReference.decision, 'excluded');
  assert(released.freedTokens > 0);
  const readmitted = await service.expand(runId, {
    branchId: 'long-term',
    nodeId: input.targetId,
    limit: 1,
    tokenBudget: 400,
  });
  const readmittedReference = requiredReference(readmitted.knownState, input.targetId);
  assert.equal(readmittedReference.decision, 'adopted');
  assert.equal(readmittedReference.reactivatedCount, 1);
  const ledger = await service.finishRun(runId);
  assert(ledger?.records.some((record) => record.action === 'release' && record.fragmentIds.includes(input.targetId)));
  assert(ledger?.records.some((record) => record.action === 'expand' && record.fragmentIds.includes(input.targetId)));
  return {
    initialAtomIds: start.initialContext?.atomIds ?? [],
    releasedAtomIds: released.releasedAtomIds,
    freedTokens: released.freedTokens,
    readmittedAtomIds: readmitted.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id),
    reactivatedCount: readmittedReference.reactivatedCount,
    knownStateDecisionAfterRelease: releasedReference.decision,
    knownStateDecisionAfterReadmission: readmittedReference.decision,
  };
}

async function verifyUnseenConflictDoesNotMutate(runtimeValue, conflictId) {
  const before = await requiredInspection(runtimeValue.repository, conflictId);
  const updated = await runtimeValue.service.recordRunFeedback({
    runId: 'stage10-unseen-conflict',
    status: 'ok',
    references: [{ atomId: conflictId, decision: 'conflicted', reason: 'Outside active Context.' }],
    activeAtomIds: [],
    releasedAtomIds: [],
    usedAtomIds: [],
    successfulToolCallIds: [],
    recordedAt: '2026-07-17T03:00:00.000Z',
  });
  const after = await requiredInspection(runtimeValue.repository, conflictId);
  assert.equal(updated.length, 0);
  assert.equal(after.atom.feedbackRevision, before.atom.feedbackRevision);
  assert.deepEqual(after.atom.routingFeedback, before.atom.routingFeedback);
  return { feedbackRecordsCreated: updated.length, feedbackRevisionUnchanged: true };
}

async function verifyFeedbackEvolution(runtimeValue, input) {
  const oldAt = '2026-07-17T03:10:00.000Z';
  const currentAt = '2027-07-17T03:10:00.000Z';
  const beforeVerifiedUseful = input.initialInspection.atom.verifiedUsefulness.useful;
  for (let index = 0; index < 32; index += 1) {
    await runtimeValue.service.recordRunFeedback({
      runId: `stage10-release-${index}`,
      status: 'ok',
      references: [{ atomId: input.targetId, decision: 'excluded', reason: 'Explicit run-scoped release.' }],
      activeAtomIds: [],
      releasedAtomIds: [input.targetId],
      usedAtomIds: [],
      successfulToolCallIds: [],
      recordedAt: oldAt,
    });
  }
  const afterRelease = await requiredInspection(runtimeValue.repository, input.targetId);
  const immediateRanking = await rankedCandidates(runtimeValue.repository, oldAt);
  const immediateTarget = requiredCandidate(immediateRanking, input.targetId);
  assert.equal(immediateRanking[0]?.atom.id, input.controlId);
  assert(immediateTarget.priority.routingRelevance < 0.1);

  const decayedRanking = await rankedCandidates(runtimeValue.repository, currentAt);
  const decayedTarget = requiredCandidate(decayedRanking, input.targetId);
  assert(decayedTarget.priority.routingRelevance > immediateTarget.priority.routingRelevance);
  assert(decayedTarget.priority.routingRelevance < 0.5);

  await runtimeValue.service.recordRunFeedback({
    runId: 'stage10-routing-useful',
    status: 'ok',
    references: [{ atomId: input.targetId, decision: 'adopted', reason: 'Explicitly used after task matching.' }],
    activeAtomIds: [input.targetId],
    releasedAtomIds: [],
    usedAtomIds: [input.targetId],
    verification: {
      attempt: 1,
      verdict: 'pass',
      source: 'model',
      verifiedAt: currentAt,
    },
    successfulToolCallIds: [],
    recordedAt: currentAt,
  });
  const routingRecovered = await requiredInspection(runtimeValue.repository, input.targetId);
  const routingRecoveredRanking = await rankedCandidates(runtimeValue.repository, currentAt);
  const routingRecoveredTarget = requiredCandidate(routingRecoveredRanking, input.targetId);
  assert(routingRecoveredTarget.priority.routingRelevance > decayedTarget.priority.routingRelevance);
  assert.deepEqual(routingRecovered.atom.verifiedUsefulness, input.initialInspection.atom.verifiedUsefulness);

  const verifiedAt = '2027-07-17T03:10:01.000Z';
  await runtimeValue.service.recordRunFeedback({
    runId: 'stage10-verified-useful',
    status: 'ok',
    references: [{ atomId: input.targetId, decision: 'adopted', reason: 'Structurally verified use.' }],
    activeAtomIds: [input.targetId],
    releasedAtomIds: [],
    usedAtomIds: [input.targetId],
    verification: {
      attempt: 1,
      verdict: 'pass',
      source: 'structural',
      verifiedAt,
    },
    successfulToolCallIds: [],
    recordedAt: verifiedAt,
  });
  const finalInspection = await requiredInspection(runtimeValue.repository, input.targetId);
  const verifiedRanking = await rankedCandidates(runtimeValue.repository, verifiedAt);
  const verifiedTarget = requiredCandidate(verifiedRanking, input.targetId);
  assert(verifiedTarget.priority.routingRelevance >= routingRecoveredTarget.priority.routingRelevance);
  assert.equal(finalInspection.atom.verifiedUsefulness.useful, beforeVerifiedUseful + 1);
  assert.equal(finalInspection.atom.confidence, input.initialInspection.atom.confidence);
  assert.equal(finalInspection.atom.content, input.initialInspection.atom.content);
  assert.equal(finalInspection.catalog.embeddingHash, input.initialInspection.catalog.embeddingHash);
  assert.equal(finalInspection.catalog.embeddingStatus, 'ready');
  assert.equal(finalInspection.atom.routingFeedback?.notUseful, 32);
  assert.equal(finalInspection.atom.routingFeedback?.useful, 2);
  assert((finalInspection.atom.routingFeedback?.effectiveEvidenceWeight ?? 64) < 5);

  return {
    currentAt: verifiedAt,
    immediateRanking,
    decayedRanking,
    routingRecoveredRanking,
    verifiedRanking,
    routingRelevance: {
      immediate: round(immediateTarget.priority.routingRelevance),
      decayed: round(decayedTarget.priority.routingRelevance),
      routingRecovered: round(routingRecoveredTarget.priority.routingRelevance),
      verified: round(verifiedTarget.priority.routingRelevance),
    },
    verifiedUsefulDelta: finalInspection.atom.verifiedUsefulness.useful - beforeVerifiedUseful,
    finalInspection,
  };
}

async function verifyRestartedDeepSearch(service, input, embeddingStats) {
  const runId = 'stage10-restart-deep-search';
  const callsBefore = embeddingStats.calls;
  const queryCallsBefore = embeddingStats.queryCalls;
  await service.beginRun({
    runId,
    sessionId: 'stage10-restart-deep-search-session',
    query: 'Which memory should leave the active context and later return when the goal changes?',
    recentHistory: [],
    workspace: input.workspace,
    autoPrime: false,
  });
  const index = await service.branchIndex(runId, 'long-term');
  assert(index.entries.length > 0);
  await service.expand(runId, {
    branchId: 'long-term',
    nodeId: MemoryRepository.branchRootId('long-term'),
    limit: 1,
    tokenBudget: 64,
  });
  const result = await service.deepSearch(runId, {
    branchId: 'long-term',
    query: 'Which memory should leave the active context and later return when the goal changes?',
    limit: 3,
    tokenBudget: 1_200,
  });
  await service.finishRun(runId);
  const atomIds = result.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id);
  assert(atomIds.includes(input.targetId));
  return {
    atomIds,
    retrievalPaths: result.fragments.map((fragment) => fragment.evidence?.retrievalPath),
    tokensUsed: result.tokensUsed,
    embeddingCalls: embeddingStats.calls - callsBefore,
    queryEmbeddingCalls: embeddingStats.queryCalls - queryCallsBefore,
  };
}

async function rankedCandidates(repository, now) {
  return repository.retrieval.indexMemory({
    branch: 'long-term',
    scopes: [{ scope: 'global' }],
    query: 'dynamic working set atom release readmission context routing',
    limit: 10,
    now,
  });
}

function fixtureIntents() {
  return [
    intent({
      id: 'stage10-target',
      summary: 'Dynamic memory working set release and readmission',
      content: 'A relevant atom may leave the active context when it no longer helps, then return through indexed expansion when the task changes.',
      retrievalKeys: ['dynamic working set', 'atom release', 'readmission', 'context routing'],
      importance: 0.94,
      confidence: 0.98,
    }),
    intent({
      id: 'stage10-control',
      summary: 'Bounded context candidate ordering uses governance signals',
      content: 'After scope filtering, the runtime orders candidates by task match, authority, confidence, importance, verified usefulness, routing relevance and token budget.',
      retrievalKeys: ['dynamic working set', 'candidate ordering', 'context routing', 'token budget'],
      importance: 0.86,
      confidence: 0.94,
    }),
    intent({
      id: 'stage10-conflict',
      summary: 'Disputed claim that every memory atom must remain loaded',
      content: 'An external claim says every atom should remain in Context forever, which conflicts with bounded progressive disclosure.',
      retrievalKeys: ['dynamic working set', 'all atoms loaded', 'context routing'],
      importance: 0.8,
      confidence: 0.86,
      epistemicStatus: 'disputed',
      authorityKind: 'external-source',
    }),
  ];
}

function intent(options) {
  return {
    id: options.id,
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: options.summary,
    content: options.content,
    retrievalKeys: options.retrievalKeys,
    sourceRunId: `stage10:${options.id}`,
    sourceStage: 'tool',
    sourceRefs: [`conversation-source:stage10:${options.id}:assistant-message:fixture`],
    importance: options.importance,
    confidence: options.confidence,
    reason: 'Memory v3 stage 10 isolated evolution fixture.',
    epistemic: {
      domain: 'knowledge',
      statementKind: 'factual-claim',
      epistemicStatus: options.epistemicStatus ?? 'verified',
      authorityScope: {
        kind: options.authorityKind ?? 'tool-evidence',
        scope: 'global',
        topics: options.retrievalKeys,
      },
      assertedBy: options.authorityKind === 'external-source'
        ? { kind: 'external', id: 'stage10-external' }
        : { kind: 'tool', id: 'stage10-fixture' },
      evidenceRefs: [`stage10:fixture:${options.id}`],
    },
  };
}

function instrumentEmbedding(base) {
  const stats = { calls: 0, queryCalls: 0, documentCalls: 0, texts: 0, durationMs: 0 };
  return {
    stats,
    engine: {
      descriptor: base.descriptor,
      isAvailable: () => base.isAvailable(),
      async embed(request) {
        const start = performance.now();
        stats.calls += 1;
        stats.texts += request.texts.length;
        if (request.purpose === 'query') stats.queryCalls += 1;
        else stats.documentCalls += 1;
        try {
          return await base.embed(request);
        } finally {
          stats.durationMs += performance.now() - start;
        }
      },
    },
  };
}

async function requiredInspection(repository, atomId) {
  const inspection = await repository.management.inspectNode(atomId, 'D3');
  assert(inspection?.atom);
  assert(inspection.catalog);
  return inspection;
}

function requiredCandidate(candidates, atomId) {
  const candidate = candidates.find((value) => value.atom.id === atomId);
  assert(candidate, `Missing ranked candidate ${atomId}.`);
  return candidate;
}

function requiredReference(knownState, atomId) {
  const reference = knownState.references.find((value) => value.atomId === atomId);
  assert(reference, `Missing KnownState reference ${atomId}.`);
  return reference;
}

function requiredId(ids, fixtureId) {
  const id = ids[fixtureId];
  assert(id, `Missing persisted id for ${fixtureId}.`);
  return id;
}

async function resolveEmbeddingModelRoot(explicitRoot) {
  if (explicitRoot) return resolve(explicitRoot);
  const { loadBranding, resolveDataDir } = await import('../packages/branding/dist/index.js');
  return join(resolveDataDir(await loadBranding()), 'models', 'embedding');
}

function parseArgs(values) {
  const options = {
    model: 'bge-small-zh-v1.5',
    modelRoot: undefined,
    embeddingBatch: 16,
    maxRssMiB: 512,
    keep: false,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--model=')) options.model = value.slice('--model='.length);
    else if (value.startsWith('--model-root=')) options.modelRoot = resolve(value.slice('--model-root='.length));
    else if (value.startsWith('--embedding-batch=')) options.embeddingBatch = integer(value, '--embedding-batch=', 1, 128);
    else if (value.startsWith('--max-rss-mib=')) options.maxRssMiB = integer(value, '--max-rss-mib=', 64, 4_096);
    else if (value === '--keep') options.keep = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.model !== 'bge-small-zh-v1.5' && options.model !== 'multilingual-e5-small') {
    throw new Error('model must be bge-small-zh-v1.5 or multilingual-e5-small.');
  }
  return options;
}

function integer(value, prefix, minimum, maximum) {
  const parsed = Number(value.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${prefix.slice(2, -1)} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function assertIsolatedRoot(value) {
  const base = resolve(tmpdir());
  const target = resolve(value);
  assert(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`), `Unsafe temporary root: ${target}`);
  assert(target.includes('littlesheep-memory-v3-evolution-'), `Unexpected temporary root: ${target}`);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
