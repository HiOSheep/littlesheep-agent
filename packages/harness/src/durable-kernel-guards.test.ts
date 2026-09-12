// These guards decide two safety boundaries: when a run is terminal, and which
// late settlements are only audit closures. Getting either wrong either
// reopens a failed run or blocks the closure of a real crash.
import { describe, expect, it } from 'vitest';
import type {
  DurableHarnessEventAppendInput,
  DurableRunProjection,
  DurableRunStatus,
} from '@littlesheep/types';
import { isDurableRunTerminal, isTerminalAuditClosure } from './durable-kernel-guards.js';

function projection(overrides: Partial<DurableRunProjection> = {}): DurableRunProjection {
  return {
    version: 1,
    sessionId: 'session-a',
    runId: 'run-a',
    cursor: 3,
    status: 'running',
    eventCount: 3,
    finalReply: { state: 'none' },
    stageTransitions: [],
    verifications: [],
    modelRequests: [],
    pendingModelRequestIds: [],
    effects: [],
    pendingEffectIds: [],
    unknownEffectIds: [],
    ...overrides,
  } as DurableRunProjection;
}

function settlement(
  type: 'effect_settled' | 'model_request_settled' | 'final_reply_settled',
  payload: Record<string, unknown>,
): DurableHarnessEventAppendInput {
  return { idempotencyKey: 'k', sessionId: 'session-a', runId: 'run-a', type, source: 'runtime', payload };
}

describe('durable run guards', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'treats a %s run as terminal',
    (status: DurableRunStatus) => {
      expect(isDurableRunTerminal(projection({ status }))).toBe(true);
    },
  );

  it('treats a settled Runtime status as terminal even while waiting for the user', () => {
    expect(isDurableRunTerminal(projection({
      status: 'waiting_user',
      finalReply: { state: 'runtime_status' },
    }))).toBe(true);
  });

  it('does not treat an open run as terminal', () => {
    for (const status of ['accepted', 'running', 'waiting_user'] as const) {
      expect(isDurableRunTerminal(projection({ status, finalReply: { state: 'proposed' } }))).toBe(false);
    }
  });

  it('accepts only a settlement for a fact that was still pending when the run ended', () => {
    const terminal = projection({
      status: 'failed',
      pendingEffectIds: ['effect-1'],
      pendingModelRequestIds: ['model-1'],
    });
    expect(isTerminalAuditClosure(terminal, settlement('effect_settled', { effectId: 'effect-1' }))).toBe(true);
    expect(isTerminalAuditClosure(terminal, settlement('model_request_settled', { requestId: 'model-1' }))).toBe(true);
    // Already settled or never pending facts must not be re-closed.
    expect(isTerminalAuditClosure(terminal, settlement('effect_settled', { effectId: 'effect-other' }))).toBe(false);
    expect(isTerminalAuditClosure(terminal, settlement('model_request_settled', { requestId: 'model-other' }))).toBe(false);
    expect(isTerminalAuditClosure(terminal, settlement('effect_settled', { effectId: 7 }))).toBe(false);
    expect(isTerminalAuditClosure(terminal, settlement('final_reply_settled', { reply: 'x' }))).toBe(false);
  });

  it('never treats a settlement as an audit closure while the run is still open', () => {
    const open = projection({ status: 'running', pendingEffectIds: ['effect-1'] });
    expect(isTerminalAuditClosure(open, settlement('effect_settled', { effectId: 'effect-1' }))).toBe(false);
  });
});
