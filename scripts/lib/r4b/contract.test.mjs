// R4-B1 contract tests: shape/runtime consistency, negative invariants, legacy
// read compatibility and frozen-baseline protection. All offline.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_SCHEMA_PATH, CONTRACT_STATUSES, CONTRACT_VERSION, CREDIBILITY_LEVELS, DIMENSION_NAMES,
  EVIDENCE_TIERS, FROZEN_BASELINES, GOAL_STATUSES, INFRASTRUCTURE_STATUSES, MECHANISM_STATUSES,
  REPO_ROOT, REQUIRED_DIMENSION_FIELDS, REQUIRED_LEDGER_FIELDS, REQUIRED_MECHANISM_FIELDS,
  REQUIRED_RECORD_FIELDS, SCHEMA_VERSION, SUITE_ID, TRIAL_MAX, TRIAL_MIN, assertEvaluationRecord,
  assertLedger, computeEvaluatorFingerprint, gitProductState, makeRecordId, parseRecordId,
  readLegacyRecords, sha256Text, validateEvaluationRecord, validateLedger, verifyFrozenBaselines,
} from './contract.mjs';

const schema = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(REPO_ROOT, CONTRACT_SCHEMA_PATH), 'utf8'));
const FILE02_G_TASK = { id: 'FILE-02-G', version: '2.0.0', contract: null, contractRef: null };
const FILE02_S_TASK = { id: 'FILE-02-S', version: '2.0.0', contract: { schema: true }, contractRef: '#/contracts/file02s' };
const DELIV_01_R_TASK = { id: 'DELIV-01-R', version: '2.0.0', contract: null, contractRef: null };

const tempRoots = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 2 });
});

function record(overrides = {}) {
  const taskId = overrides.taskId ?? 'FILE-02-G';
  const trial = overrides.trial ?? 1;
  const text = 'Read inventory.csv and create inventory-summary.json with total quantity 5 and items sorted by sku, preserving each quantity.';
  const base = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    recordId: makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId, trial }),
    batchId: 'r4b-offline-2026-10-21',
    taskId,
    taskVersion: '2.0.0',
    trial,
    evidenceTier: 'A_runtime_deterministic',
    ancestry: { taskId: 'FILE-02', relation: 'goal_only', frozenTaskSuiteSha256: FROZEN_BASELINES.s3aTaskSuite.sha256 },
    product: { sha: 'c12fb52e031d70c29f5781a4ea843ba474b2df6a', treeFingerprint: 'tree-fingerprint', dirty: false, sourceDirty: false, dirtyPaths: [] },
    evaluator: { fingerprint: 'a'.repeat(64), contractSha256: 'b'.repeat(64), taskSuiteSha256: 'c'.repeat(64), command: 'node scripts/eval-v2.mjs --run-controlled --task=FILE-02-G --trial=1' },
    modelConfig: { providerId: 'scripted', simulated: true, wireModelId: null, apiProtocol: null, parameters: {} },
    userGoal: { text, textSha256: sha256Text(text), constraintVersion: CONTRACT_VERSION },
    dimensions: {
      goal: { status: 'passed', evidenceRefs: ['file://inventory-summary.json#sha256=deadbeef'], rejectionReasons: [], missingFields: [] },
      contract: { status: 'not_applicable', evidenceRefs: [], rejectionReasons: [], missingFields: [] },
      mechanism: { status: 'not_exercised', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [] },
    },
    legacyOracle: null,
    providerUsage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null, reason: 'no authoritative receipt' },
    execution: {
      infrastructureStatus: 'executed',
      startedAt: '2026-10-21T12:00:00.000Z',
      endedAt: '2026-10-21T12:00:01.000Z',
      durationMs: 1000,
      requests: { logical: 3, physical: 0, retries: 0, blocked: 0, budget: 0 },
      tokens: { requestedMax: null, effectiveMax: null, observedInput: null, observedOutput: null },
      tooling: { proposals: 2, executed: 2, denied: 0, failed: 0 },
      effects: { settled: 1, duplicateSuccessful: 0, unknown: 0 },
    },
    safety: { networkPolicy: 'denied', agentNetworkRequests: 0, forbiddenRequests: 0, credentialsRedacted: true },
    credibility: { level: 'direct_evidence', missingFields: [] },
    cleanup: { attempted: true, succeeded: true, residuals: [] },
  };
  return { ...base, ...overrides, dimensions: { ...base.dimensions, ...(overrides.dimensions ?? {}) } };
}

