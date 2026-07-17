#!/usr/bin/env node

import { opendir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js';
import { observeMemoryWorkload } from '../packages/runner/dist/index.js';
import { projectExecutionLog } from './lib/memory-v3-workload-projection.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_NAME = 'memory-v3-workload';
const MAX_CLI_RUNS = 10_000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'));
  const dataDir = args.dataDir ? resolve(args.dataDir) : resolveDataDir(branding);
  const executionLogsDir = join(dataDir, 'execution-logs');
  const selection = await selectLatestLogFiles(executionLogsDir, args.maxRuns);
  const logs = [];
  let rejected = 0;
  let projectionTruncatedRuns = 0;

  for (const candidate of selection.files) {
    try {
      const parsed = JSON.parse(await readFile(join(executionLogsDir, candidate.name), 'utf8'));
      const projected = projectExecutionLog(parsed);
      if (!projected) {
        rejected += 1;
        continue;
      }
      logs.push(projected.log);
      if (projected.truncated) projectionTruncatedRuns += 1;
    } catch {
      rejected += 1;
    }
  }

  const observation = observeMemoryWorkload(logs, {
    maxRuns: args.maxRuns,
    sourceRunCount: selection.discovered,
    minKnownStateRuns: args.minKnownStateRuns,
    minExplicitUseRuns: args.minExplicitUseRuns,
    minProviderUsageRuns: args.minProviderUsageRuns,
    minVerifiedOutcomeRuns: args.minVerifiedOutcomeRuns,
    minResourceSampleRuns: args.minResourceSampleRuns,
  });
  const report = {
    report: REPORT_NAME,
    source: {
      filesDiscovered: selection.discovered,
      filesSelected: selection.files.length,
      logsAccepted: logs.length,
      logsRejected: rejected,
      projectionTruncatedRuns,
    },
    observation,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.requireReady && observation.calibration.state !== 'ready') process.exitCode = 2;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current || current === '--') continue;
    if (current === '--require-ready') {
      flags.add('require-ready');
      continue;
    }
    if (!current.startsWith('--')) throw new Error('invalid-argument');
    const equals = current.indexOf('=');
    if (equals > 2) {
      values.set(current.slice(2, equals), current.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error('missing-argument-value');
    values.set(current.slice(2), next);
    index += 1;
  }

  return {
    dataDir: values.get('data-dir'),
    maxRuns: integerOption(values, 'max-runs', 1_000, 1, MAX_CLI_RUNS),
    minKnownStateRuns: integerOption(values, 'min-known-state-runs', 20, 0, MAX_CLI_RUNS),
    minExplicitUseRuns: integerOption(values, 'min-explicit-use-runs', 10, 0, MAX_CLI_RUNS),
    minProviderUsageRuns: integerOption(values, 'min-provider-usage-runs', 10, 0, MAX_CLI_RUNS),
    minVerifiedOutcomeRuns: integerOption(values, 'min-verified-outcome-runs', 20, 0, MAX_CLI_RUNS),
    minResourceSampleRuns: integerOption(values, 'min-resource-sample-runs', 20, 0, MAX_CLI_RUNS),
    requireReady: flags.has('require-ready'),
  };
}

function integerOption(values, name, fallback, minimum, maximum) {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`invalid-${name}`);
  }
  return parsed;
}

async function selectLatestLogFiles(directory, limit) {
  const heap = [];
  let discovered = 0;
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { discovered, files: [] };
    throw error;
  }

  try {
    for await (const entry of handle) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      discovered += 1;
      let metadata;
      try {
        metadata = await stat(join(directory, entry.name));
      } catch {
        continue;
      }
      pushNewest(heap, { name: entry.name, mtimeMs: metadata.mtimeMs }, limit);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  return { discovered, files: heap.sort(compareNewestFirst) };
}

function pushNewest(heap, value, limit) {
  if (heap.length < limit) {
    heap.push(value);
    siftUp(heap, heap.length - 1);
    return;
  }
  if (compareOldestFirst(value, heap[0]) <= 0) return;
  heap[0] = value;
  siftDown(heap, 0);
}

function siftUp(heap, start) {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareOldestFirst(heap[parent], heap[index]) <= 0) return;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function siftDown(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareOldestFirst(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < heap.length && compareOldestFirst(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) return;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

function compareOldestFirst(left, right) {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

function compareNewestFirst(left, right) {
  return right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ report: REPORT_NAME, error: safeErrorCode(error) })}\n`);
  process.exitCode = 1;
});

function safeErrorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[a-z0-9-]+$/i.test(error.message)) return error.message;
  return 'report-failed';
}
