import type { RuntimeEventEnvelope, SessionId } from '@littlesheep/types';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { MemoryServiceOptions } from './contracts.js';
import { runtimeEventLedgerResourceId } from './resource-identifiers.js';

const MAX_RESOLVED_RUNTIME_EVENTS = 64;

export class RuntimeEventResourceCoordinator {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly resolveEvents: MemoryServiceOptions['resolveRuntimeEvents'],
  ) {}

  async register(
    runId: string,
    sessionId: SessionId,
    events: ReadonlyArray<RuntimeEventEnvelope>,
  ): Promise<void> {
    const group = `session-runtime-events:${sessionId}`;
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    for (const event of events) {
      if (event.runId !== runId || String(event.sessionId) !== String(sessionId)) {
        throw new Error(`Runtime event "${event.id}" does not belong to run "${runId}" and its session.`);
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
        throw new Error(`Runtime event "${event.id}" has an invalid sequence.`);
      }
      if (eventIds.has(event.id)) throw new Error(`Duplicate runtime event id "${event.id}".`);
      if (sequences.has(event.sequence)) throw new Error(`Duplicate runtime event sequence ${event.sequence}.`);
      eventIds.add(event.id);
      sequences.add(event.sequence);
    }
    const valid = [...events].sort((left, right) => left.sequence - right.sequence);
    if (valid.length === 0) {
      await this.repository.replaceResourceGroup(group, [], { staleMode: 'remove' });
      return;
    }
    const now = new Date().toISOString();
    const eventTypes = [...new Set(valid.map((event) => event.type))];
    const statusCounts = Object.fromEntries(
      [...new Set(valid.map((event) => event.status))]
        .map((status) => [status, valid.filter((event) => event.status === status).length]),
    );
    const resourceId = runtimeEventLedgerResourceId(runId);
    await this.repository.replaceResourceGroup(group, [{
      version: 1,
      id: resourceId,
      kind: 'runtime-event-ledger',
      title: '本轮运行时事件账本',
      description: `登记 ${valid.length} 个运行时事件的状态与顺序；不复制事件 payload。`,
      tier: InjectionTier.T2_RELEVANT,
      scope: 'run',
      scopeKey: runId,
      authority: 'derived',
      privacy: 'private',
      source: { kind: 'runtime-event', id: resourceId },
      indexKeys: ['runtime events', '运行时事件', runId, ...eventTypes],
      status: 'active',
      registryGroup: group,
      registeredAt: now,
      updatedAt: now,
      metadata: {
        runId,
        sessionId: String(sessionId),
        eventCount: valid.length,
        eventTypes,
        statusCounts,
        firstSequence: valid[0]!.sequence,
        latestSequence: valid.at(-1)!.sequence,
        firstReceivedAt: valid[0]!.receivedAt,
        latestReceivedAt: valid.at(-1)!.receivedAt,
      },
    }], { staleMode: 'remove' });
  }

  async resolve(resource: MemoryResourceRegistration): Promise<{
    content: string;
    source: string;
    generatedAt: string;
  } | undefined> {
    if (resource.source.kind !== 'runtime-event' || !resource.scopeKey) return undefined;
    const events = (await this.resolveEvents?.(resource.scopeKey))
      ?.filter((event) => event.runId === resource.scopeKey)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_RESOLVED_RUNTIME_EVENTS);
    if (!events || events.length === 0) return undefined;
    const expectedSessionId = typeof resource.metadata?.sessionId === 'string'
      ? resource.metadata.sessionId
      : undefined;
    const valid = expectedSessionId
      ? events.filter((event) => String(event.sessionId) === expectedSessionId)
      : events;
    if (valid.length === 0) return undefined;
    return {
      content: [
        'Runtime event ledger (payload values are intentionally omitted):',
        ...valid.map((event) => [
          `- #${event.sequence} ${event.type}; status=${event.status}; source=${event.source}; received=${event.receivedAt}`,
          `payload keys=${Object.keys(event.payload).slice(0, 20).join(', ') || 'none'}`,
          event.appliedAt ? `applied=${event.appliedAt}` : '',
          event.expiresAt ? `expires=${event.expiresAt}` : '',
          event.decisionReason ? 'decision reason recorded' : '',
        ].filter(Boolean).join('; ')),
      ].join('\n'),
      source: `run:${resource.scopeKey}#runtime-events`,
      generatedAt: valid.at(-1)!.receivedAt,
    };
  }
}
