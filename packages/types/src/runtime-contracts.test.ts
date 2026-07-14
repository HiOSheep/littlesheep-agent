import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MANIFEST_VERSION,
  CONTEXT_SNAPSHOT_VERSION,
  RUN_CHECKPOINT_VERSION,
  RESOLVED_RUN_CONFIG_VERSION,
  MODE_DEFINITION_VERSION,
  RUNTIME_EVENT_VERSION,
  TASK_BOOK_PATCH_VERSION,
  MODEL_REQUEST_SNAPSHOT_VERSION,
  TOOL_INVOCATION_RECORD_VERSION,
  EXECUTION_EVIDENCE_VERSION,
  asSessionId,
  getDisplayablePromptTokens,
  type AttachmentManifest,
  type ContextSafetyEstimate,
  type ContextSnapshot,
  type LocalTokenLedger,
  type ProviderTokenLedger,
  type RunCheckpoint,
  type ResolvedRunConfig,
  type ModeDefinition,
  type ModelRequestSnapshot,
  type ToolInvocationRecord,
  type ExecutionEvidenceBundle,
  type RuntimeEventEnvelope,
  type TaskBookPatch,
} from './index.js';

describe('runtime continuity v1 contracts', () => {
  it('keeps exact local accounting separate from provider usage', () => {
    const local: LocalTokenLedger = {
      version: CONTEXT_SNAPSHOT_VERSION,
      source: 'local',
      accuracy: 'exact',
      provider: 'openai',
      model: 'gpt-test',
      tokenizerId: 'test-tokenizer-v1',
      promptTokens: 1200,
      countedAt: '2026-07-13T00:00:00.000Z',
    };
    const provider: ProviderTokenLedger = {
      version: CONTEXT_SNAPSHOT_VERSION,
      source: 'provider',
      provider: 'openai',
      model: 'gpt-test',
      promptTokens: 1224,
      completionTokens: 120,
      totalTokens: 1344,
      cachedPromptTokens: 200,
      reasoningTokens: 80,
      reportedAt: '2026-07-13T00:00:01.000Z',
    };
    const snapshot: ContextSnapshot = {
      version: CONTEXT_SNAPSHOT_VERSION,
      id: 'context-1',
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      provider: 'openai',
      model: 'gpt-test',
      createdAt: '2026-07-13T00:00:00.000Z',
      budget: {
        status: 'known',
        maxContextTokens: 128000,
        reservedOutputTokens: 8000,
        availablePromptTokens: 120000,
        compressionThresholdRatio: 0.8,
      },
      items: [],
      totalItemCount: 0,
      itemsTruncated: false,
      compressionRecommended: false,
      localTokenLedger: local,
      providerUsage: provider,
    };

    expect(snapshot.localTokenLedger?.source).toBe('local');
    expect(snapshot.providerUsage?.source).toBe('provider');
    expect(snapshot.providerUsage?.cachedPromptTokens).toBe(200);
    expect(snapshot.providerUsage?.reasoningTokens).toBe(80);
    expect(getDisplayablePromptTokens(local)).toBe(1200);
    expect(getDisplayablePromptTokens(provider)).toBe(1224);
  });

  it('does not expose an unavailable local count as a real token value', () => {
    const unavailable: LocalTokenLedger = {
      version: CONTEXT_SNAPSHOT_VERSION,
      source: 'local',
      accuracy: 'unavailable',
      provider: 'unknown',
      model: 'unknown-model',
      reason: 'No matching tokenizer is registered.',
      countedAt: '2026-07-13T00:00:00.000Z',
    };

    expect(getDisplayablePromptTokens(unavailable)).toBeUndefined();
  });

  it('keeps conservative safety estimates outside the displayable token ledger', () => {
    const safetyEstimate: ContextSafetyEstimate = {
      version: CONTEXT_SNAPSHOT_VERSION,
      source: 'local',
      accuracy: 'conservative',
      purpose: 'overflow_protection',
      provider: 'openai',
      model: 'gpt-test',
      estimatorId: 'utf8-safety-v1',
      estimatedPromptTokens: 24_000,
      calculatedAt: '2026-07-13T00:00:00.000Z',
      displayable: false,
    };

    expect(safetyEstimate.displayable).toBe(false);
    expect(safetyEstimate.accuracy).toBe('conservative');
  });

  it('versions attachment, event, patch, and checkpoint records independently', () => {
    const manifest: AttachmentManifest = {
      version: ATTACHMENT_MANIFEST_VERSION,
      runId: 'run-1',
      entries: [{
        id: 'attachment-1',
        name: 'notes.md',
        kind: 'document',
        ownership: 'user_workplace',
        contentState: 'uninspected',
        registeredAt: '2026-07-13T00:00:00.000Z',
      }],
    };
    const event: RuntimeEventEnvelope = {
      version: RUNTIME_EVENT_VERSION,
      id: 'event-1',
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      sequence: 1,
      type: 'user_message',
      source: 'app',
      status: 'queued',
      receivedAt: '2026-07-13T00:00:01.000Z',
      payload: { text: 'Add a verification step.' },
    };
    const patch: TaskBookPatch = {
      version: TASK_BOOK_PATCH_VERSION,
      id: 'patch-1',
      runId: 'run-1',
      baseRevision: 1,
      nextRevision: 2,
      eventIds: [event.id],
      reason: 'User added a verification requirement.',
      operations: [{
        type: 'add_step',
        step: { id: 'step-2', description: 'Verify the output.' },
      }],
      createdAt: '2026-07-13T00:00:02.000Z',
    };
    const checkpoint: RunCheckpoint = {
      version: RUN_CHECKPOINT_VERSION,
      id: 'checkpoint-1',
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      status: 'paused',
      currentStage: 'execute',
      taskBookRevision: patch.nextRevision,
      eventCursor: event.sequence,
      pendingEventIds: [],
      contextSnapshotIds: ['context-1'],
      sideEffects: [{
        idempotencyKey: 'write:D:/work/result.txt:hash',
        toolName: 'write',
        status: 'succeeded',
        evidenceRef: 'execution-log:tool-call-1',
      }],
      loopBudget: {
        attemptsUsed: 1,
        maxAttempts: 3,
        elapsedMs: 500,
        maxElapsedMs: 60000,
        noProgressRounds: 0,
        maxNoProgressRounds: 2,
      },
      createdAt: '2026-07-13T00:00:03.000Z',
      reason: 'User paused the run.',
    };

    expect(manifest.version).toBe(1);
    expect(event.version).toBe(1);
    expect(patch.version).toBe(1);
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.sideEffects[0]?.status).toBe('succeeded');
  });

  it('keeps run resolution, model requests, tool calls, and evidence as separate records', () => {
    const sessionId = asSessionId('session-1');
    const config: ResolvedRunConfig = {
      version: RESOLVED_RUN_CONFIG_VERSION,
      runId: 'run-1',
      resolvedAt: '2026-07-13T00:00:00.000Z',
      origin: 'app',
      behaviorModeId: 'coding',
      permissionPolicyId: 'research',
      workflowStrategyId: 'core-flow-v1',
      contextStrategyId: 'indexed-default-v1',
      memoryStrategyId: 'index-first-v1',
      toolSelectionStrategyId: 'registered-tools-v1',
      outputContractId: 'user-reply-v1',
      provider: 'openai',
      model: 'gpt-test',
      reasoning: 'high',
      parameters: { temperature: 0 },
      availableToolNames: ['read'],
      approvalRequiredToolNames: ['write'],
      userOverrides: {},
      projectOverrides: {},
    };
    const request: ModelRequestSnapshot = {
      version: MODEL_REQUEST_SNAPSHOT_VERSION,
      id: 'request-1',
      runId: config.runId,
      sessionId,
      stage: 'execute',
      requestIndex: 1,
      provider: config.provider,
      model: config.model,
      createdAt: '2026-07-13T00:00:01.000Z',
      messages: [{
        role: 'system',
        contentKind: 'text',
        characterCount: 120,
        toolCallCount: 0,
      }],
      totalMessageCount: 1,
      messagesTruncated: false,
      toolNames: ['read'],
      totalToolCount: 1,
      toolsTruncated: false,
      toolChoice: 'auto',
      temperature: 0,
      stream: false,
      contextSnapshotId: 'context-1',
    };
    const invocation: ToolInvocationRecord = {
      version: TOOL_INVOCATION_RECORD_VERSION,
      id: 'tool-record-1',
      callId: 'call-1',
      runId: config.runId,
      sessionId,
      stepId: 'step-1',
      toolName: 'read',
      toolSource: 'builtin',
      status: 'succeeded',
      proposedAt: '2026-07-13T00:00:02.000Z',
      startedAt: '2026-07-13T00:00:03.000Z',
      endedAt: '2026-07-13T00:00:04.000Z',
      approval: { required: false, decision: 'not_required' },
      outputSummary: 'Read one file.',
      outputSanitized: true,
      durationMs: 1000,
      evidenceIds: ['evidence-1'],
    };
    const evidence: ExecutionEvidenceBundle = {
      version: EXECUTION_EVIDENCE_VERSION,
      runId: config.runId,
      evidence: [{
        version: EXECUTION_EVIDENCE_VERSION,
        id: 'evidence-1',
        runId: config.runId,
        sessionId,
        stepId: invocation.stepId,
        kind: 'tool_result',
        status: 'pass',
        sourceRef: `tool:${invocation.id}`,
        summary: 'The requested file was read successfully.',
        createdAt: invocation.endedAt!,
        sensitive: false,
        metadata: {},
      }],
    };

    expect(config.permissionPolicyId).toBe('research');
    expect(request.contextSnapshotId).toBe('context-1');
    expect(invocation.evidenceIds).toEqual(['evidence-1']);
    expect(evidence.evidence[0]?.sourceRef).toBe('tool:tool-record-1');
  });

  it('keeps behavior mode declarative and independent from permission policy', () => {
    const mode: ModeDefinition = {
      version: MODE_DEFINITION_VERSION,
      id: 'coding',
      label: '编程',
      description: 'Programming-specialized behavior.',
      promptProfileId: 'coding',
      workflowStrategyId: 'core-flow-v1',
      toolSelectionStrategyId: 'coding-tools-v1',
      memoryStrategyId: 'index-first-v1',
      contextStrategyId: 'legacy-stage-assembly-v1',
      outputContractId: 'user-reply-v1',
      modelDefaults: { reasoning: 'high', parameters: { temperature: 0 } },
    };

    expect(mode.version).toBe(1);
    expect(mode.promptProfileId).toBe('coding');
    expect('permissionPolicyId' in mode).toBe(false);
  });
});
