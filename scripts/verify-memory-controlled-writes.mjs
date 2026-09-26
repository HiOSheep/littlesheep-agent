// RS-07 memory acceptance: the controlled write/forget/correct surface, exercised through the real
// runner, the real Memory v3 repository and the real session store, in an isolated data root.
//
// What this proves and what it does not:
//   - every step below runs against real storage in a temporary data root, which is restarted
//     (the runner is shut down and a second one is built over the same directory) where a claim is
//     about durability;
//   - the model is a controlled double. It is used exactly where the taskbook allows it — to place
//     requests, tool arguments and call counts at a boundary — and never to stand in for storage,
//     retrieval or the runtime's own authorization checks;
//   - a real-model pass is NOT part of this script. The report says so in `limits`, because a
//     controlled double cannot prove that a real model chooses to call the tools well.
//
// Run: node scripts/verify-memory-controlled-writes.mjs

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { MemoryRepository, createMemoryV3ExperimentMarker } from '../packages/memory-tree/dist/index.js';
import { mkdtemp as mkdtempFs, rm as rmFs } from 'node:fs/promises';
import { createRunner } from '../packages/runner/dist/runner.js';

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-controlled-writes-'));
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const originalFetch = globalThis.fetch;
/** Every scenario's outcome, in the order the taskbook's acceptance table asks for them. */
const scenarios = [];
const limits = [];
const notices = [];
let blockedNetworkAttempts = 0;
let runner;
let report;
let failure;

