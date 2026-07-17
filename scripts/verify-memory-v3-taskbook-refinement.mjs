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
    throw new Error('Network access is forbidden during Memory v3 TaskBook refinement acceptance.');
  };
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });
  await createMemoryV3ExperimentMarker(dataDir);

  const requests = [];
  const responses = [];
  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'acceptance/model',
    llm: queueLlm(responses, requests),
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
    sourceStage: 'evolve',
    importance: 0.85,
    confidence: 0.95,
    reason: 'Acceptance fixture for structured TaskBook memory refinement.',
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

  responses.push(
    response('{"type":"problem","confidence":0.95,"reason":"continue the task"}'),
    response(JSON.stringify({
      assessment: {
        userNeed: 'Validate the repository with its pnpm workspace convention.',
        complexity: 'standard',
        goal: 'Validate the repository using pnpm workspace filters.',
        successCriteria: ['Use pnpm workspace filters for repository validation.'],
        needsClarification: false,
        requiresTaskBook: true,
        maxExtraScopeRatio: 1.2,
      },
      taskBook: {
        goal: 'Validate the repository using pnpm workspace filters.',
        complexity: 'standard',
        successCriteria: ['Use pnpm workspace filters for repository validation.'],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.2, guidance: 'Stay within the validation task.' },
        steps: [{
          id: 'step-1',
          title: 'Run repository validation',
          description: 'Use pnpm workspace filters to validate the repository.',
          tools: [],
          acceptanceCriteria: ['The validation follows the stored project command policy.'],
        }],
      },
    })),
    response('Repository validation followed the pnpm workspace policy.'),
    response(JSON.stringify({
      verdict: 'pass',
      reason: 'The stored policy was used.',
      usedMemoryAtomIds: [atomId],
    })),
    response('{"memories":[],"createSkill":null}'),
    response('{"observations":[]}'),
  );

  const result = await runner.run({ text: '继续处理这个', cwd: workspace });
  assert.equal(result.status, 'ok');
  const initialRequests = requests.slice(0, 2);
  assert(initialRequests.every((request) => !systemText(request).includes('workspace filters when validating')),
    'The vague request injected the Atom before DECIDE clarified the task.');
  const executeRequest = requests.find((request) => systemText(request).includes('# TaskBook Refined Memory Atoms'));
  assert(executeRequest, 'EXECUTE did not receive the TaskBook-refined memory section.');
  assert(systemText(executeRequest).includes('workspace filters when validating'),
    'The refined Atom body did not enter the EXECUTE request.');
  assert(result.memoryKnownState?.references.some((reference) => (
    reference.atomId === atomId && reference.decision === 'adopted'
  )), 'The refined Atom was not registered as adopted KnownState evidence.');
  assert.deepEqual(result.verificationHistory?.at(-1)?.usedMemoryAtomIds, [atomId]);
  const taskbookRecords = result.memoryAccess?.records.filter((record) => (
    record.reason?.includes('taskbook atom selection')
  )) ?? [];
  assert(taskbookRecords.length >= 4, 'TaskBook refinement did not audit each bounded D1 branch inspection.');

  const duplicateRunId = 'acceptance-refinement-duplicate';
  await runner.infra.memoryService.beginRun({
    runId: duplicateRunId,
    sessionId: 'acceptance-refinement-session',
    query: 'continue',
    recentHistory: [],
    workspace,
    autoPrime: false,
  });
  const firstRefinement = await runner.infra.memoryService.refineRun({
    runId: duplicateRunId,
    query: 'Validate the repository using pnpm workspace filters.',
    purpose: 'taskbook',
  });
  const duplicateRefinement = await runner.infra.memoryService.refineRun({
    runId: duplicateRunId,
    query: '  validate the repository USING pnpm workspace filters.  ',
    purpose: 'taskbook',
  });
  await runner.infra.memoryService.finishRun(duplicateRunId);
  assert(firstRefinement.context?.atomIds.includes(atomId), 'The direct bounded refinement did not find the expected Atom.');
  assert.equal(duplicateRefinement.skippedReason, 'duplicate-query');
  assert.equal(blockedNetworkAttempts, 0, 'TaskBook refinement attempted network access.');

  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    atomId,
    run: {
      initialRequestsWithoutAtom: initialRequests.length,
      executeReceivedRefinedAtom: true,
      usedMemoryAtomIds: result.verificationHistory?.at(-1)?.usedMemoryAtomIds ?? [],
      taskbookBranchInspections: taskbookRecords.length,
      memoryTokensUsed: result.memoryAccess?.tokensUsed ?? 0,
      totalMemoryTokenBudget: result.memoryAccess?.totalTokenBudget ?? 0,
    },
    bounds: {
      maxAddedAtomsPerRefinement: 2,
      tokenBudgetPerRefinement: 400,
      duplicateQuerySkipped: duplicateRefinement.skippedReason === 'duplicate-query',
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

function queueLlm(responses, requests) {
  const chat = async (request) => {
    requests.push(request);
    return responses.shift() ?? response('');
  };
  return {
    chat,
    async chatStream(request, onDelta) {
      const result = await chat(request);
      if (result.content) onDelta({ type: 'delta', delta: result.content });
      onDelta({ type: 'done', finishReason: result.finishReason });
      return result;
    },
    async embed() {
      return { embeddings: [], model: '', usage: { promptTokens: 0 } };
    },
  };
}

function response(content) {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function systemText(request) {
  return String(request.messages?.find((message) => message.role === 'system')?.content ?? '');
}
