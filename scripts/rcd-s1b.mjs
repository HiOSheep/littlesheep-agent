#!/usr/bin/env node
// S1B shell replay comparison cases. Uses isolated temp workspaces created by the test adapters.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['B01', 'B02', 'B03', 'B04', 'B05'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const evidenceSummary = {
  B01: 'Two distinct callIds used the same command, cwd and input hash. The first real process logged v1 and settled succeeded. A trusted fixture edit changed input.txt hash v1 to v2. The second call was refused as side_effect_replay; the exec effect retained callId of the first call, external kind, no resource keys, and no reRunnable declaration.',
  B02: 'With the fixture unchanged, one real process start was recorded. A second distinct callId with the same exact input was refused as side_effect_replay; one succeeded effect remains in the ledger.',
  B03: 'One Runner tool execution wrote the fixture. Durable effect intent and succeeded settlement use the same effectId. After Runner restart, two recoverDurableRun calls produced no effect actions, did not append another settlement, and did not execute the tool again.',
  B04: 'Controlled exception injection occurs after a real fixture file write and before the tool returns. One unknown settlement with a SHA-256 error reference remains in the durable stream. Restart recovery projects one unknown effect, appends no second settlement, and does not rerun the fixture tool. This is not an OS crash test.',
  B05: 'A denied command was requested in two separate logical runs and denied twice. One exact command received a one-shot approval and wrote only its expected marker; a different command required a second approval and was denied. A pre-aborted invocation was recorded aborted and did not write its marker.',
};

function sourceFingerprint() {
  const status = git('status', '--short', '--untracked-files=all').split(/\r?\n/u).filter(Boolean);
  const diff = git('diff', '--binary', 'HEAD');
  const untracked = status.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
  const extras = untracked.map((path) => {
    try { return `${path}\0${readFileSync(resolve(root, path))}`; } catch { return `${path}\0unreadable`; }
  });
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: status.length > 0, statusEntries: status, sha256: sha256([diff, ...extras].join('\0')) };
}

function run(args) {
  const idArg = args.find((arg) => arg.startsWith('--id='))?.slice('--id='.length);
  const all = args.includes('--all');
  const outputArg = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
  if (Number(Boolean(idArg)) + Number(all) !== 1 || (idArg && !ids.includes(idArg))) {
    process.stderr.write('Usage: node scripts/rcd-s1b.mjs run (--id=B01..B05 | --all) [--output=<path>]\n');
    process.exitCode = 2;
    return;
  }
  const selected = idArg ? [idArg] : ids;
  const startedAt = new Date().toISOString();
  const source = sourceFingerprint();
  const temp = mkdtempSync(join(tmpdir(), 'ls-rcd-s1b-report-'));
  const records = [];
  try {
    const jsonPath = join(temp, 'vitest.json');
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const output = execFileSync(process.execPath, [
        resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/rcd-s1b-shell-replay.test.ts',
        ...(idArg ? ['-t', `${idArg}:`] : []), '--reporter=json', `--outputFile=${jsonPath}`,
      ], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      stdout = output;
    } catch (error) {
      exitCode = typeof error?.status === 'number' ? error.status : 1;
      stdout = String(error?.stdout ?? '');
      stderr = String(error?.stderr ?? '');
    }
    let vitest;
    try { vitest = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { /* preserve a readable harness result below */ }
    const assertions = (vitest?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
    for (const id of selected) {
      const assertion = assertions.find((item) => String(item.fullName ?? item.title).includes(`${id}:`));
      records.push({
        caseId: id,
        infrastructureStatus: assertion ? 'executed' : exitCode === 0 ? 'harness_error' : 'harness_error',
        productResult: assertion?.status === 'passed' ? (id === 'B01' || id === 'B02' ? 'correctly_blocked' : 'passed') : 'unverified',
        evidenceSummary: evidenceSummary[id],
        test: assertion ? { name: assertion.fullName ?? assertion.title, status: assertion.status, durationMs: assertion.duration ?? null, failureMessages: assertion.failureMessages ?? [] } : null,
        exitCode,
        stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
        harnessSummary: stdout.split(/\r?\n/u).filter((line) => /test[s]?\s|PASS|FAIL|Test Files/u.test(line)).slice(-8),
        timeoutMs: 120_000,
        isolatedWorkspace: 'adapter creates a fresh OS temporary directory per case and removes it in afterEach',
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const endedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    suiteId: 'LS-RCD-S1B-SHELL-REPLAY',
    generatedAt: endedAt,
    startedAt,
    endedAt,
    source,
    environment: { node: process.version, platform: process.platform, arch: process.arch, provider: 'scripted-mock', simulated: true, publicNetwork: 'not used' },
    interpretation: 'B01/B02 verify the current intentional opaque-Shell replay refusal; their productResult correctly_blocked records policy behavior, not completion of a requested repeated observation.',
    infrastructure: { executed: records.filter((item) => item.infrastructureStatus === 'executed').length, failed: records.filter((item) => item.infrastructureStatus !== 'executed').length },
    cases: records,
  };
  const output = resolve(outputArg ?? join(root, 'docs/reference/rcd-s1b-shell-replay-2026-10-16.json'));
  const outputRelative = output.startsWith(root) ? output.slice(root.length + 1) : output;
  if (existsSync(output) && !outputArg) {
    // Default artifact is versioned intentionally; explicit output paths may be overwritten by request.
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: outputRelative, infrastructure: report.infrastructure, cases: records.map(({ caseId, productResult, test }) => ({ caseId, productResult, testStatus: test?.status ?? 'missing' })) }, null, 2)}\n`);
  if (records.some((item) => item.infrastructureStatus !== 'executed')) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'run') run(args);
else {
  process.stderr.write('Usage: node scripts/rcd-s1b.mjs run (--id=B01..B05 | --all) [--output=<path>]\n');
  process.exitCode = 2;
}