const APPROVAL = { approvalGranted: true };

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the controlled memory acceptance.');
  };
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  // RS-08: the memory write path cannot be switched on by accident. A data root without the isolated
  // data marker (or an active migration locator) must be refused before any storage is opened, which is
  // what keeps a rollback build from quietly resuming the automatic writes this batch removed.
  {
    const bareDir = await mkdtempFs(join(tmpdir(), 'littlesheep-memory-no-marker-'));
    let refusal;
    try {
      const repository = new MemoryRepository({
        dataDir: bareDir,
        backend: 'v3',
      });
      await repository.initialize();
    } catch (error) {
      refusal = error;
    } finally {
      await rmFs(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
    assert(refusal, 'A v3 memory repository opened a data root with no marker or migration locator.');
    assert(/refusing to open this data root/u.test(refusal.message),
      `Unexpected refusal message: ${refusal.message}`);
    scenarios.push({
      scenario: '受控启动拒绝（无隔离标识 / 无迁移 locator）',
      evidence: { refused: true, messageMatched: true },
      result: 'pass',
    });
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  // A short session triggers compaction in scenario 4 without a thousand messages.
  config.sessions.compaction = { threshold: 0.5, keepRecent: 2, ...(config.sessions.compaction.background === undefined
    ? {}
    : { background: config.sessions.compaction.background }) };

  const boot = async () => {
    const requests = [];
    const instance = await createRunner({
      config: structuredClone(config),
      branding: DEFAULT_BRANDING,
      model: 'acceptance/model',
      llm: queueLlm(requests),
      skillsDirs: [],
    });
    return { runner: instance, requests };
  };

  const first = await boot();
  runner = first.runner;

  // ─── 0. The tools the agent can actually call ────────────────────────────────────────────────────
  const names = runner.infra.registry.names();
  assert(names.includes('memory_tree'), 'memory_tree is not registered.');
  assert(names.includes('memory_write'), 'memory_write is not registered.');
  assert(names.includes('memory_manage'), 'memory_manage is not registered.');
  assert(!names.includes('write_memory') && !names.includes('record_experience'),
    'A retired memory writer is still registered.');
  // Every tool is read from the *current* runner: after a restart the previous instance's ports point at
  // closed storage, and using them would test nothing.
  const tool = (name) => runner.infra.registry.get(name).tool;
  const treeTool = tool('memory_tree');
  // The navigation tool is read-only: the five read actions parse, and every write-shaped action does
  // not. This is checked on the registered tool, not on a copy of the list in a doc.
  const treeReads = ['root_index', 'branch_index', 'expand', 'deep_search', 'release'];
  for (const action of treeReads) {
    assert(treeTool.inputSchema.safeParse({ action, ...(action === 'expand' || action === 'deep_search'
      ? { branch: 'long-term', query: 'x' }
      : action === 'branch_index' ? { branch: 'long-term' }
        : action === 'release' ? { atomIds: ['atom'] } : {}) }).success,
    `memory_tree no longer accepts the read action ${action}.`);
  }
  for (const action of ['write', 'remember', 'invalidate', 'forget', 'correct', 'manage']) {
    assert(!treeTool.inputSchema.safeParse({ action }).success,
      `memory_tree accepts the write-shaped action ${action}.`);
  }
  scenarios.push({
    scenario: '可调用工具目录',
    evidence: {
      registered: ['memory_tree', 'memory_write', 'memory_manage'],
      memoryTreeActions: treeReads,
      memoryTreeRejects: ['write', 'remember', 'invalidate', 'forget', 'correct', 'manage'],
    },
    result: 'pass',
  });

  const session = await runner.sessionManager.create('acceptance/model');
  const append = async (id, text, runId, role = 'user') => {
    await runner.sessionManager.append(session.id, [{
      id,
      role,
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
      runId,
    }]);
  };

  // ─── 1. An explicit "remember this", then a restart, then recall in a new session ────────────────
  await append('remember-port', '记住：本地开发端口是 5432。', 'run-remember');
  const rememberArgs = {
    reasonKind: 'user-request',
    summary: '本地开发端口',
    content: '本地开发端口是 5432。',
    retrievalKeys: ['本地端口', '开发环境'],
    reason: '用户明确要求记住。',
    sourceMessageIds: ['remember-port'],
  };
  const toolContext = (runId) => ({ sessionId: session.id, runId, cwd: workspace, ...APPROVAL });
  const remembered = await tool('memory_write').execute(rememberArgs, toolContext('run-remember'));
  assert.equal(remembered.ok, true, `memory_write failed: ${remembered.error}`);
  const portAtom = remembered.meta.memoryWriteAtomId;
  assert(portAtom, 'memory_write did not report the atom it committed.');

  // Source binding: the atom cites the user message record, and nothing else.
  const storedAtom = await runner.infra.memoryRepository.management.inspectNode(portAtom, 'D3');
  assert.deepEqual(storedAtom.atom.sourceRefs, ['conversation-source:run-remember:user-message:remember-port'],
    'The committed atom is not traceable to the user message that asked for it.');

  // Idempotency: the same request again does not create a second memory.
  const repeated = await tool('memory_write').execute(rememberArgs, toolContext('run-remember-2'));
  assert.equal(repeated.ok, true);
  const afterRepeat = await runner.infra.memoryRepository.listNodes('long-term');
  assert.equal(afterRepeat.length, 1, `A repeated write created a duplicate: ${afterRepeat.length} atoms.`);

  await runner.shutdown();
  const second = await boot();
  runner = second.runner;

  // Recall is proved where it matters: a new session, after the restart, asks a question and the
  // model's own request carries the remembered fact. The navigation tools are checked separately
  // because a bounded index is not the same claim as the body entering Context.
  const freshSession = await runner.sessionManager.create('acceptance/model');
  const recallRun = await runner.run({ sessionId: freshSession.id, text: '本地开发端口是多少？' });
  assert.equal(recallRun.status, 'ok', `The recall run failed: ${recallRun.status}`);
  const recalledBody = second.requests
    .flatMap((request) => request.messages ?? [])
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
  assert(recalledBody.includes('5432'),
    'The remembered fact did not reach the model in a new session after the restart.');
  // And the run's own memory accounting names that atom, so the fact arrived through memory navigation
  // rather than because a test happened to include it.
  const recallReferences = recallRun.memoryAccess?.knownState?.references ?? [];
  assert(recallReferences.some((reference) => reference.atomId === portAtom),
    `The recall run did not account for the remembered atom: ${recallReferences.map((entry) => entry.atomId).join(', ')}`);
  const recallExpands = (recallRun.memoryAccess?.records ?? []).filter((record) => record.action === 'expand');
  assert(recallExpands.length > 0, 'The recall run expanded no memory branch.');
  scenarios.push({
    scenario: '明确记住 → 重启 → 新会话召回',
    evidence: {
      atom: portAtom,
      sourceRefs: storedAtom.atom.sourceRefs,
      duplicateWrites: 0,
      factReachedNewSession: true,
      recallRunMemoryAccess: {
        tokensUsed: recallRun.memoryAccess?.tokensUsed ?? 0,
        branches: recallRun.memoryAccess?.expandedBranches ?? [],
        expands: recallExpands.length,
        referenceDecision: recallReferences.find((reference) => reference.atomId === portAtom)?.decision,
      },
    },
    result: 'pass',
  });

  // ─── 2. A necessary decision the user did not say "remember" about ───────────────────────────────
  await append('necessary-window', '发布窗口定在每周五 15:00 之后，其他时间不动生产。', 'run-necessary');
  const necessary = await tool('memory_write').execute({
    reasonKind: 'necessary',
    summary: '生产发布窗口',
    content: '生产发布窗口是每周五 15:00 之后。',
    retrievalKeys: ['发布窗口', '生产'],
    reason: '这是用户与团队确认过的硬约束，后续排期都要避开它；不记住会重复排期冲突。',
    sourceMessageIds: ['necessary-window'],
  }, toolContext('run-necessary'));
  assert.equal(necessary.ok, true, `necessary write failed: ${necessary.error}`);
  const windowAtom = necessary.meta.memoryWriteAtomId;

  // The same request with a thin reason is refused.
  const thin = await tool('memory_write').execute({
    reasonKind: 'necessary',
    summary: '生产发布窗口',
    content: '生产发布窗口是每周五 15:00 之后。',
    retrievalKeys: ['发布窗口'],
    reason: '有用',
    sourceMessageIds: ['necessary-window'],
  }, toolContext('run-necessary'));
  assert.equal(thin.meta.errorKind, 'memory_write_reason_thin');
  scenarios.push({
    scenario: '必要条件写入与薄弱理由拒绝',
    evidence: { committed: windowAtom, thinReasonErrorKind: thin.meta.errorKind },
    result: 'pass',
  });

  // ─── 3. Ordinary chat and unsupported writes do not touch durable memory ─────────────────────────
  const atomsBeforeChat = (await runner.infra.memoryRepository.listNodes('long-term')).length;
  const chatRun = await runner.run({ sessionId: session.id, text: '你好，今天天气怎么样？' });
  assert.equal(chatRun.status, 'ok', `The chat run did not finish: ${chatRun.status}`);
  const atomsAfterChat = (await runner.infra.memoryRepository.listNodes('long-term')).length;
  assert.equal(atomsAfterChat, atomsBeforeChat, 'An ordinary chat turn wrote a durable memory.');

  // The model cannot authorize a write on the user's behalf.
  await append('unrelated', '这个构建为什么失败？', 'run-unrelated');
  const unrequested = await tool('memory_write').execute({
    reasonKind: 'user-request',
    summary: '构建失败原因',
    content: '构建失败是因为缺少依赖。',
    retrievalKeys: ['构建'],
    reason: '模型认为这条重要。',
    sourceMessageIds: ['unrelated'],
  }, toolContext('run-unrelated'));
  assert.equal(unrequested.ok, false);
  assert.equal(unrequested.meta.errorKind, 'memory_write_not_authorized');
  assert.equal((await runner.infra.memoryRepository.listNodes('long-term')).length, atomsAfterChat,
    'An unauthorized write changed durable memory.');
  scenarios.push({
    scenario: '普通闲聊不写、模型不能自授权',
    evidence: {
      chatRunStatus: chatRun.status,
      atomsBefore: atomsBeforeChat,
      atomsAfter: atomsAfterChat,
      unauthorizedErrorKind: unrequested.meta.errorKind,
    },
    result: 'pass',
  });

  // ─── 4. Compaction under pressure produces a summary and learns nothing ──────────────────────────
  const atomsBeforeCompaction = (await runner.infra.memoryRepository.listNodes('long-term')).length;
  for (let index = 0; index < 12; index += 1) {
    await append(`pressure-${index}`, `进度记录 ${index}：${'x'.repeat(240)}`, `run-pressure-${index}`);
  }
  const pressured = await runner.run({ sessionId: session.id, text: '继续推进' });
  assert.equal(pressured.status, 'ok');
  const atomsAfterCompaction = (await runner.infra.memoryRepository.listNodes('long-term')).length;
  assert.equal(atomsAfterCompaction, atomsBeforeCompaction,
    'Compaction created durable memory, which it must not do any more (RS-05).');
  const metadataAfterCompaction = await runner.sessionManager.loadMetadata(session.id);
  scenarios.push({
    scenario: '正常压力压缩不学习',
    evidence: {
      atomsBefore: atomsBeforeCompaction,
      atomsAfter: atomsAfterCompaction,
      compaction: metadataAfterCompaction?.compaction ? 'summary-present' : 'no-summary-yet',
    },
    result: 'pass',
  });
  if (!metadataAfterCompaction?.compaction) {
    notices.push('Compaction did not trigger within twelve long turns; the no-learning claim is proved by the '
      + 'unchanged atom count and by the RS-06A/RS-05 tests, not by a summary in this run.');
  }

  // ─── 5. A user correction, and the restart that must not undo it ─────────────────────────────────
  await append('correct-port', '刚才记错了：本地开发端口是 6432。', 'run-correct');
  await runner.infra.memoryService.beginRun({
    runId: 'run-correct', sessionId: session.id, query: '本地端口', recentHistory: [], workspace,
  });
  await runner.infra.memoryService.expand('run-correct', { branchId: 'long-term', query: '本地端口' });
  // Read the revision as it is now, the way a client must: the earlier reinforcement moved it on.
  const beforeCorrection = await runner.infra.memoryRepository.management.inspectNode(portAtom, 'D3');
  const correction = await tool('memory_manage').execute({
    action: 'correct',
    atomId: portAtom,
    expectedRevision: beforeCorrection.atom.revision,
    reason: '用户说刚才记错了，端口是 6432。',
    sourceMessageIds: ['correct-port'],
    replacement: {
      summary: '本地开发端口',
      content: '本地开发端口是 6432。',
      retrievalKeys: ['本地端口', '开发环境'],
    },
  }, toolContext('run-correct'));
  assert.equal(correction.ok, true, `memory_manage correct failed: ${correction.error}`);
  const replacement = correction.meta.memoryManageReplacementAtomId;
  const supersededAtom = await runner.infra.memoryRepository.management.inspectNode(portAtom, 'D3');
  assert.equal(supersededAtom.atom.supersession?.byAtomId, replacement);

  // Stale revision: a second correction naming the old revision is refused, not applied twice.
  const stale = await tool('memory_manage').execute({
    action: 'correct',
    atomId: portAtom,
    expectedRevision: beforeCorrection.atom.revision,
    reason: '重复的纠正。',
    sourceMessageIds: ['correct-port'],
    replacement: { summary: '本地开发端口', content: '本地开发端口是 6432。', retrievalKeys: ['本地端口'] },
  }, toolContext('run-correct'));
  assert.equal(stale.ok, false);
  assert(['memory_manage_stale_revision', 'memory_manage_unsupported'].includes(stale.meta.errorKind),
    `A repeated correction was not refused: ${stale.meta.errorKind}`);

  const currentAfterCorrection = await runner.infra.memoryService.expand('run-correct', { branchId: 'long-term', query: '本地端口' });
  const currentBody = currentAfterCorrection.fragments.map((fragment) => fragment.content).join('\n');
  assert(currentBody.includes('6432'), 'The corrected fact is not the current one.');
  assert(!currentBody.includes('5432'), 'The superseded fact is still being injected.');

  await runner.shutdown();
  const third = await boot();
  runner = third.runner;
  // After the restart, ask the question in a fresh session and read what the model was actually told:
  // that is the claim "only the new statement is current".
  const correctionSession = await runner.sessionManager.create('acceptance/model');
  const correctionRun = await runner.run({ sessionId: correctionSession.id, text: '本地开发端口是多少？' });
  assert.equal(correctionRun.status, 'ok');
  const afterRestartBody = third.requests
    .flatMap((request) => request.messages ?? [])
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
  assert(afterRestartBody.includes('6432'),
    'The corrected fact did not reach the model after the restart.');
  assert(!afterRestartBody.includes('5432'),
    'The superseded statement is still being injected after the restart.');
  const history = await runner.infra.memoryRepository.management.inspectNode(portAtom, 'D3');
  assert(history.atom.supersession, 'The earlier atom lost its supersession record across the restart.');
  scenarios.push({
    scenario: '用户自然语言纠正（5432 → 6432）',
    evidence: {
      superseded: portAtom,
      replacement,
      relationId: correction.meta.memoryManageRelationId,
      repeatedCorrectionErrorKind: stale.meta.errorKind,
      currentAfterRestartIsReplacement: true,
      historyRetained: true,
    },
    result: 'pass',
  });

  // ─── 6. Forgetting, the revocation marker, and the restart that must not revive it ───────────────
  await append('forget-window', '忘掉之前那条发布窗口。', 'run-forget');
  await runner.infra.memoryService.beginRun({
    runId: 'run-forget', sessionId: session.id, query: '发布窗口', recentHistory: [], workspace,
  });
  await runner.infra.memoryService.expand('run-forget', { branchId: 'long-term', query: '发布窗口' });
  const windowInspection = await runner.infra.memoryRepository.management.inspectNode(windowAtom, 'D3');
  const forgotten = await tool('memory_manage').execute({
    action: 'forget',
    atomId: windowAtom,
    expectedRevision: windowInspection.atom.revision,
    reason: '用户要求忘记发布窗口。',
    sourceMessageIds: ['forget-window'],
  }, toolContext('run-forget'));
  assert.equal(forgotten.ok, true, `memory_manage forget failed: ${forgotten.error}`);
  assert.equal(forgotten.meta.memoryManageOutcome, 'committed');

  // A repeated forget is idempotent, not an error.
  const repeatedForget = await tool('memory_manage').execute({
    action: 'forget',
    atomId: windowAtom,
    expectedRevision: windowInspection.atom.revision,
    reason: '再次忘记。',
    sourceMessageIds: ['forget-window'],
  }, toolContext('run-forget'));
  assert.equal(repeatedForget.ok, true);
  assert.equal(repeatedForget.meta.memoryManageOutcome, 'already-inactive');

  const forgottenBody = (await runner.infra.memoryService.expand('run-forget', { branchId: 'long-term', query: '发布窗口' }))
    .fragments.map((fragment) => fragment.content).join('\n');
  assert(!forgottenBody.includes('15:00'), 'The forgotten fact is still injected.');

  // The revocation marker is written by the run's finalize step, and survives the restart.
  const revokedRun = await runner.run({ sessionId: session.id, text: '继续' });
  assert.equal(revokedRun.status, 'ok');
  const revokedMetadata = await runner.sessionManager.loadMetadata(session.id);
  assert(revokedMetadata?.memoryRevokedAt, 'A committed forget did not revoke the session summaries.');

  await runner.shutdown();
  const fourth = await boot();
  runner = fourth.runner;
  const revivedMetadata = await runner.sessionManager.loadMetadata(session.id);
  assert.equal(revivedMetadata?.memoryRevokedAt, revokedMetadata.memoryRevokedAt,
    'The revocation marker did not survive the restart.');
  await runner.infra.memoryService.beginRun({
    runId: 'run-after-forget', sessionId: session.id, query: '发布窗口', recentHistory: [], workspace,
  });
  const afterForget = await runner.infra.memoryService.expand('run-after-forget', { branchId: 'long-term', query: '发布窗口' });
  const afterForgetBody = afterForget.fragments.map((fragment) => fragment.content).join('\n');
  assert(!afterForgetBody.includes('15:00'), 'The forgotten fact came back after the restart.');
  assert((await runner.infra.memoryRepository.listNodes('long-term')).some((node) => node.id === windowAtom),
    'The forgotten record was deleted instead of kept as history.');
  scenarios.push({
    scenario: '用户自然语言忘记 + 撤销标记 + 重启不复活',
    evidence: {
      atom: windowAtom,
      outcome: forgotten.meta.memoryManageOutcome,
      repeatedOutcome: repeatedForget.meta.memoryManageOutcome,
      memoryRevokedAt: revokedMetadata.memoryRevokedAt,
      survivedRestart: true,
      recordRetained: true,
    },
    result: 'pass',
  });

  // ─── 7. The refusals the table asks for, each with its own reason ────────────────────────────────
  const refusals = {};
  const unknown = await tool('memory_manage').execute({
    action: 'forget',
    atomId: 'memory-atom:does-not-exist',
    expectedRevision: 1,
    reason: '用户要求忘记这条。',
    sourceMessageIds: ['forget-window'],
  }, toolContext('run-refusals'));
  refusals.unknownTarget = unknown.meta.errorKind;

  const invisible = await tool('memory_manage').execute({
    action: 'forget',
    atomId: replacement,
    expectedRevision: 1,
    reason: '用户要求忘记这条。',
    sourceMessageIds: ['forget-window'],
  }, toolContext('run-never-navigated'));
  refusals.notSeenByRun = invisible.meta.errorKind;

  const unauthorized = await tool('memory_manage').execute({
    action: 'forget',
    atomId: replacement,
    expectedRevision: 1,
    reason: '模型认为该忘记。',
    sourceMessageIds: ['unrelated'],
  }, toolContext('run-refusals'));
  refusals.notAuthorized = unauthorized.meta.errorKind;

  const missingSource = await tool('memory_write').execute({
    ...rememberArgs,
    content: '本地开发端口是 6432 以外的值。',
    sourceMessageIds: ['no-such-message'],
  }, toolContext('run-refusals'));
  refusals.missingSource = missingSource.meta.errorKind;

  const unapproved = await tool('memory_write').execute(rememberArgs, {
    sessionId: session.id, runId: 'run-refusals', cwd: workspace, permissionMode: 'restricted',
  });
  refusals.withoutApproval = unapproved.meta.errorKind;

  // A cited tool result that the runtime truncated cannot support a durable fact.
  await runner.sessionManager.append(session.id, [{
    id: 'truncated-tool',
    role: 'assistant',
    content: [{
      type: 'tool_result',
      result: {
        callId: 'call-truncated',
        ok: true,
        output: 'partial output ... [truncated: 40 chars omitted]',
        sanitized: true,
        meta: { truncated: true },
      },
    }],
    timestamp: new Date().toISOString(),
    runId: 'run-refusals',
  }]);
  const truncatedCite = await tool('memory_write').execute({
    reasonKind: 'necessary',
    summary: '工具输出结论',
    content: '工具输出显示构建通过。',
    retrievalKeys: ['构建'],
    reason: '这条结论后续会用于判断是否可以发布，不记住需要重新跑一次构建。',
    sourceMessageIds: ['truncated-tool'],
  }, toolContext('run-refusals'));
  refusals.truncatedSource = truncatedCite.meta.errorKind;

  for (const [name, kind] of Object.entries(refusals)) {
    assert.equal(typeof kind, 'string', `The ${name} case did not produce an error kind.`);
  }
  assert.equal(refusals.unknownTarget, 'memory_manage_target_missing');
  assert.equal(refusals.notSeenByRun, 'memory_manage_target_not_visible');
  assert.equal(refusals.notAuthorized, 'memory_manage_not_authorized');
  assert.equal(refusals.missingSource, 'memory_write_source_missing');
  assert.equal(refusals.withoutApproval, 'memory_write_not_approved');
  assert.equal(refusals.truncatedSource, 'memory_write_source_incomplete');
  scenarios.push({ scenario: '拒绝情形逐项可辨', evidence: refusals, result: 'pass' });

  // ─── 8. §2.1 on real storage: a changed value never merges into the old statement ────────────────
  await append('regression-5432', '记住：回归测试用的端口是 5432。', 'run-regression');
  const regressionOld = await tool('memory_write').execute({
    reasonKind: 'user-request',
    summary: '回归测试端口',
    content: '回归用的服务端口是 5432，仅用于本地测试。',
    retrievalKeys: ['回归端口'],
    reason: '用户明确要求记住。',
    sourceMessageIds: ['regression-5432'],
  }, toolContext('run-regression'));
  assert.equal(regressionOld.ok, true);
  await append('regression-6432', '记住：回归测试用的端口是 6432。', 'run-regression-2');
  const regressionNew = await tool('memory_write').execute({
    reasonKind: 'user-request',
    summary: '回归测试端口',
    content: '回归用的服务端口是 6432，仅用于本地测试。',
    retrievalKeys: ['回归端口'],
    reason: '用户明确要求记住。',
    sourceMessageIds: ['regression-6432'],
  }, toolContext('run-regression-2'));
  assert.equal(regressionNew.ok, false, 'A changed value was committed as a merge.');
  assert.equal(regressionNew.meta.errorKind, 'memory_write_rejected');
  const regressionAtomId = regressionOld.meta.memoryWriteAtomId;
  const regressionAtom = await runner.infra.memoryRepository.management.inspectNode(regressionAtomId, 'D3');
  assert(regressionAtom.atom.content.includes('5432'), 'The existing statement changed under a refused write.');
  assert(!regressionAtom.atom.content.includes('6432'), 'The refused write leaked into the existing statement.');
  const regressionRefs = regressionAtom.atom.sourceRefs.join(' ');
  assert(!regressionRefs.includes('regression-6432'),
    'The refused statement was attached to the old fact as its evidence.');
  scenarios.push({
    scenario: '§2.1 常驻回归（真实 V3 存储）',
    evidence: {
      atom: regressionAtomId,
      refusedKind: regressionNew.meta.errorKind,
      bodyUnchanged: true,
      newSourceNotAttached: true,
      auditRecorded: (await runner.infra.memoryRepository.snapshot()).writeAudit
        .some((entry) => entry.decision === 'rejected'),
    },
    result: 'pass',
  });

  assert.equal(blockedNetworkAttempts, 0, 'The acceptance attempted network access.');

  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataRoot: { isolated: true, restarts: 4 },
    scenarios,
    refusals,
    limits: [
      'The model is a controlled double: this run proves what the runtime does with the calls it is given, '
      + 'not that a real model issues them well. A real-model pass over an isolated data root is still owed.',
      ...limits,
    ],
    notices,
    network: { blockedAttempts: blockedNetworkAttempts },
    resources: {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rssMiB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
    },
  };
} catch (error) {
  failure = error;
} finally {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  try { await runner?.shutdown(); } catch (error) { failure ??= error; }
  try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;

function queueLlm(requests) {
  return {
    async chat(request) {
      requests.push(request);
      return { content: '好的。', toolCalls: [], finishReason: 'stop' };
    },
    async chatStream(request, onDelta) {
      requests.push(request);
      onDelta({ type: 'delta', delta: '好的。' });
      onDelta({ type: 'done', finishReason: 'stop' });
      return { content: '好的。', toolCalls: [], finishReason: 'stop' };
    },
    async embed() {
      return { embeddings: [], model: '', usage: { promptTokens: 0 } };
    },
  };
}