function errorsOf(recordValue, options) {
  return validateEvaluationRecord(recordValue, options).errors.map((error) => error.code);
}

describe('V2 contract: schema and runtime stay consistent', () => {
  it('pins contract/schema versions and the evaluator contract document', () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(CONTRACT_VERSION).toBe('2.0.0');
    expect(SUITE_ID).toBe('LS-RCD-R4B-V2');
    expect(schema.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema.contractVersion).toBe(CONTRACT_VERSION);
    expect(schema.$defs.record.properties.schemaVersion.const).toBe(SCHEMA_VERSION);
    expect(schema.$defs.record.properties.contractVersion.const).toBe(CONTRACT_VERSION);
    expect(schema.$defs.record.required).toEqual([...REQUIRED_RECORD_FIELDS]);
    expect(schema.$defs.ledger.required).toEqual([...REQUIRED_LEDGER_FIELDS]);
    expect(schema.$defs.dimension.required).toEqual([...REQUIRED_DIMENSION_FIELDS]);
    expect(schema.$defs.mechanismDimension.required).toEqual([...REQUIRED_MECHANISM_FIELDS]);
    expect(schema.$defs.dimension.properties.status.enum).toEqual([...new Set([...GOAL_STATUSES, ...CONTRACT_STATUSES])]);
    expect(schema.$defs.mechanismDimension.properties.status.enum).toEqual([...MECHANISM_STATUSES]);
    expect(schema.$defs.record.properties.evidenceTier.enum).toEqual([...EVIDENCE_TIERS]);
    expect(schema.properties === undefined).toBe(true);
    expect(Array.isArray(schema['x-runtime-invariants'])).toBe(true);
    expect(schema['x-runtime-invariants'].length).toBeGreaterThanOrEqual(10);
    expect(schema.$defs.record.properties.execution.properties.infrastructureStatus.enum).toEqual([...INFRASTRUCTURE_STATUSES]);
    expect(schema.$defs.record.properties.credibility.properties.level.enum).toEqual([...CREDIBILITY_LEVELS]);
    expect(TRIAL_MIN).toBe(1);
    expect(TRIAL_MAX).toBe(5);
    expect(DIMENSION_NAMES).toEqual(['goal', 'contract', 'mechanism']);
  });

  it('recomputes the user-goal hash and rejects tampering', () => {
    const good = record();
    expect(validateEvaluationRecord(good, { task: FILE02_G_TASK }).valid).toBe(true);
    const tampered = { ...good, userGoal: { ...good.userGoal, textSha256: 'd'.repeat(64) } };
    expect(errorsOf(tampered, { task: FILE02_G_TASK })).toContain('user-goal-hash');
  });

  it('enforces record identity: taskId + trial are the unique identity', () => {
    expect(makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId: 'DELIV-01-R', trial: 5 }))
      .toBe('v2:r4b-offline-2026-10-21:DELIV-01-R:trial:5');
    expect(parseRecordId('v2:r4b-offline-2026-10-21:FILE-02-G:trial:4'))
      .toEqual({ batchId: 'r4b-offline-2026-10-21', taskId: 'FILE-02-G', trial: 4 });
    expect(parseRecordId('v2:r4b-offline-2026-10-21:FILE-02-G:trial:6')).toBeNull();
    expect(() => makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId: 'FILE-02-G', trial: 0 })).toThrow(/trial/);
    expect(() => makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId: 'FILE-02-G', trial: 6 })).toThrow(/trial/);
    const mismatched = { ...record(), trial: 2 };
    expect(errorsOf(mismatched, { task: FILE02_G_TASK })).toContain('record-id-trial');
    expect(errorsOf({ ...record(), taskId: 'FILE-02-S' }, { task: FILE02_S_TASK })).toContain('record-id-task');
  });
});

