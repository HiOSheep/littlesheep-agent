// End-to-end controlled-provider tests for the four V2 tasks, including
// negative variants that prove the oracles detect real defects. Gated behind
// V2_E2E=1 so the main verify:full suite does not spend minutes spawning eight
// child evaluator processes; `node scripts/eval-v2.mjs --verify` sets it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.V2_E2E === '1';
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const outputRoot = enabled ? mkdtempSync(join(tmpdir(), 'ls-v2-e2e-')) : '';
afterAll(() => { if (outputRoot) rmSync(outputRoot, { recursive: true, force: true, maxRetries: 2 }); });

const cases = [
  { task: 'FILE-02-G', variant: 'canonical', faultMode: 'none', expected: { goal: 'passed', contract: 'not_applicable', mechanism: 'not_exercised' } },
  { task: 'FILE-02-S', variant: 'canonical', faultMode: 'none', expected: { goal: 'passed', contract: 'passed', mechanism: 'not_exercised' } },
  { task: 'FILE-02-S', variant: 'wrong-field', faultMode: 'none', expected: { goal: 'passed', contract: 'failed', mechanism: 'not_exercised' } },
  { task: 'DELIV-01-G', variant: 'canonical', faultMode: 'none', expected: { goal: 'passed', contract: 'not_applicable', mechanism: 'not_exercised' } },
  { task: 'DELIV-01-R', variant: 'canonical', faultMode: 'inject', expected: { goal: 'passed', contract: 'not_applicable', mechanism: 'passed' } },
  { task: 'DELIV-01-R', variant: 'canonical', faultMode: 'none', expected: { goal: 'passed', contract: 'not_applicable', mechanism: 'not_exercised' } },
  { task: 'DELIV-01-R', variant: 'canonical', faultMode: 'no-recovery', expected: { goal: 'failed', contract: 'not_applicable', mechanism: 'failed' } },
  { task: 'DELIV-01-R', variant: 'canonical', faultMode: 'duplicate', expected: { goal: 'passed', contract: 'not_applicable', mechanism: 'passed' }, replayBlocked: true },
];

function run(task, variant, faultMode, trial = 1) {
  const caseDir = mkdtempSync(join(outputRoot, 'case-'));
  const args = [
    'scripts/eval-v2.mjs', '--run-controlled', `--task=${task}`, `--variant=${variant}`,
    `--fault-mode=${faultMode}`, `--trial=${trial}`, `--records-dir=${caseDir}`,
  ];
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`eval-v2 failed (${result.status}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

describe.skipIf(!enabled)('V2 controlled task suite (end to end)', () => {
  it.each(cases)('$task $variant/$faultMode settles $expected independently', (testCase) => {
    const summary = run(testCase.task, testCase.variant, testCase.faultMode);
    expect(summary.dimensions, JSON.stringify(summary)).toEqual(testCase.expected);
    expect(summary.cleanup.succeeded).toBe(true);
    expect(summary.recordPath).toBeTruthy();
    const record = JSON.parse(readFileSync(summary.recordPath, 'utf8'));
    expect(record.schemaVersion).toBe(2);
    expect(record.recordId).toBe(summary.recordId);
    expect(record.taskId).toBe(testCase.task);
    expect(record.trial).toBe(1);
    expect(record.safety.credentialsRedacted).toBe(true);
    expect(record.safety.forbiddenRequests).toBe(0);
    expect(record.modelConfig.simulated).toBe(true);
    expect(record.providerUsage.status).toBe('unavailable');
    expect(record.providerUsage.inputTokens).toBeNull();
    expect(record.cleanup.succeeded).toBe(true);
    expect(record.evaluator.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    if (testCase.replayBlocked) {
      // The product blocks the repeated side-effect replay; the oracle must
      // still see one successful execution and zero duplicate effects.
      const invocations = record.oracleDetails.mechanism.invocations;
      expect(invocations.some((invocation) => invocation.status === 'repeated_call_blocked' && invocation.errorKind === 'side_effect_replay')).toBe(true);
    }
  }, 180_000);

  it('writes trials 1 and 4 as independent immutable records', () => {
    const trial1 = run('FILE-02-G', 'canonical', 'none', 1);
    const trial4 = run('FILE-02-G', 'canonical', 'none', 4);
    expect(basename(trial1.recordPath)).toContain('trial__1');
    expect(basename(trial4.recordPath)).toContain('trial__4');
    expect(trial1.recordId).not.toBe(trial4.recordId);
    expect(trial1.dimensions.goal).toBe('passed');
    expect(trial4.dimensions.goal).toBe('passed');
    expect(() => run('FILE-02-G', 'canonical', 'none', 6)).toThrow(/trial must be an integer from 1 to 5/);
    const dir = join(outputRoot, 'duplicate-record');
    const args = ['scripts/eval-v2.mjs', '--run-controlled', '--task=FILE-02-G', '--trial=1', `--records-dir=${dir}`];
    const first = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 });
    const second = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 });
    expect(first.status).toBe(0);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/LEDGER_RECORD_EXISTS|refusing to overwrite/);
  }, 300_000);
});
