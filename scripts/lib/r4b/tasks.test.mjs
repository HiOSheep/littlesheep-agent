// Structural tests for the versioned V2 task suite: frozen ancestry,
// contract visibility and dimension/fixture consistency are hard requirements.
import { describe, expect, it } from 'vitest';
import { loadTaskSuite, validateTaskSuite } from './tasks.mjs';
import { FROZEN_BASELINES, sha256Text } from './contract.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codesOf(suite) {
  return validateTaskSuite(suite).errors.map((error) => error.code);
}

describe('V2 task suite', () => {
  it('loads four tasks with frozen S3A ancestry and stable definitions', () => {
    const loaded = loadTaskSuite();
    expect(loaded.tasks.map((task) => task.id)).toEqual(['FILE-02-G', 'FILE-02-S', 'DELIV-01-G', 'DELIV-01-R']);
    expect(loaded.suiteSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.suite.frozenAncestry.s3aTaskSuite.sha256).toBe(FROZEN_BASELINES.s3aTaskSuite.sha256);
    for (const task of loaded.tasks) {
      expect(task.ancestry.frozenTaskSuiteSha256).toBe(FROZEN_BASELINES.s3aTaskSuite.sha256);
      const { taskDefinitionSha256, ...definition } = task;
      expect(taskDefinitionSha256).toBe(sha256Text(JSON.stringify(definition)));
      expect(taskDefinitionSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(loaded.tasks.find((task) => task.id === 'DELIV-01-R').faultFixture.kind).toBe('evaluator_driven_schema_invalid_first_proposal');
    expect(loaded.tasks.find((task) => task.id === 'FILE-02-S').contract.ref).toBe('#/contracts/file02s');
  });

  it('requires the contract text to be visible in the model-visible task input', () => {
    const suite = clone(loadTaskSuite().suite);
    const task = suite.tasks.find((entry) => entry.id === 'FILE-02-S');
    task.userInput = 'Create inventory-summary.json for inventory.csv.';
    expect(codesOf(suite)).toContain('task-contract-not-visible');
  });

  it('rejects a rewritten or missing frozen ancestry hash', () => {
    const suite = clone(loadTaskSuite().suite);
    suite.tasks[0].ancestry.frozenTaskSuiteSha256 = '0'.repeat(64);
    expect(codesOf(suite)).toContain('task-ancestry-hash');
    const suite2 = clone(loadTaskSuite().suite);
    suite2.frozenAncestry.s3aTaskSuite.sha256 = '1'.repeat(64);
    expect(codesOf(suite2)).toContain('suite-ancestry-hash');
  });

  it('rejects dimension flags that contradict the task definition', () => {
    const withContract = clone(loadTaskSuite().suite);
    withContract.tasks[1].dimensions.contract = false;
    expect(codesOf(withContract)).toContain('task-contract-flag');
    const noMechanism = clone(loadTaskSuite().suite);
    noMechanism.tasks[0].dimensions.mechanism = true;
    expect(codesOf(noMechanism)).toContain('task-mechanism-flag');
    const noFaultFixture = clone(loadTaskSuite().suite);
    noFaultFixture.tasks[3].faultFixture = null;
    expect(codesOf(noFaultFixture)).toContain('task-mechanism-flag');
  });

  it('rejects duplicate, missing and unknown tasks', () => {
    const duplicate = clone(loadTaskSuite().suite);
    duplicate.tasks[1].id = 'FILE-02-G';
    expect(codesOf(duplicate)).toContain('suite-duplicate');
    const missing = clone(loadTaskSuite().suite);
    missing.tasks.pop();
    expect(codesOf(missing)).toContain('suite-missing-task');
    const unknown = clone(loadTaskSuite().suite);
    unknown.tasks[0].id = 'FILE-99-X';
    const codes = codesOf(unknown);
    expect(codes).toContain('suite-missing-task');
    expect(codes).toContain('suite-unknown-task');
  });

  it('rejects unknown oracle modules, wrong schema version and wrong tier', () => {
    const oracle = clone(loadTaskSuite().suite);
    oracle.tasks[0].oracle.module = 'scripts/other.mjs';
    expect(codesOf(oracle)).toContain('task-oracle');
    const schema = clone(loadTaskSuite().suite);
    schema.schemaVersion = 1;
    expect(codesOf(schema)).toContain('suite-schema');
    const tier = clone(loadTaskSuite().suite);
    tier.evidenceTier = 'B_real_model';
    expect(codesOf(tier)).toContain('suite-tier');
  });
});
