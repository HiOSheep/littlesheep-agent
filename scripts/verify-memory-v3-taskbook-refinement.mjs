import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import {
  InjectionTier,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

// Bounded in-run memory refinement, on the one path that can still reach it.
//
// This gate used to claim more than the runtime does. It fed the classifier a TaskBook assessment
// and asserted that a second, TaskBook-specific memory section reached the main loop
// (`# TaskBook Refined Memory Atoms`) with `taskbook atom selection` audit records. That path is
// gone: the runner creates no TaskBook, so `MemoryService.refineRun` — the only reader of the
// rendered section — is not reached by any run, and those assertions could no longer fire. What
// remains real, and is what this gate verifies, is the contract of that service method itself:
//
//   1. a refinement inspects the D1 branch indexes and admits only the task-relevant atom;
//   2. every bounded D1 inspection is audited on the run's navigation ledger;
//   3. a normalized duplicate query is skipped instead of re-injecting the same atom;
//   4. the run's refinement budget is finite, and an exhausted budget returns no atoms at all;
//   5. nothing here spends a model request or touches the network.
//
// The same boundary is covered by `packages/memory-tree/src/memory-tree.test.ts` ("bounds TaskBook
// refinements and skips normalized duplicate queries"). If the runtime ever regains a TaskBook path,
// this gate should grow back a runtime-level assertion rather than a renamed one.
const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-taskbook-refinement-'));
const workspace = join(dataDir, 'workspace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const originalFetch = globalThis.fetch;
let blockedNetworkAttempts = 0;
let runner;
let report;
let failure;

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during Memory v3 refinement acceptance.');
  };
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.workspace = workspace;
  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'acceptance/model',
    // No model request belongs to these assertions: refinement is a Runtime-owned, index-driven step,
    // and a client that fails the run keeps that true instead of hiding a model call.
    llm: noRequestLlm(),
    skillsDirs: [],
  });

  const seed = await runner.infra.memoryService.write({
    id: 'acceptance-taskbook-refinement',
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'pnpm workspace validation policy',
    content: 'Use pnpm workspace filters when validating this repository.',
    retrievalKeys: ['pnpm workspace', 'workspace filters', 'repository validation'],
    sourceRefs: ['conversation-source:acceptance-taskbook-refinement:user-message:1'],
    sourceRunId: 'acceptance-taskbook-refinement',
    sourceStage: 'tool',
    importance: 0.85,
    confidence: 0.95,
    reason: 'Acceptance fixture for the bounded in-run refinement contract.',
    epistemic: {
      domain: 'user',
      statementKind: 'instruction',
      epistemicStatus: 'reported',
      authorityScope: { kind: 'user-self', scope: 'global', topics: ['pnpm', 'validation'] },
      assertedBy: { kind: 'user', id: 'local-user' },
      evidenceRefs: ['acceptance:user-project-policy'],
    },
  });
  assert(seed.node, `Seed write failed: ${seed.decision}: ${seed.reason}`);
  const atomId = seed.node.id;

  const runId = 'acceptance-refinement-bounds';
  await runner.infra.memoryService.beginRun({
    runId,
    sessionId: 'acceptance-refinement-session',
    query: 'continue',
    recentHistory: [],
    workspace,
    autoPrime: false,
  });

  // 1 + 2: one refinement admits the relevant atom and audits its D1 inspections.
  const firstRefinement = await runner.infra.memoryService.refineRun({
    runId,
    query: 'Validate the repository using pnpm workspace filters.',
    purpose: 'taskbook',
  });
  assert(firstRefinement.context?.atomIds.includes(atomId),
    `The bounded refinement did not admit the relevant atom; admitted=${firstRefinement.context?.atomIds?.join(',') ?? 'none'}`);
  assert(firstRefinement.ledger, 'The refinement produced no navigation ledger.');
  const inspectionRecords = firstRefinement.ledger.records.filter((record) => (
    record.reason?.includes('taskbook atom selection')
  ));
  assert(inspectionRecords.length >= 4,
    `The refinement audited only ${inspectionRecords.length} bounded D1 branch inspection(s).`);
  assert(inspectionRecords.every((record) => record.action === 'branch_index'),
    'The refinement audit named a non-index action.');

  // 3: a normalized duplicate query re-injects nothing.
  const duplicateRefinement = await runner.infra.memoryService.refineRun({
    runId,
    query: '  validate the repository USING pnpm workspace filters.  ',
    purpose: 'taskbook',
  });
  assert.equal(duplicateRefinement.skippedReason, 'duplicate-query',
    `A normalized duplicate refinement was not skipped: ${duplicateRefinement.skippedReason ?? 'ran'}`);
  assert.equal(duplicateRefinement.context, undefined,
    'A skipped duplicate refinement still returned atoms for injection.');

  // 4: the per-run refinement budget is finite and an exhausted budget admits nothing. A refusal
  // reports itself in `skippedReason`, and it may arrive before the last loop step does.
  const distinctRefinements = [];
  let limitRefusal;
  for (let index = 0; index < 8; index += 1) {
    const refinement = await runner.infra.memoryService.refineRun({
      runId,
      query: `Validate the repository scope variant ${index}`,
      purpose: 'replan',
    });
    if (refinement.skippedReason !== undefined) {
      limitRefusal = refinement;
      break;
    }
    distinctRefinements.push(refinement);
  }
  assert(limitRefusal, 'The run accepted refinements past any finite budget.');
  assert.equal(limitRefusal.skippedReason, 'refinement-limit',
    `The run stopped refining for the wrong reason: ${limitRefusal.skippedReason}`);
  assert.equal(limitRefusal.context, undefined,
    'A refinement past the budget still returned atoms for injection.');
  assert.equal(distinctRefinements.length, 3,
    `The run performed ${distinctRefinements.length + 1} refinements before refusing; the accepted refinement itself counts too.`);

  const ledger = await runner.infra.memoryService.finishRun(runId);
  assert(ledger, 'The refinement run produced no final ledger.');
  assert.equal(blockedNetworkAttempts, 0, 'In-run refinement attempted network access.');

  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    atomId,
    runtimeContract: {
      taskBookRefinementReachedByRuns: false,
      reason: 'The runner creates no TaskBook, so no run reaches MemoryService.refineRun.',
    },
    refinement: {
      admittedAtomIds: firstRefinement.context?.atomIds ?? [],
      boundedD1Inspections: inspectionRecords.length,
      duplicateQuerySkipped: duplicateRefinement.skippedReason === 'duplicate-query',
      refinementsBeforeLimit: distinctRefinements.length + 1,
      limitSkippedReason: limitRefusal.skippedReason,
      limitAdmittedNoAtoms: limitRefusal.context === undefined,
      memoryTokensUsed: ledger.tokensUsed,
      totalMemoryTokenBudget: ledger.totalTokenBudget,
    },
    network: { blockedAttempts: blockedNetworkAttempts },
    resources: {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
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

/**
 * Refinement is Runtime-owned. A model call here would mean the runtime had gone back to asking the
 * model what to remember, so the gate fails the request instead of silently answering it.
 */
function noRequestLlm() {
  const chat = async () => {
    throw new Error('The refinement contract must not spend a model request.');
  };
  return {
    chat,
    chatStream: chat,
    async embed() {
      return { embeddings: [], model: '', usage: { promptTokens: 0 } };
    },
  };
}