describe('V2 contract: missing or contradictory evidence is rejected', () => {
  it('rejects a goal pass without evidence or with unresolved gaps', () => {
    expect(errorsOf(record({ dimensions: { goal: { status: 'passed', evidenceRefs: [], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('passed-without-evidence');
    expect(errorsOf(record({ dimensions: { goal: { status: 'passed', evidenceRefs: ['x'], rejectionReasons: ['mismatch'], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('passed-with-rejection');
    expect(errorsOf(record({ dimensions: { goal: { status: 'passed', evidenceRefs: ['x'], rejectionReasons: [], missingFields: ['total'] } } }), { task: FILE02_G_TASK })).toContain('passed-with-missing');
    expect(errorsOf(record({ dimensions: { goal: { status: 'unverified', evidenceRefs: [], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('unverified-without-gap');
    expect(errorsOf(record({ dimensions: { goal: { status: 'failed', evidenceRefs: [], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('failed-without-reason');
  });

  it('rejects contract settlement that the model could not see', () => {
    const invisible = record({
      taskId: 'FILE-02-S',
      dimensions: {
        contract: { status: 'failed', evidenceRefs: ['x'], rejectionReasons: ['field name total missing'], missingFields: [], constraintVisible: false, constraintRef: '#/contracts/file02s' },
      },
    });
    expect(errorsOf(invisible, { task: FILE02_S_TASK })).toContain('contract-not-visible');
    const noRef = record({
      taskId: 'FILE-02-S',
      dimensions: { contract: { status: 'passed', evidenceRefs: ['x'], rejectionReasons: [], missingFields: [], constraintVisible: true } },
    });
    expect(errorsOf(noRef, { task: FILE02_S_TASK })).toContain('contract-ref');
    const mismatchedRef = record({
      taskId: 'FILE-02-S',
      dimensions: { contract: { status: 'passed', evidenceRefs: ['x'], rejectionReasons: [], missingFields: [], constraintVisible: true, constraintRef: '#/contracts/other' } },
    });
    expect(errorsOf(mismatchedRef, { task: FILE02_S_TASK })).toContain('contract-ref-mismatch');
    expect(errorsOf(record({ taskId: 'FILE-02-S' }), { task: FILE02_S_TASK })).toContain('contract-applicable');
    expect(errorsOf(record({ dimensions: { contract: { status: 'passed', evidenceRefs: ['x'], rejectionReasons: [], missingFields: [], constraintVisible: true, constraintRef: '#/contracts/file02s' } } }), { task: FILE02_G_TASK })).toContain('contract-not-applicable');
  });

  it('keeps mechanism states distinct: not_exercised != failed, blocked != failed', () => {
    expect(errorsOf(record({ dimensions: { mechanism: { status: 'not_exercised', triggered: true, evidenceRefs: [], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('mechanism-not-exercised-triggered');
    expect(errorsOf(record({ dimensions: { mechanism: { status: 'passed', triggered: false, evidenceRefs: ['x'], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('mechanism-status-triggered');
    expect(errorsOf(record({ dimensions: { mechanism: { status: 'blocked', triggered: true, evidenceRefs: ['x'], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK })).toContain('mechanism-blocked-reason');
    const passed = record({
      taskId: 'DELIV-01-R',
      dimensions: {
        mechanism: { status: 'passed', triggered: true, evidenceRefs: ['invocation://validation_failed'], rejectionReasons: [], missingFields: [] },
      },
    });
    expect(validateEvaluationRecord(passed, { task: DELIV_01_R_TASK }).valid).toBe(true);
    const duplicateEffect = record({
      taskId: 'DELIV-01-R',
      dimensions: { mechanism: { status: 'passed', triggered: true, evidenceRefs: ['x'], rejectionReasons: [], missingFields: [] } },
      execution: { ...record().execution, effects: { settled: 2, duplicateSuccessful: 1, unknown: 0 } },
    });
    expect(errorsOf(duplicateEffect, { task: DELIV_01_R_TASK })).toContain('duplicate-effects');
  });

  it('never turns harness problems, dirty cleanup or security violations into passes', () => {
    const harness = record({ execution: { ...record().execution, infrastructureStatus: 'harness_error' } });
    expect(errorsOf(harness, { task: FILE02_G_TASK })).toContain('infrastructure-claim');
    const cleanup = record({ cleanup: { attempted: true, succeeded: false, residuals: ['workspace'] } });
    expect(errorsOf(cleanup, { task: FILE02_G_TASK })).toEqual(expect.arrayContaining(['cleanup-infrastructure', 'cleanup-claim']));
    const security = record({
      safety: { networkPolicy: 'denied', agentNetworkRequests: 1, forbiddenRequests: 1, credentialsRedacted: true },
    });
    expect(errorsOf(security, { task: FILE02_G_TASK })).toContain('forbidden-request');
  });

  it('rejects budget overrun, inferred usage and aggregate verdicts', () => {
    const budget = record({ execution: { ...record().execution, requests: { logical: 1, physical: 3, retries: 0, blocked: 0, budget: 2 } } });
    expect(errorsOf(budget, { task: FILE02_G_TASK })).toContain('budget-exceeded');
    const usage = record({ providerUsage: { status: 'unavailable', inputTokens: 0, outputTokens: 0, cachedInputTokens: null, source: null, reason: 'none' } });
    expect(errorsOf(usage, { task: FILE02_G_TASK })).toContain('usage-unavailable-values');
    expect(errorsOf(record({ status: 'passed' }), { task: FILE02_G_TASK })).toContain('aggregate-verdict');
    expect(errorsOf(record({ result: 'passed' }), { task: FILE02_G_TASK })).toContain('aggregate-verdict');
  });

  it('rejects legacy mapping and fingerprint drift', () => {
    const mapped = record({ legacyOracle: { result: 'failed', oracleVersion: 'legacy', legacyMapped: true } });
    expect(errorsOf(mapped, { task: FILE02_G_TASK })).toContain('legacy-mapped');
    const fingerprint = record({ evaluator: { ...record().evaluator, fingerprint: 'e'.repeat(64) } });
    expect(errorsOf(fingerprint, { task: FILE02_G_TASK, expectedFingerprint: 'f'.repeat(64) })).toContain('evaluator-fingerprint');
  });
});

describe('V2 ledger validation', () => {
  function ledger(records) {
    const counts = { goal: 0, contract: 0, mechanism: 0 };
    for (const item of records) {
      for (const name of DIMENSION_NAMES) {
        if (item.dimensions[name].status === 'passed') counts[name] += 1;
        if (item.dimensions[name].status === 'failed') counts[name] += 1;
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      suiteId: SUITE_ID,
      batchId: 'r4b-offline-2026-10-21',
      generatedAt: '2026-10-21T12:00:02.000Z',
      evidenceTier: 'A_runtime_deterministic',
      records,
      metrics: {
        goal: { denominatorId: 'v2-controlled', n: counts.goal, passed: records.filter((r) => r.dimensions.goal.status === 'passed').length, failed: records.filter((r) => r.dimensions.goal.status === 'failed').length, excluded: {}, populationClaim: false },
        contract: { denominatorId: 'v2-controlled-contract', n: counts.contract, passed: records.filter((r) => r.dimensions.contract.status === 'passed').length, failed: records.filter((r) => r.dimensions.contract.status === 'failed').length, excluded: {}, populationClaim: false },
        mechanism: { denominatorId: 'v2-controlled-mechanism', n: 0, passed: 0, failed: 0, excluded: { not_exercised: 1 }, populationClaim: false },
        perTask: {},
      },
      legacy: { records: [], mappedToDimensions: false, denominatorId: 'legacy-frozen-s3b' },
    };
  }

  it('accepts a consistent ledger and recomputes metrics', () => {
    const good = ledger([record(), record({ recordId: makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId: 'FILE-02-G', trial: 2 }), trial: 2 })]);
    expect(validateLedger(good, { tasks: [FILE02_G_TASK, FILE02_S_TASK, DELIV_01_R_TASK] }).valid).toBe(true);
    expect(validateLedger(good, { tasks: [FILE02_G_TASK], computeMetrics: (records) => ({
      goal: { n: records.length, passed: records.length, failed: 0 },
      contract: { n: 0, passed: 0, failed: 0 },
      mechanism: { n: 0, passed: 0, failed: 0 },
    }) }).valid).toBe(true);
  });

  it('rejects duplicate task/trial identity and mixed evidence tiers', () => {
    const duplicate = ledger([record(), record()]);
    expect(validateLedger(duplicate, { tasks: [FILE02_G_TASK] }).errors.map((e) => e.code)).toContain('ledger-duplicate');
    const mixed = ledger([record(), record({ evidenceTier: 'B_real_model', trial: 2, recordId: makeRecordId({ batchId: 'r4b-offline-2026-10-21', taskId: 'FILE-02-G', trial: 2 }) })]);
    expect(validateLedger(mixed, { tasks: [FILE02_G_TASK] }).errors.map((e) => e.code)).toContain('ledger-tier-mixed');
  });

  it('rejects metrics that contradict the records and legacy mapping', () => {
    const bad = ledger([record()]);
    bad.metrics.goal.passed = 1;
    bad.metrics.goal.failed = 1;
    bad.metrics.goal.n = 2;
    expect(validateLedger(bad, { tasks: [FILE02_G_TASK], computeMetrics: (records) => ({
      goal: { n: records.length, passed: records.length, failed: 0 },
      contract: { n: 0, passed: 0, failed: 0 },
      mechanism: { n: 0, passed: 0, failed: 0 },
    }) }).errors.map((e) => e.code)).toContain('metric-mismatch');
    bad.legacy.mappedToDimensions = true;
    expect(validateLedger(bad, { tasks: [FILE02_G_TASK] }).errors.map((e) => e.code)).toContain('legacy-section');
  });
});

describe('V2 contract: evaluator fingerprint and frozen baselines', () => {
  it('computes a deterministic fingerprint over a frozen file list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-v2-fingerprint-'));
    tempRoots.push(root);
    await writeFile(join(root, 'a.mjs'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(root, 'b.json'), '{"b":2}\n', 'utf8');
    const first = computeEvaluatorFingerprint({ repoRoot: root, files: ['a.mjs', 'b.json'] });
    const second = computeEvaluatorFingerprint({ repoRoot: root, files: ['a.mjs', 'b.json'] });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
    await writeFile(join(root, 'b.json'), '{"b":3}\n', 'utf8');
    expect(computeEvaluatorFingerprint({ repoRoot: root, files: ['a.mjs', 'b.json'] })).not.toBe(first);
    expect(() => computeEvaluatorFingerprint({ repoRoot: root, files: ['missing.mjs'] })).toThrow(/EVALUATOR_FILE_MISSING/);
  });

  it('proves the S3A/S3B frozen files are untouched at this baseline', () => {
    const result = verifyFrozenBaselines();
    expect(result.valid, JSON.stringify(result.checks.filter((check) => !check.ok))).toBe(true);
    for (const [key, baseline] of Object.entries(FROZEN_BASELINES)) {
      expect(result.checks.find((check) => check.key === key).actual).toBe(baseline.sha256);
    }
  });

  it('reads the repository product state without claiming hash equality', () => {
    const state = gitProductState();
    expect(state.sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(state.treeFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(Array.isArray(state.dirtyPaths)).toBe(true);
  });
});

describe('V2 contract: legacy history is read-only and never mapped', () => {
  it('reads the controlled ledger and real-model batch as display-only rows', () => {
    const controlled = readLegacyRecords(resolve(REPO_ROOT, 'docs/reference/rcd-s3b-controlled-baseline-2026-10-17.json'));
    expect(controlled.schemaVersion).toBe(1);
    expect(controlled.records.length).toBeGreaterThan(0);
    expect(controlled.records.every((row) => row.displayOnly && row.mappedToDimensions === false)).toBe(true);
    expect(controlled.records.every((row) => row.oracleVersion === 'legacy-s3b-v1')).toBe(true);

    const batch = readLegacyRecords(resolve(REPO_ROOT, 'docs/reference/rcd-s3b-real-deepseek-batch-2026-10-17.json'));
    expect(batch.records.length).toBeGreaterThan(0);
    expect(batch.records.some((row) => row.evidenceTier === 'B_real_model')).toBe(true);
    expect(batch.records.every((row) => row.mappedToDimensions === false)).toBe(true);

    const single = readLegacyRecords(resolve(REPO_ROOT, 'docs/reference/rcd-s3b-real-deepseek-FILE-02-trial-2-2026-10-17.json'));
    expect(single.records).toHaveLength(1);
    expect(single.records[0].oracleResult).toBe('failed');
    expect(single.records[0].displayOnly).toBe(true);
  });

  it('keeps the frozen control-flow baseline hash stable for the RCD core entry', async () => {
    const { sha256File } = await import('./contract.mjs');
    const actual = sha256File(resolve(REPO_ROOT, FROZEN_BASELINES.rcdS0fCoreBaseline.path));
    expect(actual).toBe(FROZEN_BASELINES.rcdS0fCoreBaseline.sha256);
    expect(createHash('sha256').update(actual).digest('hex')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('V2 contract: assertion helpers surface structured errors', () => {
  it('throws with code and errors for invalid records and ledgers', () => {
    expect(() => assertEvaluationRecord(record({ dimensions: { goal: { status: 'passed', evidenceRefs: [], rejectionReasons: [], missingFields: [] } } }), { task: FILE02_G_TASK }))
      .toThrow(/Invalid V2 evaluation record/);
    try {
      const invalidTrial = record();
      invalidTrial.trial = 9;
      assertEvaluationRecord(invalidTrial, { task: FILE02_G_TASK });
    } catch (error) {
      expect(error.code).toBe('EVALUATION_RECORD_INVALID');
      expect(Array.isArray(error.errors)).toBe(true);
    }
  });
});
