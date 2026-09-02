import { describe, expect, it } from 'vitest';
import type {
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableHarnessEventStoreLike,
  DurableInboxCommand,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
} from '@littlesheep/types';
import { DurableHarnessKernel, DurableKernelError, reduceDurableRunProjection } from './durable-kernel.js';

class MemoryEventStore implements DurableHarnessEventStoreLike {
  events: DurableHarnessEvent[] = [];
  async append<TPayload extends Record<string, unknown>>(input: DurableHarnessEventAppendInput<TPayload>): Promise<DurableHarnessEventAppendOutcome<TPayload>> {
    const existing = this.events.find((event) => event.eventId === input.eventId || event.idempotencyKey === input.idempotencyKey);
    if (existing) return {
      kind: 'duplicate',
      event: existing as DurableHarnessEvent<TPayload>,
    };
    const event: DurableHarnessEvent<TPayload> = {
      version: 1,
      eventId: input.eventId ?? `event-${this.events.length + 1}`,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      runId: input.runId,
      cursor: this.events.length + 1,
      type: input.type,
      source: input.source,
      occurredAt: input.occurredAt ?? '2026-09-02T00:00:00.000Z',
      payload: input.payload,
    };
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
  private readonly commands = new Map<string, DurableInboxCommand>();
  async enqueue(input: DurableInboxEnqueueInput): Promise<DurableInboxEnqueueOutcome> {
    const existing = this.commands.get(input.commandId ?? 'command-1');
    if (existing) return { kind: 'duplicate', command: existing };
    const command: DurableInboxCommand = {
      version: 1,
      commandId: input.commandId ?? 'command-1',
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      status: 'queued',
      enqueuedAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      attempts: 0,
    };
    this.commands.set(command.commandId, command);
    return { kind: 'enqueued', command };
  }
  async claim(): Promise<DurableInboxCommand[]> {
    const result: DurableInboxCommand[] = [];
    for (const command of this.commands.values()) {
      if (command.status !== 'queued') continue;
      const claimed = { ...command, status: 'claimed' as const, attempts: command.attempts + 1, leaseUntil: '2099-01-01T00:00:00.000Z' };
      this.commands.set(command.commandId, claimed);
      result.push(claimed);
    }
    return result;
  }
  async complete(commandId: string, resultEventIds: readonly string[] = []): Promise<DurableInboxCommand> {
    const command = this.commands.get(commandId);
    if (!command) throw new Error('missing');
    const completed = { ...command, status: 'completed' as const, resultEventIds: [...resultEventIds] };
    this.commands.set(commandId, completed);
    return completed;
  }
  async fail(commandId: string, reason: string): Promise<DurableInboxCommand> {
    const command = this.commands.get(commandId);
    if (!command) throw new Error('missing');
    const failed = { ...command, status: 'failed' as const, failureReason: reason };
    this.commands.set(commandId, failed);
    return failed;
  }
  async read(commandId: string): Promise<DurableInboxCommand | null> {
    return this.commands.get(commandId) ?? null;
  }
}

const sessionId = 'session-a';
const runId = 'run-a';
function event<T extends DurableHarnessEvent['type']>(type: T, payload: Record<string, unknown>, source: DurableHarnessEvent['source'], id: string): DurableHarnessEventAppendInput {
  return { eventId: id, idempotencyKey: id, sessionId, runId, type, source, payload, occurredAt: '2026-09-02T00:00:00.000Z' };
}

describe('DurableHarnessKernel', () => {
  it('requires run acceptance, intent before settlement, proposal before final settlement, and one completion', async () => {
    const store = new MemoryEventStore();
    const kernel = new DurableHarnessKernel({ eventStore: store });
    await expect(kernel.append(event('route_decided', { route: 'respond' }, 'runtime', 'route'))).rejects.toMatchObject({ kind: 'transition' });
    await kernel.append(event('run_accepted', {}, 'runtime', 'accept'));
    await kernel.append(event('route_decided', { route: 'respond' }, 'runtime', 'route'));
    await expect(kernel.append(event('effect_settled', { effectId: 'missing', status: 'succeeded' }, 'tool', 'settle-missing'))).rejects.toBeInstanceOf(DurableKernelError);
    await kernel.append(event('effect_intent_created', { effectId: 'effect-1', idempotencyKey: 'effect-key', toolName: 'write', effectKind: 'local_mutation' }, 'runtime', 'intent'));
    await expect(kernel.append(event('final_reply_proposed', {
      reply: 'done', replyFingerprint: 'fp-0', modelRequestId: 'model-0',
    }, 'model', 'proposal-before-settlement'))).rejects.toMatchObject({ kind: 'transition' });
    await kernel.append(event('effect_settled', { effectId: 'effect-1', status: 'succeeded' }, 'tool', 'settle'));
    await kernel.append(event('final_reply_proposed', {
      reply: 'done', replyFingerprint: 'fp-0', modelRequestId: 'model-0',
    }, 'model', 'proposal'));
    await kernel.append(event('final_reply_settled', {
      reply: 'done', replyFingerprint: 'fp-0', modelRequestId: 'model-0',
    }, 'runtime', 'settled'));
    const projection = await kernel.replay(sessionId, runId);
    expect(projection.finalReply.state).toBe('settled');
    expect(projection.pendingEffectIds).toEqual([]);
    await kernel.append(event('run_completed', {}, 'runtime', 'complete'));
    expect((await kernel.replay(sessionId, runId)).status).toBe('completed');
    await expect(kernel.append(event('run_completed', {}, 'runtime', 'complete-2'))).rejects.toMatchObject({ kind: 'transition' });
  });

  it('does not execute a settled effect again and blocks unknown effects from completion', async () => {
    const store = new MemoryEventStore();
    const kernel = new DurableHarnessKernel({ eventStore: store });
    await kernel.append(event('run_accepted', {}, 'runtime', 'accept'));
    await kernel.append(event('effect_intent_created', { effectId: 'effect-1', idempotencyKey: 'effect-key', toolName: 'write', effectKind: 'external' }, 'runtime', 'intent'));
    await kernel.append(event('effect_settled', { effectId: 'effect-1', status: 'unknown' }, 'tool', 'settle'));
    await expect(kernel.append(event('effect_settled', { effectId: 'effect-1', status: 'succeeded' }, 'tool', 'settle-again'))).rejects.toMatchObject({ kind: 'transition' });
    const projection = await kernel.replay(sessionId, runId);
    expect(projection.unknownEffectIds).toEqual(['effect-1']);
    await expect(kernel.append(event('run_completed', {}, 'runtime', 'complete'))).rejects.toMatchObject({ kind: 'transition' });
  });

  it('uses one final settlement reservation and inbox processing is idempotent', async () => {
    const eventStore = new MemoryEventStore();
    const inboxStore = new MemoryInboxStore();
    let reservations = 0;
    const kernel = new DurableHarnessKernel({
      eventStore,
      inboxStore,
      reserveFinalReply: async () => {
        reservations += 1;
        return reservations === 1;
      },
    });
    await kernel.enqueue({ ...event('run_accepted', {}, 'runtime', 'command-accept'), commandId: 'command-accept' });
    await kernel.enqueue({ ...event('user_input_appended', { text: 'hello' }, 'app', 'command-1'), commandId: 'command-1' });
    const processed = await kernel.processInbox();
    expect(processed.map((result) => result.status)).toEqual(['completed', 'completed']);
    expect((await kernel.processInbox()).length).toBe(0);
    await kernel.append(event('final_reply_proposed', {
      reply: 'hello', replyFingerprint: 'fp', modelRequestId: 'model-1',
    }, 'model', 'proposal'));
    await kernel.append(event('final_reply_settled', {
      reply: 'hello', replyFingerprint: 'fp', modelRequestId: 'model-1',
    }, 'runtime', 'settled'));
    expect(reservations).toBe(1);
  });

  it('rebuilds projections from a cursor and rejects unknown events', () => {
    const events: DurableHarnessEvent[] = [{
      version: 1,
      eventId: 'accept',
      idempotencyKey: 'accept',
      sessionId,
      runId,
      cursor: 1,
      type: 'run_accepted',
      source: 'runtime',
      occurredAt: '2026-09-02T00:00:00.000Z',
      payload: {},
    }];
    expect(reduceDurableRunProjection(events).cursor).toBe(1);
    expect(() => reduceDurableRunProjection([{ ...events[0]!, version: 99 as 1 }])).toThrow(/unknown durable event version/);
  });

  it('records capability snapshots and probes as separate replayable Runtime facts', async () => {
    const store = new MemoryEventStore();
    const kernel = new DurableHarnessKernel({ eventStore: store });
    await kernel.append(event('run_accepted', {}, 'runtime', 'accept'));
    await kernel.append(event('user_input_appended', { contentLength: 8 }, 'app', 'input'));
    await kernel.append(event('capability_snapshot_read', {
      snapshot: {
        capabilityEpoch: 'epoch-1',
        permissionPolicyId: 'research',
        workspace: 'available',
        tools: [{ name: 'web_search', status: 'approval_required', source: 'builtin' }],
        network: { enabled: false, status: 'disabled' },
      },
    }, 'runtime', 'snapshot'));
    await kernel.append(event('capability_probe_settled', {
      probeId: 'probe-1',
      status: 'observed',
      capabilityEpoch: 'epoch-1',
      evidence: 'runtime_snapshot',
      permissionDecision: 'allow',
    }, 'runtime', 'probe'));
    await kernel.append(event('route_decided', {
      route: 'respond',
      source: 'rules',
      retrievalIntent: 'capability_probe',
    }, 'runtime', 'route'));

    const projection = await kernel.replay(sessionId, runId);
    expect(projection.capabilitySnapshot).toMatchObject({
      capabilityEpoch: 'epoch-1',
      permissionPolicyId: 'research',
      network: { enabled: false, status: 'disabled' },
    });
    expect(projection.capabilityProbe).toMatchObject({
      probeId: 'probe-1',
      capabilityEpoch: 'epoch-1',
      permissionDecision: 'allow',
    });
  });

  it('rejects a probe without a matching snapshot and does not accept a second probe', async () => {
    const store = new MemoryEventStore();
    const kernel = new DurableHarnessKernel({ eventStore: store });
    await kernel.append(event('run_accepted', {}, 'runtime', 'accept'));
    await expect(kernel.append(event('capability_probe_settled', {
      probeId: 'probe-1', status: 'observed', capabilityEpoch: 'epoch-1',
      evidence: 'runtime_snapshot', permissionDecision: 'allow',
    }, 'runtime', 'probe-before-snapshot'))).rejects.toMatchObject({ kind: 'transition' });
    await kernel.append(event('capability_snapshot_read', {
      snapshot: {
        capabilityEpoch: 'epoch-1', permissionPolicyId: 'research', workspace: 'unavailable',
        tools: [], network: { enabled: false, status: 'unavailable' },
      },
    }, 'runtime', 'snapshot'));
    await kernel.append(event('capability_probe_settled', {
      probeId: 'probe-1', status: 'observed', capabilityEpoch: 'epoch-1',
      evidence: 'runtime_snapshot', permissionDecision: 'unavailable',
    }, 'runtime', 'probe'));
    await expect(kernel.append(event('capability_probe_settled', {
      probeId: 'probe-2', status: 'observed', capabilityEpoch: 'epoch-1',
      evidence: 'runtime_snapshot', permissionDecision: 'unavailable',
    }, 'runtime', 'probe-again'))).rejects.toMatchObject({ kind: 'transition' });
  });

  it('requires a capability snapshot before a capability route is durable', async () => {
    const store = new MemoryEventStore();
    const kernel = new DurableHarnessKernel({ eventStore: store });
    await kernel.append(event('run_accepted', {}, 'runtime', 'accept'));
    await expect(kernel.append(event('route_decided', {
      route: 'respond', source: 'rules', retrievalIntent: 'capability_question',
    }, 'runtime', 'route'))).rejects.toMatchObject({ kind: 'transition' });
  });
});
