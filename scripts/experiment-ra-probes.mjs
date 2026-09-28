// Deterministic probes for RA-03 (F-02) and RA-04 (F-03), run against whatever is built.
//
// F-02: a tool whose resource resolver THROWS. The baseline returns `exclusive` (conservative). The first
//       candidate kept the declared `parallel` and returned an empty resource list, which the scheduler
//       reads as "conflicts with nothing".
// F-03: a read-only call whose resources change revision. The first candidate issued a fresh key once and
//       then fell back to the unqualified key, so the SECOND read of the same new revision was refused by
//       the old revision's spent count.
//
// Usage: node scripts/experiment-ra-probes.mjs
import { resolveToolExecutionPolicy } from '../packages/tools/dist/tool-execution-result.js';
import { ToolExecutionService, toolResourcesConflict } from '../packages/tools/dist/index.js';

const ctx = { sessionId: 'probe', runId: 'probe', cwd: process.cwd() };

// ── F-02 ────────────────────────────────────────────────────────────────────────────────────────────
const throwingTool = {
  name: 'declared_probe',
  description: 'probe',
  inputSchema: { parse: (value) => value },
  execution: {
    concurrency: 'parallel',
    resources: () => { throw new Error('resolver failed'); },
  },
  async execute() { return { ok: true, output: 'x' }; },
};
const policy = resolveToolExecutionPolicy(throwingTool, {}, ctx);
const emptyResourcePolicy = { concurrency: policy.concurrency, resources: policy.resources };
const f02 = {
  concurrencyAfterThrow: policy.concurrency,
  resourcesAfterThrow: policy.resources,
  verdict: policy.concurrency === 'exclusive'
    ? 'conservative: a failed resolution serialises the call'
    : 'UNSAFE: a failed resolution left the call parallel with no resources',
  schedulerView: {
    conflictsWithAnything: toolResourcesConflict([], [{ key: 'fs:anywhere', mode: 'write' }]),
  },
};

// ── F-03 ────────────────────────────────────────────────────────────────────────────────────────────
// Two arms: the old shape (generation that falls back) and the new shape (revision folded into the key),
// driven through the same service interface so the difference is the rule alone.
async function revisionProbe(mode) {
  let revision = 0;
  let reads = 0;
  const tool = {
    name: 'read',
    description: 'probe',
    inputSchema: { parse: (value) => value },
    execution: { concurrency: 'parallel', resources: () => [{ key: 'fs:probe', mode: 'read' }] },
    async execute() { reads += 1; return { ok: true, output: `content-${reads}` }; },
  };
  const service = new ToolExecutionService({
    registrations: [{ tool, source: 'builtin' }],
    toolContext: ctx,
    maxRepeat: 3,
    ...(mode === 'revision'
      ? { resourceRevision: () => revision }
      : { resourceChangeCursor: () => revision }),
  });
  const trace = [];
  const call = async (label) => {
    const result = await service.executeBatch([{ callId: `${label}-${trace.length}`, name: 'read', input: { file_path: 'p.txt' } }]);
    const record = service.snapshot().records.at(-1);
    trace.push({ step: label, revision, ok: result.get(0)?.ok === true, status: record?.status });
  };
  // Old revision: read three times, which spends the bound.
  await call('old-1'); await call('old-2'); await call('old-3');
  // A trusted change.
  revision = 1;
  await call('new-1');
  // The same new revision again: this is the read F-03 says was wrongly refused.
  await call('new-2');
  return { mode, trace, newRevisionReadsAllowed: trace.filter((entry) => entry.step.startsWith('new-') && entry.ok).length };
}

const oldShape = await revisionProbe('generation');
const newShape = await revisionProbe('revision');

// ── report ──────────────────────────────────────────────────────────────────────────────────────────
const payload = {
  generatedAt: new Date().toISOString(),
  F02: f02,
  F03: {
    oldShape,
    newShape,
    verdict: newShape.newRevisionReadsAllowed === 2
      ? 'fixed: every read of the new revision shares the new revision key and its bound'
      : 'still broken: a read of the new revision is refused',
  },
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
