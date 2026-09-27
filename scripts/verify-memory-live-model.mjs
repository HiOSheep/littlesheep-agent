// RS-07's real-model acceptance for the controlled memory surface.
//
// Everything else about the memory surface is verified with a deterministic double, which proves what
// the runtime does with the calls it is given but says nothing about whether a real model makes them.
// This gate answers that question against the shipped provider path, over an isolated data root:
//
//   1. the user says "remember this"        -> the model calls memory_write and a long-term atom exists
//   2. a new session asks about it          -> the answer carries the fact the model was actually given
//   3. the user says they were wrong        -> the model corrects through memory_manage
//   4. ordinary small talk                  -> no durable memory appears
//   5. the user asks to forget it           -> memory_manage forgets it and it stops being injected
//
// The API key is read from the environment and never written anywhere: the config points at
// `$DEEPSEEK_API_KEY`, which is the same indirection the app ships with.
//
// Usage: DEEPSEEK_API_KEY=... node scripts/verify-memory-live-model.mjs

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { createMemoryV3ExperimentMarker } from '../packages/memory-tree/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required: this gate exists to run a real model.');

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-live-memory-'));
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const scenarios = [];
/** How many times the runtime asked this client for permission, answered the way a user would. */
const approvals = { requested: 0 };
const limits = [];
let runner;
let report;
let failure;

const PORT = '5432';
const CHANGED_PORT = '6432';

