// Durable Harness kernel: versioned event validation, effect lifecycle,
// projection rebuild and one authoritative final-reply settlement.
import type {
  DurableCapabilityProbeProjection,
  DurableCapabilitySnapshotProjection,
  DurableEffectProjection,
  DurableEffectStatus,
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableHarnessEventStoreLike,
  DurableInboxCommand,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
  DurableModelRequestStatus,
  DurableRunProjection,
  DurableRunStatus,
  FinalReplyReservation,
} from '@littlesheep/types';
import { DURABLE_HARNESS_EVENT_VERSION } from '@littlesheep/types';

export interface DurableHarnessKernelOptions {
  eventStore: DurableHarnessEventStoreLike;
  inboxStore?: DurableInboxStoreLike;
  /** Optional adapter to the persistent session-level reply registry. */
  reserveFinalReply?: (sessionId: string, reservation: FinalReplyReservation) => Promise<boolean>;
}

export interface DurableInboxProcessResult {
  readonly commandId: string;
  readonly status: 'completed' | 'failed';
  readonly eventId?: string;
  readonly reason?: string;
}

/**
 * Runtime-owned reducer and command boundary for the durable Harness path.
 * It intentionally knows nothing about filesystem paths, tools or providers.
 */
export class DurableHarnessKernel {
  private readonly eventStore: DurableHarnessEventStoreLike;
  private readonly inboxStore?: DurableInboxStoreLike;
  private readonly reserveFinalReply?: DurableHarnessKernelOptions['reserveFinalReply'];
  private readonly runTails = new Map<string, Promise<void>>();

  constructor(options: DurableHarnessKernelOptions) {
    this.eventStore = options.eventStore;
    this.inboxStore = options.inboxStore;
    this.reserveFinalReply = options.reserveFinalReply;
  }

  async initialize(): Promise<void> {
    const eventStore = this.eventStore as DurableHarnessEventStoreLike & { initialize?: () => Promise<void> };
    await eventStore.initialize?.();
    const inboxStore = this.inboxStore as (DurableInboxStoreLike & { initialize?: () => Promise<void> }) | undefined;
    await inboxStore?.initialize?.();
  }

