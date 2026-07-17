import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  InjectionTier,
  MemoryTree,
  TreeMemoryBranch,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import { MemoryRepositoryV3Backend } from '../packages/memory-tree/dist/memory-repository/v3-backend.js';
import { resolveMemoryWritePolicy } from '../packages/memory-tree/dist/memory-repository/write-policy.js';

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-relationship-routing-'));
assertIsolatedRoot(dataDir);
const originalFetch = globalThis.fetch;
let blockedNetworkAttempts = 0;
let backend;
let report;
let failure;
const embedding = { documentCalls: 0, queryCalls: 0, texts: 0 };

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during Memory v3 relationship-routing acceptance.');
  };
  await createMemoryV3ExperimentMarker(dataDir);
  backend = await openBackend(dataDir, embedding);
  const fixture = await createFixture(backend);

  const beforeRestart = await runCases(backend, fixture);
  const beforeInitialInjection = await verifyInitialInjection(backend, fixture);
  backend.close();
  backend = undefined;
  backend = await openBackend(dataDir, embedding);
  const afterRestart = await runCases(backend, fixture);
  const afterInitialInjection = await verifyInitialInjection(backend, fixture);

  assert.deepEqual(afterRestart, beforeRestart, 'Relationship routing changed after repository restart.');
  assert.deepEqual(afterInitialInjection, beforeInitialInjection, 'Initial relation injection changed after repository restart.');
  assert.equal(embedding.queryCalls, 0, 'D1 relationship routing must not create query embeddings.');
  assert.equal(blockedNetworkAttempts, 0, 'Relationship routing attempted network access.');

  const failures = [...beforeRestart, ...afterRestart]
    .filter((item) => !item.passed)
    .map((item) => `${item.phase}:${item.id}`);
  report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    corpus: {
      atoms: fixture.atomCount,
      entities: fixture.entityCount,
      relations: fixture.relationCount,
      cases: fixture.cases.length,
      passes: 2,
    },
    routing: {
      passed: [...beforeRestart, ...afterRestart].filter((item) => item.passed).length,
      total: fixture.cases.length * 2,
      relationPaths: [...beforeRestart, ...afterRestart]
        .flatMap((item) => item.selected)
        .filter((item) => item.path === 'relation').length,
      scopeLeaks: [...beforeRestart, ...afterRestart]
        .reduce((sum, item) => sum + item.scopeLeaks.length, 0),
      unexpected: [...beforeRestart, ...afterRestart]
        .reduce((sum, item) => sum + item.unexpected.length, 0),
      initialInjection: {
        beforeRestart: beforeInitialInjection,
        afterRestart: afterInitialInjection,
      },
    },
    embedding: { ...embedding, blockedNetworkAttempts },
    resources: {
      durationMs: round(performance.now() - startedAt),
      rss: process.memoryUsage().rss,
    },
    failures,
    details: { beforeRestart, afterRestart },
  };
  assert.equal(report.ok, true, `Relationship-routing failures: ${failures.join(', ')}`);
} catch (error) {
  failure = error;
} finally {
  globalThis.fetch = originalFetch;
  try { backend?.close(); } catch (error) { failure ??= error; }
  try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;

async function openBackend(root, stats) {
  const engine = {
    descriptor: {
      engineId: 'relationship-routing-local-test',
      modelId: 'deterministic-local-vector',
      version: '1',
      dimensions: 3,
      transport: 'local',
    },
    isAvailable: () => true,
    async embed(request) {
      stats.texts += request.texts.length;
      if (request.purpose === 'query') stats.queryCalls += 1;
      else stats.documentCalls += 1;
      return {
        descriptor: this.descriptor,
        vectors: request.texts.map(() => [1, 0, 0]),
      };
    },
  };
  const instance = new MemoryRepositoryV3Backend({
    dataDir: root,
    policy: resolveMemoryWritePolicy(),
    v3: { embeddingEngine: engine },
  });
  await instance.initialize();
  return instance;
}

async function createFixture(current) {
  const now = '2026-07-17T06:30:00.000Z';
  const entitySpecs = [
    ['global-feature', 'global'],
    ['global-required', 'global'],
    ['global-unrelated', 'global'],
    ['global-similar', 'global'],
    ['global-expired', 'global'],
    ['global-weak', 'global'],
    ['global-disputed', 'global'],
    ['global-archived', 'global'],
    ['replacement-old', 'global'],
    ['replacement-new', 'global'],
    ['conflict-left', 'global'],
    ['conflict-right', 'global'],
    ['project-a-seed', 'project', 'project-a'],
    ['project-a-required', 'project', 'project-a'],
    ['project-b-seed', 'project', 'project-b'],
    ['project-b-required', 'project', 'project-b'],
    ['session-a-seed', 'session', 'session-a'],
    ['session-a-required', 'session', 'session-a'],
    ['session-b-seed', 'session', 'session-b'],
    ['session-b-required', 'session', 'session-b'],
  ];
  const entities = Object.fromEntries(entitySpecs.map(([id, scope, scopeKey]) => [id, entity(id, scope, scopeKey, now)]));
  for (const value of Object.values(entities)) await current.graphStore.upsertEntity(value);

  const relationSpecs = [
    relation('dependency', entities['global-feature'], entities['global-required'], 'depends-on', now),
    relation('unrelated', entities['global-feature'], entities['global-unrelated'], 'depends-on', now),
    relation('similar', entities['global-feature'], entities['global-similar'], 'similar-to', now),
    { ...relation('expired', entities['global-feature'], entities['global-expired'], 'depends-on', now), expiresAt: '2026-07-17T06:00:00.000Z' },
    { ...relation('weak', entities['global-feature'], entities['global-weak'], 'depends-on', now), confidence: 0.2 },
    { ...relation('disputed', entities['global-feature'], entities['global-disputed'], 'depends-on', now), status: 'disputed', resolutionStatus: 'under-review' },
    { ...relation('archived', entities['global-feature'], entities['global-archived'], 'depends-on', now), status: 'archived' },
    relation('replacement', entities['replacement-new'], entities['replacement-old'], 'replaces', now),
    relation('conflict', entities['conflict-left'], entities['conflict-right'], 'conflicts-with', now),
    relation('project-a', entities['project-a-seed'], entities['project-a-required'], 'depends-on', now),
    relation('project-b', entities['project-b-seed'], entities['project-b-required'], 'depends-on', now),
    relation('session-a', entities['session-a-seed'], entities['session-a-required'], 'supported-by', now),
    relation('session-b', entities['session-b-seed'], entities['session-b-required'], 'supported-by', now),
  ];
  for (const value of relationSpecs) await current.graphStore.upsertRelation(value);

  const atomSpecs = [
    atom('global-seed', entities['global-feature'], 'aurora rollout policy', 'Execute the Aurora rollout policy.', ['aurora rollout policy']),
    atom('global-required', entities['global-required'], 'signed checksum gate', 'The signed checksum gate applies to Aurora before deployment.', ['aurora', 'signed checksum']),
    atom('global-unrelated', entities['global-unrelated'], 'neutral interface color', 'Use neutral gray for the interface.', ['interface color']),
    atom('global-similar', entities['global-similar'], 'aurora layout labels', 'Aurora layout labels use compact wording.', ['aurora', 'layout']),
    atom('global-expired', entities['global-expired'], 'aurora expired gate', 'Aurora once used an expired approval gate.', ['aurora', 'expired']),
    atom('global-weak', entities['global-weak'], 'aurora weak claim', 'Aurora has an untrusted weak dependency.', ['aurora', 'weak']),
    atom('global-disputed', entities['global-disputed'], 'aurora disputed claim', 'Aurora has a disputed dependency.', ['aurora', 'disputed']),
    atom('global-archived', entities['global-archived'], 'aurora archived claim', 'Aurora has an archived dependency.', ['aurora', 'archived']),
    atom('replacement-old', entities['replacement-old'], 'legacy protocol migration', 'Migrate the legacy protocol.', ['legacy protocol migration']),
    atom('replacement-new', entities['replacement-new'], 'replacement migration protocol', 'The migration now uses the replacement protocol.', ['migration', 'replacement protocol']),
    atom('conflict-left', entities['conflict-left'], 'atlas deployment decision', 'Use the Atlas deployment decision.', ['atlas deployment decision']),
    atom('conflict-right', entities['conflict-right'], 'atlas conflicting constraint', 'Atlas has a conflicting deployment constraint.', ['atlas', 'deployment constraint']),
    atom('project-a-seed', entities['project-a-seed'], 'project alpha release', 'Execute the Project Alpha release.', ['project alpha release']),
    atom('project-a-required', entities['project-a-required'], 'alpha project gate', 'Alpha requires a signed project gate.', ['alpha', 'project gate']),
    atom('project-b-seed', entities['project-b-seed'], 'project beta release', 'Execute the Project Beta release.', ['project beta release']),
    atom('project-b-required', entities['project-b-required'], 'beta project gate', 'Beta requires a separate project gate.', ['beta', 'project gate']),
    atom('session-a-seed', entities['session-a-seed'], 'session alpha task', 'Continue the Session Alpha task.', ['session alpha task']),
    atom('session-a-required', entities['session-a-required'], 'alpha session evidence', 'Alpha has supporting session evidence.', ['alpha', 'session evidence']),
    atom('session-b-seed', entities['session-b-seed'], 'session beta task', 'Continue the Session Beta task.', ['session beta task']),
    atom('session-b-required', entities['session-b-required'], 'beta session evidence', 'Beta has separate session evidence.', ['beta', 'session evidence']),
  ];
  const ids = {};
  for (const spec of atomSpecs) {
    const result = await current.write(spec.intent);
    assert.equal(result.decision, 'created', `Fixture atom ${spec.key} was not created: ${result.decision}`);
    assert(result.node?.id, `Fixture atom ${spec.key} has no persisted id.`);
    ids[spec.key] = result.node.id;
  }

  const cases = [
    testCase('dependency', ids['global-seed'], 'long-term', [{ scope: 'global' }], 'aurora rollout policy',
      [ids['global-required']], [ids['global-seed'], ids['global-required']],
      [ids['global-unrelated'], ids['global-similar'], ids['global-expired'], ids['global-weak'], ids['global-disputed'], ids['global-archived']]),
    testCase('replacement-inverse', ids['replacement-old'], 'long-term', [{ scope: 'global' }], 'legacy protocol migration',
      [ids['replacement-new']], [ids['replacement-old'], ids['replacement-new']], []),
    testCase('replacement-forward-blocked', ids['replacement-new'], 'long-term', [{ scope: 'global' }], 'replacement migration protocol',
      [], [ids['replacement-new']], [ids['replacement-old']]),
    testCase('conflict-outbound', ids['conflict-left'], 'long-term', [{ scope: 'global' }], 'atlas deployment decision',
      [ids['conflict-right']], [ids['conflict-left'], ids['conflict-right']], []),
    testCase('conflict-inbound', ids['conflict-right'], 'long-term', [{ scope: 'global' }], 'atlas conflicting constraint',
      [ids['conflict-left']], [ids['conflict-right'], ids['conflict-left']], []),
    testCase('project-scope', ids['project-a-seed'], 'project', [{ scope: 'project', scopeKey: 'project-a' }], 'project alpha release',
      [ids['project-a-required']], [ids['project-a-seed'], ids['project-a-required']], [ids['project-b-seed'], ids['project-b-required']]),
    testCase('session-scope', ids['session-a-seed'], 'daily', [{ scope: 'session', scopeKey: 'session-a' }], 'session alpha task',
      [ids['session-a-required']], [ids['session-a-seed'], ids['session-a-required']], [ids['session-b-seed'], ids['session-b-required']]),
  ];
  return {
    ids,
    cases,
    atomCount: atomSpecs.length,
    entityCount: entitySpecs.length,
    relationCount: relationSpecs.length,
  };
}

async function runCases(current, fixture) {
  const details = [];
  for (const test of fixture.cases) {
    const restore = forceDirectSeed(current, test.seedAtomId);
    try {
      const candidates = await current.indexMemory({
        branch: test.branch,
        scopes: test.scopes,
        query: test.query,
        limit: 20,
        now: '2026-07-17T06:30:00.000Z',
      });
      const selected = candidates.map((candidate) => ({
        id: candidate.atom.id,
        path: candidate.retrievalPath,
        relationType: candidate.envelope.relationRoute?.relationType,
        direction: candidate.envelope.relationRoute?.direction,
      }));
      const ids = selected.map((item) => item.id);
      const missing = test.required.filter((id) => !ids.includes(id));
      const unexpected = ids.filter((id) => !test.allowed.includes(id));
      const forbidden = ids.filter((id) => test.forbidden.includes(id));
      const badRelationPath = test.required.filter((id) => selected.find((item) => item.id === id)?.path !== 'relation');
      const scopeLeaks = forbidden;
      details.push({
        phase: current.closed ? 'closed' : 'open',
        id: test.id,
        selected,
        missing,
        unexpected,
        forbidden,
        badRelationPath,
        scopeLeaks,
        passed: missing.length === 0 && unexpected.length === 0 && forbidden.length === 0 && badRelationPath.length === 0,
      });
    } finally {
      restore();
    }
  }
  return details.map((detail) => ({ ...detail, phase: 'verified' }));
}

async function verifyInitialInjection(current, fixture) {
  const test = fixture.cases.find((item) => item.id === 'dependency');
  assert(test, 'Missing dependency case for initial-injection verification.');
  const restore = forceDirectSeed(current, test.seedAtomId);
  try {
    const repository = {
      indexPath: current.indexPath,
      retrieval: {
        supported: true,
        indexMemory: (request) => current.indexMemory(request),
        retrieveMemory: (request) => current.retrieveMemory(request),
        recordAccess: (records) => current.recordMemoryAccess(records),
      },
    };
    const tree = new MemoryTree({
      rootIndexMaxChars: 1_600,
      totalRunTokenBudget: 3_200,
      perBranchTokenBudget: 1_200,
    });
    tree.register(new TreeMemoryBranch({
      repository,
      kind: 'long-term',
      displayName: 'Long-term Memory',
      purpose: 'Relationship-routing acceptance.',
      whenToUse: 'the task needs a verified dependency',
      searchHints: ['dependency'],
    }));
    const runId = 'relationship-routing-initial-injection';
    tree.beginRun({
      runId,
      sessionId: 'relationship-routing-session',
      query: test.query,
      recentHistory: [],
      workspace: dataDir,
      now: new Date('2026-07-17T06:30:00.000Z'),
    });
    const primed = await tree.prime(runId, { query: test.query, maxAtoms: 2, tokenBudget: 600 });
    tree.finishRun(runId);
    const selected = primed.fragments.map((fragment) => ({
      id: fragment.id,
      path: fragment.evidence?.retrievalPath,
      relationType: fragment.evidence?.relationRoute?.relationType,
    }));
    assert(selected.some((item) => item.id === fixture.ids['global-required'] && item.path === 'relation'),
      `Required dependency did not enter initial Context through relation routing: ${JSON.stringify(selected)}`);
    return { selected, tokensUsed: primed.tokensUsed };
  } finally {
    restore();
  }
}

function forceDirectSeed(current, atomId) {
  const entry = current.catalog.getAtom(atomId);
  assert(entry, `Missing seed catalog entry: ${atomId}`);
  const searchFts = current.catalog.searchFts;
  const listAtoms = current.catalog.listAtoms;
  current.catalog.searchFts = () => [{ entry, score: 1, matchReason: 'fts' }];
  current.catalog.listAtoms = () => [entry];
  return () => {
    current.catalog.searchFts = searchFts;
    current.catalog.listAtoms = listAtoms;
  };
}

function testCase(id, seedAtomId, branch, scopes, query, required, allowed, forbidden) {
  return { id, seedAtomId, branch, scopes, query, required, allowed, forbidden };
}

function entity(id, scope, scopeKey, now) {
  return {
    version: 1,
    id: `entity:${id}`,
    type: 'concept',
    owner: { kind: 'agent', id: 'ls' },
    scope,
    scopeKey,
    externalKey: `${scope}:${scopeKey ?? 'global'}:${id}`,
    label: id,
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function relation(id, from, to, type, now) {
  return {
    version: 1,
    id: `relation:${id}`,
    fromEntityId: from.id,
    toEntityId: to.id,
    type,
    scope: from.scope,
    scopeKey: from.scopeKey,
    source: { kind: 'tool', id: 'relationship-routing-acceptance' },
    sourceRefs: [],
    evidenceRefs: [`tool:relationship-routing:${id}`],
    confidence: 0.9,
    authorityScope: { kind: 'tool-evidence', scope: from.scope, scopeKey: from.scopeKey, topics: ['relationship-routing'] },
    relevance: 0.9,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function atom(key, linkedEntity, summary, content, retrievalKeys) {
  const branch = linkedEntity.scope === 'project'
    ? 'project'
    : linkedEntity.scope === 'session'
      ? 'daily'
      : 'long-term';
  return {
    key,
    intent: {
      id: `fixture:${key}`,
      branch,
      parentNodeId: `${branch}:root`,
      scope: linkedEntity.scope,
      scopeKey: linkedEntity.scopeKey,
      tier: InjectionTier.T2_RELEVANT,
      summary,
      content,
      retrievalKeys,
      sourceRunId: 'relationship-routing-acceptance',
      sourceStage: 'tool',
      importance: 0.8,
      confidence: 0.9,
      reason: 'Memory v3 relationship-routing acceptance fixture.',
      epistemic: {
        domain: linkedEntity.scope === 'project' ? 'project' : linkedEntity.scope === 'session' ? 'session' : 'knowledge',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: linkedEntity.scope, scopeKey: linkedEntity.scopeKey, topics: ['relationship-routing'] },
        assertedBy: { kind: 'tool', id: 'relationship-routing-acceptance' },
        evidenceRefs: [`tool:relationship-routing:${key}`],
        entityRefs: [linkedEntity.id],
        relationRefs: [],
      },
    },
  };
}

function assertIsolatedRoot(value) {
  const base = resolve(tmpdir());
  const target = resolve(value);
  assert(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`), `Unsafe temporary root: ${target}`);
  assert(target.includes('littlesheep-memory-v3-relationship-routing-'), `Unexpected temporary root: ${target}`);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
