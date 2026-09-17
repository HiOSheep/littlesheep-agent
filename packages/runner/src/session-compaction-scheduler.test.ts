import { describe, expect, it } from 'vitest';
import { asSessionId } from '@littlesheep/types';
import {
  SessionCompactionScheduler,
  type SessionCompactionRunContext,
} from './session-compaction-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SessionCompactionScheduler', () => {
  it('coalesces pressure notifications per session into one flight', async () => {
    const scheduler = new SessionCompactionScheduler();
    const gate = deferred<void>();
    const calls: string[] = [];
    const run = async (context: SessionCompactionRunContext) => {
      calls.push(context.operationId);
      await gate.promise;
      return true;
    };
    const first = scheduler.request({ sessionId: asSessionId('session-1'), force: false, run });
    const second = scheduler.request({ sessionId: asSessionId('session-1'), force: false, run });

    expect(calls).toHaveLength(1);
    gate.resolve();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome).toMatchObject({ status: 'completed', compacted: true, coalesced: false });
    expect(secondOutcome).toMatchObject({ status: 'completed', compacted: true, coalesced: true });
    expect(calls).toHaveLength(1);
    expect(scheduler.operations()).toMatchObject([{ coalescedRequests: 1, status: 'completed' }]);
  });

  it('defers automatic soft compaction while the global soft slot is busy', async () => {
    const scheduler = new SessionCompactionScheduler({ maxSoftConcurrency: 1 });
    const gate = deferred<void>();
    let calls = 0;
    const run = async () => {
      calls += 1;
      await gate.promise;
      return true;
    };
    const active = scheduler.request({ sessionId: asSessionId('session-1'), force: false, run });
    const deferredOutcome = await scheduler.request({ sessionId: asSessionId('session-2'), force: false, run });
    expect(deferredOutcome).toMatchObject({ status: 'deferred', reason: 'soft-concurrency-limit' });
    expect(calls).toBe(1);

    gate.resolve();
    await active;
    await expect(scheduler.request({ sessionId: asSessionId('session-2'), force: false, run }))
      .resolves.toMatchObject({ status: 'completed', compacted: true });
    expect(calls).toBe(2);
  });

  it('does not starve a hard request in another session behind a soft flight', async () => {
    const scheduler = new SessionCompactionScheduler({ maxSoftConcurrency: 1 });
    const softGate = deferred<void>();
    const order: string[] = [];
    const soft = scheduler.request({
      sessionId: asSessionId('session-a'),
      force: false,
      run: async () => {
        order.push('soft');
        await softGate.promise;
        return true;
      },
    });
    const hard = await scheduler.request({
      sessionId: asSessionId('session-b'),
      force: true,
      run: async () => {
        order.push('hard');
        return true;
      },
    });

    expect(hard).toMatchObject({ status: 'completed', compacted: true });
    expect(order).toEqual(['soft', 'hard']);
    softGate.resolve();
    await soft;
  });

  it('waits for an active soft flight before running a hard request', async () => {
    const scheduler = new SessionCompactionScheduler();
    const softGate = deferred<void>();
    const order: string[] = [];
    const soft = scheduler.request({
      sessionId: asSessionId('session-1'),
      force: false,
      run: async () => {
        order.push('soft-start');
        await softGate.promise;
        order.push('soft-end');
        return true;
      },
    });
    const hard = scheduler.request({
      sessionId: asSessionId('session-1'),
      force: true,
      run: async () => {
        order.push('hard');
        return true;
      },
    });

    softGate.resolve();
    const [softOutcome, hardOutcome] = await Promise.all([soft, hard]);
    expect(order).toEqual(['soft-start', 'soft-end', 'hard']);
    expect(softOutcome).toMatchObject({ status: 'completed', compacted: true, coalesced: false });
    expect(hardOutcome).toMatchObject({ status: 'completed', compacted: true, coalesced: false });
    expect(scheduler.operations()).toHaveLength(2);
  });

  it('aborts owned operations on dispose and reports cancellation', async () => {
    const scheduler = new SessionCompactionScheduler();
    const pending = scheduler.request({
      sessionId: asSessionId('session-1'),
      force: true,
      run: (context) => new Promise<boolean>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });

    scheduler.dispose('runner-shutdown');
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'runner-shutdown' });
    expect(scheduler.operations()).toMatchObject([{ status: 'cancelled', error: 'runner-shutdown' }]);
    await expect(scheduler.request({ sessionId: asSessionId('session-2'), force: true, run: async () => true }))
      .resolves.toMatchObject({ status: 'deferred', reason: 'scheduler-disposed' });
  });

  it('records cancellation even when the callback swallows the abort', async () => {
    const scheduler = new SessionCompactionScheduler();
    const gate = deferred<void>();
    const pending = scheduler.request({
      sessionId: asSessionId('session-1'),
      force: true,
      run: async (context) => {
        await gate.promise;
        // Best-effort compaction wrappers may absorb the abort error; ownership must not be lost.
        return !context.signal.aborted;
      },
    });
    scheduler.dispose('runner-shutdown');
    gate.resolve();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', reason: 'runner-shutdown' });
    expect(scheduler.operations()).toMatchObject([{ status: 'cancelled' }]);
  });

  it('records a failed attempt as an operation failure without failing the run contract', async () => {
    const scheduler = new SessionCompactionScheduler();
    await expect(scheduler.request({
      sessionId: asSessionId('session-1'),
      force: true,
      run: async () => ({ status: 'failed', error: 'schema' }),
    })).resolves.toMatchObject({ status: 'failed', error: 'schema' });
    expect(scheduler.operations()).toMatchObject([{ status: 'failed', error: 'schema' }]);
  });

  it('attributes operation usage without inventing unknown tokens', async () => {
    const scheduler = new SessionCompactionScheduler();
    await scheduler.request({
      sessionId: asSessionId('session-usage'),
      force: true,
      run: async () => ({
        status: 'compacted',
        usage: { requestCount: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120, usageStatus: 'partial' },
      }),
    });
    expect(scheduler.operations()).toMatchObject([{
      status: 'completed',
      result: 'compacted',
      usage: { requestCount: 2, usageStatus: 'partial', totalTokens: 120 },
    }]);
  });

  it('records a terminal no-new-range operation without inventing work', async () => {
    const scheduler = new SessionCompactionScheduler();
    await expect(scheduler.request({ sessionId: asSessionId('session-1'), force: true, run: async () => false }))
      .resolves.toMatchObject({ status: 'completed', compacted: false });
    expect(scheduler.operations()).toMatchObject([{ status: 'completed', result: 'no-new-range' }]);
  });

  it('keeps a bounded operation history', async () => {
    const scheduler = new SessionCompactionScheduler({ maxSoftConcurrency: 8 });
    for (let index = 0; index < 205; index += 1) {
      await scheduler.request({
        sessionId: asSessionId(`session-${index}`),
        force: true,
        run: async () => false,
      });
    }
    expect(scheduler.operations().length).toBeLessThanOrEqual(200);
  });
});