  async append<TPayload extends Record<string, unknown>>(
    input: DurableHarnessEventAppendInput<TPayload>,
  ): Promise<DurableHarnessEventAppendOutcome<TPayload>> {
    validateEventInput(input);
    const key = `${input.sessionId}\u0000${input.runId}`;
    const previous = this.runTails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = await this.eventStore.read(input.sessionId, input.runId);
      const projection = reduceDurableRunProjection(existing);
      const knownDuplicate = existing.find((event) =>
        (input.eventId !== undefined && event.eventId === input.eventId)
        || event.idempotencyKey === input.idempotencyKey,
      );
      if (!knownDuplicate) {
        validateTransition(projection, input);
        if (input.type === 'final_reply_settled' && this.reserveFinalReply) {
          const reply = requiredString(input.payload.reply, 'final_reply_settled.reply');
          const fingerprint = requiredString(input.payload.replyFingerprint, 'final_reply_settled.replyFingerprint');
          const modelRequestId = requiredString(input.payload.modelRequestId, 'final_reply_settled.modelRequestId');
          const settlementId = typeof input.payload.settlementId === 'string' && input.payload.settlementId.trim()
            ? input.payload.settlementId.trim()
            : input.eventId ?? `${input.runId}:final-reply-settled`;
          if (!await this.reserveFinalReply(input.sessionId, {
            version: 1,
            settlementId,
            reply,
            replyFingerprint: fingerprint,
            modelRequestId,
          })) {
            throw new DurableKernelError('final reply fingerprint is already reserved', 'duplicate_final_reply');
          }
        }
      }
      const outcome = await this.eventStore.append(input);
      if (outcome.kind === 'conflict') throw new DurableKernelError('event append conflict', 'conflict');
      return outcome;
    });
    this.runTails.set(key, operation.then(() => undefined, () => undefined));
    return operation;
  }

  async enqueue(input: DurableInboxEnqueueInput): Promise<DurableInboxEnqueueOutcome> {
    if (!this.inboxStore) throw new DurableKernelError('durable inbox is not configured', 'inbox_unavailable');
    validateEventInput({ ...input, eventId: input.commandId, source: sourceForInboxType(input.type) });
    return this.inboxStore.enqueue(input);
  }

  /**
   * Materialize queued commands into events. The event is appended before the
   * inbox command is completed, so a crash between the two operations is safe:
   * the next drain sees an idempotent duplicate and only completes the command.
   */
  async processInbox(limit?: number): Promise<DurableInboxProcessResult[]> {
    if (!this.inboxStore) throw new DurableKernelError('durable inbox is not configured', 'inbox_unavailable');
    const commands = await this.inboxStore.claim(limit);
    const results: DurableInboxProcessResult[] = [];
    for (const command of commands) {
      try {
        const outcome = await this.append({
          eventId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          sessionId: command.sessionId,
          runId: command.runId,
          type: command.type,
          source: sourceForInboxCommand(command),
          payload: command.payload,
        });
        const eventId = outcome.kind === 'appended' || outcome.kind === 'duplicate' ? outcome.event.eventId : undefined;
        await this.inboxStore.complete(command.commandId, eventId ? [eventId] : []);
        results.push({ commandId: command.commandId, status: 'completed', ...(eventId ? { eventId } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.inboxStore.fail(command.commandId, reason, false);
        results.push({ commandId: command.commandId, status: 'failed', reason });
      }
    }
    return results;
  }

  async replay(sessionId: string, runId: string): Promise<DurableRunProjection> {
    return reduceDurableRunProjection(await this.eventStore.read(sessionId, runId));
  }

  async replayAfter(sessionId: string, runId: string, cursor: number): Promise<DurableHarnessEvent[]> {
    return this.eventStore.readAfter(sessionId, runId, cursor);
  }

  async rebuildProjection(sessionId: string, runId: string): Promise<DurableRunProjection> {
    return this.replay(sessionId, runId);
  }
}

export class DurableKernelError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'conflict' | 'duplicate_final_reply' | 'inbox_unavailable' | 'transition') {
    super(message);
    this.name = 'DurableKernelError';
  }
}

export function reduceDurableRunProjection(events: readonly DurableHarnessEvent[]): DurableRunProjection {
  let projection = emptyProjection(events[0]?.sessionId ?? '', events[0]?.runId ?? '');
  let expectedCursor = 1;
  for (const event of events) {
    if (event.version !== DURABLE_HARNESS_EVENT_VERSION) throw new DurableKernelError(`unknown durable event version: ${String(event.version)}`, 'invalid');
    if (event.cursor !== expectedCursor) throw new DurableKernelError(`event cursor gap at ${event.cursor}`, 'invalid');
    if (projection.sessionId && (event.sessionId !== projection.sessionId || event.runId !== projection.runId)) {
      throw new DurableKernelError('event stream contains mixed session/run ids', 'invalid');
    }
    projection = applyDurableHarnessEvent(projection, event);
    expectedCursor += 1;
  }
  return projection;
}

function emptyProjection(sessionId: string, runId: string): DurableRunProjection {
  return {
    version: 1,
    sessionId,
    runId,
    cursor: 0,
    status: 'accepted',
    eventCount: 0,
    finalReply: { state: 'none' },
    modelRequests: [],
    pendingModelRequestIds: [],
    effects: [],
    pendingEffectIds: [],
    unknownEffectIds: [],
  };
}

