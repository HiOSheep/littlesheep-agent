import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableHarnessKernel } from '@littlesheep/harness';
import { DurableEventStore } from './durable-event-store.js';
import { DurableInboxStore } from './durable-inbox-store.js';
import { DurableRunRecorder, durableEvent } from './durable-run-recorder.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newStores(now: () => Date) {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-inbox-recovery-'));
  roots.push(root);
  return storesAt(root, now);
}

function storesAt(root: string, now: () => Date) {
  return {
    root,
    eventStore: new DurableEventStore({ rootDir: join(root, 'events'), now }),
    inboxStore: new DurableInboxStore({ rootDir: join(root, 'inbox'), leaseMs: 1_000, now }),
  };
}

const command = {
  commandId: 'run-a:run-accepted',
  idempotencyKey: 'run-a:run-accepted',
  sessionId: 'session-a',
  runId: 'run-a',
  type: 'run_accepted' as const,
  source: 'runtime' as const,
  occurredAt: '2026-09-10T00:00:00.000Z',
  payload: { origin: 'test', model: 'test/model' },
};

describe('durable inbox restart recovery', () => {
  it('reclaims an ingress command after its owning OS process is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-durable-inbox-kill-'));
    roots.push(root);
    const inboxRoot = join(root, 'inbox');
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      resolve('packages/runner/src/durable-inbox-crash-worker.test.ts'),
      '--pool=threads',
      '--maxWorkers=1',
      '--minWorkers=1',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, LS_DURABLE_INBOX_CRASH_ROOT: inboxRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForChildMarker(child, 'LS_DURABLE_INBOX_CLAIMED');
    } finally {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }

    const eventStore = new DurableEventStore({ rootDir: join(root, 'events') });
    const inboxStore = new DurableInboxStore({ rootDir: inboxRoot, leaseMs: 1_000 });
    const claimed = await inboxStore.read('run-killed:run-accepted');
    expect(claimed).toMatchObject({ status: 'claimed', attempts: 1 });
    const leaseDelay = Math.max(0, Date.parse(claimed?.leaseUntil ?? '') - Date.now() + 25);
    await delay(leaseDelay);

    const kernel = new DurableHarnessKernel({ eventStore, inboxStore });
    await kernel.initialize();
    const recovery = await kernel.recoverRun('session-killed', 'run-killed');
    expect(recovery.projection).toMatchObject({
      status: 'waiting_user',
      runtimeStatusReason: 'run_incomplete_after_restart',
    });
    expect(await eventStore.read('session-killed', 'run-killed')).toEqual([
      expect.objectContaining({ eventId: 'run-killed:run-accepted', cursor: 1 }),
      expect.objectContaining({ type: 'runtime_status_settled', cursor: 2 }),
    ]);
    expect(await inboxStore.read('run-killed:run-accepted')).toMatchObject({
      status: 'completed',
      attempts: 2,
      resultEventIds: ['run-killed:run-accepted'],
    });
  }, 30_000);

  it('materializes a queued ingress command after store restart', async () => {
    const now = () => new Date('2026-09-10T00:00:00.000Z');
    const first = await newStores(now);
    await first.inboxStore.enqueue(command);

    const restarted = storesAt(first.root, now);
    const kernel = new DurableHarnessKernel(restarted);
    await kernel.initialize();
    await expect(restarted.inboxStore.listRecoverableRuns()).resolves.toEqual([{
      sessionId: command.sessionId,
      runId: command.runId,
    }]);
    const recovery = await kernel.recoverRun(command.sessionId, command.runId);
    expect(recovery.projection).toMatchObject({
      status: 'waiting_user',
      eventCount: 2,
      runtimeStatusReason: 'run_incomplete_after_restart',
    });
    expect(recovery.actions).toEqual([expect.objectContaining({
      kind: 'runtime_status_settled',
      reason: 'run_incomplete_after_restart',
    })]);

    const events = await restarted.eventStore.read(command.sessionId, command.runId);
    expect(events.find((event) => event.type === 'run_accepted')).toMatchObject({
      eventId: command.commandId,
      source: command.source,
      occurredAt: command.occurredAt,
    });
    expect(events.filter((event) => event.type === 'run_accepted')).toHaveLength(1);
    expect(await restarted.inboxStore.read(command.commandId)).toMatchObject({
      status: 'completed',
      attempts: 1,
      resultEventIds: [command.commandId],
    });
    await expect(restarted.inboxStore.listRecoverableRuns()).resolves.toEqual([]);
  });

  it('replays an event idempotently when the process stopped before inbox completion', async () => {
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = await newStores(now);
    await first.inboxStore.enqueue(command);
    const [claimed] = await first.inboxStore.claim(1, { commandId: command.commandId });
    expect(claimed?.status).toBe('claimed');
    await first.eventStore.append({
      eventId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sessionId: command.sessionId,
      runId: command.runId,
      type: command.type,
      source: command.source,
      occurredAt: command.occurredAt,
      payload: command.payload,
    });

    nowMs += 2_000;
    const restarted = storesAt(first.root, now);
    const kernel = new DurableHarnessKernel(restarted);
    await kernel.initialize();
    await expect(restarted.inboxStore.listRecoverableRuns()).resolves.toEqual([{
      sessionId: command.sessionId,
      runId: command.runId,
    }]);
    const processed = await kernel.processInbox(1, { commandId: command.commandId });

    expect(processed).toEqual([{
      commandId: command.commandId,
      status: 'completed',
      eventId: command.commandId,
    }]);
    expect(await restarted.eventStore.read(command.sessionId, command.runId)).toHaveLength(1);
    expect(await restarted.inboxStore.read(command.commandId)).toMatchObject({
      status: 'completed',
      attempts: 2,
      resultEventIds: [command.commandId],
    });
  });

  it('fences a second real-store worker before model or tool execution can start', async () => {
    const now = () => new Date('2026-09-10T00:00:00.000Z');
    const firstStores = await newStores(now);
    const ingress = durableEvent('run_accepted', 'runtime', command.commandId, command.payload);
    const first = new DurableRunRecorder({
      ...firstStores,
      sessionId: command.sessionId,
      runId: command.runId,
      mode: 'next',
    });
    first.startIngress(ingress);
    await first.ready;

    const secondStores = storesAt(firstStores.root, now);
    const second = new DurableRunRecorder({
      ...secondStores,
      sessionId: command.sessionId,
      runId: command.runId,
      mode: 'next',
    });
    second.startIngress(ingress);

    await expect(second.ready).rejects.toThrow('already belongs to another run worker');
    expect(await secondStores.eventStore.read(command.sessionId, command.runId)).toHaveLength(1);
    expect(await secondStores.inboxStore.read(command.commandId)).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
  });
});

function waitForChildMarker(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => rejectMarker(new Error(`child did not reach ${marker}: ${output}`)), 20_000);
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
    child.once('exit', (code) => finish(new Error(`child exited before claim with code ${String(code)}: ${output}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
