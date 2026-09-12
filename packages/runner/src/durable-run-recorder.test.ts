import { describe, expect, it, vi } from 'vitest';
import type {
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableHarnessEventStoreLike,
  DurableInboxClaimFilter,
  DurableInboxCommand,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
} from '@littlesheep/types';
import {
  createDurableRunRecorder,
  durableEvent,
  DurableRunRecorder,
} from './durable-run-recorder.js';

class MemoryEventStore implements DurableHarnessEventStoreLike {
  readonly events: DurableHarnessEvent[] = [];
  readonly calls: string[] = [];
  constructor(private readonly initializationError?: Error, private readonly appendError?: Error) {}

  async initialize(): Promise<void> {
    this.calls.push('event.initialize');
    if (this.initializationError) throw this.initializationError;
  }

  async append<TPayload extends Record<string, unknown>>(
    input: DurableHarnessEventAppendInput<TPayload>,
  ): Promise<DurableHarnessEventAppendOutcome<TPayload>> {
    this.calls.push(`event.append:${input.type}`);
    if (this.appendError) throw this.appendError;
    const duplicate = this.events.find((event) => event.eventId === input.eventId || event.idempotencyKey === input.idempotencyKey);
    if (duplicate) return { kind: 'duplicate', event: duplicate as DurableHarnessEvent<TPayload> };
    const event = {
      version: 1 as const,
      eventId: input.eventId ?? `event-${this.events.length + 1}`,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      runId: input.runId,
      cursor: this.events.length + 1,
      type: input.type,
      source: input.source,
      occurredAt: input.occurredAt ?? '2026-09-03T00:00:00.000Z',
      payload: input.payload,
    } as DurableHarnessEvent<TPayload>;
    this.events.push(event);
    return { kind: 'appended', event };
  }

  async read(sessionId: string, runId: string): Promise<DurableHarnessEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId && event.runId === runId);
  }

  async readAfter(sessionId: string, runId: string, cursor: number): Promise<DurableHarnessEvent[]> {
    return (await this.read(sessionId, runId)).filter((event) => event.cursor > cursor);
  }
}

class MemoryInboxStore implements DurableInboxStoreLike {
  readonly calls: string[] = [];
  private readonly commands = new Map<string, DurableInboxCommand>();

  async initialize(): Promise<void> {
    this.calls.push('inbox.initialize');
  }

  async enqueue(input: DurableInboxEnqueueInput): Promise<DurableInboxEnqueueOutcome> {
    this.calls.push(`inbox.enqueue:${input.type}`);
    const commandId = input.commandId ?? 'command-1';
    const existing = this.commands.get(commandId);
    if (existing) return { kind: 'duplicate', command: existing };
    const command: DurableInboxCommand = {
      version: 1,
      commandId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      runId: input.runId,
      type: input.type,
      source: input.source,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      payload: input.payload,
      status: 'queued',
      enqueuedAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
      attempts: 0,
    };
    this.commands.set(commandId, command);
    return { kind: 'enqueued', command };
  }

  async claim(_limit?: number, filter?: DurableInboxClaimFilter): Promise<DurableInboxCommand[]> {
    this.calls.push('inbox.claim');
    const command = [...this.commands.values()].find((candidate) => (
      candidate.status === 'queued'
      && (filter?.commandId === undefined || filter.commandId === candidate.commandId)
    ));
    if (!command) return [];
    const claimed: DurableInboxCommand = {
      ...command,
      status: 'claimed',
      claimToken: 'claim-1',
      leaseUntil: '2099-01-01T00:00:00.000Z',
      attempts: command.attempts + 1,
    };
    this.commands.set(command.commandId, claimed);
    return [claimed];
  }

  async complete(commandId: string, resultEventIds: readonly string[] = []): Promise<DurableInboxCommand> {
    this.calls.push('inbox.complete');
    const command = this.commands.get(commandId);
    if (!command) throw new Error('missing command');
    const completed: DurableInboxCommand = {
      ...command,
      status: 'completed',
      claimToken: undefined,
      leaseUntil: undefined,
      resultEventIds: [...resultEventIds],
    };
    this.commands.set(commandId, completed);
    return completed;
  }