function applyDurableHarnessEvent(
  projection: DurableRunProjection,
  event: DurableHarnessEvent,
): DurableRunProjection {
  validateTransition(projection, event);
  const next: MutableProjection = {
    ...projection,
    cursor: event.cursor,
    eventCount: projection.eventCount + 1,
    lastEventType: event.type,
    effects: projection.effects.map((effect) => ({ ...effect })),
    pendingEffectIds: [...projection.pendingEffectIds],
    unknownEffectIds: [...projection.unknownEffectIds],
    finalReply: { ...projection.finalReply },
    ...(projection.capabilitySnapshot ? { capabilitySnapshot: { ...projection.capabilitySnapshot } } : {}),
    ...(projection.capabilityProbe ? { capabilityProbe: { ...projection.capabilityProbe } } : {}),
    modelRequests: projection.modelRequests.map((request) => ({ ...request })),
    pendingModelRequestIds: [...projection.pendingModelRequestIds],
  };
  switch (event.type) {
    case 'run_accepted':
      next.status = 'accepted';
      break;
    case 'capability_snapshot_read': {
      next.capabilitySnapshot = readCapabilitySnapshot(event);
      if (next.status === 'accepted') next.status = 'running';
      break;
    }
    case 'capability_probe_settled': {
      const probe = readCapabilityProbe(event);
      if (!next.capabilitySnapshot) {
        throw new DurableKernelError('capability probe requires a capability snapshot', 'transition');
      }
      if (probe.capabilityEpoch !== next.capabilitySnapshot.capabilityEpoch) {
        throw new DurableKernelError('capability probe epoch does not match its snapshot', 'transition');
      }
      next.capabilityProbe = probe;
      if (next.status === 'accepted') next.status = 'running';
      break;
    }
    case 'user_input_appended':
    case 'route_decided':
    case 'model_request_started':
    case 'model_response_received':
    case 'model_request_settled':
    case 'tool_call_proposed':
    case 'verification_recorded':
    case 'checkpoint_written':
      if (event.type === 'route_decided') {
        const route = requiredRoute(event.payload.route);
        next.route = route;
        next.status = route === 'clarify' ? 'waiting_user' : 'running';
      } else if (next.status === 'accepted') {
        next.status = 'running';
      }
      if (event.type === 'model_request_started') {
        const requestId = requiredString(event.payload.requestId, 'model_request_started.requestId');
        next.modelRequests.push({
          requestId,
          ...(typeof event.payload.requestIndex === 'number' ? { requestIndex: event.payload.requestIndex } : {}),
          ...(typeof event.payload.stage === 'string' ? { stage: event.payload.stage } : {}),
          ...(typeof event.payload.purpose === 'string' ? { purpose: event.payload.purpose } : {}),
          ...(typeof event.payload.provider === 'string' ? { provider: event.payload.provider } : {}),
          ...(typeof event.payload.model === 'string' ? { model: event.payload.model } : {}),
          status: 'started',
          startedEventId: event.eventId,
        });
        next.pendingModelRequestIds.push(requestId);
      } else if (event.type === 'model_response_received') {
        const requestId = requiredString(event.payload.requestId, 'model_response_received.requestId');
        const index = next.modelRequests.findIndex((request) => request.requestId === requestId);
        if (index < 0) throw new DurableKernelError(`model response has no request: ${requestId}`, 'transition');
        const current = next.modelRequests[index]!;
        if (current.status !== 'started') throw new DurableKernelError(`model response already settled: ${requestId}`, 'transition');
        next.modelRequests[index] = {
          ...current,
          status: 'received',
          ...(event.payload.usageStatus === 'unavailable' ? { usageStatus: 'unavailable' as const } : {}),
          ...(event.payload.usageStatus === 'unknown' ? { usageStatus: 'unknown' as const } : {}),
        };
      } else if (event.type === 'model_request_settled') {
        const requestId = requiredString(event.payload.requestId, 'model_request_settled.requestId');
        const index = next.modelRequests.findIndex((request) => request.requestId === requestId);
        if (index < 0) throw new DurableKernelError(`model settlement has no request: ${requestId}`, 'transition');
        const current = next.modelRequests[index]!;
        if (current.settlementEventId) throw new DurableKernelError(`model request already settled: ${requestId}`, 'transition');
        const status = requiredModelRequestStatus(event.payload.status);
        next.modelRequests[index] = {
          ...current,
          status,
          settlementEventId: event.eventId,
          ...(typeof event.payload.providerReached === 'boolean' ? { providerReached: event.payload.providerReached } : {}),
          ...(typeof event.payload.retryOf === 'string' ? { retryOf: event.payload.retryOf } : {}),
          ...(typeof event.payload.errorKind === 'string' ? { errorKind: event.payload.errorKind } : {}),
          ...(event.payload.usageStatus === 'available' ? { usageStatus: 'available' as const } : {}),
          ...(event.payload.usageStatus === 'unavailable' ? { usageStatus: 'unavailable' as const } : {}),
          ...(event.payload.usageStatus === 'unknown' ? { usageStatus: 'unknown' as const } : {}),
        };
        next.pendingModelRequestIds = next.pendingModelRequestIds.filter((id) => id !== requestId);
      }
      break;
    case 'effect_intent_created': {
      const effect = readEffectIntent(event);
      next.effects.push(effect);
      next.pendingEffectIds.push(effect.effectId);
      next.status = 'running';
      break;
    }
    case 'effect_settled': {
      const effectId = requiredString(event.payload.effectId, 'effect_settled.effectId');
      const index = next.effects.findIndex((effect) => effect.effectId === effectId);
      if (index < 0) throw new DurableKernelError(`effect settlement has no intent: ${effectId}`, 'transition');
      const current = next.effects[index];
      if (!current || current.settlementEventId) throw new DurableKernelError(`effect already settled: ${effectId}`, 'transition');
      const status = requiredEffectStatus(event.payload.status);
      const updated: DurableEffectProjection = {
        ...current,
        status,
        settlementEventId: event.eventId,
        ...(typeof event.payload.evidenceRef === 'string' ? { evidenceRef: event.payload.evidenceRef } : {}),
        ...(typeof event.payload.error === 'string' ? { error: event.payload.error } : {}),
      };
      next.effects[index] = updated;
      next.pendingEffectIds = next.pendingEffectIds.filter((id) => id !== effectId);
      if (status === 'unknown') {
        next.unknownEffectIds.push(effectId);
        next.status = 'waiting_user';
      }
      break;
    }
    case 'final_reply_proposed':
      next.finalReply = {
        ...next.finalReply,
        state: 'proposed',
        ...(typeof event.payload.settlementId === 'string' && event.payload.settlementId.trim()
          ? { settlementId: event.payload.settlementId.trim() }
          : {}),
        reply: requiredString(event.payload.reply, 'final_reply_proposed.reply'),
        replyFingerprint: requiredString(event.payload.replyFingerprint, 'final_reply_proposed.replyFingerprint'),
        modelRequestId: requiredString(event.payload.modelRequestId, 'final_reply_proposed.modelRequestId'),
      };
      break;
    case 'final_reply_settled':
      next.finalReply = {
        state: 'settled',
        settlementId: typeof event.payload.settlementId === 'string' && event.payload.settlementId.trim()
          ? event.payload.settlementId.trim()
          : event.eventId,
        reply: requiredString(event.payload.reply, 'final_reply_settled.reply'),
        replyFingerprint: requiredString(event.payload.replyFingerprint, 'final_reply_settled.replyFingerprint'),
        modelRequestId: requiredString(event.payload.modelRequestId, 'final_reply_settled.modelRequestId'),
      };
      break;
    case 'runtime_status_settled': {
      const status = requiredRuntimeStatus(event.payload.status);
      next.finalReply = { state: 'runtime_status', settlementId: event.eventId };
      next.status = status;
      break;
    }
    case 'run_failed':
      next.status = 'failed';
      break;
    case 'run_interrupted':
      next.status = 'interrupted';
      break;
    case 'run_completed':
      if (projection.finalReply.state !== 'settled') throw new DurableKernelError('run completion requires a settled final reply', 'transition');
      if (projection.pendingModelRequestIds.length > 0) throw new DurableKernelError('run completion requires all model requests settled', 'transition');
      if (projection.pendingEffectIds.length > 0 || projection.unknownEffectIds.length > 0) throw new DurableKernelError('run completion requires all effects settled', 'transition');
      next.status = 'completed';
      break;
    default:
      return assertNeverEvent(event as never);
  }
  return freezeProjection(next);
}