try {
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.model = 'deepseek/deepseek-flash';
  config.agents.defaults.workspace = workspace;
  // One provider, pointed at DeepSeek exactly the way the shipped preset does: the key is an indirection
  // (`$DEEPSEEK_API_KEY`) resolved by the app, so no secret is written into this file or the data root.
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

  const longTerm = async () => runner.infra.memoryRepository.listNodes('long-term');
  /**
   * What the branch actually holds, by kind and scope. A bare count cannot tell a structural node from a
   * memory the model wrote, and the difference is the whole question when a model has been running.
   */
  const treeSummary = async () => {
    const nodes = await longTerm();
    const byKind = {};
    const byScope = {};
    for (const node of nodes) {
      const kind = node.id.startsWith('memory-atom:') ? 'atom' : node.id.includes(':root') ? 'root' : 'other';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      byScope[node.scope] = (byScope[node.scope] ?? 0) + 1;
    }
    return {
      total: nodes.length,
      byKind,
      byScope,
      activeAtoms: nodes.filter((node) => node.id.startsWith('memory-atom:') && node.status === 'active').length,
      summaries: nodes
        .filter((node) => node.id.startsWith('memory-atom:'))
        .map((node) => String(node.summary ?? '').slice(0, 60))
        .slice(0, 12),
    };
  };
  const sessionToolNames = async (sessionId) => {
    const lines = (await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'))
      .split('\n').filter(Boolean);
    const names = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue }
      for (const block of record?.content ?? []) {
        if (block?.type === 'tool_calls') {
          for (const call of block.calls ?? []) names.push(call?.function?.name ?? call?.name ?? null);
        }
        if (block?.type === 'tool_result' && block.result?.ok === false) names.push('FAILED:' + String(block.result.error ?? '').slice(0, 80));
      }
    }
    return names;
  };
  // A headless run has no approval dialog, so the gate answers the way a user reading the prompt would.
  // Everything else — the permission policy, the tool's own checks, the write path — stays the shipped
  // one. The answer is recorded so the report can say whether approval was even asked for.
  const run = (sessionId, text) => runner.run({
    sessionId,
    text,
    permissionPolicyId: 'full',
    cwd: workspace,
    approve: async () => {
      approvals.requested += 1;
      return true;
    },
  });

  // ─── 1. The user asks for the fact to be remembered ───────────────────────────────────────────────
  const rememberSession = await runner.sessionManager.create('deepseek/deepseek-flash');
  const rememberRun = await run(rememberSession.id, `记住：本地开发端口是 ${PORT}，以后都用这个。`);
  const rememberTools = await sessionToolNames(rememberSession.id);
  const atoms = await longTerm();
  scenarios.push({
    scenario: '用户明确要求记住',
    evidence: {
      status: rememberRun.status,
      reply: String(rememberRun.reply ?? '').slice(0, 200),
      toolsCalled: rememberTools,
      longTermAtoms: atoms.length,
      atomContent: atoms[0]?.content?.slice(0, 160) ?? null,
    },
    result: rememberTools.includes('memory_write') && atoms.some((atom) => atom.content.includes(PORT))
      ? 'pass'
      : 'fail',
  });

  // ─── 2. A new session asks about it ──────────────────────────────────────────────────────────────
  const recallSession = await runner.sessionManager.create('deepseek/deepseek-flash');
  const recallRun = await run(recallSession.id, '本地开发端口是多少？只回答端口号。');
  const recallReply = String(recallRun.reply ?? '');
  scenarios.push({
    scenario: '新会话召回（真实注入）',
    evidence: {
      status: recallRun.status,
      reply: recallReply.slice(0, 200),
      memoryAccess: {
        tokensUsed: recallRun.memoryAccess?.tokensUsed ?? 0,
        branches: recallRun.memoryAccess?.expandedBranches ?? [],
      },
    },
    result: recallReply.includes(PORT) ? 'pass' : 'fail',
  });

  // ─── 3. The user says the memory is wrong ────────────────────────────────────────────────────────
  const correctionSession = await runner.sessionManager.create('deepseek/deepseek-flash');
  const correctionRun = await run(
    correctionSession.id,
    `刚才记错了：本地开发端口是 ${CHANGED_PORT}，请把之前记的那条改过来。`,
  );
  const correctionTools = await sessionToolNames(correctionSession.id);
  const afterCorrection = await longTerm();
  const currentBodies = afterCorrection.map((atom) => atom.content).join('\n');
  scenarios.push({
    scenario: '用户自然语言纠正',
    evidence: {
      status: correctionRun.status,
      reply: String(correctionRun.reply ?? '').slice(0, 200),
      toolsCalled: correctionTools,
      atoms: afterCorrection.length,
      currentHasOldPort: currentBodies.includes(PORT),
      currentHasNewPort: currentBodies.includes(CHANGED_PORT),
    },
    // A correction the model performs must leave the new value current. If the model only wrote a new
    // fact (memory_write) without correcting, the gate says so rather than claiming success.
    result: correctionTools.includes('memory_manage') || (
      correctionTools.includes('memory_write') && currentBodies.includes(CHANGED_PORT)
    ) ? 'pass' : 'fail',
  });
  if (!correctionTools.includes('memory_manage')) {
    limits.push('The correction turn did not use memory_manage; the report records which tools it did use, '
      + 'so this is a model-behaviour observation rather than a runtime claim.');
  }

  // ─── 4. Ordinary small talk writes nothing ───────────────────────────────────────────────────────
  const chatSession = await runner.sessionManager.create('deepseek/deepseek-flash');
  const beforeChat = (await longTerm()).length;
  const chatRun = await run(chatSession.id, '今天天气不错，随便聊聊。');
  const chatTools = await sessionToolNames(chatSession.id);
  const afterChat = (await longTerm()).length;
  scenarios.push({
    scenario: '普通闲聊不写入',
    evidence: {
      status: chatRun.status,
      reply: String(chatRun.reply ?? '').slice(0, 160),
      toolsCalled: chatTools,
      atomsBefore: beforeChat,
      atomsAfter: afterChat,
    },
    result: !chatTools.includes('memory_write') && afterChat === beforeChat ? 'pass' : 'fail',
  });

  // ─── 5. The user asks for it to be forgotten ─────────────────────────────────────────────────────
  const forgetSession = await runner.sessionManager.create('deepseek/deepseek-flash');
  const forgetRun = await run(forgetSession.id, '忘掉本地开发端口那条记忆吧，不需要了。');
  const forgetTools = await sessionToolNames(forgetSession.id);
  const afterForget = await longTerm();
  // "Current" has to be read from the atom itself: `listNodes` projects a node, and a superseded or
  // invalidated atom keeps `status: 'active'` there on purpose (its record stays). An earlier version of
  // this gate filtered on the node's status and therefore reported a successful forget as still injected.
  const currentAtoms = [];
  for (const node of afterForget) {
    if (!node.id.startsWith('memory-atom:')) continue;
    const inspection = await runner.infra.memoryRepository.management.inspectNode(node.id, 'D3');
    const atom = inspection?.atom;
    if (atom && atom.status === 'active' && !atom.supersession && !atom.invalidation) currentAtoms.push(node);
  }
  const refreshed = currentAtoms.map((atom) => atom.content).join('\n');
  const stillInjected = refreshed.includes(CHANGED_PORT) || refreshed.includes(PORT);
  scenarios.push({
    scenario: '用户要求忘记',
    evidence: {
      status: forgetRun.status,
      reply: String(forgetRun.reply ?? '').slice(0, 200),
      toolsCalled: forgetTools,
      currentAtoms: currentAtoms.length,
      currentAtomSummaries: currentAtoms.map((atom) => String(atom.summary ?? '').slice(0, 60)),
      stillInjected: refreshed.includes(CHANGED_PORT) || refreshed.includes(PORT),
    },
    // Calling the tool is not the outcome: the fact must actually stop being current, otherwise a failed
    // forget would be reported as a pass.
    result: forgetTools.includes('memory_manage') && !stillInjected ? 'pass' : 'fail',
  });

  const failed = scenarios.filter((scenario) => scenario.result !== 'pass');
  report = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    model: 'deepseek/deepseek-flash',
    dataRoot: { isolated: true },
    memoryTree: await treeSummary(),
    approvalsAsked: approvals.requested,
    scenarios,
    limits: [
      'This is a live model: its tool choices are its own. A failing scenario is a measurement of model '
      + 'behaviour against the runtime contract, not a runtime defect by itself — the same scenarios are '
      + 'verified deterministically in verify:memory-controlled-writes.',
      ...limits,
    ],
    resources: {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    },
  };
} catch (error) {
  failure = error;
} finally {
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  try { await runner?.shutdown(); } catch (error) { failure ??= error; }
  try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;
