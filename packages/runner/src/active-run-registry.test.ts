import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@littlesheep/types';
import { ActiveRunRegistry } from './active-run-registry.js';

describe('ActiveRunRegistry', () => {
  it('owns one isolated queue per active run and releases it on unregister', () => {
    const registry = new ActiveRunRegistry({ queueOptions: { maxEventAgeMs: null } });
    const queue = registry.register('run-1', asSessionId('session-1'));
    expect(registry.append('run-1', {
      sessionId: asSessionId('session-1'),
      type: 'pause_requested',
      source: 'app',
      payload: { reason: 'user requested pause' },
    })).toMatchObject({ kind: 'accepted', event: { runId: 'run-1', sequence: 1 } });
    expect(registry.append('run-1', {
      sessionId: asSessionId('other-session'),
      type: 'resume_requested',
      source: 'app',
      payload: {},
    })).toMatchObject({ kind: 'rejected', reason: 'session-mismatch' });
    expect(registry.summary('run-1')).toMatchObject({ queued: 1, pendingEventIds: [expect.any(String)] });
    expect(registry.unregister('run-1')).toBe(true);
    expect(registry.size).toBe(0);
    expect(() => queue.summary()).toThrow('disposed');
    expect(registry.append('run-1', {
      type: 'resume_requested',
      source: 'app',
      payload: {},
    })).toMatchObject({ kind: 'rejected', reason: 'run-not-active' });
  });

  it('enforces an active-run limit and disposes all retained queues', () => {
    const registry = new ActiveRunRegistry({ maxActiveRuns: 1, queueOptions: { maxEventAgeMs: null } });
    const queue = registry.register('run-1', asSessionId('session-1'));
    expect(() => registry.register('run-2', asSessionId('session-2'))).toThrow('1 run limit');
    registry.dispose();
    expect(registry.size).toBe(0);
    expect(() => queue.summary()).toThrow('disposed');
    expect(() => registry.register('run-3', asSessionId('session-3'))).toThrow('disposed');
  });

  it('publishes bounded task progress without exposing mutable registry state', () => {
    let now = new Date('2026-07-29T01:00:00.000Z');
    const registry = new ActiveRunRegistry({
      now: () => now,
      queueOptions: { maxEventAgeMs: null },
    });
    const observed: ReturnType<ActiveRunRegistry['list']>[] = [];
    const unsubscribe = registry.subscribe((runs) => observed.push(runs));
    registry.register('run-progress', asSessionId('session-progress'), {
      origin: 'app',
      startedAt: '2026-07-29T00:59:00.000Z',
    });
    now = new Date('2026-07-29T01:00:01.000Z');
    expect(registry.observe('run-progress', {
      type: 'task_book',
      taskBook: {
        assessment: {
          userNeed: 'verify progress',
          complexity: 'standard',
          goal: 'verify progress',
          successCriteria: ['done'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1.5,
        },
        goal: 'verify progress',
        complexity: 'standard',
        successCriteria: ['done'],
        steps: [
          { id: 'step-1', title: 'Read', description: 'Read files', status: 'done' },
          { id: 'step-2', title: 'Verify', description: 'Verify result', status: 'in_progress' },
        ],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay bounded' },
      },
    })).toBe(true);
    registry.observe('run-progress', { type: 'tool_start', callId: 'call-1', name: 'read' });
    registry.observe('run-progress', { type: 'verification_start' });

    const snapshot = registry.list()[0]!;
    expect(snapshot).toMatchObject({
      runId: 'run-progress',
      sessionId: 'session-progress',
      origin: 'app',
      startedAt: '2026-07-29T00:59:00.000Z',
      updatedAt: '2026-07-29T01:00:01.000Z',
      phase: 'verifying',
      controlStatus: 'running',
      totalSteps: 2,
      completedSteps: 1,
      activeSteps: [{ stepId: 'step-2', title: 'Verify' }],
      activeToolCount: 1,
    });
    snapshot.activeSteps[0]!.title = 'mutated outside';
    expect(registry.list()[0]?.activeSteps[0]?.title).toBe('Verify');
    expect(observed.length).toBeGreaterThan(1);

    unsubscribe();
    const countAfterUnsubscribe = observed.length;
    registry.observe('run-progress', { type: 'final_delta' });
    expect(observed).toHaveLength(countAfterUnsubscribe);
    registry.dispose();
  });

  it('queues pause and resume at safe boundaries but interrupts immediately and idempotently', () => {
    const interrupt = vi.fn();
    const registry = new ActiveRunRegistry({ queueOptions: { maxEventAgeMs: null } });
    registry.register('run-control', asSessionId('session-control'), { interrupt });

    expect(registry.request('run-control', 'pause', 'hold')).toMatchObject({
      kind: 'accepted',
      action: 'pause',
      run: { controlStatus: 'pause_requested' },
    });
    expect(registry.request('run-control', 'resume', 'continue')).toMatchObject({
      kind: 'accepted',
      action: 'resume',
      run: { controlStatus: 'running' },
    });
    expect(registry.request('run-control', 'interrupt', 'stop now')).toMatchObject({
      kind: 'accepted',
      action: 'interrupt',
      run: { controlStatus: 'interrupt_requested' },
    });
    expect(registry.request('run-control', 'interrupt', 'again')).toMatchObject({ kind: 'accepted' });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith('stop now');
    expect(registry.request('run-control', 'resume')).toMatchObject({
      kind: 'rejected',
      reason: 'action-conflict',
    });
    registry.dispose();
  });
});
