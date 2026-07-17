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
import { createMemoryV3CompactionContinuityFixture } from './lib/memory-v3-compaction-continuity-fixtures.mjs';

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-compaction-continuity-'));
assertIsolatedRoot(dataDir);
const workspace = join(dataDir, 'workspace');
await mkdir(workspace, { recursive: true });

let runtime;
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
    throw new Error('Network access is forbidden during the Memory v3 compaction-continuity acceptance.');
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
  runtime = await createRuntime(dataDir, embeddingEngine, args.embeddingBatch);
  const fixture = createMemoryV3CompactionContinuityFixture('stage12-session-alpha', 'stage12-session-beta');
  const writes = await runtime.service.writeMany(fixture.atoms);
  const nonCreatedWrites = writes.filter((item) => item.decision !== 'created');
  assert.equal(nonCreatedWrites.length, 0, `Continuity fixtures merged unexpectedly: ${JSON.stringify(nonCreatedWrites)}`);
  const atomIds = new Map(writes.map((item) => [item.intentId, item.node?.id]));

  const beforeRestart = await runCases(runtime.service, fixture.cases, atomIds, workspace, 'before');
  await runtime.repository.shutdown();
  runtime = await createRuntime(dataDir, embeddingEngine, args.embeddingBatch);
  const afterRestart = await runCases(runtime.service, fixture.cases, atomIds, workspace, 'after');

  const failures = [];
  for (const detail of [...beforeRestart, ...afterRestart]) if (!detail.passed) failures.push(`${detail.phase}:${detail.id}`);
  if (embedding.queryCalls !== 0) failures.push(`D1 query embedding calls ${embedding.queryCalls} != 0`);
  if (blockedNetworkAttempts !== 0) failures.push(`blocked network attempts ${blockedNetworkAttempts} != 0`);
  const rssAfter = process.memoryUsage().rss;
  if (rssAfter > args.maxRssMiB * 1024 * 1024) failures.push(`RSS ${rssAfter} exceeds ${args.maxRssMiB} MiB`);

  report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    model: { id: args.model, descriptor: embeddingEngine.descriptor, assetBytes: verification.totalBytes },
    corpus: { atoms: fixture.atoms.length, cases: fixture.cases.length, passes: 2 },
    continuity: {
      passed: [...beforeRestart, ...afterRestart].filter((detail) => detail.passed).length,
      total: fixture.cases.length * 2,
      queryEmbeddingCalls: embedding.queryCalls,
    },
    embedding: { ...embedding, durationMs: round(embedding.durationMs), blockedNetworkAttempts },
    resources: { rssBefore, rssAfter, durationMs: round(performance.now() - startedAt) },
    failures,
    details: { beforeRestart, afterRestart },
  };
} catch (error) {
  failure = error;
} finally {
  try { await runtime?.repository.shutdown(); } catch (error) { failure ??= error; }
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
  if (!report.ok) failure ??= new Error(`Memory v3 compaction-continuity acceptance failed: ${report.failures.join('; ')}`);
}
if (failure) throw failure;

async function createRuntime(root, embeddingEngine, maxEmbeddingBatchSize) {
  const repository = new MemoryRepository({
    dataDir: root,
    backend: 'v3',
    v3: { embeddingEngine, maxEmbeddingBatchSize },
  });
  await repository.initialize();
  const tree = new MemoryTree({ rootIndexMaxChars: 1_600, totalRunTokenBudget: 3_200, perBranchTokenBudget: 1_200 });
  for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
  const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
  return {
    repository,
    service: new MemoryService({ tree, repository, writer, dataDir: root, rootIndexMaxChars: 1_600 }),
  };
}

async function runCases(service, cases, atomIds, workspace, phase) {
  const details = [];
  for (const [index, testCase] of cases.entries()) {
    const taskQuery = composeMemoryTaskQuery(testCase.query, testCase.history, {}, testCase.summary);
    const runId = `stage12-${phase}-${index}`;
    const start = await service.beginRun({
      runId,
      sessionId: testCase.sessionId,
      query: testCase.query,
      recentHistory: testCase.history,
      continuitySummary: testCase.summary,
      workspace,
    });
    const selected = start.initialContext?.atomIds ?? [];
    const required = resolveIds(atomIds, testCase.required);
    const allowed = resolveIds(atomIds, testCase.allowed);
    const forbidden = resolveIds(atomIds, testCase.forbidden);
    const missing = required.filter((atomId) => !selected.includes(atomId));
    const forbiddenHits = selected.filter((atomId) => forbidden.includes(atomId));
    const unexpected = selected.filter((atomId) => !allowed.includes(atomId));
    const summaryMismatch = taskQuery.summaryUsed !== testCase.summaryUsed;
    const ledgerReason = start.ledger.records.find((record) => record.action === 'branch_index')?.reason ?? '';
    const ledgerMismatch = taskQuery.summaryUsed
      ? !ledgerReason.includes(`summary=${testCase.summary.id}`)
      : ledgerReason.includes('summary=summary-');
    details.push({
      phase,
      id: testCase.id,
      selected,
      missing,
      forbiddenHits,
      unexpected,
      summaryUsed: taskQuery.summaryUsed,
      summaryChars: taskQuery.summaryChars,
      historyMessages: taskQuery.historyMessageCount,
      summaryMismatch,
      ledgerMismatch,
      passed: missing.length === 0 && forbiddenHits.length === 0 && unexpected.length === 0
        && !summaryMismatch && !ledgerMismatch,
    });
    await service.finishRun(runId);
  }
  return details;
}

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
  assert(target.includes('littlesheep-memory-v3-compaction-continuity-'), `Unexpected temporary root: ${target}`);
}