function validateTransition(projection: DurableRunProjection, event: DurableHarnessEventAppendInput | DurableHarnessEvent): void {
  const isFirst = projection.eventCount === 0;
  if (isFirst && event.type !== 'run_accepted') throw new DurableKernelError('run must begin with run_accepted', 'transition');
  if (!isFirst && event.type === 'run_accepted') throw new DurableKernelError('run_accepted may only be appended once', 'transition');
  if (projection.status === 'completed' || projection.status === 'failed' || projection.status === 'interrupted') {
    throw new DurableKernelError(`run is already terminal: ${projection.status}`, 'transition');
  }
  if (event.type === 'final_reply_settled') {
    if (projection.finalReply.state === 'settled' || projection.finalReply.state === 'runtime_status') throw new DurableKernelError('final reply already settled', 'transition');
    if (projection.finalReply.state !== 'proposed') throw new DurableKernelError('final reply settlement requires a proposal', 'transition');
    if (projection.pendingEffectIds.length > 0 || projection.unknownEffectIds.length > 0) throw new DurableKernelError('cannot settle reply while effects are pending or unknown', 'transition');
    if (projection.pendingModelRequestIds.length > 0) throw new DurableKernelError('cannot settle reply while model requests are pending', 'transition');
  }
  if (event.type === 'runtime_status_settled' && (projection.finalReply.state === 'settled' || projection.finalReply.state === 'runtime_status')) {
    throw new DurableKernelError('runtime status already settled', 'transition');
  }
  if ((event.type === 'run_failed' || event.type === 'run_interrupted') && projection.finalReply.state === 'settled') {
    throw new DurableKernelError('cannot fail or interrupt after final reply settlement', 'transition');
  }
  if (event.type === 'run_completed') {
    if (projection.finalReply.state !== 'settled') throw new DurableKernelError('run completion requires a settled final reply', 'transition');
    if (projection.pendingEffectIds.length > 0 || projection.unknownEffectIds.length > 0) throw new DurableKernelError('run completion requires all effects settled', 'transition');
  }
  if (event.type === 'effect_intent_created') {
    const effectId = requiredString(event.payload.effectId, 'effect_intent_created.effectId');
    if (projection.effects.some((effect) => effect.effectId === effectId)) throw new DurableKernelError(`effect intent already exists: ${effectId}`, 'transition');
    const idempotencyKey = requiredString(event.payload.idempotencyKey, 'effect_intent_created.idempotencyKey');
    if (projection.effects.some((effect) => effect.idempotencyKey === idempotencyKey)) throw new DurableKernelError(`effect idempotency key already exists: ${idempotencyKey}`, 'transition');
  }
  if (event.type === 'capability_snapshot_read') {
    readCapabilitySnapshot(event);
    if (projection.capabilitySnapshot) {
      throw new DurableKernelError('capability snapshot has already been read', 'transition');
    }
  }
  if (event.type === 'capability_probe_settled') {
    const probe = readCapabilityProbe(event);
    if (!projection.capabilitySnapshot) {
      throw new DurableKernelError('capability probe requires a capability snapshot', 'transition');
    }
    if (projection.capabilityProbe) {
      throw new DurableKernelError('capability probe has already settled', 'transition');
    }
    if (probe.capabilityEpoch !== projection.capabilitySnapshot.capabilityEpoch) {
      throw new DurableKernelError('capability probe epoch does not match its snapshot', 'transition');
    }
  }
  if (event.type === 'model_request_started') {
    const requestId = requiredString(event.payload.requestId, 'model_request_started.requestId');
    if (projection.modelRequests.some((request) => request.requestId === requestId)) {
      throw new DurableKernelError(`model request already exists: ${requestId}`, 'transition');
    }
  }
  if (event.type === 'model_response_received') {
    const requestId = requiredString(event.payload.requestId, 'model_response_received.requestId');
    const request = projection.modelRequests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.status !== 'started') {
      throw new DurableKernelError(`model response requires an unsettled request: ${requestId}`, 'transition');
    }
  }
  if (event.type === 'model_request_settled') {
    const requestId = requiredString(event.payload.requestId, 'model_request_settled.requestId');
    const request = projection.modelRequests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.settlementEventId) {
      throw new DurableKernelError(`model settlement requires one unsettled request: ${requestId}`, 'transition');
    }
    requiredModelRequestStatus(event.payload.status);
  }
  if (event.type === 'effect_settled') {
    const effectId = requiredString(event.payload.effectId, 'effect_settled.effectId');
    const effect = projection.effects.find((candidate) => candidate.effectId === effectId);
    if (!effect) throw new DurableKernelError(`effect settlement has no intent: ${effectId}`, 'transition');
    if (effect.settlementEventId) throw new DurableKernelError(`effect already settled: ${effectId}`, 'transition');
  }
  if (event.type === 'final_reply_settled') {
    const reply = requiredString(event.payload.reply, 'final_reply_settled.reply');
    const fingerprint = requiredString(event.payload.replyFingerprint, 'final_reply_settled.replyFingerprint');
    const modelRequestId = requiredString(event.payload.modelRequestId, 'final_reply_settled.modelRequestId');
    if (projection.finalReply.reply !== reply
      || projection.finalReply.replyFingerprint !== fingerprint
      || projection.finalReply.modelRequestId !== modelRequestId) {
      throw new DurableKernelError('final reply settlement does not match its proposal', 'transition');
    }
    const proposalSettlementId = projection.finalReply.settlementId;
    const settlementId = typeof event.payload.settlementId === 'string' && event.payload.settlementId.trim()
      ? event.payload.settlementId.trim()
      : event.eventId;
    if (proposalSettlementId && proposalSettlementId !== settlementId) {
      throw new DurableKernelError('final reply settlement identity does not match its proposal', 'transition');
    }
  }
  if (event.type === 'final_reply_proposed') {
    if (projection.finalReply.state !== 'none') {
      throw new DurableKernelError('final reply proposal already exists', 'transition');
    }
    if (projection.pendingEffectIds.length > 0 || projection.unknownEffectIds.length > 0) {
      throw new DurableKernelError('cannot propose a final reply while effects are pending or unknown', 'transition');
    }
    if (projection.pendingModelRequestIds.length > 0) {
      throw new DurableKernelError('cannot propose a final reply while model requests are pending', 'transition');
    }
    requiredString(event.payload.reply, 'final_reply_proposed.reply');
    requiredString(event.payload.replyFingerprint, 'final_reply_proposed.replyFingerprint');
    requiredString(event.payload.modelRequestId, 'final_reply_proposed.modelRequestId');
    if (event.payload.settlementId !== undefined) requiredString(event.payload.settlementId, 'final_reply_proposed.settlementId');
  }
  if (event.type === 'route_decided' && projection.route !== undefined) {
    throw new DurableKernelError('route has already been decided', 'transition');
  }
  if (event.type === 'route_decided'
    && (event.payload.retrievalIntent === 'capability_question' || event.payload.retrievalIntent === 'capability_probe')
    && !projection.capabilitySnapshot) {
    throw new DurableKernelError('capability route requires a capability snapshot', 'transition');
  }
  validateSource(event);
}

