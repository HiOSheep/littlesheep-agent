#!/usr/bin/env node
// A/B batch driver for the runtime-autonomy experiment.
//
// The single-case entry (`experiment-autonomy-sandbox.mjs model`) runs one arm of one trial; this driver
// owns the parts that must not be left to a human remembering the sequence:
//
//   * arm A runs the **untouched tree** and arm B runs the tree with exactly one candidate patch applied;
//   * the packages are rebuilt between arms, so the bytes that ran are the bytes the ledger's sourceHash
//     describes;
//   * the block order alternates (A→B, then B→A) as section 3 requires, so a Provider-side warm-up or a
//     time-of-day effect cannot be attributed to one arm;
//   * the frozen batch budget is checked before every trial and the batch stops rather than overrunning.
//
// Usage:
//   node scripts/experiment-autonomy-sandbox-batch.mjs plan --file=<plan.json> [--dry-run]
//
// Nothing here writes into the checkout except the patch application it reverts immediately; ledgers,
// raw run directories and summaries stay in the evidence directory.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { appendJsonLine, ensureDir, readJsonLines, writeJson } from './lib/experiment-ledger.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(REPO_ROOT, 'scripts', 'experiment-autonomy-sandbox.mjs');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) { args.mode ??= raw; continue; }
    const [key, value] = raw.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

async function run(command, commandArgs, options = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd: options.cwd ?? REPO_ROOT,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return { ok: true, stdout, stderr, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      code: error.code,
      elapsedMs: Date.now() - started,
    };
  }
}

/** Every patch a case is defined by. A combination case applies several at once. */
function patchNamesOf(entry) {
  return entry.patches ?? (entry.patch ? [entry.patch] : []);
}

/** Revert every patch the plan knows about; a patch that is not applied is not an error. */
async function revertAll(plan) {
  const reverted = [];
  for (const entry of plan.cases) {
    for (const patchName of patchNamesOf(entry)) {
      const patch = join(plan.patchDir, patchName);
      if (!existsSync(patch)) continue;
      const result = await run('git', ['apply', '--reverse', '--check', patch]);
      if (!result.ok) continue;
      const applied = await run('git', ['apply', '--reverse', patch]);
      reverted.push({ patch: patchName, ok: applied.ok });
    }
  }
  return reverted;
}

async function applyPatch(plan, patchName) {
  const patch = join(plan.patchDir, patchName);
  const result = await run('git', ['apply', patch]);
  if (!result.ok) throw new Error(`git apply ${patchName} failed: ${result.stderr.trim()}`);
  return patch;
}

/**
 * Build one workspace package.
 *
 * This invokes the TypeScript compiler directly instead of `pnpm --filter ... run build`. The package's
 * own build script *is* `tsc -p tsconfig.json`, and shelling out to a package-manager shim added a failure
 * mode that has nothing to do with the experiment: `pnpm` is a `.cmd` on Windows, and a spawned `cmd.exe`
 * intermittently failed to resolve it, aborting a batch mid-block.
 */
