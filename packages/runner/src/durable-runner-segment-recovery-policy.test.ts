import { describe, expect, it } from 'vitest';
import { asSessionId } from '@littlesheep/types';
import type {
  DurableHarnessEvent,
  DurableRunProjection,
  RunCheckpoint,
} from '@littlesheep/types';
import { isEligibleSameRunSegmentRecovery } from './durable-runner-segment-recovery-policy.js';

const sessionId = asSessionId('session-s2b-recovery-policy');
const runId = 'run-s2b-recovery-policy';
let eventSequence = 0;

describe('same-Run segment recovery eligibility', () => {
  it('accepts only a complete safe segment boundary with settled ingress and remaining run budgets', () => {
    const fixture = recoveryFixture();
    expect(isEligibleSameRunSegmentRecovery(
      fixture.checkpoint,
      fixture.projection,
      fixture.events,
      sessionId,
      runId,
    )).toBe(true);
  });

  it.each([
    ['legacy checkpoint without a safe boundary', (fixture: RecoveryFixture) => {
      fixture.checkpoint.safeSegmentBoundary = undefined;
    }],
    ['paused checkpoint', (fixture: RecoveryFixture) => {
      fixture.checkpoint.runtimeControl = { version: 1, state: 'paused', changedAt: '2026-10-16T00:00:00.000Z', eventIds: [] };
    }],
    ['interrupted checkpoint', (fixture: RecoveryFixture) => {
      fixture.checkpoint.runtimeControl = { version: 1, state: 'interrupted', changedAt: '2026-10-16T00:00:00.000Z', eventIds: [] };
    }],
    ['cancelled Run', (fixture: RecoveryFixture) => {
      Object.assign(fixture.projection, { status: 'interrupted' });
    }],
    ['exhausted model-call budget', (fixture: RecoveryFixture) => {
      fixture.checkpoint.loopBudget.attemptsUsed = fixture.checkpoint.loopBudget.maxAttempts;
    }],
    ['exhausted tool budget', (fixture: RecoveryFixture) => {
      fixture.checkpoint.loopBudget.toolCallsUsed = fixture.checkpoint.loopBudget.maxToolCalls;
    }],
    ['exhausted Run-wide segment budget', (fixture: RecoveryFixture) => {
      fixture.checkpoint.loopBudget.toolLoopIterationsUsed = fixture.checkpoint.loopBudget.maxToolLoopIterationsPerRun;
    }],
    ['unknown side effect', (fixture: RecoveryFixture) => {
      Object.assign(fixture.projection, { unknownEffectIds: ['effect-unknown'] });
    }],
    ['unsettled effect', (fixture: RecoveryFixture) => {
      Object.assign(fixture.projection, { pendingEffectIds: ['effect-pending'] });
    }],
    ['unsettled Provider request', (fixture: RecoveryFixture) => {
      Object.assign(fixture.projection, { pendingModelRequestIds: ['request-pending'] });
    }],
    ['Provider reach is unknown', (fixture: RecoveryFixture) => {
      Object.assign(fixture.projection, {
        modelRequests: [{ requestId: 'request-1', status: 'received', providerReachStatus: 'unknown', startedEventId: 'event-request-1' }],
      });
    }],
    ['missing durable checkpoint-written event', (fixture: RecoveryFixture) => {
      fixture.events = fixture.events.filter((event) => event.type !== 'checkpoint_written');
    }],
    ['duplicated ingress', (fixture: RecoveryFixture) => {
      fixture.events.push(event('run_accepted', {}));
    }],
    ['mismatched original inbound reference', (fixture: RecoveryFixture) => {
      fixture.events[1] = event('user_input_appended', { messageId: 'different-input' });
    }],
    ['queued runtime event', (fixture: RecoveryFixture) => {
      fixture.checkpoint.pendingEventIds = ['queued-event'];
    }],
    ['terminal completion event', (fixture: RecoveryFixture) => {
      fixture.events.push(event('run_completed', {}));
    }],
  ])('fails closed for %s', (_name, mutate) => {
    const fixture = recoveryFixture();
    mutate(fixture);
    expect(isEligibleSameRunSegmentRecovery(
      fixture.checkpoint,
      fixture.projection,
      fixture.events,
      sessionId,
      runId,
    )).toBe(false);
  });
});

interface RecoveryFixture {
  checkpoint: RunCheckpoint;
  projection: DurableRunProjection;
  events: DurableHarnessEvent[];
}

function recoveryFixture(): RecoveryFixture {
  const checkpoint = {
    version: 1,
    id: 'checkpoint-segment-2',
    runId,
    sessionId,
    status: 'recoverable',
    currentStage: 'execute',
    reason: 'execution-segment-started',
    safeSegmentBoundary: {
      version: 1,
      kind: 'execution_segment',
      modelContextFingerprint: 'a'.repeat(64),
      executionContextFingerprint: 'b'.repeat(64),
      executionContextComponents: {
        identity: 'c'.repeat(64),
        tools: 'd'.repeat(64),
        configuration: 'e'.repeat(64),
        prompt: 'f'.repeat(64),
        memory: '0'.repeat(64),
      },
    },
    resumeState: { version: 1, inboundMessageId: 'original-input' },
    runtimeControl: { version: 1, state: 'running', changedAt: '2026-10-16T00:00:00.000Z', eventIds: [] },
    pendingEventIds: [],
    runtimeEventQueue: { version: 1, cursor: 0, events: [] },
    sideEffects: [],
    loopBudget: {
      attemptsUsed: 30,
      maxAttempts: 64,
      elapsedMs: 30_000,
      maxElapsedMs: 600_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 4,
      toolLoopIterationsUsed: 30,
      maxToolLoopIterations: 30,
      maxToolLoopIterationsPerRun: 60,
      executionSegmentIndex: 2,
      segmentIterationsUsed: 0,
      toolCallsUsed: 30,
      maxToolCalls: 64,
    },
  } as unknown as RunCheckpoint;
  const projection = {
    version: 1,
    sessionId: String(sessionId),
    runId,
    cursor: 3,
    status: 'running',
    route: 'execute',
    eventCount: 3,
    finalReply: { state: 'none' },
    stageTransitions: [],
    verifications: [],
    modelRequests: [{ requestId: 'request-1', status: 'received', providerReachStatus: 'reached', startedEventId: 'request-started' }],
    pendingModelRequestIds: [],
    effects: [],
    pendingEffectIds: [],
    unknownEffectIds: [],
  } as unknown as DurableRunProjection;
  return {
    checkpoint,
    projection,
    events: [
      event('run_accepted', {}),
      event('user_input_appended', { messageId: 'original-input' }),
      event('checkpoint_written', { checkpointId: checkpoint.id }),
    ],
  };
}

function event(type: DurableHarnessEvent['type'], payload: Record<string, unknown>): DurableHarnessEvent {
  eventSequence += 1;
  return {
    version: 1,
    eventId: `${type}-${eventSequence}`,
    idempotencyKey: `${type}-${eventSequence}`,
    sessionId: String(sessionId),
    runId,
    cursor: 1,
    type,
    source: 'runtime',
    occurredAt: '2026-10-16T00:00:00.000Z',
    payload,
  };
}