function validateEventInput(input: DurableHarnessEventAppendInput): void {
  if (typeof input.sessionId !== 'string' || typeof input.runId !== 'string' || typeof input.idempotencyKey !== 'string'
    || !input.sessionId.trim() || !input.runId.trim() || !input.idempotencyKey.trim()) {
    throw new DurableKernelError('event identity fields must be non-empty strings', 'invalid');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new DurableKernelError('event payload must be an object', 'invalid');
}

function validateSource(event: DurableHarnessEventAppendInput | DurableHarnessEvent): void {
  const source = event.source;
  const expected: Partial<Record<DurableHarnessEvent['type'], readonly string[]>> = {
    run_accepted: ['runtime', 'app', 'channel'],
    user_input_appended: ['app', 'channel'],
    capability_snapshot_read: ['runtime'],
    capability_probe_settled: ['runtime'],
    route_decided: ['runtime'],
    model_request_started: ['runtime'],
    model_response_received: ['model', 'runtime'],
    model_request_settled: ['runtime'],
    tool_call_proposed: ['model', 'runtime'],
    effect_intent_created: ['runtime'],
    effect_settled: ['tool', 'runtime'],
    verification_recorded: ['runtime'],
    checkpoint_written: ['runtime'],
    final_reply_proposed: ['model', 'runtime'],
    final_reply_settled: ['runtime'],
    runtime_status_settled: ['runtime'],
    run_failed: ['runtime'],
    run_interrupted: ['runtime'],
    run_completed: ['runtime'],
  };
  if (!expected[event.type]?.includes(source)) throw new DurableKernelError(`invalid source ${source} for ${event.type}`, 'invalid');
}

function readEffectIntent(event: DurableHarnessEvent): DurableEffectProjection {
  const effectId = requiredString(event.payload.effectId, 'effect_intent_created.effectId');
  const idempotencyKey = requiredString(event.payload.idempotencyKey, 'effect_intent_created.idempotencyKey');
  const toolName = requiredString(event.payload.toolName, 'effect_intent_created.toolName');
  const effectKind = event.payload.effectKind;
  if (effectKind !== 'local_mutation' && effectKind !== 'external' && effectKind !== 'unknown') throw new DurableKernelError('invalid effect kind', 'invalid');
  return {
    effectId,
    idempotencyKey,
    toolName,
    effectKind,
    status: 'planned',
    intentEventId: event.eventId,
    ...(typeof event.payload.inputHash === 'string' ? { inputHash: event.payload.inputHash } : {}),
  };
}

function readCapabilitySnapshot(event: { payload: Record<string, unknown> }): DurableCapabilitySnapshotProjection {
  const snapshot = event.payload.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new DurableKernelError('capability_snapshot_read.snapshot must be an object', 'invalid');
  }
  const record = snapshot as Record<string, unknown>;
  const capabilityEpoch = requiredString(record.capabilityEpoch, 'capability_snapshot_read.capabilityEpoch');
  const permissionPolicyId = requiredString(record.permissionPolicyId, 'capability_snapshot_read.permissionPolicyId');
  const workspace = record.workspace;
  if (workspace !== 'available' && workspace !== 'approval_required' && workspace !== 'denied' && workspace !== 'unavailable') {
    throw new DurableKernelError('invalid capability workspace status', 'invalid');
  }
  if (!Array.isArray(record.tools)) throw new DurableKernelError('capability_snapshot_read.tools must be an array', 'invalid');
  const tools = record.tools.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DurableKernelError(`invalid capability tool at ${index}`, 'invalid');
    const tool = item as Record<string, unknown>;
    const name = requiredString(tool.name, `capability_snapshot_read.tools[${index}].name`);
    const status = tool.status;
    if (status !== 'available' && status !== 'approval_required') throw new DurableKernelError(`invalid capability tool status at ${index}`, 'invalid');
    const source = tool.source;
    if (source !== 'builtin' && source !== 'external') throw new DurableKernelError(`invalid capability tool source at ${index}`, 'invalid');
    return { name, status, source } as const;
  });
  const network = record.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) throw new DurableKernelError('invalid capability network state', 'invalid');
  const networkRecord = network as Record<string, unknown>;
  if (typeof networkRecord.enabled !== 'boolean') throw new DurableKernelError('capability network enabled must be boolean', 'invalid');
  const networkStatus = requiredString(networkRecord.status, 'capability_snapshot_read.network.status');
  const providerId = typeof networkRecord.providerId === 'string' && networkRecord.providerId.trim()
    ? networkRecord.providerId.trim()
    : undefined;
  return {
    capabilityEpoch,
    permissionPolicyId,
    workspace,
    tools,
    network: { enabled: networkRecord.enabled, status: networkStatus, ...(providerId ? { providerId } : {}) },
  };
}

