import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildTaskOutcome, readTaskOutcomeForProjection } from './task-outcome.js';
import { unknownTaskOutcome } from '@littlesheep/types';
import { parseExplicitFileContentRequirement } from './task-outcome-request.js';
import { asSessionId, type AgentResult } from '@littlesheep/types';

const requirement = parseExplicitFileContentRequirement({
  runId: 'run-1', sourceMessageId: 'user-message-1', text: '创建 result.txt，内容必须为 hello。',
})!;

function resultWithReceipt(status: 'passed' | 'failed' | 'blocked'): Pick<AgentResult,
  'status' | 'runtimeStatus' | 'sideEffects' | 'modelRequests' | 'messages' | 'toolInvocations'> {
  const checkCallId = `check-${status}`;
  const digest = 'a'.repeat(64);
  return {
    status: 'ok' as const,
    sideEffects: [{ toolName: 'write', idempotencyKey: 'write-key', callId: 'write-call', status: 'succeeded' as const }],
    modelRequests: [],
    toolInvocations: [{
      version: 1,
      id: 'invocation-write',
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      toolName: 'write',
      toolSource: 'builtin',
      callId: 'write-call',
      status: 'succeeded',
      proposedAt: '2026-10-17T00:00:00.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }, {
      version: 1,
      id: `invocation-${checkCallId}`,
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      toolName: 'runtime_check_file_content',
      toolSource: 'run-scoped',
      callId: checkCallId,
      status: 'succeeded',
      proposedAt: '2026-10-17T00:00:00.000Z',
      approval: { required: false, decision: 'not_required' },
      evidenceIds: [],
    }],
    messages: [{ id: 'message-write', timestamp: '2026-10-17T00:00:00.500Z', role: 'tool', content: [{ type: 'tool_result', result: {
      callId: 'write-call',
      ok: true,
      meta: { workspaceFileMutation: { resourceRef: 'workspace:result.txt', action: 'created' } },
    } }] }, { id: 'message-check', timestamp: '2026-10-17T00:00:01.000Z', role: 'tool', content: [{ type: 'tool_result', result: {
      callId: checkCallId,
      ok: true,
      meta: { taskOutcomeCheck: {
        version: 1,
        requirementId: requirement.requirementId,
        evidenceId: `file-check:${status}-req`,
        fileStateEvidenceId: `file-check:${status}-state`,
        status,
        resourceRef: 'workspace:result.txt',
        ...(status === 'blocked' ? { reasonCode: 'permission_denied' } : { contentHash: digest }),
      } },
    } }] }],
  };
}

describe('buildTaskOutcome', () => {
  it('does not expose a completed outcome before terminal settlement', () => {
    const completed = {
      ...unknownTaskOutcome('run-1'),
      execution: { status: 'completed' as const },
      requirementInventory: 'complete' as const,
      status: 'completed' as const,
    };
    expect(readTaskOutcomeForProjection({
      status: 'running', finalReply: { state: 'proposed' },
      taskOutcome: { outcome: completed, settledEventId: 'outcome-1' },
    }, 'run-1')).toMatchObject({
      status: 'unknown', execution: { reasonCode: 'outcome_pending_terminal_settlement' },
    });
  });

  it('requires the trusted check receipt and preserves mismatch as partial completion', () => {
    const outcome = buildTaskOutcome({ runId: 'run-1', result: resultWithReceipt('failed'), requirement });
    expect(outcome).toMatchObject({
      status: 'partially_completed',
      execution: { status: 'completed' },
      requirementInventory: 'complete',
      requirements: [{ sourceMessageId: 'user-message-1', status: 'failed', reasonCode: 'file_content_mismatch' }],
      artifacts: [{ resourceRef: 'workspace:result.txt', verification: 'failed' }],
    });
    expect(outcome.requirements[0]?.evidenceRefs).toHaveLength(4);
  });

  it('only marks the explicit requirement passed when the trusted checker passed', () => {
    const outcome = buildTaskOutcome({ runId: 'run-1', result: resultWithReceipt('passed'), requirement });
    expect(outcome.status).toBe('completed');
    expect(outcome.requirements[0]?.status).toBe('passed');
    expect(outcome.evidence.map((item) => item.kind)).toEqual(['file_state', 'settled_effect', 'tool_result', 'requirement_check']);
  });

  it('reuses a settled write identity when pre-checkpoint result messages are absent after recovery', () => {
    const recovered = resultWithReceipt('passed');
    recovered.messages = recovered.messages.filter((message) => message.id !== 'message-write');
    recovered.toolInvocations = recovered.toolInvocations?.filter((record) => record.toolName !== 'write');
    const target = resolve(process.cwd(), 'result.txt').replace(/[\\/]+$/u, '');
    const normalized = process.platform === 'win32' ? target.toLocaleLowerCase() : target;
    recovered.sideEffects = [{
      toolName: 'write',
      idempotencyKey: 'write-key',
      callId: 'write-call',
      resourceKeys: [`fs:${normalized}`],
      status: 'succeeded',
      endedAt: '2026-10-17T00:00:00.500Z',
    }];

    const outcome = buildTaskOutcome({ runId: 'run-1', workspaceRoot: process.cwd(), result: recovered, requirement });
    expect(outcome).toMatchObject({
      status: 'completed',
      requirements: [{ status: 'passed' }],
    });
    expect(outcome.evidence.some((item) => item.kind === 'settled_effect' && item.status === 'pass')).toBe(true);
  });

  it('does not pass a matching existing file without a settled write effect from this Run', () => {
    const existingFileOnly = resultWithReceipt('passed');
    existingFileOnly.toolInvocations = existingFileOnly.toolInvocations?.filter((record) => record.toolName !== 'write');
    existingFileOnly.sideEffects = [];
    existingFileOnly.messages = existingFileOnly.messages.filter((message) => message.id !== 'message-write');
    expect(buildTaskOutcome({ runId: 'run-1', result: existingFileOnly, requirement })).toMatchObject({
      status: 'partially_completed',
      requirements: [{ status: 'unverified', reasonCode: 'no_settled_write_effect' }],
      artifacts: [{ verification: 'unverified' }],
    });
  });

  it('keeps missing checks unverified and arbitrary inventories unknown', () => {
    const noCheck = resultWithReceipt('passed');
    noCheck.toolInvocations = [];
    expect(buildTaskOutcome({ runId: 'run-1', result: noCheck, requirement }).requirements[0]?.status).toBe('unverified');
    const unknown = buildTaskOutcome({ runId: 'run-2', result: { ...noCheck, status: 'ok' } });
    expect(unknown).toMatchObject({ status: 'unknown', requirementInventory: 'unknown' });
  });

  it('does not pass requirements with an unknown side effect or unsettled Provider request', () => {
    const unknownEffect = resultWithReceipt('passed');
    unknownEffect.sideEffects = [{ toolName: 'write', idempotencyKey: 'write-key', callId: 'write-call', status: 'unknown' as const }];
    expect(buildTaskOutcome({ runId: 'run-1', result: unknownEffect, requirement }).requirements[0]?.status).toBe('blocked');
    const providerPending = resultWithReceipt('passed');
    expect(buildTaskOutcome({
      runId: 'run-1', result: providerPending, requirement, unsettledProviderRequestIds: ['provider-1'],
    }).requirements[0]?.status).toBe('blocked');
  });
});
