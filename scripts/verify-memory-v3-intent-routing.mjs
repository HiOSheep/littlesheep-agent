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
  composeMemoryTaskQuery,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import {
  LocalTransformersEmbeddingEngine,
  verifyLocalEmbeddingModel,
} from '../packages/embedding/dist/index.js';
import { createMemoryV3IntentRoutingFixture } from './lib/memory-v3-intent-routing-fixtures.mjs';

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-intent-routing-'));
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
    throw new Error('Network access is forbidden during the Memory v3 intent-routing acceptance.');
  };

  baseEngine = new LocalTransformersEmbeddingEngine({
    model: args.model,
    modelRootDir,
    batchSize: args.embeddingBatch,
  });
  const embedding = { calls: 0, queryCalls: 0, documentCalls: 0, texts: 0, durationMs: 0 };
  const embeddingEngine = {
    descriptor: baseEngine.descriptor,
    isAvailable: () => baseEngine.isAvailable(),
    async embed(request) {
      const callStartedAt = performance.now();
      embedding.calls += 1;
      embedding.texts += request.texts.length;
      if (request.purpose === 'query') embedding.queryCalls += 1;
      else embedding.documentCalls += 1;
      try {
        return await baseEngine.embed(request);
      } finally {
        embedding.durationMs += performance.now() - callStartedAt;
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
  const fixture = createMemoryV3IntentRoutingFixture(workspaceA, workspaceB);
  const writes = await service.writeMany(fixture.atoms);
  const nonCreatedWrites = writes.filter((item) => item.decision !== 'created');
  assert.equal(nonCreatedWrites.length, 0, `Intent-routing fixtures merged unexpectedly: ${JSON.stringify(nonCreatedWrites)}`);
  const atomIds = new Map(writes.map((item) => [item.intentId, item.node?.id]));

  const d1QueryCallsBefore = embedding.queryCalls;
  const d1Details = [];
  for (const [index, testCase] of fixture.d1Cases.entries()) {
    const taskQuery = composeMemoryTaskQuery(testCase.query, testCase.history);
    const runId = `stage11-d1-${index}`;
    const start = await service.beginRun({
      runId,
      sessionId: `stage11-session-d1-${index}`,
      query: testCase.query,
      recentHistory: testCase.history,
      workspace: testCase.workspace,
    });
    const selected = start.initialContext?.atomIds ?? [];
    const required = resolveIds(atomIds, testCase.required);
    const allowed = resolveIds(atomIds, testCase.allowed);
    const forbidden = resolveIds(atomIds, testCase.forbidden);
    const missing = required.filter((atomId) => !selected.includes(atomId));
    const forbiddenHits = selected.filter((atomId) => forbidden.includes(atomId));
    const unexpected = selected.filter((atomId) => !allowed.includes(atomId));
    d1Details.push({
      id: testCase.id,
      selected,
      required,
      missing,
      forbiddenHits,
      unexpected,
      historyUsed: taskQuery.historyUsed,
      historyMessageCount: taskQuery.historyMessageCount,
      exclusions: taskQuery.excludedPhrases,
      retrievalChars: taskQuery.retrievalText.length,
      passed: missing.length === 0 && forbiddenHits.length === 0 && unexpected.length === 0,
    });
    await service.finishRun(runId);
  }
  const d1QueryEmbeddingCalls = embedding.queryCalls - d1QueryCallsBefore;

  const deepQueryCallsBefore = embedding.queryCalls;
  const deepDetails = [];
  for (const [index, testCase] of fixture.deepSearchCases.entries()) {
    const runId = `stage11-deep-${index}`;
    await service.beginRun({
      runId,
      sessionId: `stage11-session-deep-${index}`,
      query: testCase.query,
      recentHistory: [],
      workspace: testCase.workspace,
      autoPrime: false,
    });
    const indexResult = await service.branchIndex(runId, testCase.branch);
    assert(indexResult.entries[0], `No D1 entry available for ${testCase.id}.`);
    const opened = await service.expand(runId, {
      branchId: testCase.branch,
      nodeId: MemoryRepository.branchRootId(testCase.branch),
      query: testCase.query,
      tokenBudget: 96,
      limit: 1,
    });
    if (opened.fragments.length > 0) {
      await service.release(runId, opened.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id));
    }
    const result = await service.deepSearch(runId, {
      branchId: testCase.branch,
      query: testCase.query,
      tokenBudget: 2_000,
      limit: 5,
    });
    const selected = result.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id);
    const required = resolveIds(atomIds, testCase.required);
    const forbidden = resolveIds(atomIds, testCase.forbidden);
    const missing = required.filter((atomId) => !selected.includes(atomId));
    const forbiddenHits = selected.filter((atomId) => forbidden.includes(atomId));
    const unexpected = selected.filter((atomId) => !required.includes(atomId));
    const scopeLeaks = result.fragments.filter((fragment) => {
      const scopeKey = fragment.evidence?.scopeKey;
      return scopeKey && scopeKey !== testCase.workspace;
    }).map((fragment) => fragment.evidence?.atomId ?? fragment.id);
    deepDetails.push({
      id: testCase.id,
      selected,
      required,
      missing,
      forbiddenHits,
      unexpected,
      scopeLeaks,
      paths: result.fragments.map((fragment) => fragment.evidence?.retrievalPath),
      taskRelevance: result.fragments.map((fragment) => round(fragment.evidence?.taskRelevance ?? 0)),
      matchReasons: result.fragments.map((fragment) => fragment.matchReason),
      passed: missing.length === 0 && forbiddenHits.length === 0 && unexpected.length === 0 && scopeLeaks.length === 0,
    });
    await service.finishRun(runId);
  }
  const deepQueryEmbeddingCalls = embedding.queryCalls - deepQueryCallsBefore;

  const failures = [];
  for (const detail of d1Details) if (!detail.passed) failures.push(`D1 ${detail.id} failed`);
  for (const detail of deepDetails) if (!detail.passed) failures.push(`deep ${detail.id} failed`);
  if (d1QueryEmbeddingCalls !== 0) failures.push(`D1 query embedding calls ${d1QueryEmbeddingCalls} != 0`);
  if (deepQueryEmbeddingCalls !== fixture.deepSearchCases.length) {
    failures.push(`deep query embedding calls ${deepQueryEmbeddingCalls} != ${fixture.deepSearchCases.length}`);
  }
  if (blockedNetworkAttempts !== 0) failures.push(`blocked network attempts ${blockedNetworkAttempts} != 0`);
  const rssAfter = process.memoryUsage().rss;
  if (rssAfter > args.maxRssMiB * 1024 * 1024) failures.push(`RSS ${rssAfter} exceeds ${args.maxRssMiB} MiB`);

  report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    model: { id: args.model, descriptor: embeddingEngine.descriptor, assetBytes: verification.totalBytes },
    corpus: { atoms: fixture.atoms.length, d1Cases: fixture.d1Cases.length, deepSearchCases: fixture.deepSearchCases.length },
    d1: {
      passed: d1Details.filter((detail) => detail.passed).length,
      total: d1Details.length,
      queryEmbeddingCalls: d1QueryEmbeddingCalls,
    },
    deepSearch: {
      passed: deepDetails.filter((detail) => detail.passed).length,
      total: deepDetails.length,
      queryEmbeddingCalls: deepQueryEmbeddingCalls,
    },
    embedding: { ...embedding, durationMs: round(embedding.durationMs), blockedNetworkAttempts },
    resources: { rssBefore, rssAfter, durationMs: round(performance.now() - startedAt) },
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
  if (!report.ok) failure ??= new Error(`Memory v3 intent-routing acceptance failed: ${report.failures.join('; ')}`);
}
if (failure) throw failure;

function resolveIds(atomIds, fixtureIds) {
  return fixtureIds.map((fixtureId) => {
    const atomId = atomIds.get(fixtureId);
    assert(atomId, `Missing persisted atom for fixture ${fixtureId}.`);
    return atomId;
  });
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
    output: undefined,
    keep: false,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--model=')) options.model = value.slice('--model='.length);
    else if (value.startsWith('--model-root=')) options.modelRoot = resolve(value.slice('--model-root='.length));
    else if (value.startsWith('--embedding-batch=')) options.embeddingBatch = integer(value, '--embedding-batch=', 1, 128);
    else if (value.startsWith('--max-rss-mib=')) options.maxRssMiB = integer(value, '--max-rss-mib=', 128, 4_096);
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

function round(value) { return Math.round(value * 10_000) / 10_000; }

function assertIsolatedRoot(value) {
  const base = resolve(tmpdir());
  const target = resolve(value);
  assert(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`), `Unsafe temporary root: ${target}`);
  assert(target.includes('littlesheep-memory-v3-intent-routing-'), `Unexpected temporary root: ${target}`);
}
