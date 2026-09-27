// RS-08: what happens to an old data root that still carries a compaction memory proposal.
//
// The legacy state is built through the shipped API rather than by hand-writing a pending file: a real
// session compacts for real, then the same session manager commits a successor summary together with the
// kind of memory proposal the retired build produced. That leaves exactly what an older build would have
// left behind — a committed summary plus a pending proposal nobody settled — and the drill then runs the
// current build over it and checks what it does:
//
//   - the proposal is terminated: every candidate rejected, with a termination stamp and a reason that
//     names the change that retired it, and the pending file is kept as its own audit trail;
//   - no durable memory comes out of it, so an old candidate cannot revive automatic learning;
//   - the session keeps compacting and answering, and a later compaction neither re-stamps nor settles it;
//   - a data root with neither the isolated-data marker nor a migration locator is still refused before
//     any storage opens.
//
// Run: pnpm run verify-legacy-data-root-upgrade

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { MemoryRepository, createMemoryV3ExperimentMarker } from '../packages/memory-tree/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-legacy-root-'));
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const originalFetch = globalThis.fetch;
const scenarios = [];
let blockedNetworkAttempts = 0;
let runner;
let report;
let failure;

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the legacy data-root drill.');
  };
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.sessions.compaction = { threshold: 10, keepRecent: 4, background: false };

  const boot = () => createRunner({
    config: structuredClone(config),
    branding: DEFAULT_BRANDING,
    model: 'acceptance/model',
    llm: idleLlm(),
    skillsDirs: [],
  });
  const appendMany = async (sessionId, from, to, tag) => {
    for (let index = from; index < to; index += 1) {
      await runner.sessionManager.append(sessionId, [{
        id: tag + '-' + index,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: tag + ' 第 ' + index + ' 段：' + 'z'.repeat(200) }],
        timestamp: new Date().toISOString(),
        runId: 'run-' + tag + '-' + index,
      }]);
    }
  };

  // ─── 1. A real session that compacts, so there is a real summary to succeed ───────────────────────
  runner = await boot();
  const session = await runner.sessionManager.create('acceptance/model');
  const sessionId = session.id;
  await appendMany(sessionId, 0, 24, 'legacy');
  const firstRun = await runner.run({ sessionId, text: '继续' });
  assert.equal(firstRun.status, 'ok', 'The compacting run failed: ' + firstRun.status);
  const metadata = await runner.sessionManager.loadMetadata(sessionId);
  assert(metadata?.compaction, 'The fixture did not compact, so there is no real summary to chain from.');
  const atomsBefore = (await runner.infra.memoryRepository.listNodes('long-term')).length;

  // ─── 2. The legacy proposal, committed through the shipped session manager ────────────────────────
  const baseSummary = await runner.infra.sessionManager.loadCompactionProjection(sessionId, metadata.compaction.id);
  assert(baseSummary && baseSummary.version === 2, 'The committed summary is not readable as a v2 projection.');
  const legacySummaryId = 'legacy-summary-2026-09-20';
  const proposal = {
    version: 1,
    evidenceComplete: true,
    candidates: [
      {
        id: 'legacy-candidate-1',
        branch: 'long-term',
        parentNodeId: 'long-term:root',
        scope: 'global',
        summary: '旧构建提出的长期事实',
        content: '这条内容来自旧构建的压缩候选，本版本不得写入长期记忆。',
        retrievalKeys: ['legacy', 'candidate'],
        sourceMessageIds: ['legacy-1'],
        importance: 0.9,
        confidence: 0.95,
        reason: '旧构建自动学习候选。',
      },
      {
        id: 'legacy-candidate-2',
        branch: 'long-term',
        parentNodeId: 'long-term:root',
        scope: 'global',
        summary: '旧构建提出的第二条候选',
        content: '同样不得写入长期记忆。',
        retrievalKeys: ['legacy'],
        sourceMessageIds: ['legacy-3'],
        importance: 0.8,
        confidence: 0.9,
        reason: '旧构建自动学习候选。',
      },
    ],
    outcomes: [],
  };
  // A successor of the real summary: a hand-made one is not a state an old build could have left, and it
  // fails the metadata apply, which is how an earlier version of this drill misread the whole question.
  await runner.infra.sessionManager.commitCompaction(
    sessionId,
    { ...baseSummary, id: legacySummaryId, previousSummaryId: baseSummary.id },
    {
      expectedPreviousSummaryId: baseSummary.id,
      sourceEndMessageId: baseSummary.sourceEndMessageId,
      sourceHash: baseSummary.sourceHash,
      policyVersion: 1,
      transactionKey: 'legacy-transaction-key',
    },
    proposal,
  );
  const compactionRoot = join(dataDir, 'sessions', '.compactions', digest(String(sessionId)));
  const pendingPath = join(compactionRoot, 'pending', digest(legacySummaryId) + '.pending.json');
  assert(existsSync(pendingPath),
    'The shipped manager did not leave a pending proposal for the legacy state: ' + pendingPath);
  const legacyPending = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert(legacyPending.summaryCommittedAt,
    'The committed proposal carries no summaryCommittedAt, which is what the compatibility sweep filters on.');
  await runner.shutdown();

  // ─── 3. The current build opens that data root ───────────────────────────────────────────────────
  runner = await boot();
  await appendMany(sessionId, 24, 48, 'upgrade');
  const upgradedRun = await runner.run({ sessionId, text: '继续' });
  assert.equal(upgradedRun.status, 'ok', 'The upgrade run failed: ' + upgradedRun.status);

  // Where the record lives depends on which comes first: the sweep terminates the proposal, and a later
  // recovery treats a committed transaction whose predecessor has changed as a conflict and quarantines
  // it. RS-05 asks for the record to survive with the reason nothing was written, not for one particular
  // directory, so the drill accepts either place and reports which one it was.
  const quarantined = (await readdir(join(compactionRoot, 'failed')).catch(() => [])).sort();
  const auditPath = existsSync(pendingPath)
    ? pendingPath
    : (quarantined.length > 0 ? join(compactionRoot, 'failed', quarantined.at(-1)) : null);
  assert(auditPath, 'The legacy proposal left no record at all: neither pending nor quarantined.');
  const settled = JSON.parse(await readFile(auditPath, 'utf8')).memoryProposal;
  const candidateIds = settled.candidates.map((candidate) => candidate.id);
  const rejected = settled.outcomes.filter((outcome) => outcome.status === 'rejected');
  assert(settled.terminatedAt, 'The pending proposal was not stamped as terminated.');
  assert(settled.terminationReason?.includes('RS-05'),
    'The termination reason does not name the change that caused it: ' + settled.terminationReason);
  assert.equal(rejected.length, candidateIds.length,
    'Not every candidate was rejected: ' + JSON.stringify(settled.outcomes));
  const atomsAfter = (await runner.infra.memoryRepository.listNodes('long-term')).length;
  assert.equal(atomsAfter, atomsBefore,
    'The legacy candidates revived automatic learning: ' + atomsBefore + ' -> ' + atomsAfter + ' atoms.');
  scenarios.push({
    scenario: '旧数据根升级：pending 候选被终止而非复活',
    evidence: {
      candidates: candidateIds.length,
      rejectedOutcomes: rejected.length,
      terminatedAt: settled.terminatedAt,
      terminationReason: settled.terminationReason,
      auditLocation: existsSync(pendingPath) ? 'pending' : 'quarantined-after-termination',
      longTermAtomsBefore: atomsBefore,
      longTermAtomsAfter: atomsAfter,
    },
    result: 'pass',
  });

  // ─── 4. A later compaction must not settle or re-stamp it ─────────────────────────────────────────
  await appendMany(sessionId, 48, 72, 'repeat');
  const repeatedRun = await runner.run({ sessionId, text: '继续' });
  assert.equal(repeatedRun.status, 'ok');
  const afterRepeat = JSON.parse(await readFile(auditPath, 'utf8'));
  assert.equal(afterRepeat.memoryProposal.terminatedAt, settled.terminatedAt,
    'A later compaction re-stamped the terminated proposal.');
  assert.equal((await runner.infra.memoryRepository.listNodes('long-term')).length, atomsBefore,
    'A later compaction wrote durable memory from the terminated proposal.');
  scenarios.push({
    scenario: '重复压缩不重复结算',
    evidence: { terminatedAtStable: true, longTermAtoms: atomsBefore },
    result: 'pass',
  });
  await runner.shutdown();
  runner = undefined;

  // ─── 5. A data root with no marker and no locator is still refused ────────────────────────────────
  {
    const bareDir = await mkdtemp(join(tmpdir(), 'littlesheep-legacy-bare-'));
    let refusal;
    try {
      const repository = new MemoryRepository({ dataDir: bareDir, backend: 'v3' });
      await repository.initialize();
    } catch (error) {
      refusal = error;
    } finally {
      await rm(bareDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
    assert(refusal && /refusing to open this data root/u.test(refusal.message),
      'A marker-less data root was not refused: ' + (refusal?.message ?? 'no error'));
    scenarios.push({
      scenario: '无隔离标识 / 无迁移 locator 时受控拒绝',
      evidence: { refused: true, message: refusal.message.slice(0, 120) },
      result: 'pass',
    });
  }

  assert.equal(blockedNetworkAttempts, 0, 'The drill attempted network access.');
  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    dataRoot: { isolated: true, reusedAcrossRuns: true },
    scenarios,
    limits: [
      'The legacy proposal is committed through the shipped SessionManager API with the shape the retired '
      + 'build produced; no older build is available here to produce the file itself.',
      'The model is a controlled double, so this proves the runtime treatment of legacy state, not model '
      + 'behaviour.',
    ],
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

if (report) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (failure) throw failure;

function idleLlm() {
  return {
    async chat() { return { content: '好的。', toolCalls: [], finishReason: 'stop' }; },
    async chatStream(_request, onDelta) {
      onDelta({ type: 'delta', delta: '好的。' });
      onDelta({ type: 'done', finishReason: 'stop' });
      return { content: '好的。', toolCalls: [], finishReason: 'stop' };
    },
    async embed() { return { embeddings: [], model: '', usage: { promptTokens: 0 } }; },
  };
}
