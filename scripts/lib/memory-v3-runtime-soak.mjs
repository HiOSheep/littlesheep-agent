import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  InjectionTier,
  MemoryRepository,
  createMemoryV3ExperimentMarker,
} from '../../packages/memory-tree/dist/index.js';

export function createDeterministicEmbeddingEngine(label) {
  const stats = { calls: 0, texts: 0, batches: [] };
  const descriptor = {
    engineId: `memory-v3-soak-${label}`,
    modelId: 'deterministic-local-test',
    version: '1',
    dimensions: 4,
    transport: 'test',
  };
  return {
    stats,
    engine: {
      descriptor,
      isAvailable: () => true,
      async embed(request) {
        stats.calls += 1;
        stats.texts += request.texts.length;
        stats.batches.push(request.texts.length);
        return {
          descriptor,
          vectors: request.texts.map(deterministicVector),
        };
      },
    },
  };
}

export async function verifyMemoryV3RuntimeFeedback(options) {
  const runtimeDataDir = join(options.dataDir, 'runtime-feedback');
  await createMemoryV3ExperimentMarker(runtimeDataDir);
  const embedding = createDeterministicEmbeddingEngine('runtime-feedback');
  let repository = openRepository(runtimeDataDir, embedding.engine, options.embeddingBatchSize);

  try {
    await repository.initialize();
    const created = await repository.write({
      branch: 'long-term',
      parentNodeId: MemoryRepository.branchRootId('long-term'),
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Runtime routing feedback remains bounded and recoverable',
      content: 'LittleSheep lowers optional context admission after release feedback and restores it after verified usefulness.',
      retrievalKeys: ['runtime', 'routing', 'feedback', 'recovery'],
      sourceRunId: 'run-memory-v3-runtime-soak',
      sourceStage: 'tool',
      importance: 0.82,
      confidence: 0.91,
      reason: 'Isolated public MemoryRepository runtime feedback verification.',
      epistemic: {
        domain: 'knowledge',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3', 'routing'] },
        assertedBy: { kind: 'tool', id: 'verify-memory-v3-soak' },
      },
    });
    assert.equal(created.decision, 'created');
    assert(created.node);
    const atomId = created.node.id;
    const competitor = await repository.write({
      branch: 'long-term',
      parentNodeId: MemoryRepository.branchRootId('long-term'),
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Neutral control atom for runtime routing comparison',
      content: 'This independent control record shares the runtime routing feedback recovery topic but has no routing observations.',
      retrievalKeys: ['runtime', 'routing', 'feedback', 'recovery', 'neutral-control'],
      sourceRunId: 'run-memory-v3-runtime-soak-control',
      sourceStage: 'tool',
      importance: 0.72,
      confidence: 0.84,
      reason: 'Provides a stable candidate for ranking changes caused by routing feedback.',
      epistemic: {
        domain: 'knowledge',
        statementKind: 'reported-observation',
        epistemicStatus: 'corroborated',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3', 'routing'] },
        assertedBy: { kind: 'tool', id: 'verify-memory-v3-soak-control' },
      },
    });
    assert.equal(competitor.decision, 'created', competitor.reason);
    assert(competitor.node);
    const competitorId = competitor.node.id;
    const before = await requiredInspection(repository, atomId);
    const beforeRanking = await rankedCandidates(repository, options.now().toISOString());
    const beforeCandidate = requiredCandidate(beforeRanking, atomId);
    assert.equal(beforeRanking[0]?.atom.id, atomId);
    const embeddingCallsBeforeFeedback = embedding.stats.calls;

    await repository.recordMemoryFeedback(makeFeedbackBatch({
      atomId,
      count: options.feedbackEvents,
      phase: 'release',
      outcome: 'not-useful',
      verified: false,
      now: options.now,
    }));
    const afterRelease = await requiredInspection(repository, atomId);
    const releaseRanking = await rankedCandidates(repository, options.now().toISOString());
    const releaseCandidate = requiredCandidate(releaseRanking, atomId);
    assert(releaseCandidate.priority.score < beforeCandidate.priority.score);
    assert(releaseCandidate.priority.routingRelevance < beforeCandidate.priority.routingRelevance);
    assert.equal(releaseRanking[0]?.atom.id, competitorId);
    assert.equal(afterRelease.atom.confidence, before.atom.confidence);
    assert.deepEqual(afterRelease.atom.verifiedUsefulness, before.atom.verifiedUsefulness);
    assert.equal(afterRelease.catalog.embeddingStatus, 'ready');
    assert.equal(afterRelease.catalog.embeddingHash, before.catalog.embeddingHash);
    assert.equal(embedding.stats.calls, embeddingCallsBeforeFeedback);

    await repository.recordMemoryFeedback(makeFeedbackBatch({
      atomId,
      count: options.feedbackEvents,
      phase: 'verified-useful',
      outcome: 'useful',
      verified: true,
      now: options.now,
    }));
    const afterRecovery = await requiredInspection(repository, atomId);
    const recoveryRanking = await rankedCandidates(repository, options.now().toISOString());
    const recoveredCandidate = requiredCandidate(recoveryRanking, atomId);
    assert(recoveredCandidate.priority.score > releaseCandidate.priority.score);
    assert(recoveredCandidate.priority.routingRelevance > releaseCandidate.priority.routingRelevance);
    assert.equal(recoveryRanking[0]?.atom.id, atomId);
    assert.equal(afterRecovery.atom.confidence, before.atom.confidence);
    assert.equal(
      afterRecovery.atom.verifiedUsefulness.useful,
      before.atom.verifiedUsefulness.useful + options.feedbackEvents,
    );
    assert.equal(afterRecovery.atom.feedbackRevision, before.atom.feedbackRevision + options.feedbackEvents * 2);
    assert(routingEvidenceCount(afterRecovery.atom.routingFeedback) <= 64);
    assert.equal(afterRecovery.atom.routingFeedback?.recentFeedbackIds?.length, 64);
    assert.equal(afterRecovery.catalog.embeddingStatus, 'ready');
    assert.equal(afterRecovery.catalog.embeddingHash, before.catalog.embeddingHash);
    assert.equal(embedding.stats.calls, embeddingCallsBeforeFeedback);

    const feedbackRows = catalogScalar(repository.indexPath, 'SELECT COUNT(*) AS count FROM atom_feedback');
    assert.equal(feedbackRows, options.feedbackEvents * 2);
    const callsBeforeRestart = embedding.stats.calls;
    await repository.shutdown();
    repository = openRepository(runtimeDataDir, embedding.engine, options.embeddingBatchSize);
    await repository.initialize();
    const restarted = await requiredInspection(repository, atomId);
    assert.deepEqual(restarted.atom.routingFeedback, afterRecovery.atom.routingFeedback);
    assert.equal(restarted.catalog.embeddingStatus, 'ready');
    assert.equal(embedding.stats.calls, callsBeforeRestart);

    const status = await repository.management.status();
    assert.equal(status.catalog?.integrity, 'ok');
    assert.equal(status.catalog?.embedding.pending, 0);
    assert.equal(status.catalog?.embedding.failed, 0);
    return {
      atomId,
      competitorId,
      feedbackEventsPerPhase: options.feedbackEvents,
      catalogFeedbackRows: feedbackRows,
      ranking: {
        before: beforeRanking.map((candidate) => candidate.atom.id),
        afterRelease: releaseRanking.map((candidate) => candidate.atom.id),
        afterRecovery: recoveryRanking.map((candidate) => candidate.atom.id),
      },
      score: {
        before: beforeCandidate.priority.score,
        afterRelease: releaseCandidate.priority.score,
        afterRecovery: recoveredCandidate.priority.score,
      },
      routingRelevance: {
        before: beforeCandidate.priority.routingRelevance,
        afterRelease: releaseCandidate.priority.routingRelevance,
        afterRecovery: recoveredCandidate.priority.routingRelevance,
      },
      boundedRoutingEvidence: routingEvidenceCount(restarted.atom.routingFeedback),
      retainedFeedbackIds: restarted.atom.routingFeedback?.recentFeedbackIds?.length ?? 0,
      verifiedUsefulCount: restarted.atom.verifiedUsefulness.useful,
      embedding: embeddingReport(embedding.stats),
      restartPreservedReadyVector: restarted.catalog.embeddingStatus === 'ready',
    };
  } finally {
    await repository.shutdown();
  }

  async function rankedCandidates(repositoryValue, now) {
    return repositoryValue.retrieval.indexMemory({
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: 'runtime routing feedback recovery',
      limit: 10,
      now,
    });
  }
}

