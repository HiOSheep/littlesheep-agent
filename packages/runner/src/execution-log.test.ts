// @littlesheep/runner — execution-log.test.ts
// Verifies ExecutionLogStore: write/read round-trip, error resilience,
// tool-call pairing, and list() behavior.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionLogStore, type ExecutionLogInput } from './execution-log.js';
import type {
  ContextSnapshot,
  MemoryContinuityAssessment,
  MemoryIntentDecisionRecord,
  Message,
  ModelRequestSnapshot,
  SessionRunSummary,
  ToolInvocationRecord,
} from '@littlesheep/types';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';

let dir: string;
let store: ExecutionLogStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ls-exec-'));
  store = new ExecutionLogStore({ rootDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ExecutionLogStore', () => {
  const continuationControlFailure = (runId: string): ExecutionLogInput => ({
    runId,
    sessionId: 'session-continuation-log',
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:00.100Z',
    status: 'error',
    model: 'runtime/control',
    inboundText: '[redacted continuation answer]',
    reply: '',
    error: 'continuation claim is already active',
    trace: [],
    messages: [],
    durationMs: 100,
    conversationContinuation: {
      version: 1,
      resolution: 'conflict',
      turnId: 'conversation-turn-stable',
      inputDigest: 'input-digest-stable',
      failure: {
        code: 'claim_conflict',
        detail: 'continuation claim is already active',
        recoverable: true,
      },
    },
  });

  const completedContinuation = (runId: string): ExecutionLogInput => ({
    runId,
    sessionId: 'session-continuation-log',
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:01.000Z',
    status: 'ok',
    model: 'test/model',
    inboundText: 'continue the original task',
    reply: 'original task completed',
    trace: [],
    messages: [],
    durationMs: 1_000,
    usage: {
      promptTokens: 21,
      completionTokens: 8,
      totalTokens: 29,
      source: 'provider',
    },
    sideEffects: [{
      idempotencyKey: 'effect-stable',
      toolName: 'write_pdf',
      status: 'succeeded',
      effectKind: 'local_mutation',
      evidenceRef: 'artifact:translated.pdf',
    }],
    conversationContinuation: {
      version: 1,
      resolution: 'bound',
      turnId: 'conversation-turn-stable',
      inputDigest: 'input-digest-stable',
      checkpointId: 'checkpoint-stable',
      disposition: 'retry',
      dispositionSource: 'directive',
    },
  });

  it('replaces an early continuation control failure with the completed execution result', async () => {
    const runId = 'run-control-before-completion';
    await store.write(continuationControlFailure(runId));
    await store.write(completedContinuation(runId));

    const log = await store.read(runId);
    expect(log).toMatchObject({
      status: 'ok',
      reply: 'original task completed',
      usage: { promptTokens: 21, completionTokens: 8, totalTokens: 29 },
      sideEffects: [{ idempotencyKey: 'effect-stable', status: 'succeeded' }],
      conversationContinuation: { resolution: 'bound' },
    });
    expect(log?.conversationContinuation?.failure).toBeUndefined();
  });

  it('does not let a late continuation control failure overwrite a completed execution result', async () => {
    const runId = 'run-completion-before-control';
    await store.write(completedContinuation(runId));
    const retained = await store.write(continuationControlFailure(runId));

    expect(retained).toMatchObject({ status: 'ok', reply: 'original task completed' });
    expect((await store.read(runId))?.conversationContinuation).toMatchObject({
      resolution: 'bound',
      checkpointId: 'checkpoint-stable',
    });
  });

  it('serializes competing stores without corrupting the stable run log or leaking temp files', async () => {
    const runId = 'run-cross-store-race';
    const competingStore = new ExecutionLogStore({ rootDir: dir });

    await Promise.all([
      store.write(continuationControlFailure(runId)),
      competingStore.write(completedContinuation(runId)),
    ]);

    const raw = readFileSync(join(dir, `${runId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { status: string; reply: string };
    expect(parsed).toMatchObject({ status: 'ok', reply: 'original task completed' });
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('persists the bounded memory continuity assessment', async () => {
    const assessment: MemoryContinuityAssessment = {
      version: 1,
      status: 'supported',
      confidence: 0.82,
      evaluatedAt: '2026-01-01T00:00:05.000Z',
      method: 'answer-evidence-v1',
      sources: {
        initialContext: true,
        sessionSummary: false,
        recentHistoryMessages: 2,
        explicitContinuationRequest: true,
        contextObserved: true,
        observedContextSnapshots: 1,
        contextItemsTruncated: false,
        memoryToolResults: 0,
        activeMemoryAtoms: 1,
        adoptedMemoryReferences: 1,
        excludedOrConflictedReferences: 0,
      },
      evidence: {
        replyTermCount: 4,
        memoryTermCount: 10,
        memoryAnchorCount: 3,
        summaryAnchorCount: 0,
        historyAnchorCount: 1,
        taskAnchorCount: 2,
        independentContinuityAnchorCount: 4,
      },
      matchedSignals: ['reply_matches_selected_memory'],
      missingSignals: [],
      matchedSources: ['active_memory_atom'],
      matchedAtomIds: ['atom-1'],
      referencedAtomIds: ['atom-1'],
    };
    await store.write({
      runId: 'run-continuity', sessionId: 's1', startedAt: '', endedAt: '', status: 'ok',
      model: 'test', inboundText: 'hello', reply: 'hi', trace: [], messages: [], durationMs: 0,
      memoryContinuityAssessment: assessment,
    });

    expect((await store.read('run-continuity'))?.memoryContinuityAssessment).toEqual(assessment);
  });

  it('write → read 往返一致', async () => {
    const input = {
      runId: 'run-1',
      sessionId: 's1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'ok' as const,
      model: 'test',
      inboundText: 'hello',
      reply: 'hi',
      trace: [{ name: 'enter' as const, startedAt: '', endedAt: '', ok: true }],
      runtimeResources: {
        version: 1 as const,
        device: {
          platform: 'win32' as const,
          arch: 'x64',
          totalMemoryMiBBucket: 16_384,
          logicalCpuBucket: 16,
        },
        start: {
          sampledAt: '2026-01-01T00:00:00.000Z',
          rssBytes: 100,
          heapUsedBytes: 40,
          externalBytes: 5,
          arrayBuffersBytes: 2,
        },
        end: {
          sampledAt: '2026-01-01T00:00:05.000Z',
          rssBytes: 120,
          heapUsedBytes: 45,
          externalBytes: 6,
          arrayBuffersBytes: 3,
        },
      },
      messages: [],
      durationMs: 5000,
    };
    await store.write(input);
    const log = await store.read('run-1');
    expect(log).not.toBeNull();
    expect(log!.runId).toBe('run-1');
    expect(log!.sessionId).toBe('s1');
    expect(log!.reply).toBe('hi');
    expect(log!.inboundText).toBe('hello');
    expect(log!.status).toBe('ok');
    expect(log!.durationMs).toBe(5000);
    expect(log!.runtimeResources).toEqual(input.runtimeResources);
    expect(log!.toolCalls).toEqual([]);
  });

  it('read 不存在的 runId → null', async () => {
    const log = await store.read('nonexistent');
    expect(log).toBeNull();
  });

  it('read 损坏文件 → null（不抛异常）', async () => {
    writeFileSync(join(dir, 'bad.json'), '{not valid json');
    const log = await store.read('bad');
    expect(log).toBeNull();
  });

  it('extractToolCallPairs 正确配对 call+result', async () => {
    const callId = randomUUID();
    const messages: Message[] = [
      {
        id: randomUUID(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_calls', calls: [{ id: callId, name: 'read', input: { path: '/x' } }] },
        ],
      },
      {
        id: randomUUID(),
        role: 'tool',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_result', result: { callId, ok: true, output: 'data' } },
        ],
      },
    ];
    await store.write({
      runId: 'run-2',
      sessionId: 's1',
      startedAt: '',
      endedAt: '',
      status: 'ok',
      model: 't',
      inboundText: '',
      reply: '',
      trace: [],
      messages,
      durationMs: 0,
    });
    const log = await store.read('run-2');
    expect(log!.toolCalls).toHaveLength(1);
    expect(log!.toolCalls[0]!.call.name).toBe('read');
    expect(log!.toolCalls[0]!.call.input).toEqual({ path: '/x' });
    expect(log!.toolCalls[0]!.result.ok).toBe(true);
    expect(log!.toolCalls[0]!.result.output).toBe('data');
    expect(log!.toolInvocations).toHaveLength(1);
    expect(log!.toolInvocations?.[0]).toMatchObject({
      callId,
      toolName: 'read',
      status: 'succeeded',
      inputSummary: 'object keys: path',
      outputSummary: 'output present (4 characters)',
      approval: { required: 'unknown', decision: 'unknown' },
    });
    expect(log!.toolInvocations?.[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(log!.toolInvocations)).not.toContain('/x');
    expect(JSON.stringify(log!.toolInvocations)).not.toContain('data');
    expect(log!.evidence?.[0]).toMatchObject({
      kind: 'tool_result',
      status: 'pass',
      metadata: { callId, toolName: 'read', outputPresent: true },
    });
  });

  it('prefers authoritative invocation records over legacy error-text inference', async () => {
    const callId = 'authoritative-call';
    const messages: Message[] = [
      {
        id: randomUUID(), role: 'assistant', timestamp: new Date().toISOString(),
        content: [{ type: 'tool_calls', calls: [{ id: callId, name: 'plugin_probe', input: { secret: 'hidden' } }] }],
      },
      {
        id: randomUUID(), role: 'tool', timestamp: new Date().toISOString(),
        content: [{ type: 'tool_result', result: { callId, ok: false, error: 'timed out according to legacy text' } }],
      },
    ];
    const authoritative: ToolInvocationRecord = {
      version: 1,
      id: 'run-authoritative:tool:1',
      callId,
      runId: 'run-authoritative',
      sessionId: 'session-authoritative' as import('@littlesheep/types').SessionId,
      toolName: 'plugin_probe',
      toolSource: 'plugin:test',
      status: 'validation_failed',
      proposedAt: '2026-07-20T00:00:00.000Z',
      resolvedAt: '2026-07-20T00:00:00.001Z',
      endedAt: '2026-07-20T00:00:00.002Z',
      inputHash: 'a'.repeat(64),
      inputSummary: 'object keys: secret',
      approval: { required: 'unknown', decision: 'unknown' },
      errorKind: 'input_validation',
      error: 'schema rejected the request',
      evidenceIds: ['run-authoritative:evidence:tool:1'],
    };

    await store.write({
      runId: 'run-authoritative',
      sessionId: 'session-authoritative',
      startedAt: '2026-07-20T00:00:00.000Z',
      endedAt: '2026-07-20T00:00:01.000Z',
      status: 'error',
      model: 'test',
      inboundText: 'run probe',
      reply: '',
      trace: [],
      toolInvocations: [authoritative],
      messages,
      durationMs: 1_000,
    });

    const log = await store.read('run-authoritative');
    expect(log?.toolInvocations).toEqual([authoritative]);
    expect(log?.toolInvocations?.[0]).toMatchObject({
      status: 'validation_failed',
      toolSource: 'plugin:test',
      errorKind: 'input_validation',
    });
    expect(log?.evidence?.[0]).toMatchObject({
      status: 'fail', metadata: { toolName: 'plugin_probe' },
    });
  });

  it('persists resolved configuration and bounded model/context snapshots', async () => {
    const resolvedRunConfig = {
      version: 1 as const,
      runId: 'run-observed',
      resolvedAt: '2026-07-13T00:00:00.000Z',
      origin: 'app' as const,
      behaviorModeId: 'coding',
      permissionPolicyId: 'research' as const,
      workflowStrategyId: 'core-flow-v1',
      contextStrategyId: 'legacy-stage-assembly-v1',
      memoryStrategyId: 'index-first-v1',
      toolSelectionStrategyId: 'registered-tools-v1',
      outputContractId: 'user-reply-v1',
      provider: 'openai',
      model: 'gpt-test',
      reasoning: 'high' as const,
      parameters: {},
      availableToolNames: [],
      approvalRequiredToolNames: [],
      userOverrides: {},
      projectOverrides: {},
    };
    const modelRequests = [{
      version: 1 as const,
      id: 'request-1',
      runId: 'run-observed',
      sessionId: 's' as import('@littlesheep/types').SessionId,
      stage: 'reply' as const,
      requestIndex: 1,
      provider: 'openai',
      model: 'gpt-test',
      createdAt: '2026-07-13T00:00:01.000Z',
      messages: [],
      totalMessageCount: 0,
      messagesTruncated: false,
      toolNames: [],
      totalToolCount: 0,
      toolsTruncated: false,
      stream: false,
    }];
    const contextSnapshots = [{
      version: 1 as const,
      id: 'context-1',
      runId: 'run-observed',
      sessionId: 's' as import('@littlesheep/types').SessionId,
      provider: 'openai',
      model: 'gpt-test',
      createdAt: '2026-07-13T00:00:01.000Z',
      budget: { status: 'unknown' as const, reason: 'not connected' },
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
      compressionRecommended: false,
    }];
    const memoryIntentDecisions: MemoryIntentDecisionRecord[] = [{
      version: 1,
      id: 'memory-intent-1',
      runId: 'run-observed',
      stage: 'evolve',
      proposedIntent: 'write',
      decision: 'committed',
      reason: 'Created from verified evidence.',
      branch: 'project',
      summary: 'Use pnpm.',
      evidenceRefs: ['run:run-observed:verification:1:pass'],
      writeIntentId: 'memory-intent-1',
      repositoryDecision: 'created',
      createdAt: '2026-07-13T00:00:02.000Z',
    }];

    await store.write({
      runId: 'run-observed', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: 'openai/gpt-test', inboundText: '', reply: '', trace: [], messages: [], durationMs: 0,
      resolvedRunConfig,
      modelRequests,
      contextSnapshots,
      memoryIntentDecisions,
    });

    const log = await store.read('run-observed');
    expect(log?.resolvedRunConfig).toEqual(resolvedRunConfig);
    expect(log?.modelRequests).toEqual(modelRequests);
    expect(log?.contextSnapshots).toEqual(contextSnapshots);
    expect(log?.memoryIntentDecisions).toEqual(memoryIntentDecisions);
  });

  it('reads legacy logs that do not contain the new phase-0 records', async () => {
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify({
      runId: 'legacy', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: 'test', inboundText: 'old', reply: 'reply', trace: [], toolCalls: [], durationMs: 0,
    }));

    const log = await store.read('legacy');
    expect(log?.runId).toBe('legacy');
    expect(log?.toolCalls).toEqual([]);
    expect(log?.resolvedRunConfig).toBeUndefined();
    expect(log?.modelRequests).toBeUndefined();
    expect(log?.toolInvocations).toBeUndefined();
    expect(log?.webEvidence).toBeUndefined();
  });

  it('persists only the bounded web evidence projection', async () => {
    await store.write({
      runId: 'run-web-evidence', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: 'test', inboundText: 'search for a current source', reply: 'done', trace: [], messages: [], durationMs: 0,
      webEvidence: {
        version: 1,
        providerId: 'fake',
        generatedAt: '2026-08-29T00:00:00.000Z',
        completeness: 'complete',
        citationIds: ['web-1'],
        citationCount: 1,
        documentCount: 1,
        cached: false,
        partial: false,
        truncated: false,
        blocked: false,
        stale: false,
      },
    });

    const log = await store.read('run-web-evidence');
    expect(log?.webEvidence).toMatchObject({ providerId: 'fake', citationIds: ['web-1'] });
    expect(JSON.stringify(log?.webEvidence)).not.toContain('page body');
    expect('documents' in (log?.webEvidence ?? {})).toBe(false);
    expect('query' in (log?.webEvidence ?? {})).toBe(false);
  });

  it('defensively removes run-local web bodies and unapproved projection fields before writing JSON', async () => {
    const body = 'RUN_LOCAL_WEB_BODY_SENTINEL';
    const secret = 'fixture-url-secret';
    const callId = 'web-call';
    const messages: Message[] = [{
      id: 'assistant-web-call', role: 'assistant', timestamp: '2026-08-29T00:00:00.000Z',
      content: [{
        type: 'tool_calls',
        calls: [{ id: callId, name: 'web_fetch', input: { urlHash: 'a'.repeat(64), url: 'https://example.com/' } }],
      }],
    }, {
      id: 'tool-web-result', role: 'tool', timestamp: '2026-08-29T00:00:00.000Z',
      content: [{
        type: 'tool_result',
        result: {
          callId, ok: true, output: JSON.stringify({ citationIds: ['web-run-1-source'] }),
          modelOutput: { content: body, externalUntrusted: true },
        },
      }],
    }];
    await store.write({
      runId: 'run-web-defence', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: 'test', inboundText: 'fetch current source', reply: 'done', trace: [], messages, durationMs: 0,
      webEvidence: {
        version: 1,
        providerId: 'fake',
        generatedAt: '2026-08-29T00:00:00.000Z',
        completeness: 'complete',
        citationIds: ['web-run-1-source'],
        citations: [{
          id: 'web-run-1-source',
          url: `https://example.com/private?token=${secret}`,
          origin: 'https://example.com',
          urlHash: 'b'.repeat(64),
          fetchedAt: '2026-08-29T00:00:00.000Z',
          status: 'fetched',
          truncated: false,
          snippet: body,
        }],
        citationCount: 1,
        documentCount: 1,
        cached: false,
        partial: false,
        truncated: false,
        blocked: false,
        stale: false,
        query: `private ${secret}`,
        documents: [{ content: body }],
      } as never,
    });

    const log = await store.read('run-web-defence');
    const durable = JSON.stringify(log);
    expect(durable).not.toContain(body);
    expect(durable).not.toContain(secret);
    expect(durable).not.toContain('documents');
    expect(durable).not.toContain('snippet');
    expect(log?.toolCalls[0]?.result).not.toHaveProperty('modelOutput');
    expect(log?.webEvidence?.citations?.[0]).toMatchObject({
      id: 'web-run-1-source', origin: 'https://example.com', urlHash: 'b'.repeat(64),
    });
    expect(log?.webEvidence?.citations?.[0]?.url).toBeUndefined();
  });

  it('links bounded memory and attachment resource ids without persisting their bodies', async () => {
    const createdAt = '2026-07-13T00:00:01.000Z';
    const sourceIds = [
      'summary-1',
      'attachment-manifest:run-resources',
      'runtime-events:run-resources',
      ...Array.from({ length: 260 }, (_, index) => `memory-resource-${index}`),
    ];
    const contextSnapshots: ContextSnapshot[] = [{
      version: 1,
      id: 'context-resources',
      runId: 'run-resources',
      sessionId: 'session-resources' as import('@littlesheep/types').SessionId,
      provider: 'test',
      model: 'model',
      createdAt,
      budget: { status: 'unknown', reason: 'test' },
      items: sourceIds.map((id, index) => ({
        id: `item-${index}`,
        kind: index === 1 ? 'attachment_manifest' : index === 2 ? 'runtime_event' : 'summary_memory',
        scope: index === 0 ? 'session' : 'run',
        source: { kind: index === 1 ? 'attachment' : index === 2 ? 'runtime_event' : 'memory', id },
        priority: 80,
        required: true,
        sensitive: true,
        createdAt,
        contentType: 'text',
        contentHash: `hash-${index}`,
        characterCount: 10,
        disposition: 'included',
      })),
      totalItemCount: sourceIds.length,
      itemsTruncated: false,
      compressionRecommended: false,
    }];
    const memoryAccess: MemoryAccessLedger = {
      runId: 'run-resources',
      sessionId: 'session-resources' as import('@littlesheep/types').SessionId,
      workspace: 'D:/workspace',
      startedAt: createdAt,
      endedAt: createdAt,
      totalTokenBudget: 1_000,
      tokensUsed: 10,
      expandedBranches: ['resources'],
      dedupKeys: [],
      knownState: { version: 1, runId: 'run-resources', revision: 0, updatedAt: createdAt, references: [] },
      records: [{
        id: 'access-1',
        action: 'expand',
        at: createdAt,
        branchId: 'resources',
        status: 'ok',
        fragmentIds: ['summary-1', 'expanded-memory-node'],
        sourceCount: 2,
        dedupedCount: 0,
        tokensUsed: 10,
        tokenBudget: 100,
      }],
    };

    await store.write({
      runId: 'run-resources', sessionId: 'session-resources', startedAt: createdAt, endedAt: createdAt,
      status: 'ok', model: 'test/model', inboundText: 'inspect', reply: 'done', trace: [], messages: [],
      contextSnapshots, memoryAccess, durationMs: 1,
    });

    const log = await store.read('run-resources');
    expect(log?.resourceIds).toHaveLength(256);
    expect(log?.resourceIds?.slice(0, 3)).toEqual([
      'summary-1',
      'attachment-manifest:run-resources',
      'runtime-events:run-resources',
    ]);
    expect(log?.resourceIdsTruncated).toBe(true);
    expect(JSON.stringify(log)).not.toContain('PRIVATE-RESOURCE-BODY');
  });

  it('keeps persisted model observations aligned with the bounded checkpoint window', async () => {
    const createdAt = '2026-07-13T00:00:01.000Z';
    const modelRequests: ModelRequestSnapshot[] = Array.from({ length: MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 6 }, (_, index) => ({
      version: 1,
      id: `request-${index}`,
      runId: 'run-observation-window',
      sessionId: 'session-observation-window' as import('@littlesheep/types').SessionId,
      stage: 'execute',
      requestIndex: index,
      provider: 'test',
      model: 'model',
      createdAt,
      messages: [],
      totalMessageCount: 0,
      messagesTruncated: false,
      toolNames: [],
      totalToolCount: 0,
      toolsTruncated: false,
      stream: false,
      contextSnapshotId: `snapshot-${index}`,
      payloadHash: `hash-${index}`,
    }));
    const contextSnapshots: ContextSnapshot[] = modelRequests.map((request) => ({
      version: 1,
      id: request.contextSnapshotId!,
      runId: request.runId,
      sessionId: request.sessionId,
      provider: request.provider,
      model: request.model,
      createdAt,
      budget: { status: 'unknown', reason: 'test' },
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
      compressionRecommended: false,
    }));

    await store.write({
      runId: 'run-observation-window',
      sessionId: 'session-observation-window',
      startedAt: createdAt,
      endedAt: createdAt,
      status: 'ok',
      model: 'test/model',
      inboundText: 'observe',
      reply: 'done',
      trace: [],
      modelRequests,
      contextSnapshots,
      messages: [],
      durationMs: 1,
    });

    const log = await store.read('run-observation-window');
    expect(log?.modelRequests).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(log?.contextSnapshots).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(log?.modelRequests?.[0]?.requestIndex).toBe(6);
    expect(log?.contextSnapshots?.[0]?.id).toBe('snapshot-6');
    expect(log?.modelRequests?.every((request) => (
      request.contextSnapshotId !== undefined
      && log.contextSnapshots?.some((snapshot) => snapshot.id === request.contextSnapshotId)
    ))).toBe(true);
  });

  it('retains an older snapshot referenced by the persisted request tail', async () => {
    const createdAt = '2026-07-13T00:00:01.000Z';
    const modelRequests: ModelRequestSnapshot[] = Array.from({ length: MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 6 }, (_, index) => ({
      version: 1,
      id: `association-request-${index}`,
      runId: 'run-observation-association',
      sessionId: 'session-observation-association' as import('@littlesheep/types').SessionId,
      stage: 'execute',
      requestIndex: index,
      provider: 'test',
      model: 'model',
      createdAt,
      messages: [],
      totalMessageCount: 0,
      messagesTruncated: false,
      toolNames: [],
      totalToolCount: 0,
      toolsTruncated: false,
      stream: false,
      contextSnapshotId: index === 6 ? 'association-snapshot-0' : `association-snapshot-${index}`,
      payloadHash: `association-hash-${index}`,
    }));
    const contextSnapshots: ContextSnapshot[] = modelRequests.map((request, index) => ({
      version: 1,
      id: `association-snapshot-${index}`,
      runId: request.runId,
      sessionId: request.sessionId,
      provider: request.provider,
      model: request.model,
      createdAt,
      budget: { status: 'unknown', reason: 'test' },
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
      compressionRecommended: false,
    }));

    await store.write({
      runId: 'run-observation-association',
      sessionId: 'session-observation-association',
      startedAt: createdAt,
      endedAt: createdAt,
      status: 'ok',
      model: 'test/model',
      inboundText: 'associate',
      reply: 'done',
      trace: [],
      modelRequests,
      contextSnapshots,
      messages: [],
      durationMs: 1,
    });

    const log = await store.read('run-observation-association');
    expect(log?.modelRequests).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(log?.contextSnapshots).toHaveLength(MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN);
    expect(log?.modelRequests?.[0]?.requestIndex).toBe(6);
    expect(log?.modelRequests?.[0]?.contextSnapshotId).toBe('association-snapshot-0');
    expect(log?.contextSnapshots?.some((snapshot) => snapshot.id === 'association-snapshot-0')).toBe(true);
    expect(log?.contextSnapshots?.some((snapshot) => snapshot.id === 'association-snapshot-6')).toBe(false);
  });

  it('未配对的 call（无 result）被忽略', async () => {
    const messages: Message[] = [
      {
        id: randomUUID(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_calls', calls: [{ id: 'orphan', name: 'read', input: {} }] },
        ],
      },
    ];
    await store.write({
      runId: 'run-3',
      sessionId: 's1',
      startedAt: '',
      endedAt: '',
      status: 'ok',
      model: 't',
      inboundText: '',
      reply: '',
      trace: [],
      messages,
      durationMs: 0,
    });
    const log = await store.read('run-3');
    expect(log!.toolCalls).toEqual([]);
  });

  it('list 返回所有 runId', async () => {
    await store.write({
      runId: 'a', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: '', trace: [], messages: [], durationMs: 0,
    });
    await store.write({
      runId: 'b', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: '', trace: [], messages: [], durationMs: 0,
    });
    const ids = await store.list();
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('list 空目录 → []', async () => {
    const emptyStore = new ExecutionLogStore({ rootDir: join(dir, 'noexist') });
    const ids = await emptyStore.list();
    expect(ids).toEqual([]);
  });

  it('persists clarification request and response metadata', async () => {
    const clarificationRequest = {
      id: 'run-4:clarification',
      kind: 'missing_information' as const,
      sourceStage: 'decide' as const,
      createdAt: '2026-07-10T00:00:00.000Z',
      originalRequest: 'edit it',
      blockingReason: 'target missing',
      questions: [{ id: 'question-1', field: 'path', prompt: 'Which file?', required: true }],
    };
    const clarificationResponse = {
      requestId: 'prior:clarification',
      answer: 'README.md',
      answeredAt: '2026-07-10T00:01:00.000Z',
    };
    await store.write({
      runId: 'run-4', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: 'Which file?', trace: [], messages: [], durationMs: 0,
      clarificationRequest,
      clarificationResponse,
    });

    const log = await store.read('run-4');
    expect(log?.clarificationRequest).toEqual(clarificationRequest);
    expect(log?.clarificationResponse).toEqual(clarificationResponse);
  });

  it('persists redacted conversation continuation evidence', async () => {
    const conversationContinuation = {
      version: 1 as const,
      resolution: 'bound' as const,
      checkpointId: 'checkpoint-1',
      sourceRunId: 'source-run-1',
      requestId: 'request-1',
      answerMessageId: 'answer-1',
      resumeRunId: 'resume-run-1',
      disposition: 'retry' as const,
      dispositionSource: 'model' as const,
      resumeStage: 'recover' as const,
      resumeRule: 'recover->recover',
      resources: {
        status: 'restored' as const,
        attachmentCount: 1,
        toolRecipeCount: 1,
        restoredToolCount: 1,
      },
      permissions: { checkpoint: 'restricted' as const, current: 'full' as const },
      replayPrevention: {
        completedStepCountPreserved: 2,
        succeededSideEffectCountPreserved: 1,
        uncertainSideEffectCount: 0,
        answerMessageAlreadyPersisted: true,
      },
    };
    await store.write({
      runId: 'continuation-run', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: 'private user text is stored only in the existing inbound field',
      reply: 'done', trace: [], messages: [], durationMs: 0,
      conversationContinuation,
    });

    expect((await store.read('continuation-run'))?.conversationContinuation)
      .toEqual(conversationContinuation);
  });

  it('persists partial replan history inside task execution evidence', async () => {
    await store.write({
      runId: 'run-replan', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: 'done', trace: [], messages: [], durationMs: 0,
      taskExecution: {
        goal: 'finish the task',
        complexity: 'standard',
        status: 'done',
        startedAt: '2026-07-10T00:00:00.000Z',
        steps: [{
          stepId: 'step-1', description: 'finish it', status: 'done', attempt: 2,
          startedAt: '2026-07-10T00:00:02.000Z', output: 'done', toolCallIds: [], toolResults: [],
        }],
        replanHistory: [{
          attempt: 1,
          requestedAt: '2026-07-10T00:00:01.000Z',
          targetStepIds: ['step-1'],
          reason: 'first attempt incomplete',
          feedback: 'retry with evidence',
          preservedStepIds: [],
          revisedStepIds: ['step-1'],
          decidedAt: '2026-07-10T00:00:01.500Z',
          resumedAt: '2026-07-10T00:00:02.000Z',
        }],
      },
    });

    const log = await store.read('run-replan');
    expect(log?.taskExecution?.steps[0]?.attempt).toBe(2);
    expect(log?.taskExecution?.replanHistory?.[0]?.targetStepIds).toEqual(['step-1']);
  });

  it('persists the task contract and every verification outcome', async () => {
    const taskBook = {
      assessment: {
        userNeed: 'inspect the project', complexity: 'standard' as const, goal: 'inspect the project',
        successCriteria: ['inspection is verified'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
      },
      goal: 'inspect the project', complexity: 'standard' as const,
      successCriteria: ['inspection is verified'],
      steps: [{ id: 'step-1', description: 'inspect files', status: 'done' as const }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
      stageResults: [],
    };
    const verificationHistory = [{
      attempt: 1, verdict: 'pass' as const, reason: 'evidence satisfies the contract',
      verifiedAt: '2026-07-11T01:00:03.000Z', source: 'model' as const,
    }];
    await store.write({
      runId: 'run-contract', sessionId: 's', startedAt: '2026-07-11T01:00:00.000Z',
      endedAt: '2026-07-11T01:00:04.000Z', status: 'ok', model: 'test/model',
      inboundText: 'inspect it', reply: 'inspection complete', trace: [], messages: [], durationMs: 4_000,
      taskBook,
      verificationHistory,
    });

    const log = await store.read('run-contract');
    expect(log?.taskBook).toMatchObject({ goal: 'inspect the project', successCriteria: ['inspection is verified'] });
    expect(log?.taskBook?.stageResults).toBeUndefined();
    expect(log?.verificationHistory).toEqual(verificationHistory);
  });

  it('atomically retains the newest bounded summary per session', async () => {
    const summary = (runId: string, endedAt: string): SessionRunSummary => ({
      version: 1,
      runId,
      status: 'ok',
      startedAt: '2026-07-15T01:00:00.000Z',
      endedAt,
      durationMs: 1000,
      tools: {
        total: 0, succeeded: 0, failed: 0, totalDurationMs: 0,
        recent: [], truncated: false,
      },
    });

    await Promise.all([
      store.writeLatestForSession('session-a', summary('newer', '2026-07-15T01:00:03.000Z')),
      store.writeLatestForSession('session-a', summary('older', '2026-07-15T01:00:02.000Z')),
    ]);

    store = new ExecutionLogStore({ rootDir: dir });
    expect(await store.readLatestForSession('session-a')).toMatchObject({ runId: 'newer' });
    expect(await store.readLatestForSession('session-b')).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
