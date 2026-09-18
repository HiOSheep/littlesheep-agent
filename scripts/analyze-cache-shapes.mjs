// @littlesheep — analyze-cache-shapes.mjs
//
// Zero-cost shape analysis for the prompt-cache work. Every model request
// already records its verdict, so this reads a comparison data directory and
// answers the questions that located the regressions and the wins: where two
// consecutive runs first diverge, what a call costs by its position inside a
// run, what the provider actually received (head and tail), and whether the
// reply purpose still emits more than one system shape.
//
// Usage: node scripts/analyze-cache-shapes.mjs <dataDir>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: node scripts/analyze-cache-shapes.mjs <dataDir>');
  process.exit(2);
}
const logDir = join(dataDir, 'execution-logs');

const runs = [];
for (const file of readdirSync(logDir).filter((name) => name.endsWith('.json'))) {
  const path = join(logDir, file);
  let log;
  try { log = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  const snapshots = new Map((log.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  const requests = (log.modelRequests ?? []).map((request) => {
    const messages = request.messages ?? [];
    const prompt = request.cacheObservation?.providerPrompt ?? {};
    return {
      index: request.requestIndex ?? 0,
      purpose: request.callContract?.purpose ?? 'unknown',
      messages,
      firstSystem: messages.find((message) => message.role === 'system'),
      items: (snapshots.get(request.contextSnapshotId)?.items ?? []).map((item) => item.id),
      uncached: prompt.uncachedTokenCount ?? 0,
      total: prompt.tokenCount ?? 0,
    };
  }).sort((left, right) => left.index - right.index);
  if (requests.length === 0) continue;
  runs.push({ id: String(log.runId ?? file).slice(-8), mtime: statSync(path).mtimeMs, requests });
}
runs.sort((left, right) => left.mtime - right.mtime);
if (runs.length === 0) {
  console.error(`no execution logs under ${logDir}`);
  process.exit(2);
}

const percent = (part, whole) => (whole === 0 ? '-' : `${((1 - part / whole) * 100).toFixed(1)}%`);

console.log('=== call cost by position inside a run ===');
const positions = new Map();
for (const run of runs) {
  run.requests.forEach((request, index) => {
    const key = index === 0 ? 'first' : index === 1 ? 'second' : 'third+';
    const entry = positions.get(key) ?? { calls: 0, uncached: 0, total: 0 };
    entry.calls += 1;
    entry.uncached += request.uncached;
    entry.total += request.total;
    positions.set(key, entry);
  });
}
for (const key of ['first', 'second', 'third+']) {
  const entry = positions.get(key);
  if (!entry) continue;
  console.log(`  ${key.padEnd(7)} calls=${String(entry.calls).padStart(4)} miss/call=${(entry.uncached / entry.calls).toFixed(0).padStart(6)} hit=${percent(entry.uncached, entry.total).padStart(7)}`);
}

console.log('\n=== where consecutive runs first diverge ===');
const divergences = new Map();
let pairs = 0;
let pairMiss = 0;
let pairTotal = 0;
for (let index = 1; index < runs.length; index += 1) {
  const previous = runs[index - 1].requests.at(-1);
  const current = runs[index].requests[0];
  let offset = 0;
  while (offset < Math.min(previous.items.length, current.items.length)
    && previous.items[offset] === current.items[offset]) offset += 1;
  const key = `at ${offset}: ${previous.items[offset] ?? '-'} -> ${current.items[offset] ?? '-'}`;
  divergences.set(key, (divergences.get(key) ?? 0) + 1);
  pairs += 1;
  pairMiss += current.uncached;
  pairTotal += current.total;
}
console.log(`  pairs=${pairs} avgFirstCallMiss=${(pairMiss / pairs).toFixed(0)} hit=${percent(pairMiss, pairTotal)}`);
for (const [key, count] of [...divergences].sort((left, right) => right[1] - left[1]).slice(0, 6)) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}

console.log('\n=== provider order of one tool loop request (head and tail) ===');
const sample = runs.flatMap((run) => run.requests).find((request) => request.purpose === 'execute_tool_loop')
  ?? runs[0].requests[0];
const messages = sample.messages;
const show = (label, from, to) => {
  for (let index = from; index < Math.min(to, messages.length); index += 1) {
    const message = messages[index];
    console.log(`  ${label}[${String(index).padStart(3)}] ${String(message.role).padEnd(9)} ${String(message.characterCount ?? 0).padStart(6)}`);
  }
};
console.log(`  ${sample.purpose}: ${messages.length} messages`);
show('head', 0, 4);
show('tail', messages.length - 4, messages.length);

console.log('\n=== reply purposes by first system message length ===');
const shapes = new Map();
for (const request of runs.flatMap((run) => run.requests)) {
  if (request.purpose !== 'reply') continue;
  const length = request.firstSystem?.characterCount ?? -1;
  shapes.set(length, (shapes.get(length) ?? 0) + 1);
}
for (const [length, count] of [...shapes].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${String(count).padStart(4)} calls with first system message of ${length} characters`);
}