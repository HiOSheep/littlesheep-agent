// @littlesheep — analyze-prompt-cache.mjs
//
// Zero-cost evidence for the prompt-cache work: every model request already
// records its own verdict (provider hit counts, invalidation reason, prompt
// component digests), so this script reads a comparison data directory and
// reports where the miss actually is, per purpose and per run shape.
//
// Usage: node scripts/analyze-prompt-cache.mjs <dataDir>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: node scripts/analyze-prompt-cache.mjs <dataDir>');
  process.exit(2);
}
const logDir = join(dataDir, 'execution-logs');
let files = [];
try { files = readdirSync(logDir).filter((name) => name.endsWith('.json')); } catch { /* fall through */ }
if (files.length === 0) {
  console.error(`no execution logs under ${logDir}`);
  process.exit(2);
}

const requests = [];
const runs = [];
let skipped = 0;
for (const file of files) {
  let log;
  try { log = JSON.parse(readFileSync(join(logDir, file), 'utf8')); } catch { skipped++; continue; }
  const rows = (log.modelRequests ?? []).map((request) => {
    const observation = request.cacheObservation ?? {};
    const prompt = observation.providerPrompt ?? {};
    return {
      index: request.requestIndex ?? 0,
      purpose: request.callContract?.purpose ?? request.stage ?? 'unknown',
      tools: (request.toolNames ?? []).length,
      total: prompt.tokenCount ?? 0,
      cached: prompt.cachedTokenCount ?? 0,
      uncached: prompt.uncachedTokenCount ?? 0,
      primary: observation.primaryInvalidationReason ?? '-',
      components: observation.promptComponents ?? {},
    };
  }).sort((left, right) => left.index - right.index);
  if (rows.length === 0) continue;
  requests.push(...rows);
  runs.push(rows);
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const percent = (part, whole) => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`);

console.log(`runs=${runs.length} requests=${requests.length} skipped=${skipped}`);
console.log(`overall: prompt=${sum(requests, 'total')} cached=${sum(requests, 'cached')} uncached=${sum(requests, 'uncached')} hit=${percent(sum(requests, 'cached'), sum(requests, 'total'))} miss/call=${(sum(requests, 'uncached') / requests.length).toFixed(1)}`);

console.log('\n== per purpose (ordered by total miss) ==');
const byPurpose = new Map();
for (const row of requests) {
  const entry = byPurpose.get(row.purpose) ?? { calls: 0, total: 0, cached: 0, uncached: 0 };
  entry.calls += 1;
  entry.total += row.total;
  entry.cached += row.cached;
  entry.uncached += row.uncached;
  byPurpose.set(row.purpose, entry);
}
for (const [purpose, entry] of [...byPurpose].sort((left, right) => right[1].uncached - left[1].uncached)) {
  console.log(
    purpose.padEnd(20),
    `calls=${String(entry.calls).padStart(3)}`,
    `miss/call=${(entry.uncached / entry.calls).toFixed(1).padStart(7)}`,
    `hit=${percent(entry.cached, entry.total).padStart(6)}`,
    `share=${percent(entry.uncached, sum(requests, 'uncached')).padStart(6)}`,
  );
}

console.log('\n== run shapes (call sequence x count) ==');
const shapes = new Map();
for (const rows of runs) {
  const sequence = [];
  for (const row of rows) {
    const last = sequence[sequence.length - 1];
    if (last && last.purpose === row.purpose) last.count += 1;
    else sequence.push({ purpose: row.purpose, count: 1 });
  }
  const signature = sequence.map((entry) => (entry.count > 1 ? `${entry.purpose} x${entry.count}` : entry.purpose)).join(' > ');
  shapes.set(signature, (shapes.get(signature) ?? 0) + 1);
}
for (const [signature, count] of [...shapes].sort((left, right) => right[1] - left[1]).slice(0, 8)) {
  console.log(String(count).padStart(3), signature);
}

console.log('\n== tool block per run (first occurrence marks the prefix break) ==');
for (const rows of runs.slice(0, 6)) {
  const withTools = rows.filter((row) => row.tools > 0);
  if (withTools.length === 0) continue;
  const sequence = rows.map((row) => `${row.purpose}${row.tools > 0 ? `(tools=${row.tools})` : ''}:${row.uncached}`).join(' ');
  console.log(` ${sequence}`);
}

console.log('\n== invalidation reasons ==');
const reasons = new Map();
for (const row of requests) reasons.set(row.primary, (reasons.get(row.primary) ?? 0) + 1);
for (const [reason, count] of [...reasons].sort((left, right) => right[1] - left[1])) {
  console.log(String(count).padStart(4), reason);
}

console.log('\n== prompt component digest flips between consecutive calls in a run ==');
const keys = new Set();
for (const row of requests) for (const key of Object.keys(row.components)) keys.add(key);
for (const key of keys) {
  let flips = 0;
  let compared = 0;
  for (const rows of runs) {
    for (let index = 1; index < rows.length; index += 1) {
      const before = rows[index - 1].components[key];
      const after = rows[index].components[key];
      if (before === undefined || after === undefined) continue;
      compared += 1;
      if (before !== after) flips += 1;
    }
  }
  console.log(key.padEnd(16), `flips=${flips}/${compared}`, compared === 0 ? '' : `(${((flips / compared) * 100).toFixed(0)}%)`);
}