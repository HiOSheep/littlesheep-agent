// Inbox claim filtering.
//
// Split from `durable-inbox-store.ts` so the store stays under its size ceiling:
// this answers "does this command match the caller's claim filter", which the
// store only consumes.
import type { DurableInboxClaimFilter, DurableInboxCommand } from '@littlesheep/types';
import { normalizeIdentifier } from './durable-store-utils.js';

export function normalizeClaimFilter(
  filter: DurableInboxClaimFilter | undefined,
): DurableInboxClaimFilter | undefined {
  if (!filter) return undefined;
  return {
    ...(filter.commandId === undefined ? {} : { commandId: normalizeIdentifier(filter.commandId, 'filter.commandId') }),
    ...(filter.sessionId === undefined ? {} : { sessionId: normalizeIdentifier(filter.sessionId, 'filter.sessionId') }),
    ...(filter.runId === undefined ? {} : { runId: normalizeIdentifier(filter.runId, 'filter.runId') }),
  };
}

export function matchesClaimFilter(
  command: DurableInboxCommand,
  filter: DurableInboxClaimFilter | undefined,
): boolean {
  return filter === undefined
    || ((filter.commandId === undefined || command.commandId === filter.commandId)
      && (filter.sessionId === undefined || command.sessionId === filter.sessionId)
      && (filter.runId === undefined || command.runId === filter.runId));
}