export function embeddingReport(stats) {
  return {
    calls: stats.calls,
    texts: stats.texts,
    batches: [...stats.batches],
    maxBatch: stats.batches.length > 0 ? Math.max(...stats.batches) : 0,
    failedCalls: stats.failedCalls ?? 0,
    durationMs: Math.round((stats.durationMs ?? 0) * 10_000) / 10_000,
  };
}

function openRepository(dataDir, embeddingEngine, maxEmbeddingBatchSize) {
  return new MemoryRepository({
    dataDir,
    backend: 'v3',
    v3: { embeddingEngine, maxEmbeddingBatchSize },
  });
}

async function requiredInspection(repository, atomId) {
  const inspection = await repository.management.inspectNode(atomId, 'D3');
  assert(inspection?.atom);
  assert(inspection.catalog);
  return inspection;
}

function requiredCandidate(candidates, atomId) {
  const candidate = candidates?.find((value) => value.atom.id === atomId);
  assert(candidate, `The runtime feedback atom ${atomId} was not returned by the indexed retrieval path.`);
  return candidate;
}

function makeFeedbackBatch(input) {
  return Array.from({ length: input.count }, (_, index) => {
    const createdAt = input.now().toISOString();
    const id = `soak-feedback:${input.phase}:${String(index).padStart(4, '0')}`;
    return {
      id,
      atomId: input.atomId,
      runId: `run-${input.phase}-${String(index).padStart(4, '0')}`,
      outcome: input.outcome,
      verified: input.verified,
      evidenceRefs: input.verified ? [`verify:${id}:pass`] : [],
      verifyStageId: input.verified ? `${id}:verify` : undefined,
      reason: input.verified
        ? 'The atom contributed to an isolated structurally verified run.'
        : 'The atom was explicitly released from an isolated run context.',
      createdAt,
    };
  });
}

function routingEvidenceCount(feedback) {
  if (!feedback) return 0;
  return feedback.useful + feedback.notUseful + feedback.conflicts + feedback.stale;
}

function catalogScalar(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare(sql).get().count);
  } finally {
    db.close();
  }
}

function deterministicVector(text) {
  let hash = 2_166_136_261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return [
    1,
    (hash & 0xff) / 255,
    ((hash >>> 8) & 0xff) / 255,
    ((hash >>> 16) & 0xff) / 255,
  ];
}