async function buildPackages(packages) {
  const results = [];
  // Dependency order, not plan order. `@littlesheep/harness` consumes `@littlesheep/tools` types, so a
  // build that ran harness first compiled against the *previous* tools dist and failed with "does not
  // exist in type ToolExecutionServiceOptions" — a build-order artifact, not a candidate defect.
  const rank = { '@littlesheep/types': 0, '@littlesheep/tools': 1, '@littlesheep/harness': 2, '@littlesheep/runner': 3 };
  const ordered = [...packages].sort((left, right) => (rank[left] ?? 5) - (rank[right] ?? 5));
  for (const pkg of ordered) {
    const dir = join(REPO_ROOT, 'packages', pkg.replace(/^@littlesheep\//u, ''));
    const tsconfig = join(dir, 'tsconfig.json');
    results.push({
      pkg,
      ...(await run(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig])),
    });
  }
  return results;
}

/** The one thing that makes an arm label trustworthy: the tree really is in that state. */
async function assertArmState(plan, arm) {
  const diff = await run('git', ['diff', '--name-only', '--', ...plan.candidatePaths]);
  const changed = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (arm === 'A' && changed.length > 0) {
    throw new Error(`arm A requires an untouched tree, but these candidate paths are modified: ${changed.join(', ')}`);
  }
  if (arm === 'B' && changed.length === 0) {
    throw new Error('arm B requires the candidate patch to be applied, but no candidate path is modified');
  }
  return changed;
}

function budgetOf(ledgerPath) {
  const records = readJsonLines(ledgerPath);
  const tokens = records.reduce((total, record) => {
    const usage = record.usage ?? {};
    return total + (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }, 0);
  return { runs: records.length, tokens };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== 'plan' || !args.file) {
    process.stderr.write('usage: experiment-autonomy-sandbox-batch.mjs plan --file=<plan.json> [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const plan = JSON.parse(readFileSync(args.file, 'utf8'));
  plan.patchDir = plan.patchDir ?? join(plan.evidenceDir, 'patches');
  plan.ledger = args.ledger ?? plan.ledger ?? join(plan.evidenceDir, 'ledger.jsonl');
  plan.candidatePaths = plan.candidatePaths ?? [...new Set(plan.cases.flatMap((entry) => entry.paths ?? []))];
  const packages = [...new Set(plan.cases.flatMap((entry) => entry.packages ?? []))];
  ensureDir(plan.evidenceDir);

  if (args['dry-run']) {
    process.stdout.write(`${JSON.stringify({ plan, packages, budget: plan.budget }, null, 2)}\n`);
    return;
  }

  const batchLog = [];
  const log = (entry) => {
    batchLog.push({ at: new Date().toISOString(), ...entry });
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };

  for (const entry of plan.cases) {
    const order = entry.order ?? 'AB';
    log({ step: 'case-start', caseId: entry.caseId, order, patch: entry.patch });

    for (const arm of order.split('')) {
      // Every arm transition starts from the frozen baseline, so a leftover patch from the previous
      // case can never be attributed to this one.
      await revertAll(plan);
      if (arm === 'B') {
        for (const patchName of patchNamesOf(entry)) await applyPatch(plan, patchName);
      }
      const changed = await assertArmState(plan, arm);
      log({ step: 'arm-state', caseId: entry.caseId, arm, changedPaths: changed });

      const builds = await buildPackages(packages);
      const failedBuild = builds.find((build) => !build.ok);
      if (failedBuild) {
        // `tsc` writes diagnostics to stdout, so both streams are kept: a failure reported with an empty
        // reason cost one whole block during this experiment.
        log({
          step: 'build-failed',
          caseId: entry.caseId,
          arm,
          pkg: failedBuild.pkg,
          code: failedBuild.code ?? null,
          stdout: failedBuild.stdout.slice(-1500),
          stderr: failedBuild.stderr.slice(-800),
        });
        throw new Error(`build failed for ${failedBuild.pkg} in arm ${arm}`);
      }
      log({ step: 'built', caseId: entry.caseId, arm, packages, elapsedMs: builds.reduce((t, b) => t + b.elapsedMs, 0) });

      for (let trial = 1; trial <= (entry.trials ?? plan.trials ?? 3); trial += 1) {
        const used = budgetOf(plan.ledger);
        if (used.runs >= plan.budget.maxTotalRuns || used.tokens >= plan.budget.maxTotalTokens) {
          log({ step: 'budget-stop', used, budget: plan.budget });
          writeJson(join(plan.evidenceDir, `batch-${plan.batchId}.json`), { plan, batchLog, stopped: 'budget' });
          return;
        }
        const result = await run(process.execPath, [
          ENTRY, 'model',
          `--case=${entry.caseId}`,
          `--arm=${arm}`,
          `--trial=${trial}`,
          `--batch=${plan.batchId}`,
          `--ledger=${plan.ledger}`,
          ...(entry.injection ? [`--injection=${entry.injection}`] : []),
          ...(plan.evidenceDir ? [`--evidenceRoot=${plan.evidenceDir}`] : []),
        ], { env: plan.env ?? {} });
        let payload = null;
        try { payload = JSON.parse(result.stdout); } catch { /* keep the raw text below */ }
        log({
          step: 'trial',
          caseId: entry.caseId,
          arm,
          trial,
          outcome: payload?.outcome ?? 'error',
          exitCode: result.code ?? 0,
          elapsedMs: result.elapsedMs,
          usage: payload?.usage ?? null,
          targetTriggered: payload?.targetTriggered ?? null,
          stderr: result.ok ? undefined : result.stderr.slice(-400),
        });
      }
    }
  }

  await revertAll(plan);
  const builds = await buildPackages(packages);
  log({ step: 'restored-baseline', packages, ok: builds.every((build) => build.ok) });
  writeJson(join(plan.evidenceDir, `batch-${plan.batchId}.json`), { plan, batchLog, stopped: 'complete' });
  appendJsonLine(join(plan.evidenceDir, 'batch-log.jsonl'), { batchId: plan.batchId, completedAt: new Date().toISOString() });
}

await main();