  async fail(commandId: string, reason: string): Promise<DurableInboxCommand> {
    this.calls.push('inbox.fail');
    const command = this.commands.get(commandId);
    if (!command) throw new Error('missing command');
    const failed: DurableInboxCommand = { ...command, status: 'failed', failureReason: reason };
    this.commands.set(commandId, failed);
    return failed;
  }

  async read(commandId: string): Promise<DurableInboxCommand | null> {
    return this.commands.get(commandId) ?? null;
  }
}

const accepted = durableEvent('run_accepted', 'runtime', 'run:accepted', { origin: 'test', model: 'test/model' });

describe('DurableRunRecorder admission and append modes', () => {
  it('initializes event and inbox stores before strict ingress is accepted', async () => {
    const eventStore = new MemoryEventStore();
    const inboxStore = new MemoryInboxStore();
    const recorder = new DurableRunRecorder({
      eventStore,
      inboxStore,
      sessionId: 'session-a',
      runId: 'run-a',
      mode: 'next',
    });

    recorder.startIngress(accepted);
    await recorder.ready;

    expect(eventStore.calls).toEqual([
      'event.initialize',
      'event.append:run_accepted',
    ]);
    expect(inboxStore.calls).toEqual([
      'inbox.initialize',
      'inbox.enqueue:run_accepted',
      'inbox.claim',
      'inbox.complete',
    ]);
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_accepted']);
  });

  it('fails closed before run_accepted when strict initialization fails', async () => {
    const eventStore = new MemoryEventStore(new Error('corrupt event partition'));
    const log = vi.fn();
    const recorder = createDurableRunRecorder({
      eventStore,
      sessionId: 'session-a',
      runId: 'run-a',
      origin: 'test',
      model: 'test/model',
      mode: 'next',
      log,
    });

    await expect(recorder.ready).rejects.toThrow('corrupt event partition');
    expect(eventStore.events).toEqual([]);
    expect(eventStore.calls).toEqual(['event.initialize']);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('initialization failed'));
  });

  it('rejects a second worker for an already materialized strict ingress', async () => {
    const eventStore = new MemoryEventStore();
    const inboxStore = new MemoryInboxStore();
    const first = new DurableRunRecorder({
      eventStore,
      inboxStore,
      sessionId: 'session-a',
      runId: 'run-a',
      mode: 'next',
    });
    first.startIngress(accepted);
    await first.ready;

    const second = new DurableRunRecorder({
      eventStore,
      inboxStore,
      sessionId: 'session-a',
      runId: 'run-a',
      mode: 'next',
    });
    second.startIngress(accepted);

    await expect(second.ready).rejects.toThrow('already belongs to another run worker');
    expect(eventStore.events.filter((event) => event.type === 'run_accepted')).toHaveLength(1);
  });

  it('keeps shadow admission compatible and does not expose append failures', async () => {
    const eventStore = new MemoryEventStore(undefined, new Error('disk full'));
    const recorder = createDurableRunRecorder({
      eventStore,
      sessionId: 'session-a',
      runId: 'run-a',
      origin: 'test',
      model: 'test/model',
      mode: 'shadow',
    });

    await expect(recorder.ready).resolves.toBeUndefined();
    await recorder.flushBestEffort();
    expect(recorder.error?.message).toBe('disk full');
  });

  it('propagates strict append failures to the caller', async () => {
    const eventStore = new MemoryEventStore(undefined, new Error('append unavailable'));
    const inboxStore = new MemoryInboxStore();
    const recorder = new DurableRunRecorder({
      eventStore,
      inboxStore,
      sessionId: 'session-a',
      runId: 'run-a',
      mode: 'next',
    });

    await expect(recorder.append(accepted)).rejects.toThrow('append unavailable');
    await expect(recorder.flush()).rejects.toThrow('append unavailable');
  });
});
