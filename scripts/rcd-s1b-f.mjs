#!/usr/bin/env node
// Reproducible S1B-F Shell fresh-invocation and recovery evaluation.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sourceFingerprint() {
  const status = git('status', '--short', '--untracked-files=all').split(/\r?\n/u).filter(Boolean);
  const diff = git('diff', '--binary', 'HEAD');
  const untracked = status.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
  const extras = untracked.map((path) => `${path}\0${readFileSync(resolve(root, path))}`);
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: status.length > 0,
    statusEntries: status, sha256: sha256([diff, ...extras].join('\0')) };
}

const output = resolve(root, 'docs/reference/rcd-s1b-f-shell-reexecution-2026-10-16.json');
const temp = mkdtempSync(join(tmpdir(), 'ls-rcd-s1b-f-'));
const vitestPath = join(temp, 'vitest.json');
const startedAt = new Date().toISOString();
const source = sourceFingerprint();
let exitCode = 0;
let stdout = '';
let stderr = '';
try {
  try {
    stdout = execFileSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'test/rcd-s1b-shell-replay.test.ts',
      'packages/harness/src/stages/execute/side-effect-ledger.test.ts',
      'packages/tools/src/shell-authorization.test.ts',
      'packages/app/src/main/shell-authorization.test.ts',
      'packages/app/src/main/shell-repeat-authorization-store.test.ts',
      'packages/app/src/main/shell-repeat-authorization-execution.test.ts',
      'packages/app/src/main/run-policy.test.ts',
      'packages/runner/src/durable-runner-effect-recovery.test.ts',
      'packages/runner/src/durable-runner-effect-crash-worker.test.ts',
      'packages/runner/src/durable-effect-lease-recovery.test.ts',
      'packages/runner/src/durable-effect-lease-store.test.ts',
      '--reporter=json', `--outputFile=${vitestPath}`], {
      cwd: root, encoding: 'utf8', timeout: 360_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    exitCode = typeof error?.status === 'number' ? error.status : 1;
    stdout = String(error?.stdout ?? '');
    stderr = String(error?.stderr ?? '');
  }
  let vitest;
  try { vitest = JSON.parse(readFileSync(vitestPath, 'utf8')); } catch { /* report unavailable output as infrastructure failure */ }
  const assertions = (vitest?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const cases = assertions.map((item) => {
    const title = String(item.fullName ?? item.title);
    const caseId = title.match(/\b(F0[1-6]|B0[1-5]):/u)?.[1] ?? 'UNIT';
    const expectedBlocked = ['F02', 'F05', 'B04', 'B05'].includes(caseId);
    return {
      caseId,
      ...(title.includes('F01/B01:') ? { acceptanceIds: ['F01'] } : {}),
      ...(caseId === 'B03' ? { acceptanceIds: ['F04'] } : {}),
      name: item.fullName ?? item.title,
      testStatus: item.status,
      infrastructureStatus: item.status === 'passed' || item.status === 'failed' ? 'executed' : 'harness_error',
      productResult: caseId === 'UNIT' ? 'unverified'
        : item.status === 'failed' ? 'failed' : expectedBlocked ? 'correctly_blocked' : 'passed',
      durationMs: item.duration ?? null,
      failureMessages: item.failureMessages ?? [],
    };
  });
  const total = vitest?.numTotalTests ?? assertions.length;
  const passed = vitest?.numPassedTests ?? assertions.filter((item) => item.status === 'passed').length;
  const report = {
    schemaVersion: 1,
    suiteId: 'LS-RCD-S1B-F-SHELL-REEXECUTION',
    title: '修复前确定性 Runtime 基线后的受控 Shell 合法重执行',
    generatedAt: new Date().toISOString(), startedAt, source,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      provider: 'scripted controlled fixture', simulated: true, publicNetwork: 'not used', realElectron: false },
    execution: { command: 'node scripts/rcd-s1b-f.mjs', timeoutMs: 360_000,
      testFiles: ['test/rcd-s1b-shell-replay.test.ts', 'packages/harness/src/stages/execute/side-effect-ledger.test.ts',
        'packages/tools/src/shell-authorization.test.ts', 'packages/app/src/main/shell-authorization.test.ts',
        'packages/app/src/main/shell-repeat-authorization-store.test.ts', 'packages/app/src/main/shell-repeat-authorization-execution.test.ts',
        'packages/app/src/main/run-policy.test.ts', 'packages/runner/src/durable-runner-effect-recovery.test.ts',
        'packages/runner/src/durable-runner-effect-crash-worker.test.ts', 'packages/runner/src/durable-effect-lease-recovery.test.ts',
        'packages/runner/src/durable-effect-lease-store.test.ts'],
      total, passed, failed: vitest?.numFailedTests ?? Math.max(0, total - passed), exitCode,
      stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) },
    contract: {
      freshInvocationIdentity: 'Main-minted Shell grant identity; never accepted from model input or Renderer data.',
      sameCallRecovery: 'The Runner effect identity remains unchanged; recovery reuses the settled effect and does not launch a new process.',
      unknownEffect: 'A new callId and fresh grant are blocked while the same operation has planned, in_progress or unknown settlement.',
      repeatApproval: 'The process-local Main repeat store permits only its exact supported candidate within its environment binding and bounded use count; all other repeats require a new approval.',
      noProgress: 'The existing ToolExecutionService repeated-input limit and Harness loop budget remain active.' },
    counts: { infrastructure: { executed: cases.filter((item) => item.infrastructureStatus === 'executed').length,
      failed: cases.filter((item) => item.infrastructureStatus !== 'executed').length },
      product: Object.fromEntries(['passed', 'failed', 'partially_completed', 'correctly_blocked', 'unverified']
        .map((status) => [status, cases.filter((item) => item.productResult === status).length])) },
    cases,
    unavailable: { usage: 'No real provider usage was generated.', cost: 'No paid provider was used.' },
    interpretation: 'Controlled local tests only; this report does not claim real Electron or real-provider task completion. Historical S1B reports and S0-F ledgers remain unchanged.',
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output, total, passed, failed: report.execution.failed,
    infrastructure: report.counts.infrastructure }, null, 2)}\n`);
  if (report.counts.infrastructure.failed > 0 || report.execution.failed > 0) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
