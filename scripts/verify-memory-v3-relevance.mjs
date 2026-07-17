import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_BRANCH_SPECS,
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
import { createMemoryV3RelevanceFixture } from './lib/memory-v3-relevance-fixtures.mjs';

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-relevance-'));
assertIsolatedRoot(dataDir);
const workspaceA = join(dataDir, 'workspace-alpha');
const workspaceB = join(dataDir, 'workspace-beta');
await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true })]);

let repository;
let baseEngine;
let report;
let failure;
let blockedNetworkAttempts = 0;
const originalFetch = globalThis.fetch;
const rssBefore = process.memoryUsage().rss;

try {
  const modelRootDir = await resolveEmbeddingModelRoot(args.modelRoot);
  const verification = await verifyLocalEmbeddingModel(args.model, modelRootDir);
  if (!verification.available) {
    throw new Error(`Local model is incomplete: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the Memory v3 relevance acceptance.');
  };

  baseEngine = new LocalTransformersEmbeddingEngine({
    model: args.model,
    modelRootDir,
    batchSize: args.embeddingBatch,
  });
  const embeddingStats = { calls: 0, queryCalls: 0, documentCalls: 0, texts: 0, durationMs: 0 };
  const embeddingEngine = {
    descriptor: baseEngine.descriptor,
    isAvailable: () => baseEngine.isAvailable(),
    async embed(request) {
      const callStartedAt = performance.now();
      embeddingStats.calls += 1;
      embeddingStats.texts += request.texts.length;
      if (request.purpose === 'query') embeddingStats.queryCalls += 1;
      else embeddingStats.documentCalls += 1;
      try {
        return await baseEngine.embed(request);
      } finally {
        embeddingStats.durationMs += performance.now() - callStartedAt;
      }
    },
  };

  await createMemoryV3ExperimentMarker(dataDir);
  repository = new MemoryRepository({
    dataDir,
    backend: 'v3',
    v3: { embeddingEngine, maxEmbeddingBatchSize: args.embeddingBatch },
  });
  await repository.initialize();
  const tree = new MemoryTree({ rootIndexMaxChars: 1_600, totalRunTokenBudget: 3_200, perBranchTokenBudget: 1_200 });
  for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
  const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
  const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 1_600 });
  const fixture = createMemoryV3RelevanceFixture(workspaceA, workspaceB);
  const writes = await service.writeMany(fixture.atoms);
  const nonCreatedWrites = writes.filter((item) => item.decision !== 'created');
  assert.equal(
    nonCreatedWrites.length,
    0,
    `Relevance fixtures must remain separate atoms: ${JSON.stringify(nonCreatedWrites)}`,
  );
  const atomIdsByFixtureId = new Map(writes.map((item) => [item.intentId, item.node?.id]));
  for (const fixtureAtom of fixture.atoms) {
    assert(atomIdsByFixtureId.get(fixtureAtom.id), `Missing persisted atom id for fixture ${fixtureAtom.id}.`);
  }

  const d1QueryCallsBefore = embeddingStats.queryCalls;
  const d1Details = [];
  for (const [index, testCase] of fixture.d1Cases.entries()) {
    const runId = `stage9-d1-${index}`;
    const start = await service.beginRun({
      runId,
      sessionId: `stage9-session-d1-${index}`,
      query: testCase.query,
      recentHistory: [],
      workspace: testCase.workspace,
    });
    const atomIds = start.initialContext?.atomIds ?? [];
    const expectedAtomId = testCase.expected ? atomIdsByFixtureId.get(testCase.expected) : undefined;
    const allowedAtomIds = testCase.allowed.map((fixtureId) => atomIdsByFixtureId.get(fixtureId));
    const rank = expectedAtomId ? atomIds.indexOf(expectedAtomId) + 1 : 0;
    const unexpected = atomIds.filter((atomId) => !allowedAtomIds.includes(atomId));
    const tokens = (start.initialContext?.fragments ?? []).reduce((sum, fragment) => sum + fragment.tokenEstimate, 0);
    d1Details.push({
      id: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      expectedAtomId,
      rank,
      atomIds,
      unexpected,
      tokens,
      passed: expectedAtomId ? rank > 0 && unexpected.length === 0 : atomIds.length === 0,
    });
    await service.finishRun(runId);
  }
  const d1QueryEmbeddingCalls = embeddingStats.queryCalls - d1QueryCallsBefore;

  const deepDetails = [];
  const deepQueryCallsBefore = embeddingStats.queryCalls;
  for (const [index, testCase] of fixture.deepSearchCases.entries()) {
    const runId = `stage9-deep-${index}`;
    await service.beginRun({
      runId,
      sessionId: `stage9-session-deep-${index}`,
      query: testCase.query,
      recentHistory: [],
      workspace: testCase.workspace,
      autoPrime: false,
    });
    const branchIndex = await service.branchIndex(runId, testCase.branch);
    assert(branchIndex.entries[0], `No D1 entry available for ${testCase.id}.`);
    await service.expand(runId, {
      branchId: testCase.branch,
      nodeId: MemoryRepository.branchRootId(testCase.branch),
      tokenBudget: 64,
      limit: 1,
    });
    const result = await service.deepSearch(runId, {
      branchId: testCase.branch,
      query: testCase.query,
      tokenBudget: 2_000,
      limit: 5,
    });
    const atomIds = result.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id);
    const expectedAtomId = atomIdsByFixtureId.get(testCase.expected);
    assert(expectedAtomId, `Missing expected atom id for ${testCase.id}.`);
    const rank = atomIds.indexOf(expectedAtomId) + 1;
    const scopeLeaks = result.fragments.filter((fragment) => {
      const scopeKey = fragment.evidence?.scopeKey;
      return scopeKey && scopeKey !== testCase.workspace;
    }).map((fragment) => fragment.evidence?.atomId ?? fragment.id);
    deepDetails.push({
      id: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      expectedAtomId,
      rank,
      top5: atomIds,
      paths: result.fragments.map((fragment) => fragment.evidence?.retrievalPath),
      taskRelevance: result.fragments.map((fragment) => round(fragment.evidence?.taskRelevance ?? 0)),
      scopeLeaks,
      tokens: result.tokensUsed,
      passed: rank > 0 && rank <= 3 && scopeLeaks.length === 0,
    });
    await service.finishRun(runId);
  }
  const deepQueryEmbeddingCalls = embeddingStats.queryCalls - deepQueryCallsBefore;

  const d1 = summarizeD1(d1Details, d1QueryEmbeddingCalls);
  const deepSearch = summarizeDeep(deepDetails, deepQueryEmbeddingCalls);
  const failures = evaluateThresholds(
    d1,
    deepSearch,
    blockedNetworkAttempts,
    fixture.deepSearchCases.length,
    args,
  );
  report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    model: {
      id: args.model,
      descriptor: embeddingEngine.descriptor,
      assetBytes: verification.totalBytes,
    },
    corpus: {
      atoms: fixture.atoms.length,
      d1Cases: fixture.d1Cases.length,
      deepSearchCases: fixture.deepSearchCases.length,
    },
    d1,
    deepSearch,
    embedding: {
      ...embeddingStats,
      durationMs: round(embeddingStats.durationMs),
      blockedNetworkAttempts,
    },
    resources: {
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      durationMs: round(performance.now() - startedAt),
    },
    failures,
    details: { d1: d1Details, deepSearch: deepDetails },
  };
} catch (error) {
  failure = error;
} finally {
  try { await repository?.shutdown(); } catch (error) { failure ??= error; }
  try { await baseEngine?.dispose(); } catch (error) { failure ??= error; }
  globalThis.fetch = originalFetch;
  if (!args.keep) {
    try { await rm(dataDir, { recursive: true, force: true }); } catch (error) { failure ??= error; }
  }
}

if (report) {
  const json = `${JSON.stringify({ ...report, isolatedDataRootRetained: args.keep ? dataDir : undefined }, null, 2)}\n`;
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, json, 'utf8');
  }
  process.stdout.write(json);
  if (!report.ok) failure ??= new Error(`Memory v3 relevance acceptance failed: ${report.failures.join('; ')}`);
}
if (failure) throw failure;

function summarizeD1(details, queryEmbeddingCalls) {
  const positives = details.filter((item) => item.expected);
  const negatives = details.filter((item) => !item.expected);
  return {
    recallAt1: ratio(positives.filter((item) => item.rank === 1).length, positives.length),
    recallAt2: ratio(positives.filter((item) => item.rank > 0 && item.rank <= 2).length, positives.length),
    positivePassRate: ratio(positives.filter((item) => item.passed).length, positives.length),
    negativePassRate: ratio(negatives.filter((item) => item.passed).length, negatives.length),
    unexpectedAtoms: details.reduce((sum, item) => sum + item.unexpected.length, 0),
    averageTokens: round(average(details.map((item) => item.tokens))),
    maxTokens: Math.max(0, ...details.map((item) => item.tokens)),
    queryEmbeddingCalls,
  };
}

function summarizeDeep(details, queryEmbeddingCalls) {
  return {
    recallAt1: ratio(details.filter((item) => item.rank === 1).length, details.length),
    recallAt3: ratio(details.filter((item) => item.rank > 0 && item.rank <= 3).length, details.length),
    meanReciprocalRank: round(average(details.map((item) => item.rank > 0 ? 1 / item.rank : 0))),
    passRate: ratio(details.filter((item) => item.passed).length, details.length),
    scopeLeaks: details.reduce((sum, item) => sum + item.scopeLeaks.length, 0),
    averageTokens: round(average(details.map((item) => item.tokens))),
    maxTokens: Math.max(0, ...details.map((item) => item.tokens)),
    queryEmbeddingCalls,
  };
}

function evaluateThresholds(d1, deepSearch, blockedNetworkAttempts, expectedDeepQueryCalls, options) {
  const failures = [];
  if (d1.recallAt1 < options.d1RecallAt1) failures.push(`D1 Recall@1 ${d1.recallAt1} < ${options.d1RecallAt1}`);
  if (d1.recallAt2 < 1) failures.push(`D1 Recall@2 ${d1.recallAt2} < 1`);
  if (d1.negativePassRate < 1) failures.push(`D1 negative pass ${d1.negativePassRate} < 1`);
  if (d1.unexpectedAtoms !== 0) failures.push(`D1 unexpected atoms ${d1.unexpectedAtoms} != 0`);
  if (d1.queryEmbeddingCalls !== 0) failures.push(`D1 query embedding calls ${d1.queryEmbeddingCalls} != 0`);
  if (deepSearch.recallAt1 < options.deepRecallAt1) failures.push(`Deep Recall@1 ${deepSearch.recallAt1} < ${options.deepRecallAt1}`);
  if (deepSearch.recallAt3 < options.deepRecallAt3) failures.push(`Deep Recall@3 ${deepSearch.recallAt3} < ${options.deepRecallAt3}`);
  if (deepSearch.scopeLeaks !== 0) failures.push(`Deep scope leaks ${deepSearch.scopeLeaks} != 0`);
  if (deepSearch.queryEmbeddingCalls !== expectedDeepQueryCalls) {
    failures.push(`Deep query embedding calls ${deepSearch.queryEmbeddingCalls} != ${expectedDeepQueryCalls}`);
  }
  if (blockedNetworkAttempts !== 0) failures.push(`Blocked network attempts ${blockedNetworkAttempts} != 0`);
  return failures;
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
    d1RecallAt1: 0.75,
    deepRecallAt1: 0.6,
    deepRecallAt3: 0.9,
    output: undefined,
    keep: false,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--model=')) options.model = value.slice('--model='.length);
    else if (value.startsWith('--model-root=')) options.modelRoot = resolve(value.slice('--model-root='.length));
    else if (value.startsWith('--embedding-batch=')) options.embeddingBatch = integer(value, '--embedding-batch=', 1, 128);
    else if (value.startsWith('--d1-recall-at1=')) options.d1RecallAt1 = fraction(value, '--d1-recall-at1=');
    else if (value.startsWith('--deep-recall-at1=')) options.deepRecallAt1 = fraction(value, '--deep-recall-at1=');
    else if (value.startsWith('--deep-recall-at3=')) options.deepRecallAt3 = fraction(value, '--deep-recall-at3=');
    else if (value.startsWith('--output=')) options.output = resolve(value.slice('--output='.length));
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

function fraction(value, prefix) {
  const parsed = Number(value.slice(prefix.length));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${prefix.slice(2, -1)} must be between 0 and 1.`);
  }
  return parsed;
}

function ratio(value, total) { return total === 0 ? 1 : round(value / total); }
function average(values) { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function round(value) { return Math.round(value * 10_000) / 10_000; }

function assertIsolatedRoot(value) {
  const base = resolve(tmpdir());
  const target = resolve(value);
  assert(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`), `Unsafe temporary root: ${target}`);
  assert(target.includes('littlesheep-memory-v3-relevance-'), `Unexpected temporary root: ${target}`);
}