function readCapabilityProbe(event: { payload: Record<string, unknown> }): DurableCapabilityProbeProjection {
  const probeId = requiredString(event.payload.probeId, 'capability_probe_settled.probeId');
  const status = event.payload.status;
  if (status !== 'observed' && status !== 'unavailable') throw new DurableKernelError('invalid capability probe status', 'invalid');
  const capabilityEpoch = requiredString(event.payload.capabilityEpoch, 'capability_probe_settled.capabilityEpoch');
  if (event.payload.evidence !== 'runtime_snapshot') throw new DurableKernelError('invalid capability probe evidence', 'invalid');
  const permissionDecision = event.payload.permissionDecision;
  if (permissionDecision !== 'allow' && permissionDecision !== 'approval_required' && permissionDecision !== 'deny' && permissionDecision !== 'unavailable') {
    throw new DurableKernelError('invalid capability probe permission decision', 'invalid');
  }
  return { probeId, status, capabilityEpoch, evidence: 'runtime_snapshot', permissionDecision };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DurableKernelError(`${label} must be non-empty`, 'invalid');
  return value.trim();
}

function requiredRoute(value: unknown): NonNullable<DurableRunProjection['route']> {
  if (value !== 'respond' && value !== 'execute' && value !== 'clarify') throw new DurableKernelError('invalid route', 'invalid');
  return value;
}

