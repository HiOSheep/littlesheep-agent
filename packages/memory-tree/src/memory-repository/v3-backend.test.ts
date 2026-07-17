import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingResult, MemoryCatalogEntry, MemoryEntity, MemoryRelation } from '../v3/contracts.js';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { createMemoryV3ExperimentMarker } from '../memory-repository.js';
import { makeAtomInput, TEST_TIME } from '../v3/test-fixtures.js';
import { memoryRoutingRelevance } from '../v3/priority.js';
import { memoryCatalogActivationScore } from '../v3/activation.js';
import { composeMemoryTaskQuery } from '../task-query.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';

describe('MemoryRepositoryV3Backend recovery', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('restores graph projections before rebuilding atoms that reference entities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-rebuild-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const original = createBackend(dataDir);
    backends.push(original);
    await original.initialize();

    const entity = testEntity();
    await original.graphStore.upsertEntity(entity);
    const created = await original.write(intent(entity.id));
    expect(created.decision).toBe('created');
    expect(created.node?.id).toBeTruthy();
    original.close();
    backends.splice(backends.indexOf(original), 1);

    const catalogPath = join(dataDir, 'memory-tree', 'v3', 'catalog.sqlite');
    await Promise.all([
      rm(catalogPath, { force: true }),
      rm(`${catalogPath}-wal`, { force: true }),
      rm(`${catalogPath}-shm`, { force: true }),
    ]);

    const rebuilt = createBackend(dataDir);
    backends.push(rebuilt);
    await rebuilt.initialize();
    expect(rebuilt.catalog.getEntity(entity.id)).toEqual(entity);
    expect(await rebuilt.getNode(created.node!.id)).toMatchObject({
      id: created.node!.id,
      content: 'The catalog depends on a durable graph projection.',
    });
  });

  it('indexes a committed atom before a successful write returns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-embedding-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir, localEmbeddingEngine());
    backends.push(backend);
    await backend.initialize();

    const created = await backend.write(intent());

    expect(created.decision).toBe('created');
    expect(backend.catalog.getAtom(created.node!.id)?.embeddingStatus).toBe('ready');
    expect(backend.catalog.countEmbeddingWork()).toBe(0);
    const managementStatus = await backend.managementStatus();
    expect(managementStatus).toMatchObject({
      backendKind: 'v3',
      storageKind: 'atom-catalog',
      retrievalSupported: true,
      catalog: {
        integrity: 'ok',
        embedding: { pending: 0, failed: 0 },
      },
    });
    expect(managementStatus.catalog!.embedding.ready).toBeGreaterThanOrEqual(1);
    await expect(backend.inspectNodeForManagement(created.node!.id, 'D3')).resolves.toMatchObject({
      backendKind: 'v3',
      disclosureLevel: 'D3',
      atom: {
        id: created.node!.id,
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
      },
      catalog: { embeddingStatus: 'ready' },
      envelope: { disclosureLevel: 'D3', epistemicStatus: 'verified' },
      history: { atomId: created.node!.id },
    });
  });

  it('keeps management activation tiers stable across refreshes and resets the projection on restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-activation-hysteresis-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const atom = await backend.atomStore.create(makeAtomInput({
      id: 'activation-hysteresis',
      parentId: 'long-term:root',
      branch: 'long-term',
      domain: 'knowledge',
      scope: 'global',
      scopeKey: undefined,
      routingFeedback: {
        useful: 16,
        notUseful: 0,
        conflicts: 0,
        stale: 0,
        effectiveRelevance: 0.94,
        effectiveEvidenceWeight: 16,
        lastOutcome: 'useful',
        lastRoutedAt: TEST_TIME,
      },
      verifiedUsefulness: { useful: 8, notUseful: 0, conflicts: 0, stale: 0 },
      lastUsefulAt: TEST_TIME,
      createdAt: TEST_TIME,
      updatedAt: TEST_TIME,
    }));
    backend.catalog.upsertAtom(atom, backend.atomStore.relativePathFor(atom.id)!);
    const boundaryAt = findCatalogActivationDate(backend.catalog.getAtom(atom.id)!, 0.61, 0.66);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(TEST_TIME));
      expect((await backend.managementStatus()).catalog?.activation).toEqual({ high: 1, medium: 0, low: 0 });
      vi.setSystemTime(new Date(boundaryAt));
      expect((await backend.managementStatus()).catalog?.activation).toEqual({ high: 1, medium: 0, low: 0 });
    } finally {
      vi.useRealTimers();
    }

    backend.close();
    backends.splice(backends.indexOf(backend), 1);
    const restarted = createBackend(dataDir);
    backends.push(restarted);
    await restarted.initialize();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(boundaryAt));
      expect((await restarted.managementStatus()).catalog?.activation).toEqual({ high: 0, medium: 1, low: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses scoped FTS to keep an older exact D1 candidate outside the recent fallback visible', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-d1-fts-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const target = await backend.write({
      ...intent(),
      id: 'd1-old-aurora-policy',
      summary: 'Aurora retention policy',
      content: 'The verified Aurora retention policy keeps seven daily recovery points.',
      retrievalKeys: ['aurora retention policy', 'recovery points'],
    });
    const recent = await backend.write({
      ...intent(),
      id: 'd1-recent-distractor',
      summary: 'Recent package preference',
      content: 'Use pnpm for repository scripts.',
      retrievalKeys: ['pnpm', 'package manager'],
    });
    const recentEntry = backend.catalog.getAtom(recent.node!.id)!;
    vi.spyOn(backend.catalog, 'listAtoms').mockReturnValue([recentEntry]);

    const candidates = await backend.indexMemory({
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: 'aurora retention policy',
      limit: 20,
      now: '2026-07-17T01:30:00.000Z',
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        atom: expect.objectContaining({ id: target.node!.id }),
        retrievalPath: 'fts',
        priority: expect.objectContaining({
          taskRelevance: 1,
          activation: expect.objectContaining({ score: expect.any(Number) }),
        }),
      }),
    ]));
    expect(candidates.find((candidate) => candidate.atom.id === target.node!.id)?.priority.activation.score)
      .toBeLessThan(0.33);
    expect(candidates.find((candidate) => candidate.atom.id === recent.node!.id)?.priority.taskRelevance).toBe(0);
  });

  it('discovers independently relevant Atom candidates through trusted relations and preserves the relation path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-relation-routing-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    let backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();

    const feature = { ...testEntity(), id: 'concept:aurora-release', externalKey: 'aurora-release', label: 'Aurora release' };
    const policy = { ...testEntity(), id: 'concept:signed-policy', externalKey: 'signed-policy', label: 'Signed policy' };
    const noise = { ...testEntity(), id: 'concept:unrelated-noise', externalKey: 'unrelated-noise', label: 'Unrelated noise' };
    const similar = { ...testEntity(), id: 'concept:similar-ui', externalKey: 'similar-ui', label: 'Similar UI' };
    for (const entity of [feature, policy, noise, similar]) await backend.graphStore.upsertEntity(entity);
    const dependency = { ...testRelation(feature.id, policy.id), id: 'relation:aurora-policy' };
    const unrelated = { ...testRelation(feature.id, noise.id), id: 'relation:aurora-noise' };
    const similarity = {
      ...testRelation(feature.id, similar.id),
      id: 'relation:aurora-similar',
      type: 'similar-to' as const,
    };
    for (const relation of [dependency, unrelated, similarity]) await backend.graphStore.upsertRelation(relation);

    const seed = await backend.write({
      ...intent(feature.id),
      id: 'atom-aurora-release-seed',
      summary: 'Aurora release policy execution',
      content: 'Execute the Aurora release policy for the current deployment.',
      retrievalKeys: ['aurora release policy', 'deployment'],
    });
    const required = await backend.write({
      ...intent(policy.id),
      id: 'atom-aurora-signed-policy',
      summary: 'Aurora signed release policy prerequisite',
      content: 'The Aurora deployment requires a signed release policy before execution.',
      retrievalKeys: ['aurora', 'release policy', 'deployment prerequisite'],
    });
    const irrelevant = await backend.write({
      ...intent(noise.id),
      id: 'atom-unrelated-noise',
      summary: 'Unrelated color preference',
      content: 'Use a neutral gray interface color.',
      retrievalKeys: ['color', 'interface'],
    });
    const similarOnly = await backend.write({
      ...intent(similar.id),
      id: 'atom-similar-ui',
      summary: 'Aurora release policy UI wording',
      content: 'The Aurora release policy screen uses compact labels.',
      retrievalKeys: ['aurora release policy', 'ui'],
    });

    const runIndex = async (current: MemoryRepositoryV3Backend) => {
      const seedEntry = current.catalog.getAtom(seed.node!.id)!;
      vi.spyOn(current.catalog, 'searchFts').mockReturnValue([{
        entry: seedEntry,
        score: 1,
        matchReason: 'fts',
      }]);
      vi.spyOn(current.catalog, 'listAtoms').mockReturnValue([seedEntry]);
      return current.indexMemory({
        branch: 'long-term',
        scopes: [{ scope: 'global' }],
        query: 'aurora release policy deployment',
        limit: 10,
        now: '2026-07-17T06:00:00.000Z',
      });
    };

    const beforeRestart = await runIndex(backend);
    expect(beforeRestart.find((candidate) => candidate.atom.id === required.node!.id)).toMatchObject({
      retrievalPath: 'relation',
      envelope: {
        retrievalPath: 'relation',
        relationRoute: {
          seedAtomId: seed.node!.id,
          relationId: dependency.id,
          relationType: 'depends-on',
          direction: 'outbound',
        },
      },
    });
    expect(beforeRestart.map((candidate) => candidate.atom.id)).not.toContain(irrelevant.node!.id);
    expect(beforeRestart.map((candidate) => candidate.atom.id)).not.toContain(similarOnly.node!.id);

    const routed = beforeRestart.find((candidate) => candidate.atom.id === required.node!.id)!;
    const expanded = await backend.retrieveMemory({
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: 'aurora release policy deployment',
      nodeId: required.node!.id,
      limit: 1,
      now: '2026-07-17T06:00:00.000Z',
      disclosureLevel: 'D2',
      mode: 'expand',
      retrievalPathHint: routed.retrievalPath,
      retrievalMatchReasonHint: routed.envelope.matchReason,
    });
    expect(expanded[0]).toMatchObject({
      atom: { id: required.node!.id },
      retrievalPath: 'relation',
      envelope: { retrievalPath: 'relation' },
    });

    backend.close();
    backends.splice(backends.indexOf(backend), 1);
    backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const afterRestart = await runIndex(backend);
    expect(afterRestart.map((candidate) => [candidate.atom.id, candidate.retrievalPath]))
      .toEqual(beforeRestart.map((candidate) => [candidate.atom.id, candidate.retrievalPath]));
  });

  it('keeps replacement and negative constraints while excluding rejected plan content', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-polarity-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const oldPlan = await backend.write({
      ...intent(),
      id: 'old-full-history-plan',
      summary: '旧方案',
      content: '旧方案会把全部历史直接塞进上下文。',
      retrievalKeys: ['旧方案', '全量历史'],
      sourceRunId: 'run-old-plan',
    });
    const constraint = await backend.write({
      ...intent(),
      id: 'old-plan-rejected-decision',
      summary: '旧方案禁用决定',
      content: '用户决定不再采用旧方案，禁止全量历史注入。',
      retrievalKeys: ['旧方案', '禁止全量历史'],
      sourceRunId: 'run-old-plan-rejected',
    });
    const replacement = await backend.write({
      ...intent(),
      id: 'new-index-routing-plan',
      summary: '新的索引注入方案',
      content: '新方案沿索引选择相关 Atom，并按预算注入。',
      retrievalKeys: ['新方案', '索引注入', 'Atom 相关性'],
      sourceRunId: 'run-new-plan',
    });
    const taskQuery = composeMemoryTaskQuery('不要旧方案，改用新的索引注入方案');

    const candidates = await backend.indexMemory({
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: taskQuery.retrievalText,
      taskQuery,
      limit: 20,
      now: '2026-07-17T02:30:00.000Z',
    });
    const ids = candidates.map((candidate) => candidate.atom.id);

    expect(ids).toContain(constraint.node!.id);
    expect(ids).toContain(replacement.node!.id);
    expect(ids).not.toContain(oldPlan.node!.id);
  });

  it('keeps one coalesced background maintenance lifecycle until every batch is idle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-background-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = new MemoryRepositoryV3Backend({
      dataDir,
      policy: resolveMemoryWritePolicy(),
      v3: { embeddingEngine: localEmbeddingEngine(), maxEmbeddingBatchSize: 1 },
    });
    backends.push(backend);
    await backend.initialize();
    for (const id of ['background-a', 'background-b', 'background-c']) {
      const atom = await backend.atomStore.create(makeAtomInput({
        id,
        parentId: 'long-term:root',
        branch: 'long-term',
        domain: 'knowledge',
        scope: 'global',
        scopeKey: undefined,
        title: id,
        summary: id,
        content: `Background maintenance content for ${id}.`,
        retrievalKeys: [id],
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3'] },
      }));
      backend.catalog.upsertAtom(atom, backend.atomStore.relativePathFor(atom.id)!);
    }

    const first = backend.startBackgroundMaintenance();
    const second = backend.startBackgroundMaintenance();
    expect(second).toBe(first);
    await first;
    expect(backend.catalog.countEmbeddingWork()).toBe(0);
    expect(backend.catalog.embeddingStatusCounts()).toMatchObject({ pending: 0, failed: 0 });

    await backend.shutdown();
    backends.splice(backends.indexOf(backend), 1);
  });

  it('updates verified usefulness idempotently without changing confidence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-feedback-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const created = await backend.write(intent());
    const before = await backend.atomStore.read(created.node!.id);
    const feedback = {
      id: 'feedback-1',
      atomId: created.node!.id,
      runId: 'run-feedback',
      outcome: 'useful' as const,
      verified: true,
      evidenceRefs: ['run:run-feedback:verification:1:pass'],
      verifyStageId: 'run-feedback:verify:1',
      reason: 'Structural verification passed.',
      createdAt: '2026-07-16T06:00:00.000Z',
    };

    await backend.recordMemoryFeedback([feedback]);
    await backend.recordMemoryFeedback([feedback]);
    const after = await backend.atomStore.read(created.node!.id);

    expect(after?.verifiedUsefulness.useful).toBe(1);
    expect(after?.feedbackRevision).toBe(1);
    expect(after?.lastUsefulAt).toBe(feedback.createdAt);
    expect(after?.routingFeedback?.useful).toBe(1);
    expect(after?.confidence).toBe(before?.confidence);
    expect(backend.catalog.countFeedbackRecords()).toBe(1);
  });

  it('persists release routing feedback without changing truth confidence or rebuilding vectors', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-routing-feedback-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const engine = localEmbeddingEngine();
    const backend = createBackend(dataDir, engine);
    backends.push(backend);
    await backend.initialize();
    const created = await backend.write(intent());
    const before = await backend.atomStore.read(created.node!.id);
    const beforeRouting = memoryRoutingRelevance(before!, '2026-07-16T06:00:00.000Z');
    const embeddingCallsBeforeFeedback = vi.mocked(engine.embed).mock.calls.length;

    await backend.recordMemoryFeedback([{
      id: 'feedback-release-1',
      atomId: created.node!.id,
      runId: 'run-release',
      outcome: 'not-useful',
      verified: false,
      evidenceRefs: [],
      reason: 'The atom was released from the current working set.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);
    await backend.recordMemoryFeedback([{
      id: 'feedback-release-1',
      atomId: created.node!.id,
      runId: 'run-release',
      outcome: 'not-useful',
      verified: false,
      evidenceRefs: [],
      reason: 'The atom was released from the current working set.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);

    const after = await backend.atomStore.read(created.node!.id);
    expect(after?.routingFeedback).toMatchObject({
      useful: 0,
      notUseful: 1,
      lastOutcome: 'not-useful',
      recentFeedbackIds: ['feedback-release-1'],
    });
    expect(memoryRoutingRelevance(after!, '2026-07-16T06:00:00.000Z')).toBeLessThan(beforeRouting);
    expect(after?.verifiedUsefulness).toEqual(before?.verifiedUsefulness);
    expect(after?.confidence).toBe(before?.confidence);
    expect(backend.catalog.getAtom(created.node!.id)?.embeddingStatus).toBe('ready');
    expect(engine.embed).toHaveBeenCalledTimes(embeddingCallsBeforeFeedback);

    await backend.shutdown();
    backends.splice(backends.indexOf(backend), 1);
    const restarted = createBackend(dataDir, localEmbeddingEngine());
    backends.push(restarted);
    await restarted.initialize();
    expect((await restarted.atomStore.read(created.node!.id))?.routingFeedback?.notUseful).toBe(1);
    expect(restarted.catalog.getAtom(created.node!.id)?.embeddingStatus).toBe('ready');
  });

  it('does not revive old negative routing evidence when a new useful observation arrives', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-routing-decay-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const created = await backend.write(intent());
    const atomId = created.node!.id;
    const oldAt = '2025-07-16T06:00:00.000Z';
    const newAt = '2026-07-16T06:00:00.000Z';

    await backend.recordMemoryFeedback(Array.from({ length: 32 }, (_, index) => ({
      id: `feedback-old-release-${index}`,
      atomId,
      runId: `run-old-release-${index}`,
      outcome: 'not-useful' as const,
      verified: false,
      evidenceRefs: [],
      reason: 'Historical run-scoped release.',
      createdAt: oldAt,
    })));
    const beforeUseful = await backend.atomStore.read(atomId);
    const decayed = memoryRoutingRelevance(beforeUseful!, newAt);

    await backend.recordMemoryFeedback([{
      id: 'feedback-current-useful',
      atomId,
      runId: 'run-current-useful',
      outcome: 'useful',
      verified: false,
      evidenceRefs: ['run:run-current-useful:verification:1:pass'],
      reason: 'The current verified response explicitly used the atom.',
      createdAt: newAt,
    }]);
    const afterUseful = await backend.atomStore.read(atomId);
    const updated = memoryRoutingRelevance(afterUseful!, newAt);

    expect(decayed).toBeGreaterThan(0.45);
    expect(updated).toBeGreaterThan(decayed);
    expect(afterUseful?.routingFeedback?.effectiveRelevance).toBeCloseTo(updated, 8);
    expect(afterUseful?.routingFeedback?.effectiveEvidenceWeight).toBeLessThan(4);
  });

  it('adjusts existing relation relevance from verified usefulness without changing relation confidence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-relation-feedback-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const left = testEntity();
    const right = { ...testEntity(), id: 'concept:runtime-feedback', externalKey: 'runtime-feedback', label: 'Runtime feedback' };
    await backend.graphStore.upsertEntity(left);
    await backend.graphStore.upsertEntity(right);
    const relation = testRelation(left.id, right.id);
    await backend.graphStore.upsertRelation(relation);
    const created = await backend.write(intent(left.id, relation.id));

    await backend.recordMemoryFeedback([{
      id: 'feedback-relation-1',
      atomId: created.node!.id,
      runId: 'run-feedback',
      outcome: 'useful',
      verified: true,
      evidenceRefs: ['run:run-feedback:verification:1:pass'],
      reason: 'Structural verification passed.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);
    await backend.recordMemoryFeedback([{
      id: 'feedback-relation-1',
      atomId: created.node!.id,
      runId: 'run-feedback',
      outcome: 'useful',
      verified: true,
      evidenceRefs: ['run:run-feedback:verification:1:pass'],
      reason: 'Structural verification passed.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);

    const updated = await backend.graphStore.getRelation(relation.id);
    expect(updated?.relevance).toBeGreaterThan(relation.relevance);
    expect(updated?.confidence).toBe(relation.confidence);
    expect(updated?.feedbackRevision).toBe(1);
  });

  it('uses a lighter relation adjustment for explicit routing use without independent verification', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-relation-routing-use-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const left = testEntity();
    const right = { ...testEntity(), id: 'concept:routing-use', externalKey: 'routing-use', label: 'Routing use' };
    await backend.graphStore.upsertEntity(left);
    await backend.graphStore.upsertEntity(right);
    const relation = testRelation(left.id, right.id);
    await backend.graphStore.upsertRelation(relation);
    const created = await backend.write(intent(left.id, relation.id));
    const atomBefore = await backend.atomStore.read(created.node!.id);

    await backend.recordMemoryFeedback([{
      id: 'feedback-relation-routing-use-1',
      atomId: created.node!.id,
      runId: 'run-routing-use',
      outcome: 'useful',
      verified: false,
      evidenceRefs: ['run:run-routing-use:verification:1:pass'],
      reason: 'VERIFY explicitly cited the atom, without independent factual evidence.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);

    const updated = await backend.graphStore.getRelation(relation.id);
    const atomAfter = await backend.atomStore.read(created.node!.id);
    expect(updated?.relevance).toBeGreaterThan(relation.relevance);
    expect(updated!.relevance).toBeLessThan(relation.relevance + (1 - relation.relevance) * 0.08);
    expect(updated?.confidence).toBe(relation.confidence);
    expect(atomAfter?.routingFeedback?.useful).toBe(1);
    expect(atomAfter?.verifiedUsefulness).toEqual(atomBefore?.verifiedUsefulness);
  });

  it('applies only a light relation routing decay for an unverified release', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-relation-routing-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir);
    backends.push(backend);
    await backend.initialize();
    const left = testEntity();
    const right = { ...testEntity(), id: 'concept:routing-release', externalKey: 'routing-release', label: 'Routing release' };
    await backend.graphStore.upsertEntity(left);
    await backend.graphStore.upsertEntity(right);
    const relation = testRelation(left.id, right.id);
    await backend.graphStore.upsertRelation(relation);
    const created = await backend.write(intent(left.id, relation.id));

    await backend.recordMemoryFeedback([{
      id: 'feedback-relation-release-1',
      atomId: created.node!.id,
      runId: 'run-release',
      outcome: 'not-useful',
      verified: false,
      evidenceRefs: [],
      reason: 'Released from this run only.',
      createdAt: '2026-07-16T06:00:00.000Z',
    }]);

    const updated = await backend.graphStore.getRelation(relation.id);
    expect(updated?.relevance).toBeLessThan(relation.relevance);
    expect(updated?.relevance).toBeGreaterThan(relation.relevance * 0.95);
    expect(updated?.confidence).toBe(relation.confidence);
    expect(updated?.feedbackRevision).toBe(1);
  });
});

function createBackend(dataDir: string, embeddingEngine?: EmbeddingEngine): MemoryRepositoryV3Backend {
  return new MemoryRepositoryV3Backend({
    dataDir,
    policy: resolveMemoryWritePolicy(),
    v3: embeddingEngine ? { embeddingEngine } : undefined,
  });
}

function testEntity(): MemoryEntity {
  return {
    version: 1,
    id: 'concept:durable-graph',
    type: 'concept',
    owner: { kind: 'agent', id: 'ls' },
    scope: 'global',
    externalKey: 'durable-graph',
    label: 'Durable graph',
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
  };
}

function intent(entityId?: string, relationId?: string): MemoryWriteIntent {
  return {
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Catalog recovery requires graph-first initialization',
    content: 'The catalog depends on a durable graph projection.',
    retrievalKeys: ['catalog', 'graph', 'recovery'],
    sourceRunId: 'run-graph-recovery',
    sourceStage: 'tool',
    importance: 0.9,
    confidence: 1,
    reason: 'Verified by the Memory v3 recovery contract.',
    epistemic: {
      domain: 'knowledge',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3'] },
      assertedBy: { kind: 'tool', id: 'memory-v3-recovery-test' },
      entityRefs: entityId ? [entityId] : [],
      relationRefs: relationId ? [relationId] : [],
    },
  };
}

function testRelation(fromEntityId: string, toEntityId: string): MemoryRelation {
  return {
    version: 1,
    id: 'relation:catalog-feedback',
    fromEntityId,
    toEntityId,
    type: 'depends-on',
    scope: 'global',
    source: { kind: 'tool', id: 'memory-v3-recovery-test' },
    sourceRefs: [],
    evidenceRefs: ['tool:memory-v3-recovery-test'],
    confidence: 0.9,
    authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3'] },
    relevance: 0.5,
    feedbackRevision: 0,
    recentFeedbackIds: [],
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
  };
}

function localEmbeddingEngine(): EmbeddingEngine {
  const descriptor = {
    engineId: 'local-backend-test',
    modelId: 'memory-v3-test',
    version: '1',
    dimensions: 3,
    transport: 'local' as const,
  };
  return {
    descriptor,
    isAvailable: () => true,
    embed: vi.fn(async (request: EmbeddingRequest): Promise<EmbeddingResult> => ({
      descriptor,
      vectors: request.texts.map(() => [1, 0, 0]),
    })),
  };
}

function findCatalogActivationDate(
  entry: MemoryCatalogEntry,
  minimum: number,
  maximum: number,
): string {
  for (let day = 1; day <= 365; day += 1) {
    const at = new Date(Date.parse(entry.activationUpdatedAt) + day * 86_400_000).toISOString();
    const score = memoryCatalogActivationScore(entry, at);
    if (score >= minimum && score < maximum) return at;
  }
  throw new Error(`No catalog activation date found between ${minimum} and ${maximum}.`);
}
