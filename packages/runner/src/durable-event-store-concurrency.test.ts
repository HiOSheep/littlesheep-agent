import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableHarnessKernel, reduceDurableRunProjection } from '@littlesheep/harness';
import type { DurableHarnessEventStoreLike } from '@littlesheep/types';
import { DurableEventStore } from './durable-event-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable event store cross-process concurrency', () => {
  it('keeps cursors contiguous and gap-free when two OS processes append concurrently', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-event-concurrent-'));
    roots.push(rootDir);
    const first = spawnWorker(rootDir, 'alpha');
    const second = spawnWorker(rootDir, 'beta');
    await Promise.all([waitForMarker(first, 'alpha'), waitForMarker(second, 'beta')]);

    const store = new DurableEventStore({ rootDir });
    const events = await store.read('session-concurrent', 'run-concurrent');
    expect(events.length).toBe(50);
    expect(events.map((event) => event.cursor)).toEqual(
      Array.from({ length: 50 }, (_value, index) => index + 1),
    );
    const eventIds = new Set(events.map((event) => event.eventId));
    expect(eventIds.size).toBe(50);
    const alpha = events.filter((event) => event.eventId.startsWith('alpha-')).length;
    const beta = events.filter((event) => event.eventId.startsWith('beta-')).length;
    expect(alpha).toBe(25);
    expect(beta).toBe(25);
  }, 120_000);

  it('rebuilds the same projection from the files after a fresh kernel restart', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-event-rebuild-'));
    roots.push(rootDir);
    const sessionId = 'session-rebuild';
    const runId = 'run-rebuild';
    const events: Array<{
      type: 'run_accepted' | 'route_decided' | 'effect_intent_created' | 'effect_settled' | 'final_reply_proposed' | 'final_reply_settled' | 'run_completed';
      source: 'runtime' | 'tool' | 'model';
      eventId: string;
      payload: Record<string, unknown>;
    }> = [
      { type: 'run_accepted', source: 'runtime', eventId: 'accept', payload: {} },
      { type: 'route_decided', source: 'runtime', eventId: 'route', payload: { route: 'execute' } },
      { type: 'effect_intent_created', source: 'runtime', eventId: 'intent', payload: { effectId: 'effect-rebuild', idempotencyKey: 'effect-rebuild-key', toolName: 'write', effectKind: 'local_mutation' } },
      { type: 'effect_settled', source: 'tool', eventId: 'settle', payload: { effectId: 'effect-rebuild', status: 'succeeded', evidenceRef: 'tool:rebuild' } },
      { type: 'final_reply_proposed', source: 'model', eventId: 'reply', payload: { settlementId: 'rebuild-settlement', reply: 'rebuild answer', replyFingerprint: 'rebuild-fp', modelRequestId: 'rebuild-model' } },
      { type: 'final_reply_settled', source: 'runtime', eventId: 'reply-settled', payload: { settlementId: 'rebuild-settlement', reply: 'rebuild answer', replyFingerprint: 'rebuild-fp', modelRequestId: 'rebuild-model' } },
      { type: 'run_completed', source: 'runtime', eventId: 'complete', payload: {} },
    ];
    const original = new DurableHarnessKernel({ eventStore: new DurableEventStore({ rootDir }) });
    for (const entry of events) {
      await original.append({
        eventId: entry.eventId,
        idempotencyKey: entry.eventId,
        sessionId,
        runId,
        type: entry.type,
        source: entry.source,
        payload: entry.payload,
      });
    }
    const live = await original.replay(sessionId, runId);

    const reopened = new DurableHarnessKernel({ eventStore: new DurableEventStore({ rootDir }) });
    const read = await reopened.replayAfter(sessionId, runId, 0);
    expect(read.map((entry) => entry.cursor)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reduceDurableRunProjection(read)).toEqual(live);
    expect(await reopened.rebuildProjection(sessionId, runId)).toEqual(live);
    expect(await reopened.replayAfter(sessionId, runId, 4)).toEqual(read.slice(4));
  });

  it('resumes recovery without duplicating facts when the process dies mid-recovery', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-event-recovery-crash-'));
    roots.push(rootDir);
    const sessionId = 'session-recovery-crash';
    const runId = 'run-recovery-crash';
    const seed = new DurableHarnessKernel({ eventStore: new DurableEventStore({ rootDir }) });
    await seed.append({ eventId: 'accept', idempotencyKey: 'accept', sessionId, runId, type: 'run_accepted', source: 'runtime', payload: {} });
    await seed.append({ eventId: 'model', idempotencyKey: 'model', sessionId, runId, type: 'model_request_started', source: 'runtime', payload: { requestId: 'crash-model' } });
    await seed.append({ eventId: 'intent', idempotencyKey: 'intent', sessionId, runId, type: 'effect_intent_created', source: 'runtime', payload: { effectId: 'crash-effect', idempotencyKey: 'crash-effect-key', toolName: 'write', effectKind: 'external' } });

    // Die after the first recovery fact is durably written.
    const realStore = new DurableEventStore({ rootDir });
    let appends = 0;
    const crashingStore = {
      read: (session: string, run: string) => realStore.read(session, run),
      readAfter: (session: string, run: string, cursor: number) => realStore.readAfter(session, run, cursor),
      append: async (input: Parameters<DurableEventStore['append']>[0]) => {
        appends += 1;
        const outcome = await realStore.append(input);
        if (appends === 1) throw new Error('process died after the first recovery append');
        return outcome;
      },
    } as unknown as DurableHarnessEventStoreLike;
    const crashing = new DurableHarnessKernel({ eventStore: crashingStore });
    await expect(crashing.recoverRun(sessionId, runId)).rejects.toThrow(/process died/);
    const afterCrash = await realStore.read(sessionId, runId);
    expect(afterCrash.filter((event) => event.type === 'model_request_settled')).toHaveLength(1);
    expect(afterCrash.filter((event) => event.type === 'effect_settled')).toHaveLength(0);

    // The next process retries recovery over the same files.
    const recovered = new DurableHarnessKernel({ eventStore: new DurableEventStore({ rootDir }) });
    const result = await recovered.recoverRun(sessionId, runId);
    // The crashed pass already recorded the model settlement, so the retry
    // reports only the facts it newly writes.
    expect(result.actions.map((action) => action.kind)).toEqual([
      'effect_marked_unknown',
      'runtime_status_settled',
    ]);
    const finalEvents = await realStore.read(sessionId, runId);
    expect(finalEvents.filter((event) => event.type === 'model_request_settled')).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === 'effect_settled')).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === 'runtime_status_settled')).toHaveLength(1);
    expect(result.projection).toMatchObject({
      status: 'waiting_user',
      pendingEffectIds: [],
      pendingModelRequestIds: [],
    });
    expect((await recovered.recoverRun(sessionId, runId)).actions).toEqual([]);
  });
});

function spawnWorker(rootDir: string, prefix: string): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    resolve('packages/runner/src/durable-event-store-crash-worker.test.ts'),
    '--pool=threads',
    '--maxWorkers=1',
    '--minWorkers=1',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      LS_DURABLE_EVENT_CRASH_ROOT: rootDir,
      LS_DURABLE_EVENT_CRASH_PREFIX: prefix,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForMarker(child: ChildProcess, prefix: string): Promise<void> {
  const marker = `LS_DURABLE_EVENT_APPENDED:${prefix}`;
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`child did not reach ${marker}: ${output}`)), 90_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('exit');
      error ? rejectMarker(error) : resolveMarker();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(marker)) finish();
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => finish(new Error(`child exited before marker with code ${String(code)}: ${output}`)));
  });
}
