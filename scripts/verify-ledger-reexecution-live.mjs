// HC-04's real-model acceptance: a real model repeats a call after its own recorded change, and the
// Runtime distinguishes that from a replay.
//
// The unit tests pin the rule against the ledger; this gate asks the harder question — does a real model
// doing real work get the outcome the rule promises? The same session runs two scenarios:
//
//   1. write report.txt = v1, edit it to v2 (a later settled change to the same resource), then write
//      report.txt = v1 again with **exactly** the arguments of the first call. The warrant makes that a new
//      execution, so the third step must succeed and the file must end up back at v1.
//   2. write notes.txt = A, then immediately write notes.txt = A again with nothing in between. There is no
//      recorded change, so the second call must be refused as a replay.
//
// Both are measured from what the runtime recorded (tool results in the session, the file bytes on disk),
// not from what the model says about itself.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/verify-ledger-reexecution-live.mjs

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { createMemoryV3ExperimentMarker } from '../packages/memory-tree/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required: this gate exists to run a real model.');

const FIRST = '版本：v1';
const SECOND = '版本：v2';
const NOTE = 'note-A';
const WARRANT_PROMPT = [
  '请在本次运行内严格按顺序执行以下步骤，每一步都要等上一步的结果出来再做，不要合并、不要跳过：',
  `1) 用 write 把 workplace/report.txt 写成「${FIRST}」；`,
  '2) 用 read 读回 workplace/report.txt；',
  `3) 用 write 把 workplace/report.txt 写成「${SECOND}」（这是对同一文件的一次真实修改，是下一步的前提）；`,
  '4) 用 read 读回 workplace/report.txt；',
  `5) 再用 write 把 workplace/report.txt 写成「${FIRST}」，参数与第 1 步**完全相同**；`,
  '6) 在回答里逐步报告：每一步是否执行、第 5 步是被执行还是被拒绝，以及第 5 步之后文件的内容。',
].join('\n');
const REPLAY_PROMPT = [
  '请在本次运行内严格按顺序执行，每一步都必须真的调用工具：',
  `1) 用 write 把 workplace/notes.txt 写成「${NOTE}」；`,
  `2) 立刻用 write 把 workplace/notes.txt 再写成「${NOTE}」，参数与第 1 步**完全相同**，中间不要做别的事；`,
  '3) 在回答里说明第 2 步是被执行还是被拒绝，并给出运行时给出的原因。',
].join('\n');

const startedAt = performance.now();
const root = await mkdtemp(join(tmpdir(), 'littlesheep-ledger-live-'));
const dataDir = join(root, 'data');
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const scenarios = [];
let runner;
let report;
let failure;

try {
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.model = 'deepseek/deepseek-flash';
  config.agents.defaults.workspace = workspace;
  config.providers = [{
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: '$DEEPSEEK_API_KEY',
    models: ['deepseek-flash'],
  }];
  await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'deepseek/deepseek-flash',
    skillsDirs: [],
    log: () => undefined,
  });

  const session = await runner.sessionManager.create('deepseek/deepseek-flash');
  const run = (text, collector) => runner.run({
    sessionId: session.id,
    text,
    cwd: workspace,
    permissionPolicyId: 'full',
    approve: async () => true,
    onToolEvent: collector.onToolEvent,
  });
  /**
   * Tool outcomes the runtime reports for the run: the execution service's own `tool_end` events, not a
   * projection this gate rebuilds by parsing the session file. The error text is what tells the two
   * refusals apart — a ledger replay ("refusing to replay tool:...") from the file-observation guard
   * ("no observation ..."), which is exactly the distinction this acceptance has to measure.
   */
  const collectEvents = () => {
    const events = [];
    return {
      events,
      onToolEvent: (event) => {
        if (event?.type !== 'tool_end') return;
        events.push({
          name: event.name,
          callId: event.callId,
          ok: event.ok === true,
          error: String(event.error ?? '').slice(0, 200),
        });
      },
    };
  };
  // ─── 1. A repeat after the model's own recorded change ──────────────────────────────────────────
  const warrantCollector = collectEvents();
  const warrantRun = await run(WARRANT_PROMPT, warrantCollector);
  const writes = warrantCollector.events.filter((event) => event.name === 'write');
  const failedWrites = writes.filter((event) => !event.ok);
  const finalBytes = await readFile(join(workspace, 'report.txt'), 'utf8').catch(() => '(missing)');
  // Two successful writes of the same content are the point: the first settles, the model's own edit is
  // the recorded change, and the write-back is a new execution rather than the replay the ledger refuses.
  const writeBackSucceeded = writes.filter((event) => event.ok).length >= 2 && !finalBytes.includes(SECOND);
  scenarios.push({
    scenario: '记录到变更后，同参数再次写入是新的执行',
    evidence: {
      status: warrantRun.status,
      reply: String(warrantRun.reply ?? '').slice(0, 320),
      writeEvents: writes,
      failedWrites,
      fileContent: finalBytes,
    },
    result: writeBackSucceeded && finalBytes.includes(FIRST) ? 'pass' : 'fail',
  });

  // ─── 2. The same call twice with nothing in between stays a replay ──────────────────────────────
  const replayCollector = collectEvents();
  const replayRun = await run(REPLAY_PROMPT, replayCollector);
  const noteWrites = replayCollector.events.filter((event) => event.name === 'write');
  const refused = noteWrites.filter((event) => !event.ok);
  const refusedAsReplay = refused.some((event) => /refusing to replay|already recorded as succeeded/u.test(event.error));
  scenarios.push({
    scenario: '中间没有任何变更时，同参数重复仍是重放且被拒绝',
    evidence: {
      status: replayRun.status,
      reply: String(replayRun.reply ?? '').slice(0, 320),
      noteWrites,
      refusedCount: refused.length,
      refusedAsReplay,
    },
    result: noteWrites.length >= 2 && refusedAsReplay ? 'pass' : 'fail',
  });

  const failed = scenarios.filter((scenario) => scenario.result !== 'pass');
  report = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    provider: 'deepseek',
    model: 'deepseek/deepseek-flash',
    dataRoot: { isolated: true },
    scenarios,
    limits: [
      'This drives the app\'s run API rather than a window, and the model\'s tool sequence is its own: a '
      + 'failing scenario is a measurement of model behaviour against the runtime contract, not a runtime '
      + 'defect by itself. The rule itself is pinned deterministically in side-effect-ledger.test.ts.',
      'The warrant is deliberately unavailable to opaque tools. A shell command repeated after a change is '
      + 'still refused, because the Runtime cannot prove what the command touches — that boundary is not '
      + 'weakened by this gate.',
    ],
    resources: { durationMs: Math.round((performance.now() - startedAt) * 100) / 100 },
  };
} catch (error) {
  failure = error;
} finally {
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  try { await runner?.shutdown(); } catch (error) { failure ??= error; }
  try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) {
  process.stderr.write(`reexecution gate failed: ${failure.message}\n`);
  process.exitCode = 1;
}
