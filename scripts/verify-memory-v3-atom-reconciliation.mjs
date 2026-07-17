import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  InjectionTier,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import { MemoryRepositoryV3Backend } from '../packages/memory-tree/dist/memory-repository/v3-backend.js';
import { resolveMemoryWritePolicy } from '../packages/memory-tree/dist/memory-repository/write-policy.js';

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-atom-reconciliation-'));
const originalFetch = globalThis.fetch;
let blockedNetworkAttempts = 0;
let backend;
let report;
let failure;

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during Memory v3 Atom reconciliation acceptance.');
  };
  await createMemoryV3ExperimentMarker(dataDir);
  backend = await openBackend(dataDir);
  const fixture = await writeFixture(backend);
  const beforeRestart = await inspect(backend, fixture);

  const activeReplacement = await backend.graphStore.getRelation(fixture.replacementRelationId);
  assert(activeReplacement, 'Replacement relation disappeared before restart simulation.');
  await backend.graphStore.upsertRelation({
    ...activeReplacement,
    status: 'proposed',
    revision: activeReplacement.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  backend.close();
  backend = undefined;
  backend = await openBackend(dataDir);
  const afterRestart = await inspect(backend, fixture);

  assert.deepEqual(afterRestart.selected, beforeRestart.selected, 'Atom routing changed after repository restart.');
  assert.equal(afterRestart.replacementStatus, 'active', 'Startup compensation did not reactivate the committed relation.');
  assert.equal(beforeRestart.suggestionStatus, 'proposed', 'Unverified suggestion relation became active.');
  assert.equal(afterRestart.suggestionStatus, 'proposed', 'Restart changed unverified suggestion status.');
  assert.equal(beforeRestart.scopeLeaks, 0, 'Atom relation routing leaked across scope.');
  assert.equal(afterRestart.scopeLeaks, 0, 'Atom relation routing leaked across scope after restart.');
  assert.equal(blockedNetworkAttempts, 0, 'Atom reconciliation attempted network access.');

  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    corpus: {
      atoms: 3,
      expectedActiveRelations: 1,
      expectedProposedRelations: 1,
    },
    beforeRestart,
    afterRestart,
    network: { blockedAttempts: blockedNetworkAttempts },
    resources: {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
    },
  };
} catch (error) {
  failure = error;
} finally {
  globalThis.fetch = originalFetch;
  try { backend?.close(); } catch (error) { failure ??= error; }
  try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;

async function openBackend(root) {
  const current = new MemoryRepositoryV3Backend({ dataDir: root, policy: resolveMemoryWritePolicy() });
  await current.initialize();
  return current;
}

async function writeFixture(current) {
  const old = await current.write(userIntent({
    id: 'acceptance-old',
    summary: 'Use the old memory injection rule',
    content: 'The old rule injects every matching memory candidate.',
    retrievalKeys: ['old memory injection rule'],
    statementKind: 'instruction',
    entityHints: [{ stableKey: 'rule:old', type: 'rule', label: 'Old injection rule' }],
  }));
  const replacement = await current.write(userIntent({
    id: 'acceptance-replacement',
    summary: 'Replace the old injection rule',
    content: 'Use the bounded relevant-Atom rule instead of the old injection rule.',
    retrievalKeys: ['old memory injection rule', 'bounded atom injection'],
    statementKind: 'decision',
    entityHints: [
      { stableKey: 'rule:old', type: 'rule', label: 'Old injection rule' },
      { stableKey: 'rule:bounded', type: 'rule', label: 'Bounded Atom rule' },
    ],
    relationHints: [{ fromKey: 'rule:bounded', toKey: 'rule:old', type: 'replaces' }],
  }));
  const suggestion = await current.write({
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'workspace',
    scopeKey: 'D:/isolated-project',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Possible broad context dependency',
    content: 'The planner may depend on loading broad historical context.',
    retrievalKeys: ['broad context dependency'],
    sourceRunId: 'run-acceptance-suggestion',
    sourceStage: 'evolve',
    sourceRefs: ['conversation-source:acceptance-suggestion:assistant-reply:1'],
    importance: 0.7,
    confidence: 0.7,
    reason: 'Unverified suggestion retained for review.',
    epistemic: {
      domain: 'project',
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      authorityScope: { kind: 'none', scope: 'workspace', scopeKey: 'D:/isolated-project', topics: [] },
      assertedBy: { kind: 'agent', id: 'littlesheep' },
      entityHints: [
        { stableKey: 'planner', type: 'concept', label: 'Planner' },
        { stableKey: 'broad-history', type: 'concept', label: 'Broad history' },
      ],
      relationHints: [{ fromKey: 'planner', toKey: 'broad-history', type: 'depends-on' }],
    },
  });
  const replacementAtom = await current.atomStore.read(replacement.node.id);
  const suggestionAtom = await current.atomStore.read(suggestion.node.id);
  assert.equal(replacementAtom.relationRefs.length, 1);
  assert.equal(suggestionAtom.relationRefs.length, 1);
  return {
    oldAtomId: old.node.id,
    replacementAtomId: replacement.node.id,
    suggestionAtomId: suggestion.node.id,
    replacementRelationId: replacementAtom.relationRefs[0],
    suggestionRelationId: suggestionAtom.relationRefs[0],
  };
}

async function inspect(current, fixture) {
  const routes = current.catalog.listRelationRoutingCandidates([fixture.oldAtomId], {
    branch: 'long-term',
    limit: 10,
  }, new Date().toISOString());
  const replacementRoute = routes.find((route) => route.entry.atomId === fixture.replacementAtomId
    && route.relationType === 'replaces'
    && route.direction === 'inbound');
  assert(replacementRoute, 'The committed replacement relation did not produce a bounded route.');
  const candidates = await current.indexMemory({
    branch: 'long-term',
    scopes: [{ scope: 'global' }],
    query: 'Use the old memory injection rule',
    limit: 10,
    now: new Date().toISOString(),
  });
  const selected = candidates.map((candidate) => ({
    atomId: candidate.atom.id,
    path: candidate.retrievalPath,
    relationType: candidate.envelope.relationRoute?.relationType,
  }));
  assert(selected.some((candidate) => candidate.atomId === fixture.oldAtomId), 'The exact seed Atom was not found.');
  assert(selected.some((candidate) => candidate.atomId === fixture.replacementAtomId),
    'The replacement Atom did not enter the current candidate set.');
  const scopeLeaks = selected.filter((candidate) => candidate.atomId === fixture.suggestionAtomId).length;
  return {
    selected,
    replacementRoute: {
      relationId: replacementRoute.relationId,
      direction: replacementRoute.direction,
      strength: replacementRoute.routeStrength,
    },
    replacementStatus: (await current.graphStore.getRelation(fixture.replacementRelationId))?.status,
    suggestionStatus: (await current.graphStore.getRelation(fixture.suggestionRelationId))?.status,
    scopeLeaks,
    integrity: current.catalog.integrityCheck(),
  };
}

function userIntent(input) {
  return {
    id: input.id,
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: input.summary,
    content: input.content,
    retrievalKeys: input.retrievalKeys,
    sourceRunId: `run:${input.id}`,
    sourceStage: 'evolve',
    sourceRefs: [`conversation-source:${input.id}:user-message:1`],
    importance: 0.9,
    confidence: 0.95,
    reason: 'The user explicitly established this memory rule.',
    epistemic: {
      domain: 'user',
      statementKind: input.statementKind,
      epistemicStatus: 'reported',
      authorityScope: { kind: 'user-self', scope: 'global', topics: ['memory-v3'] },
      assertedBy: { kind: 'user', id: 'local-user' },
      entityHints: input.entityHints,
      relationHints: input.relationHints,
    },
  };
}
