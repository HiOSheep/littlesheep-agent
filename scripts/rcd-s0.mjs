#!/usr/bin/env node
// Validate the frozen RCD S0 task suite and record a content-free source/environment manifest.
// Runtime run evidence remains in its existing stores; this tool does not copy user data.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suitePath = resolve(root, 'scripts/rcd-s0-scenarios.json');
const suiteBytes = readFileSync(suitePath);
const suite = JSON.parse(suiteBytes.toString('utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function validate() {
  const errors = [];
  const required = ['id', 'category', 'kind', 'task', 'environment', 'tools', 'permissions', 'oracle', 'acceptableStops', 'prohibited', 'reset'];
  const scenarios = suite.scenarios;
  const ids = new Set();
  const counts = {};
  for (const [index, scenario] of scenarios.entries()) {
    for (const key of required) if (scenario[key] === undefined || scenario[key] === '' || scenario[key] === null) errors.push(`${scenario.id ?? index}: missing ${key}`);
    if (!/^[CFRLX]\d{2}$/u.test(scenario.id ?? '')) errors.push(`${index}: invalid scenario id`);
    if (ids.has(scenario.id)) errors.push(`${scenario.id}: duplicate id`);
    ids.add(scenario.id);
    counts[scenario.category] = (counts[scenario.category] ?? 0) + 1;
    if (!Array.isArray(scenario.tools) || scenario.tools.length === 0) errors.push(`${scenario.id}: tools must be a non-empty list`);
    if (!Array.isArray(scenario.acceptableStops) || scenario.acceptableStops.length === 0) errors.push(`${scenario.id}: acceptableStops must be a non-empty list`);
    if (!Array.isArray(scenario.prohibited) || scenario.prohibited.length === 0) errors.push(`${scenario.id}: prohibited must be a non-empty list`);
  }
  if (scenarios.length !== 24) errors.push(`expected 24 scenarios, got ${scenarios.length}`);
  for (const category of ['C', 'F', 'R', 'L', 'X']) {
    if (counts[category] !== suite.categories[category]) errors.push(`${category}: declared ${suite.categories[category]}, actual ${counts[category] ?? 0}`);
  }
  const kinds = new Set(scenarios.map((scenario) => scenario.kind));
  for (const kind of ['positive', 'safe_block', 'recovery']) if (!kinds.has(kind)) errors.push(`missing scenario kind ${kind}`);
  if (errors.length) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS ${suite.suiteId}: ${scenarios.length} scenarios (${Object.entries(counts).sort().map(([key, value]) => `${key}=${value}`).join(', ')})\n`);
  process.stdout.write(`suiteSha256=${sha256(suiteBytes)}\n`);
}

function manifest(output) {
  const packageJson = readFileSync(resolve(root, 'package.json'));
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  const lockBytes = readFileSync(lockPath);
  const status = git('status', '--short', '--untracked-files=all').split(/\r?\n/u).filter(Boolean);
  const nameStatus = git('diff', '--name-status', 'HEAD');
  const diffHash = sha256(git('diff', '--binary', 'HEAD'));
  const result = {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    capturedAt: new Date().toISOString(),
    source: {
      head: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'),
      dirty: status.length > 0,
      statusEntries: status,
      trackedDiffNameStatus: nameStatus ? nameStatus.split(/\r?\n/u) : [],
      trackedDiffSha256: diffHash,
    },
    environment: {
      node: process.version,
      pnpm: execFileSync('pnpm --version', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }).trim(),
      platform: process.platform,
      arch: process.arch,
      packageJsonSha256: sha256(packageJson),
      lockfileSha256: sha256(lockBytes),
      suiteSha256: sha256(suiteBytes),
    },
    baseline: {
      deterministicSuite: 'not_executed',
      localRuntimeE2E: 'not_executed',
      realProvider: 'not_run',
      note: 'Populate only from observed runs; missing usage and price data must remain unavailable.',
    },
    evidencePolicy: {
      rawUserContentPersisted: false,
      runtimeEvidenceSource: 'existing execution logs, durable checkpoints, provider usage records, tool invocation records, and context snapshots; see S0 report',
    },
  };
  if (output) writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output ? `Wrote ${output}` : JSON.stringify(result, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'validate') validate();
else if (command === 'manifest') {
  const outputArg = args.find((arg) => arg.startsWith('--output='));
  manifest(outputArg ? outputArg.slice('--output='.length) : undefined);
} else {
  process.stderr.write('Usage: node scripts/rcd-s0.mjs validate | manifest [--output=<path>]\n');
  process.exitCode = 2;
}
