import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createMemoryV3ExperimentMarker, InjectionTier } from '@littlesheep/memory-tree';
import { maybeCompact } from '@littlesheep/session';
import { asSessionId, textMessage } from '@littlesheep/types';
import { createRunner, type AgentRunner } from './runner.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** All model-visible text, including the trailing Context sections. */
function requestText(request: { messages: Array<{ content: unknown }> } | undefined): string {
  return (request?.messages ?? []).map((message) => String(message.content)).join('\n');
}

describe('Runner Memory v3 integration', () => {
  let dataDir: string;
  const runners: AgentRunner[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-runner-memory-v3-'));
    process.env.LITTLESHEEP_DATA_DIR = dataDir;
    await createMemoryV3ExperimentMarker(dataDir);
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.shutdown().catch(() => undefined);
    delete process.env.LITTLESHEEP_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists the deterministic CAPTURE atom, navigates it, and restores it after restart', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        repositoryBackend: 'v3' as const,
        // The per-run CAPTURE record stays reachable under the explicit legacy
        // policy; automatic EVOLVE persistence was removed.
        autoMemoryPolicy: 'legacy-per-run' as const,
      },
    };
    const first = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        textResponse('{"plan":[{"description":"inspect it","tools":[]}]}'),
        textResponse('Inspection complete.'),
        textResponse('Inspection completed successfully.'),
      ]),
      skillsDirs: [],
    });
    runners.push(first);

    const result = await first.run({ text: 'read the file as a multi-step job', cwd: workspace });
    expect(result.status).toBe('ok');
    const projectNodes = await first.infra.memoryRepository.listNodes('project', workspace);
    const dailyNodes = await first.infra.memoryRepository.listNodes('daily', workspace);
    // Nothing writes a project atom on its own any more.
    expect(projectNodes).toHaveLength(0);
    expect(dailyNodes).toHaveLength(1);
    expect(dailyNodes[0]).toMatchObject({
      summary: 'Run done: read the file as a multi-step job',
      sourceRunIds: [result.runId],
    });
    expect(await countFiles(join(dataDir, 'memory-tree', 'v3', 'atoms'), '.memory.json')).toBeGreaterThanOrEqual(1);
    expect(await countFiles(join(dataDir, 'memory-tree', 'v3', 'conversation-sources'), '.conversation-source.json'))
      .toBeGreaterThanOrEqual(1);
    const dailyInspection = await first.infra.memoryRepository.management.inspectNode(dailyNodes[0]!.id, 'D3');
    expect(dailyInspection?.atom).toMatchObject({
      domain: 'task',
      statementKind: 'reported-observation',
      epistemicStatus: 'reported',
      assertedBy: { kind: 'agent', id: 'littlesheep' },
    });
    expect(dailyInspection?.projectionRecords?.length).toBeGreaterThan(0);
    await expect(first.infra.memoryService.listConversationSources(dailyInspection?.atom?.sourceRefs ?? []))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user-message' })]));

    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      skillsDirs: [],
    });
    runners.push(restored);

    expect(await restored.infra.memoryRepository.getNode(dailyNodes[0]!.id)).toMatchObject({
      summary: 'Run done: read the file as a multi-step job',
    });

    const navigationRunId = 'memory-v3-navigation';
    await restored.infra.memoryService.beginRun({
      runId: navigationRunId,
      sessionId: asSessionId('memory-v3-session'),
      query: 'inspection completed',
      recentHistory: [],
      workspace,
      autoPrime: false,
    });
    const index = await restored.infra.memoryService.branchIndex(navigationRunId, 'daily');
    expect(index.entries.map((entry) => entry.id)).toContain(dailyNodes[0]!.id);
    const expansion = await restored.infra.memoryService.expand(navigationRunId, {
      branchId: 'daily',
      nodeId: dailyNodes[0]!.id,
      limit: 5,
      tokenBudget: 800,
    });
    expect(expansion.fragments[0]).toMatchObject({
      id: dailyNodes[0]!.id,
      metadata: { source: `memory-v3:atom:${dailyNodes[0]!.id}` },
    });
    await restored.infra.memoryService.finishRun(navigationRunId);
  });


  it('injects a D1-selected atom into the first business model request', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const requests: ChatRequest[] = [];
    const runner = await createRunner({
      config: {
        ...DEFAULT_CONFIG,
        memory: { ...DEFAULT_CONFIG.memory, repositoryBackend: 'v3' as const },
      },
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('Hello from LS.'), requests),
      skillsDirs: [],
      durableHarnessMode: 'next',
    });
    runners.push(runner);
    const write = await runner.infra.memoryService.write({
      id: 'initial-greeting-memory',
      branch: 'long-term',
      parentNodeId: 'long-term:root',
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'User greeting preference',
      content: 'The user prefers concise greetings.',
      retrievalKeys: ['hello', 'greeting', 'concise'],
      sourceRefs: ['conversation-source:seed-run:user-message:seed-message'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.8,
      confidence: 0.9,
      reason: 'Explicit user preference used by the integration test.',
      epistemic: {
        domain: 'user',
        statementKind: 'preference',
        epistemicStatus: 'reported',
        authorityScope: { kind: 'user-self', scope: 'global', topics: ['greeting'] },
        assertedBy: { kind: 'user', id: 'user' },
        evidenceRefs: ['user:explicit-greeting-preference'],
      },
    });
    expect(write).toMatchObject({ decision: 'created', node: { summary: 'User greeting preference' } });
    const result = await runner.run({ text: 'hello', cwd: workspace });
    expect(result.status).toBe('ok');
    const outbound = requests.find((request) => requestText(request).includes('Initially Selected Memory Atoms'));
    expect(requestText(outbound)).toContain('prefers concise greetings');
    // The per-request KnownState travels after the system prompt, outside the
    // Provider's cacheable prefix.
    expect(outbound?.messages.map((message) => String(message.content)).join('\n'))
      .toContain('Run Memory KnownState');
    expect(result.memoryKnownState?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ atomId: write.node!.id, decision: 'adopted' }),
    ]));
    expect(result.memoryAccess?.records.map((record) => record.action)).toEqual(expect.arrayContaining([
      'root_index', 'branch_index', 'expand',
    ]));
  });

  it('refines the working set from the normalized TaskBook before EXECUTE', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const requests: ChatRequest[] = [];
    const responses: ChatResponse[] = [];
    const runner = await createRunner({
      config: {
        ...DEFAULT_CONFIG,
        memory: { ...DEFAULT_CONFIG.memory, repositoryBackend: 'v3' as const },
      },
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeLiveQueueMockLlm(responses, requests),
      skillsDirs: [],
    });
    runners.push(runner);
    const write = await runner.infra.memoryService.write({
      id: 'taskbook-refinement-memory',
      branch: 'project',
      parentNodeId: 'project:root',
      scope: 'workspace',
      scopeKey: workspace,
      tier: InjectionTier.T2_RELEVANT,
      summary: 'pnpm workspace command policy',
      content: 'Use pnpm workspace filters when validating this repository.',
      retrievalKeys: ['pnpm workspace', 'workspace filters', 'repository validation'],
      sourceRefs: ['conversation-source:seed-run:user-message:taskbook-refinement'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.8,
      confidence: 0.9,
      reason: 'Project convention used by the TaskBook refinement integration test.',
      epistemic: {
        domain: 'project',
        statementKind: 'instruction',
        epistemicStatus: 'reported',
        authorityScope: { kind: 'user-self', scope: 'workspace', scopeKey: workspace, topics: ['pnpm'] },
        assertedBy: { kind: 'user', id: 'user' },
        evidenceRefs: ['user:project-command-policy'],
      },
    });
    if (!write.node) throw new Error(`seed write failed: ${write.decision}: ${write.reason}`);
    const atomId = write.node.id;
    responses.push(
      textResponse(JSON.stringify({
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
            acceptanceCriteria: ['The repository validation uses the project command policy.'],
          }],
        },
      })),
      textResponse('Repository validation followed the pnpm workspace policy.'),
      textResponse('The repository validation completed successfully using the pnpm workspace policy.'),
      textResponse(JSON.stringify({ verdict: 'pass', reason: 'The policy was followed.', usedMemoryAtomIds: [atomId] })),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    );

    const result = await runner.run({ text: '继续处理这个多步骤任务', cwd: workspace });

    expect(result.status).toBe('ok');
    const executeRequest = requests.find((request) => requestText(request).includes('# TaskBook Refined Memory Atoms'));
    if (!executeRequest) throw new Error(`refinement missing: ${JSON.stringify(result.memoryAccess?.records)}`);
    // Refinement happens after planning, so no request before it may already
    // carry the refined atom text.
    const executeIndex = requests.indexOf(executeRequest);
    expect(executeIndex).toBeGreaterThan(0);
    expect(requests.slice(0, executeIndex).every((request) => !requestText(request).includes('workspace filters when validating'))).toBe(true);
    expect(requestText(executeRequest)).toContain('workspace filters when validating');
    expect(result.memoryKnownState?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ atomId, decision: 'adopted' }),
    ]));
    expect(result.memoryAccess?.records.some((record) => record.reason?.includes('taskbook atom selection'))).toBe(true);
  });

  it('uses the versioned session summary as a bounded recall fallback after compaction', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const requests: ChatRequest[] = [];
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.repositoryBackend = 'v3';
    config.sessions.compaction.keepRecent = 1;
    config.sessions.compaction.threshold = 100;
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        textResponse('{"type":"problem","confidence":0.99,"reason":"resume compacted task"}'),
        textResponse('{"plan":[{"description":"resume checkpoint work","tools":[]}]}'),
        textResponse('Checkpoint continuity resumed.'),
        textResponse('The checkpoint continuity task resumed successfully.'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ], requests),
      skillsDirs: [],
    });
    runners.push(runner);
    const marker = 'ASTER-COMPACTION-CONTINUITY-MARKER';
    const seed = await runner.infra.memoryService.write({
      id: 'compaction-continuity-seed',
      branch: 'long-term',
      parentNodeId: 'long-term:root',
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Aster checkpoint recovery contract',
      content: `The active checkpoint continuity marker is ${marker}.`,
      retrievalKeys: ['Aster checkpoint recovery', 'compaction continuity', marker],
      sourceRefs: ['conversation-source:seed-run:user-message:seed-message'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.95,
      confidence: 0.98,
      reason: 'Synthetic verified seed for compaction continuity.',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['checkpoint', 'continuity'] },
        assertedBy: { kind: 'tool', id: 'memory-v3-integration-test' },
        evidenceRefs: ['test:memory-v3:compaction-continuity'],
      },
    });
    expect(seed.node).toBeTruthy();
    const session = await runner.sessionManager.create('test/model', 'Compaction continuity');
    await runner.sessionManager.append(session.id, [
      textMessage('user', 'Complete the Aster checkpoint recovery contract.'),
      textMessage('assistant', '下一步继续执行。'),
    ]);
    const summary = await maybeCompact(runner.sessionManager, session.id, {
      threshold: 1,
      keepRecent: 1,
      force: true,
      summarize: async () => ({
        summary: '当前目标：完成 Aster checkpoint recovery contract。下一步：验证压缩后可继续执行。',
        model: 'test/model',
      }),
    });
    expect(summary).toBeTruthy();

    const result = await runner.run({
      sessionId: session.id,
      text: 'Continue with that.',
      cwd: workspace,
    });
    const outbound = requests.find((request) => requestText(request).includes('Initially Selected Memory Atoms'));

    expect(result.status).toBe('ok');
    expect(requestText(outbound)).toContain(marker);
    expect(result.memoryKnownState?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ atomId: seed.node!.id, decision: 'adopted' }),
    ]));
    expect(result.memoryAccess?.records.find((record) => record.action === 'branch_index')?.reason)
      .toContain(`summary=${summary!.id}`);
    await expect(runner.sessionManager.loadCompactionActivation(session.id, summary!.id)).resolves.toMatchObject({
      useful: 1,
      verifiedUseful: 0,
      recentEventIds: [expect.stringContaining(`:${summary!.id}`)],
    });
  });

  it('removes released atom content from the next request and restores only the new expansion', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const responses: ChatResponse[] = [];
    const requests: ChatRequest[] = [];
    const runner = await createRunner({
      config: {
        ...DEFAULT_CONFIG,
        memory: { ...DEFAULT_CONFIG.memory, repositoryBackend: 'v3' as const },
      },
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeLiveQueueMockLlm(responses, requests),
      skillsDirs: [],
    });
    runners.push(runner);
    const marker = 'LS-MV3-DYNAMIC-WORKING-SET-MARKER';
    const seed = await runner.infra.memoryService.write({
      id: 'dynamic-working-set-seed',
      branch: 'long-term',
      parentNodeId: 'long-term:root',
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Dynamic working set release and readmission rule',
      content: `The isolated working-set marker is ${marker}.`,
      retrievalKeys: ['dynamic working set', 'release readmission'],
      sourceRefs: ['conversation-source:seed-run:user-message:seed-message'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.94,
      confidence: 0.98,
      reason: 'Synthetic verified seed for working-set continuity.',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3', 'working-set'] },
        assertedBy: { kind: 'tool', id: 'memory-v3-integration-test' },
        evidenceRefs: ['test:memory-v3:working-set-seed'],
      },
    });
    expect(seed.node).toBeTruthy();
    const seedBefore = await runner.infra.memoryRepository.management.inspectNode(seed.node!.id, 'D3');

    responses.push(
      textResponse('{"plan":[{"description":"refresh active memory context","tools":["memory_tree"]}]}'),
      toolCallResponse('release-memory', 'memory_tree', {
        action: 'release', atomIds: [seed.node!.id],
      }),
      toolCallResponse('readmit-memory', 'memory_tree', {
        action: 'expand', branch: 'long-term', nodeId: seed.node!.id, limit: 1, tokenBudget: 300,
      }),
      textResponse('The active memory context was refreshed.'),
      textResponse('The active memory context was refreshed successfully.'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    );

    const result = await runner.run({
      text: 'Refresh the dynamic working set rule as a multi-step job, then use the relevant atom again.',
      cwd: workspace,
    });
    const afterRelease = requests.find((request) => JSON.stringify(request.messages).includes('release-memory'));
    const afterReadmission = requests.find((request) => JSON.stringify(request.messages).includes('readmit-memory'));

    expect(result.status).toBe('ok');
    expect(afterRelease).toBeTruthy();
    expect(afterReadmission).toBeTruthy();
    // Append-only release: the original text stays (so the Provider prefix
    // survives) and the runtime appends an authoritative release note instead.
    expect(JSON.stringify(afterRelease)).toContain(marker);
    expect(JSON.stringify(afterRelease)).toContain('# Released Memory');
    // The preserved evidence keeps the marker, and the re-admitted expansion
    // adds it again, so at least one occurrence must remain.
    expect((JSON.stringify(afterReadmission).match(new RegExp(marker, 'gu')) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(result.memoryKnownState?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ atomId: seed.node!.id, decision: 'adopted', reactivatedCount: 1 }),
    ]));
    expect(result.memoryAccess?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'release', fragmentIds: [seed.node!.id] }),
      expect.objectContaining({ action: 'expand', fragmentIds: [seed.node!.id] }),
    ]));
    const seedAfter = await runner.infra.memoryRepository.management.inspectNode(seed.node!.id, 'D3');
    // No verification model call names used atoms any more, and this answer does
    // not restate the atom, so the runtime records no routing feedback for it
    // rather than accepting an unproven claim of use.
    expect(seedAfter?.atom?.routingFeedback).toMatchObject({ useful: 0, notUseful: 0 });
    expect(seedAfter?.atom?.verifiedUsefulness).toEqual(seedBefore?.atom?.verifiedUsefulness);
  });

  it('keeps atom use unclaimed without a verifier, while writes and restart recall stay continuous', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        repositoryBackend: 'v3' as const,
        // HC-18: legacy per-run EVOLVE/CAPTURE remains readable/admitted when explicitly selected.
        autoMemoryPolicy: 'legacy-per-run' as const,
      },
    };
    const responses: ChatResponse[] = [];
    const requests: ChatRequest[] = [];
    const first = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeLiveQueueMockLlm(responses, requests),
      skillsDirs: [],
    });
    runners.push(first);
    const marker = 'LS-MV3-MOCK-CONTINUITY';
    const seed = await first.infra.memoryService.write({
      id: 'mock-continuity-seed',
      branch: 'long-term',
      parentNodeId: 'long-term:root',
      scope: 'global',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Memory v3 mock continuity marker',
      content: `The isolated continuity marker is ${marker}.`,
      retrievalKeys: ['memory v3', 'continuity marker', marker],
      sourceRefs: ['conversation-source:seed-run:user-message:seed-message'],
      sourceRunId: 'seed-run',
      sourceStage: 'evolve',
      importance: 0.95,
      confidence: 1,
      reason: 'Synthetic verified seed for the isolated continuity contract.',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3', 'continuity'] },
        assertedBy: { kind: 'tool', id: 'memory-v3-integration-test' },
        evidenceRefs: ['test:memory-v3:continuity-seed'],
      },
    });
    expect(seed.node).toBeTruthy();
    const seedBefore = await first.infra.memoryRepository.management.inspectNode(seed.node!.id, 'D3');
    expect(seedBefore?.atom).toBeTruthy();

    responses.push(
      textResponse('{"plan":[{"description":"use the injected continuity marker","tools":[]}]}'),
      textResponse(`The persisted project decision uses ${marker}.`),
      textResponse(`The project decision was persisted and uses ${marker}.`),
      textResponse(JSON.stringify({ observations: [{
        summary: 'Memory v3 continuity run completed',
        content: `The isolated run used ${marker} and persisted project memory.`,
        retrievalKeys: ['memory v3', 'continuity run'],
        importance: 0.5,
        confidence: 0.95,
        reason: 'Run completion observation for restart reconstruction.',
      }] })),
    );

    const result = await first.run({
      text: 'Use the Memory v3 continuity marker from injected memory and persist the resulting project decision.',
      cwd: workspace,
    });

    expect(result.status).toBe('ok');
    expect(result.reply).toContain(marker);
    // No verification model call exists any more, so no model names the atoms
    // it used. Routing feedback comes from the answer-level continuity check.
    expect(result.verificationHistory?.at(-1)?.usedMemoryAtomIds).toBeUndefined();
    const seedAfter = await first.infra.memoryRepository.management.inspectNode(seed.node!.id, 'D3');
    expect(seedAfter?.atom).toBeTruthy();
    // The runtime only records what it can prove. There is no verification
    // model call naming this atom any more, and the answer-level continuity
    // check does not match it here, so no unproven routing feedback is written.
    expect(seedAfter!.atom!.routingFeedback).toMatchObject({ useful: 0, notUseful: 0 });
    expect(seedAfter!.atom!.feedbackRevision).toBe(seedBefore!.atom!.feedbackRevision);
    expect(seedAfter!.atom!.verifiedUsefulness.useful).toBe(seedBefore!.atom!.verifiedUsefulness.useful);
    // Automatic EVOLVE persistence is gone, so no project atom claims the marker
    // on the run's behalf; the deterministic daily CAPTURE record still proves
    // the run happened and stays queryable after restart.
    expect(await first.infra.memoryRepository.listNodes('project', workspace)).toHaveLength(0);
    expect((await first.infra.memoryRepository.listNodes('daily', workspace))
      .some((node) => node.sourceRunIds.includes(result.runId))).toBe(true);
    expect(requests.some((request) => requestText(request).includes(marker))).toBe(true);

    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      skillsDirs: [],
    });
    runners.push(restored);
    await restored.infra.memoryService.beginRun({
      runId: 'memory-v3-mock-recall',
      sessionId: asSessionId('memory-v3-mock-recall-session'),
      query: `What project decision contains ${marker}?`,
      recentHistory: [],
      workspace,
    });
    // The seeded long-term atom survives the restart and stays readable; the run
    // itself no longer writes a project atom on its own.
    expect(await restored.infra.memoryRepository.getNode(seed.node!.id)).toMatchObject({
      summary: 'Memory v3 mock continuity marker',
    });
    await restored.infra.memoryService.finishRun('memory-v3-mock-recall');
  });

  it('settles compaction through one entry and leaves legacy daily atoms queryable', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.repositoryBackend = 'v3';
    config.memory.llmCapture = true;
    // HC-18: legacy daily atoms stay writable and queryable when the old policy is explicitly selected.
    config.memory.autoMemoryPolicy = 'legacy-per-run';
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const marker = 'LS-DAILY-CONSOLIDATION-MARKER';
    const requests: ChatRequest[] = [];
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        textResponse('{"plan":[{"description":"record the project decision","tools":[]}]}'),
        textResponse(`Recorded ${marker}.`),
        textResponse(`The project decision was recorded successfully: ${marker}.`),
        textResponse(JSON.stringify({ observations: [{
          summary: 'Project consolidation decision',
          content: `The project decision is ${marker}.`,
          retrievalKeys: ['daily consolidation', marker],
          importance: 0.85,
          confidence: 0.95,
          reason: 'The user explicitly made this project-scoped decision.',
          epistemic: {
            domain: 'project',
            statementKind: 'decision',
            assertedBy: { kind: 'user', id: 'local-user' },
          },
        }] })),
        textResponse(JSON.stringify({
          summary: `Compacted project decision: ${marker}.`,
          candidates: [],
        })),
      ], requests),
      skillsDirs: [],
    });
    runners.push(runner);

    const result = await runner.run({
      text: `Use ${marker} as the project decision in this multi-step consolidation job.`,
      cwd: workspace,
    });

    const projectNodes = await runner.infra.memoryRepository.listNodes('project', workspace);
    const project = projectNodes.find((node) => node.content.includes(marker));
    const activeDaily = await runner.infra.memoryRepository.listNodes('daily', workspace);
    const archivedDaily = await runner.infra.memoryRepository.listRecentNodes('daily', {
      scope: 'workspace',
      scopeKey: workspace,
      status: 'archived',
      limit: 16,
    });
    const summary = (await runner.sessionManager.loadMetadata(result.sessionId))?.compaction;

    expect(result.status).toBe('ok');
    expect(summary).toMatchObject({ version: 2, sourceRunIds: [result.runId] });
    // C08D: the retired daily-consolidation entry no longer auto-promotes; there is a single promotion path.
    expect(project).toBeUndefined();
    // HC-18: the legacy daily atom stays readable under its original scope instead of being archived by a second entry.
    expect(activeDaily.some((node) => node.content.includes(marker))).toBe(true);
    expect(archivedDaily).toEqual([]);
    // decide + two loop turns + capture + compaction: no EVOLVE request remains.
    expect(requests).toHaveLength(5);
  });

  // HC-02: a short session with no summary/atom must still be discoverable by bounded catalog, then expanded by ref.
  it('recovers a short session fact through the bounded source catalog after restart', async () => {
    const workspace = join(dataDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.memory.repositoryBackend = 'v3';
    config.sessions.compaction.threshold = 100;
    config.sessions.compaction.keepRecent = 20;
    const marker = 'LS-SHORT-SESSION-ORACLE-7F3A';
    const first = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm([
        textResponse('{"type":"problem","confidence":0.99,"reason":"note the launch code"}'),
        textResponse('{"plan":[{"description":"acknowledge the launch code","tools":[]}]}'),
        textResponse(`The launch code is ${marker}.`),
        textResponse(`Understood: the launch code is ${marker}.`),
        textResponse('{"verdict":"pass","reason":"the launch code was acknowledged"}'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ]),
      skillsDirs: [],
    });
    runners.push(first);

    const result = await first.run({
      text: `For this chat only, the launch code is ${marker}.`,
      cwd: workspace,
    });
    expect(result.status).toBe('ok');
    // Short session: no summary and no per-run/daily atom to fall back on.
    expect((await first.sessionManager.loadMetadata(result.sessionId))?.compaction).toBeUndefined();
    expect((await first.infra.memoryRepository.snapshot()).writeAudit).toEqual([]);

    await first.shutdown();
    runners.splice(runners.indexOf(first), 1);
    const restored = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: makeMockLlm(textResponse('unused')),
      skillsDirs: [],
    });
    runners.push(restored);

    // Another session must locate a scope first; there is no unbounded global scan.
    await expect(restored.infra.memoryService.catalogConversationSources({}))
      .rejects.toThrow('requires a sessionId or runId scope');
    const otherSession = await restored.infra.memoryService.catalogConversationSources({
      sessionId: asSessionId('another-session'),
    });
    expect(otherSession.status).toBe('ok');
    expect(otherSession.entries).toEqual([]);

    const directory = await restored.infra.memoryService.catalogConversationSources({
      sessionId: result.sessionId,
    });
    expect(directory.status).toBe('ok');
    const userEntry = directory.entries.find((entry) => entry.kind === 'user-message');
    expect(userEntry).toBeDefined();
    expect(directory.entries.some((entry) => entry.kind === 'assistant-reply')).toBe(true);

    const expanded = await restored.infra.memoryService.listConversationSources([userEntry!.id]);
    expect(expanded).toHaveLength(1);
    expect(JSON.stringify(expanded[0]?.payload)).toContain(marker);
  });
});

function makeMockLlm(responses: ChatResponse | ChatResponse[], requests?: ChatRequest[]): LlmClient {
  const queue = Array.isArray(responses) ? [...responses] : undefined;
  const single = Array.isArray(responses) ? undefined : responses;
  const fallback = textResponse('');
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    requests?.push(request);
    return queue?.shift() ?? single ?? fallback;
  });
  const chatStream = vi.fn(async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    const response = await chat(request);
    if (response.content) onDelta({ type: 'delta', delta: response.content });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  });
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

function makeLiveQueueMockLlm(responses: ChatResponse[], requests?: ChatRequest[]): LlmClient {
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    requests?.push(request);
    return responses.shift() ?? textResponse('');
  });
  const chatStream = vi.fn(async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    const response = await chat(request);
    if (response.content) onDelta({ type: 'delta', delta: response.content });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  });
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function toolCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ChatResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
}

async function countFiles(root: string, suffix: string): Promise<number> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}
