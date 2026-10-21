// R4-B4 tests: denominator discipline, ledger/ report generation, overwrite
// refusal, controlled-vs-real separation and legacy exclusion from V2 rates.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeMetrics, rateSummary } from '../scripts/lib/r4b/metrics.mjs';
import { buildRecord } from '../scripts/lib/r4b/record.mjs';
import { loadTaskSuite } from '../scripts/lib/r4b/tasks.mjs';
import { buildBatchLedger, readLegacyDisplayRows, renderReport, writeReportFile } from '../scripts/lib/r4b/report.mjs';
import { writeLedgerAtomic } from '../scripts/lib/r4b/ledger.mjs';

const loaded = loadTaskSuite();
const tempRoots = [];
afterAll(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ls-v2-b4-'));
  tempRoots.push(dir);
  return dir;
}

function dimension(status, extra = {}) {
  return { status, evidenceRefs: ['workspace://fixture#sha256=deadbeef'], rejectionReasons: [], missingFields: [], ...extra };
}

const baseObservation = (taskId, dimensions) => ({
  schemaVersion: 2,
  taskId,
  taskVersion: '2.0.0',
  observation: {
    dimensions,
    files: [],
    successfulExecutions: 0,
    duplicateSuccessfulEffects: 0,
    modelConfig: { providerId: 'scripted', simulated: true, wireModelId: null, apiProtocol: null, parameters: {} },
    runtime: {
      infrastructureStatus: 'executed',
      startedAt: '2026-10-21T12:00:00.000Z',
      endedAt: '2026-10-21T12:00:01.000Z',
      durationMs: 1000,
      modelRequests: 2,
      toolProposals: 1,
      toolExecutions: 1,
      deniedToolCalls: 0,
      failedToolCalls: 0,
      settledEffects: 1,
    },
    safety: { networkPolicy: 'denied', agentNetworkRequests: 0, forbiddenRequests: 0, credentialsRedacted: true },
    cleanup: { attempted: true, succeeded: true, residuals: [] },
  },
});

function recordFor(taskId, trial, dimensions) {
  const task = loaded.tasks.find((entry) => entry.id === taskId);
  return buildRecord({
    loaded,
    task,
    trial,
    batchId: 'r4b-offline-2026-10-21',
    observation: baseObservation(taskId, dimensions),
    gitState: { sha: 'c12fb52e031d70c29f5781a4ea843ba474b2df6a', treeFingerprint: 'tree', dirty: false, sourceDirty: false, dirtyPaths: [] },
    evaluatorFingerprint: 'a'.repeat(64),
    contractSha256: 'b'.repeat(64),
    taskSuiteSha256: loaded.suiteSha256,
    command: `node scripts/eval-v2.mjs --run-controlled --task=${taskId} --trial=${trial}`,
  });
}

function buildPopulation() {
  return [
    recordFor('FILE-02-G', 1, { goal: dimension('passed'), contract: dimension('not_applicable'), mechanism: decisionNotExercised() }),
    recordFor('FILE-02-G', 2, { goal: dimension('passed'), contract: dimension('not_applicable'), mechanism: decisionNotExercised() }),
    recordFor('FILE-02-S', 1, { goal: dimension('passed'), contract: dimension('passed', { constraintVisible: true, constraintRef: '#/contracts/file02s' }), mechanism: decisionNotExercised() }),
    recordFor('FILE-02-S', 2, { goal: dimension('passed'), contract: dimension('failed', { constraintVisible: true, constraintRef: '#/contracts/file02s', rejectionReasons: ['field name total is missing'] }), mechanism: decisionNotExercised() }),
    recordFor('DELIV-01-G', 1, { goal: dimension('passed'), contract: dimension('not_applicable'), mechanism: decisionNotExercised() }),
    recordFor('DELIV-01-R', 1, { goal: dimension('passed'), contract: dimension('not_applicable'), mechanism: decisionPassed() }),
    recordFor('DELIV-01-R', 2, { goal: dimension('failed', { rejectionReasons: ['result.txt content mismatch'] }), contract: dimension('not_applicable'), mechanism: decisionFailed() }),
  ];
}

function decisionNotExercised() {
  return { status: 'not_exercised', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [] };
}
function decisionPassed() {
  return { status: 'passed', triggered: true, evidenceRefs: ['invocation://validation_failed:input_validation', 'invocation://succeeded'], rejectionReasons: [], missingFields: [] };
}
function decisionFailed() {
  return { status: 'failed', triggered: true, evidenceRefs: ['invocation://validation_failed:input_validation'], rejectionReasons: ['corrected execution did not happen'], missingFields: [] };
}

