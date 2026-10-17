import { describe, expect, it } from 'vitest';
import { parseTaskOutcome, unknownTaskOutcome } from './task-outcome.js';

describe('Task Outcome codec', () => {
  it('accepts file verification only when its check and file state evidence are linked', () => {
    const base = unknownTaskOutcome('run-1');
    const fileState = {
      version: 1 as const, id: 'file-check:state', kind: 'file_state' as const,
      status: 'informational' as const, sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt',
      contentHash: 'a'.repeat(64),
      checkedAt: '2026-10-17T12:00:00.000Z',
    };
    const toolResult = {
      version: 1 as const, id: 'tool-result:check-1', kind: 'tool_result' as const,
      status: 'informational' as const, sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt',
    };
    const requirementCheck = {
      version: 1 as const, id: 'file-check:result', kind: 'requirement_check' as const,
      status: 'pass' as const, sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt',
      contentHash: 'a'.repeat(64),
    };
    const outcome = {
      ...base,
      execution: { status: 'completed' as const },
      requirementInventory: 'complete' as const,
      requirements: [{
        id: 'req-1', sourceMessageId: 'message-1', origin: 'user_explicit' as const,
        status: 'passed' as const, evidenceRefs: [fileState.id, toolResult.id, requirementCheck.id],
      }],
      evidence: [fileState, toolResult, requirementCheck],
      artifacts: [{
        resourceRef: 'workspace:result.txt', action: 'observed' as const,
        evidenceRefs: [fileState.id, toolResult.id, requirementCheck.id], verification: 'passed' as const,
      }],
      status: 'completed' as const,
      remaining: [],
    };
    expect(parseTaskOutcome(outcome, 'run-1')).toEqual(outcome);
    expect(parseTaskOutcome({ ...outcome, evidence: [{ ...fileState, checkedAt: 'not-a-date' }, toolResult, requirementCheck] }, 'run-1'))
      .toBeUndefined();
    expect(parseTaskOutcome({ ...outcome, evidence: [fileState, toolResult] }, 'run-1')).toBeUndefined();
    expect(parseTaskOutcome({ ...outcome, requirementInventory: 'unknown' }, 'run-1')).toBeUndefined();
  });

  it('preserves old missing outcomes as unknown instead of deriving pass from execution', () => {
    expect(parseTaskOutcome(undefined, 'legacy-run')).toBeUndefined();
    expect(unknownTaskOutcome('legacy-run')).toMatchObject({
      runId: 'legacy-run', status: 'unknown', requirementInventory: 'unknown', requirements: [],
    });
  });
});
