// Durable inbox command materialization. The kernel supplies the event append
// boundary; this module owns claim/complete/fail orchestration and fencing.
import type {
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableInboxClaimFilter,
  DurableInboxCommand,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
} from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';
import { sourceForInboxCommand, validateEventInput, validateSource } from './durable-projection-codec.js';

export interface DurableInboxProcessResult {
  readonly commandId: string;
  readonly status: 'completed' | 'failed';
  readonly eventId?: string;
  readonly reason?: string;
}

export type DurableInboxAppendDisposition = 'materialized' | 'duplicate';

type AppendEvent = (
  input: DurableHarnessEventAppendInput,
) => Promise<DurableHarnessEventAppendOutcome>;

export async function enqueueDurableCommand(
  inboxStore: DurableInboxStoreLike | undefined,
  input: DurableInboxEnqueueInput,
): Promise<DurableInboxEnqueueOutcome> {
  if (!inboxStore) throw new DurableKernelError('durable inbox is not configured', 'inbox_unavailable');
  validateEventInput({ ...input, eventId: input.commandId });
  validateSource({ ...input, eventId: input.commandId });
  return inboxStore.enqueue(input);
}

export async function appendEventViaInbox(
  inboxStore: DurableInboxStoreLike | undefined,
  input: DurableHarnessEventAppendInput,
  append: AppendEvent,
): Promise<DurableInboxAppendDisposition> {
  if (!input.eventId) throw new DurableKernelError('inbox-backed events require an eventId', 'invalid');
  const enqueued = await enqueueDurableCommand(inboxStore, {
    commandId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    runId: input.runId,
    type: input.type,
    source: input.source,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    payload: input.payload,
  });
  if (enqueued.kind === 'conflict') throw new DurableKernelError('durable inbox command conflict', 'conflict');
  if (enqueued.command.status === 'failed') {
    throw new DurableKernelError('durable inbox command is permanently failed', 'conflict');
  }
  if (enqueued.command.status === 'completed') {
    const duplicate = await append(input);
    if (duplicate.kind === 'conflict') throw new DurableKernelError('completed inbox command conflicts with its event', 'conflict');
    return 'duplicate';
  }
  if (enqueued.command.status === 'claimed') {
    throw new DurableKernelError('durable inbox command is owned by another worker', 'conflict');
  }
  if (!inboxStore) throw new DurableKernelError('durable inbox is not configured', 'inbox_unavailable');
  const [claimed] = await inboxStore.claim(1, { commandId: enqueued.command.commandId });
  if (!claimed) throw new DurableKernelError('durable inbox command could not be claimed', 'conflict');
  const result = await materializeDurableCommand(inboxStore, claimed, append);
  if (result.status === 'failed') {
    throw new DurableKernelError(result.reason ?? 'durable inbox command failed', 'conflict');
  }
  return 'materialized';
}

export async function processDurableInbox(
  inboxStore: DurableInboxStoreLike | undefined,
  append: AppendEvent,
  limit?: number,
  filter?: DurableInboxClaimFilter,
): Promise<DurableInboxProcessResult[]> {
  if (!inboxStore) throw new DurableKernelError('durable inbox is not configured', 'inbox_unavailable');
  const commands = await inboxStore.claim(limit, filter);
  const results: DurableInboxProcessResult[] = [];
  for (const command of commands) {
    results.push(await materializeDurableCommand(inboxStore, command, append));
  }
  return results;
}

async function materializeDurableCommand(
  inboxStore: DurableInboxStoreLike,
  command: DurableInboxCommand,
  append: AppendEvent,
): Promise<DurableInboxProcessResult> {
  try {
    const outcome = await append({
      eventId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sessionId: command.sessionId,
      runId: command.runId,
      type: command.type,
      source: sourceForInboxCommand(command),
      ...(command.occurredAt ? { occurredAt: command.occurredAt } : {}),
      payload: command.payload,
    });
    const eventId = outcome.kind === 'appended' || outcome.kind === 'duplicate' ? outcome.event.eventId : undefined;
    await inboxStore.complete(command.commandId, eventId ? [eventId] : [], command.claimToken);
    return { commandId: command.commandId, status: 'completed', ...(eventId ? { eventId } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await inboxStore.fail(command.commandId, reason, false, command.claimToken);
    } catch {
      // A reclaimed command belongs to the new owner and must not be overwritten.
    }
    return { commandId: command.commandId, status: 'failed', reason };
  }
}