function requiredEffectStatus(value: unknown): DurableEffectStatus {
  if (value !== 'succeeded' && value !== 'failed' && value !== 'cancelled' && value !== 'unknown') throw new DurableKernelError('invalid effect settlement status', 'invalid');
  return value;
}

function requiredModelRequestStatus(value: unknown): DurableModelRequestStatus {
  if (value !== 'received' && value !== 'missing' && value !== 'aborted' && value !== 'timeout'
    && value !== 'rate_limit' && value !== 'connection_reset' && value !== 'failed') {
    throw new DurableKernelError('invalid model request settlement status', 'invalid');
  }
  return value;
}

function requiredRuntimeStatus(value: unknown): DurableRunStatus {
  if (value !== 'waiting_user' && value !== 'failed' && value !== 'interrupted') throw new DurableKernelError('invalid runtime status settlement', 'invalid');
  return value;
}

function sourceForInboxCommand(command: DurableInboxCommand): DurableHarnessEvent['source'] {
  return sourceForInboxType(command.type);
}

function sourceForInboxType(type: DurableHarnessEvent['type']): DurableHarnessEvent['source'] {
  if (type === 'user_input_appended') return 'app';
  if (type === 'model_response_received' || type === 'final_reply_proposed') return 'model';
  if (type === 'effect_settled') return 'tool';
  return 'runtime';
}

type MutableProjection = {
  -readonly [Key in keyof DurableRunProjection]: DurableRunProjection[Key] extends readonly (infer Item)[] ? Item[] : DurableRunProjection[Key];
};

function freezeProjection(projection: MutableProjection): DurableRunProjection {
  return {
    ...projection,
    effects: projection.effects.map((effect) => Object.freeze({ ...effect })),
    pendingEffectIds: [...projection.pendingEffectIds],
    unknownEffectIds: [...projection.unknownEffectIds],
    finalReply: Object.freeze({ ...projection.finalReply }),
  };
}

function assertNeverEvent(event: never): never {
  throw new DurableKernelError(`unknown durable event type: ${String((event as { type?: unknown }).type)}`, 'invalid');
}
