import { describe, expect, it } from 'vitest';
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
});