describe('V2 metrics denominators', () => {
  it('reports explicit effective samples and excludes unexercised/unverified states', () => {
    const metrics = computeMetrics(buildPopulation());
    expect(metrics.goal).toMatchObject({ n: 7, passed: 6, failed: 1 });
    expect(metrics.goal.denominatorId).toBe('A_runtime_deterministic:goal');
    expect(metrics.contract).toMatchObject({ n: 2, passed: 1, failed: 1 });
    expect(metrics.contract.excluded.not_applicable).toBe(5);
    expect(metrics.mechanism).toMatchObject({ n: 2, passed: 1, failed: 1 });
    expect(metrics.mechanism.excluded.not_exercised).toBe(5);
    expect(metrics.goal.populationClaim).toBe(false);
    expect(rateSummary(metrics.goal)).toContain('6/7');
    expect(rateSummary(metrics.contract)).toContain('1/2');
  });

  it('refuses to compute a rate across controlled and real-model tiers', () => {
    const records = buildPopulation();
    const mixed = { ...records[0], evidenceTier: 'B_real_model' };
    expect(() => computeMetrics([records[0], mixed])).toThrow(/MIXED_EVIDENCE_TIER/);
  });

  it('never lets the 16 historical invalid-model requests enter the V2 denominator', () => {
    const legacy = readLegacyDisplayRows();
    expect(legacy.controlledRows).toHaveLength(8);
    expect(legacy.attempts.length).toBeGreaterThanOrEqual(6);
    expect(legacy.invalidModelAttempts.length).toBeGreaterThanOrEqual(2);
    expect(legacy.invalidModelPhysicalRequests).toBe(16);
    expect(legacy.validModelAttempts.length).toBe(4);
    const metrics = computeMetrics(buildPopulation());
    expect(metrics.goal.n).toBe(7);
    expect(metrics.contract.n).toBe(2);
    expect(metrics.mechanism.n).toBe(2);
  });
});

describe('V2 ledger and report', () => {
  it('builds one validated ledger, refuses overwrite, and regenerates only on request', async () => {
    const dir = await tempDir();
    const path = join(dir, 'ledger.json');
    const records = buildPopulation();
    const legacy = readLegacyDisplayRows();
    const ledger = buildBatchLedger({ records, batchId: 'r4b-offline-2026-10-21', legacy });
    expect(ledger.legacy.mappedToDimensions).toBe(false);
    expect(ledger.legacy.denominatorId).toBe('legacy-frozen-s3b');
    const written = writeLedgerAtomic({ path, ledger, options: { tasks: loaded.tasks, computeMetrics } });
    expect(existsSync(written.path)).toBe(true);
    expect(() => writeLedgerAtomic({ path, ledger, options: { tasks: loaded.tasks, computeMetrics } }))
      .toThrow(/LEDGER_EXISTS/);
    const text = await readFile(path, 'utf8');
    expect(JSON.parse(text).records).toHaveLength(7);
    expect(() => writeLedgerAtomic({ path, ledger, options: { tasks: loaded.tasks, computeMetrics }, allowRegenerate: true })).not.toThrow();
  });

  it('renders the required sections, denominators, legacy separation and out-of-scope list', async () => {
    const records = buildPopulation();
    const legacy = readLegacyDisplayRows();
    const ledger = buildBatchLedger({ records, batchId: 'r4b-offline-2026-10-21', legacy });
    const report = renderReport({ ledger, legacy });
    expect(report).toContain('Goal 完成率');
    expect(report).toContain('Contract 遵循率');
    expect(report).toContain('Mechanism 已触发成功率');
    expect(report).toContain('A_runtime_deterministic:goal');
    expect(report).toContain('legacy-frozen-s3b');
    expect(report).toContain('不进入任何 V2 trial 分母');
    expect(report).toContain('错误模型 ID');
    expect(report).toContain('明确未运行');
    expect(report).toContain('真实付费 Provider');
    expect(report).toContain('Electron GUI');
    expect(report).toContain('WSL');
    expect(report).toContain('populationClaim');
    expect(report).toContain('| FILE-02-S | 1 |');
    const dir = await tempDir();
    const path = join(dir, 'report.md');
    writeReportFile({ path, content: report });
    expect(existsSync(path)).toBe(true);
    expect(() => writeReportFile({ path, content: report })).toThrow(/REPORT_EXISTS/);
    expect(() => writeReportFile({ path, content: report, force: true })).not.toThrow();
  });
});
