#!/usr/bin/env node
/**
 * Cache and cost audit for one or more harness comparison samples.
 *
 * Every number here answers a question the prompt cache work has to be judged
 * by: how much of each request was reused (hit ratio), how much fresh content
 * each call cost (uncached tokens per call), how many model calls a run needed,
 * how long a run took, and how quickly the first useful action happened. The
 * rewrite counter is included because a repeated published reply costs a whole
 * extra model call.
 *
 * Usage:
 *   node scripts/audit-cache-usage.mjs <dataDir> [<dataDir> ...]
 *   node scripts/audit-cache-usage.mjs --latest        # newest sample under TEMP
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'usage: node scripts/audit-cache-usage.mjs <dataDir>... | --latest';

function latestSampleDir() {
  const root = tmpdir();
  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('littlesheep-path-next-'))
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(join(path, 'data', 'execution-logs')).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ? join(candidates[0], 'data') : undefined;
}

function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function average(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmt(value, digits = 0) {
  return value === undefined ? 'n/a' : value.toFixed(digits);
}

function readLogs(dataDir) {
  const dir = join(dataDir, 'execution-logs');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    console.error(`audit-cache-usage: no execution logs under ${dir}`);
    process.exitCode = 1;
    return [];
  }
  const logs = [];
  for (const name of names) {
    try {
      const log = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      log.__file = name;
      logs.push(log);
    } catch {
      // A half written log is not a reason to fail the audit.
    }
  }
  return logs;
}

function audit(dataDir) {
  const logs = readLogs(dataDir);
  if (logs.length === 0) return;

  const byPurpose = new Map();
  const callsPerRun = [];
  const durations = [];
  const firstActions = [];
  const rewrites = new Map();
  let promptTokens = 0;
  let cachedTokens = 0;

  for (const log of logs) {
    const requests = log.modelRequests ?? [];
    callsPerRun.push(requests.length);
    if (typeof log.durationMs === 'number') durations.push(log.durationMs);

    const start = log.startedAt ? Date.parse(log.startedAt) : undefined;
    const firstTool = (log.toolInvocations ?? [])[0] ?? (log.toolCalls ?? [])[0];
    const firstToolAt = firstTool?.startedAt ?? firstTool?.startTime ?? firstTool?.at;
    if (start !== undefined && typeof firstToolAt === 'string') {
      const at = Date.parse(firstToolAt);
      if (Number.isFinite(at) && at >= start) firstActions.push(at - start);
    }

    const rewriteCount = log.replyProvenance?.rewriteCount;
    if (typeof rewriteCount === 'number') {
      rewrites.set(rewriteCount, (rewrites.get(rewriteCount) ?? 0) + 1);
    }

    for (const request of requests) {
      const purpose = request.callContract?.purpose ?? 'unknown';
      const system = (request.messages ?? []).find((message) => message.role === 'system');
      const entry = byPurpose.get(purpose) ?? { calls: 0, systemLengths: new Map(), miss: 0, prompt: 0, cached: 0 };
      entry.calls += 1;
      const length = typeof system?.characterCount === 'number' ? system.characterCount : -1;
      entry.systemLengths.set(length, (entry.systemLengths.get(length) ?? 0) + 1);
      const providerPrompt = request.cacheObservation?.providerPrompt ?? {};
      const total = providerPrompt.tokenCount ?? 0;
      const cached = providerPrompt.cachedTokenCount ?? 0;
      entry.prompt += total;
      entry.cached += cached;
      entry.miss += providerPrompt.uncachedTokenCount ?? total - cached;
      byPurpose.set(purpose, entry);
      promptTokens += total;
      cachedTokens += cached;
    }
  }

  console.log(`sample: ${dataDir}`);
  console.log(`runs=${logs.length} calls=${callsPerRun.reduce((a, b) => a + b, 0)}`);
  console.log(
    `hit=${fmt(promptTokens === 0 ? undefined : (cachedTokens / promptTokens) * 100, 1)}% `
    + `uncached/call=${fmt(promptTokens === 0 ? undefined : (promptTokens - cachedTokens) / callsPerRun.reduce((a, b) => a + b, 0), 1)}`,
  );
  console.log(
    `model calls/run: avg=${fmt(average(callsPerRun), 2)} p50=${percentile(callsPerRun, 50)} p95=${percentile(callsPerRun, 95)}`,
  );
  console.log(
    `task completion latency: avg=${fmt(average(durations))}ms p50=${percentile(durations, 50)}ms p95=${percentile(durations, 95)}ms`,
  );
  console.log(
    `time to first useful action: n=${firstActions.length} avg=${fmt(average(firstActions))}ms `
    + `p50=${percentile(firstActions, 50)}ms p95=${percentile(firstActions, 95)}ms`,
  );
  const rewriteSummary = [...rewrites.entries()].sort((a, b) => a[0] - b[0])
    .map(([count, runs]) => `${count}x${runs}`).join(' ');
  console.log(`rewriteCount (runs): ${rewriteSummary || 'n/a'}`);

  console.log('');
  console.log('per purpose:');
  const rows = [...byPurpose.entries()].sort((a, b) => b[1].calls - a[1].calls);
  for (const [purpose, entry] of rows) {
    const lengths = [...entry.systemLengths.entries()].sort((a, b) => b[1] - a[1])
      .map(([length, calls]) => `${length}x${calls}`).join(' ');
    console.log(
      `  ${purpose.padEnd(20)} calls=${String(entry.calls).padStart(3)} `
      + `miss/call=${fmt(entry.calls === 0 ? undefined : entry.miss / entry.calls, 1).padStart(7)} `
      + `hit=${fmt(entry.prompt === 0 ? undefined : (entry.cached / entry.prompt) * 100, 1).padStart(5)}% `
      + `system: ${lengths}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exitCode = 1;
} else if (args[0] === '--latest') {
  const dir = latestSampleDir();
  if (!dir) {
    console.error('audit-cache-usage: no sample directory found under the temp root');
    process.exitCode = 1;
  } else {
    audit(dir);
  }
} else {
  for (const dir of args) audit(dir);
}
