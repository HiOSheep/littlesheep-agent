// Durable Harness kernel: versioned event validation, effect lifecycle,
// projection rebuild and one authoritative final-reply settlement.
import type {
  DurableEffectProjection,
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableHarnessEventStoreLike,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
  DurableFinalReplyReplay,
  DurableRecoveryAction,
  DurableRecoveryReason,
  DurableRunRecoveryResult,
  DurableRunProjection,
  FinalReplyReservation,
} from '@littlesheep/types';
import { DURABLE_HARNESS_EVENT_VERSION } from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';
import {
  freezeDurableRunProjection,
  isModelTransportStatus,
  isProviderReachStatus,
  type MutableDurableRunProjection,
  readCacheObservation,
  readCapabilityProbe,
  readCapabilitySnapshot,
  readEffectIntent,
  readProviderUsage,
  requiredEffectStatus,
  requiredModelRequestStatus,
  requiredRoute,
  requiredRuntimeStatus,
  requiredString,
  sourceForInboxCommand,
  sourceForInboxType,
  validateEventInput,
  validateSource,
} from './durable-projection-codec.js';

export { DurableKernelError } from './durable-kernel-error.js';

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

export interface DurableRecoveryOptions {
  /** Proves that the session transcript and settlement registry were committed. */
  finalReplyPersisted?: (reservation: FinalReplyReservation) => Promise<boolean>;
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
      let lastCursorConflict: unknown;
      let finalReplyReservation: FinalReplyReservation | undefined;
      let finalReplyReservationReserved = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await this.eventStore.read(input.sessionId, input.runId);
        const projection = reduceDurableRunProjection(existing);
        const knownDuplicate = existing.find((event) =>
          (input.eventId !== undefined && event.eventId === input.eventId)
          || event.idempotencyKey === input.idempotencyKey,
        );
        if (!knownDuplicate) {
          validateTransition(projection, input);
          if (input.type === 'final_reply_settled' && this.reserveFinalReply && !finalReplyReservationReserved) {
            const reply = requiredString(input.payload.reply, 'final_reply_settled.reply');
            const fingerprint = requiredString(input.payload.replyFingerprint, 'final_reply_settled.replyFingerprint');
            const modelRequestId = requiredString(input.payload.modelRequestId, 'final_reply_settled.modelRequestId');
            const settlementId = typeof input.payload.settlementId === 'string' && input.payload.settlementId.trim()
              ? input.payload.settlementId.trim()
              : input.eventId ?? `${input.runId}:final-reply-settled`;
            finalReplyReservation = {
              version: 1,
              settlementId,
              reply,
              replyFingerprint: fingerprint,
              modelRequestId,
            };
            if (!await this.reserveFinalReply(input.sessionId, finalReplyReservation)) {
              throw new DurableKernelError('final reply fingerprint is already reserved', 'duplicate_final_reply');
            }
            finalReplyReservationReserved = true;
          }
        }
        try {
          const outcome = await this.eventStore.append(knownDuplicate
            ? input
            : { ...input, expectedCursor: projection.cursor });
          if (outcome.kind === 'conflict') throw new DurableKernelError('event append conflict', 'conflict');
          return outcome;
        } catch (error) {
          if (!isCursorConflict(error) || attempt === 2) throw error;
          lastCursorConflict = error;
        }
      }
      throw lastCursorConflict instanceof Error
        ? lastCursorConflict
        : new DurableKernelError('event cursor changed during append', 'conflict');
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

  /**
   * Run one idempotent post-crash recovery pass. Recovery only appends facts;
   * it never invokes a model or tool. An effect whose outcome cannot be
   * proven is settled as `unknown` and the run is left waiting for a user
   * decision. A settled effect or reply is only replayed through projection.
   */
  async recoverRun(
    sessionId: string,
    runId: string,
    options: DurableRecoveryOptions = {},
  ): Promise<DurableRunRecoveryResult> {
    let projection = await this.replay(sessionId, runId);
    const actions: DurableRecoveryAction[] = [];
    if (projection.eventCount === 0 || isDurableRunTerminal(projection)) {
      return { sessionId, runId, actions, projection };
    }

    // First close model requests. A response that reached the durable log can
    // be marked received; an absent response is explicitly marked missing.
    for (const requestId of projection.pendingModelRequestIds) {
      const request = projection.modelRequests.find((candidate) => candidate.requestId === requestId);
      if (!request) continue;
      const status = request.status === 'received' ? 'received' : 'missing';
      const reason: DurableRecoveryReason = status === 'received'
        ? 'model_response_not_settled'
        : 'model_response_missing';
      const eventId = `${runId}:recovery:model:${requestId}`;
      await this.append({
        eventId,
        idempotencyKey: eventId,
        sessionId,
        runId,
        type: 'model_request_settled',
        source: 'runtime',
        payload: {
          requestId,
          status,
          providerReached: request.providerReached ?? request.providerReachStatus === 'reached',
          providerReachStatus: request.providerReachStatus ?? 'unknown',
          transportStatus: status === 'received' ? 'completed' : 'unknown',
          usageStatus: request.usageStatus ?? 'unknown',
          errorKind: reason,
        },
      });
      actions.push({
        kind: status === 'received' ? 'model_marked_received' : 'model_marked_missing',
        eventId,
        requestId,
        reason,
      });
      projection = await this.replay(sessionId, runId);
    }

    // Never retry an effect after a crash without an authoritative outcome.
    // This includes intents that were still only `planned`: the process may
    // have crossed the Tool Execution Service boundary before it died.
    for (const effectId of projection.pendingEffectIds) {
      const effect = projection.effects.find((candidate) => candidate.effectId === effectId);
      if (!effect) continue;
      const eventId = `${runId}:recovery:effect:${effectId}`;
      await this.append({
        eventId,
        idempotencyKey: eventId,
        sessionId,
        runId,
        type: 'effect_settled',
        source: 'runtime',
        payload: {
          effectId,
          status: 'unknown',
          evidenceRef: `recovery:${effect.intentEventId}`,
          error: 'effect outcome was not durably observed before process exit',
        },
      });
      actions.push({
        kind: 'effect_marked_unknown',
        eventId,
        effectId,
        reason: 'effect_settlement_unknown',
      });
      projection = await this.replay(sessionId, runId);
    }

    // A process can die after the transcript/registry commit but before the
    // final-reply event. Promote only when the host proves that commit.
    if (projection.finalReply.state === 'proposed') {
      const finalReply = projection.finalReply;
      const reservation = finalReply.settlementId && finalReply.reply
        && finalReply.replyFingerprint && finalReply.modelRequestId
        ? {
            version: 1 as const,
            settlementId: finalReply.settlementId,
            reply: finalReply.reply,
            replyFingerprint: finalReply.replyFingerprint,
            modelRequestId: finalReply.modelRequestId,
          }
        : undefined;
      const persisted = reservation && options.finalReplyPersisted
        ? await options.finalReplyPersisted(reservation).catch(() => false)
        : false;
      if (persisted && reservation) {
        const eventId = `${runId}:recovery:final-reply-settled`;
        await this.append({
          eventId,
          idempotencyKey: eventId,
          sessionId,
          runId,
          type: 'final_reply_settled',
          source: 'runtime',
          payload: reservation,
        });
        actions.push({ kind: 'final_reply_settled', eventId });
        projection = await this.replay(sessionId, runId);
      }
    }

    if (projection.finalReply.state === 'settled'
      && projection.pendingModelRequestIds.length === 0
      && projection.pendingEffectIds.length === 0
      && projection.unknownEffectIds.length === 0
      && !isDurableRunTerminal(projection)) {
      const eventId = `${runId}:recovery:run-completed`;
      await this.append({
        eventId,
        idempotencyKey: eventId,
        sessionId,
        runId,
        type: 'run_completed',
        source: 'runtime',
        payload: { recovery: true },
      });
      actions.push({ kind: 'run_completed', eventId });
      projection = await this.replay(sessionId, runId);
    } else if (projection.finalReply.state !== 'settled'
      && projection.finalReply.state !== 'runtime_status'
      && !isDurableRunTerminal(projection)) {
      const reason: DurableRecoveryReason = projection.unknownEffectIds.length > 0
        ? 'effect_settlement_unknown'
        : projection.finalReply.state === 'proposed'
          ? 'final_reply_persistence_unconfirmed'
          : actions.some((action) => action.reason === 'model_response_missing')
            ? 'model_response_missing'
            : actions.some((action) => action.reason === 'model_response_not_settled')
              ? 'model_response_not_settled'
              : projection.pendingModelRequestIds.length > 0
                ? 'model_response_missing'
            : 'run_incomplete_after_restart';
      const eventId = `${runId}:recovery:runtime-status`;
      await this.append({
        eventId,
        idempotencyKey: eventId,
        sessionId,
        runId,
        type: 'runtime_status_settled',
        source: 'runtime',
        payload: { status: 'waiting_user', reason },
      });
      actions.push({ kind: 'runtime_status_settled', eventId, reason });
      projection = await this.replay(sessionId, runId);
    }

    return { sessionId, runId, actions, projection };
  }

  /** Replay only the authoritative final settlement; proposals are hidden. */
  async replayFinalReply(sessionId: string, runId: string): Promise<DurableFinalReplyReplay> {
    return replayDurableFinalReply(await this.replay(sessionId, runId));
  }
}

function isDurableRunTerminal(projection: DurableRunProjection): boolean {
  return projection.status === 'completed'
    || projection.status === 'failed'
    || projection.status === 'interrupted'
    || projection.finalReply.state === 'runtime_status';
}

export function replayDurableFinalReply(projection: DurableRunProjection): DurableFinalReplyReplay {
  const finalReply = projection.finalReply;
  if (finalReply.state === 'settled'
    && finalReply.settlementId
    && finalReply.reply
    && finalReply.replyFingerprint
    && finalReply.modelRequestId) {
    return {
      kind: 'settled',
      sessionId: projection.sessionId,
      runId: projection.runId,
      cursor: projection.cursor,
      settlementId: finalReply.settlementId,
      reply: finalReply.reply,
      replyFingerprint: finalReply.replyFingerprint,
      modelRequestId: finalReply.modelRequestId,
    };
  }
  if (finalReply.state === 'runtime_status' && finalReply.settlementId) {
    return {
      kind: 'runtime_status',
      sessionId: projection.sessionId,
      runId: projection.runId,
      cursor: projection.cursor,
      settlementId: finalReply.settlementId,
      status: projection.status === 'failed' || projection.status === 'interrupted'
        ? projection.status
        : 'waiting_user',
      ...(projection.runtimeStatusReason ? { reason: projection.runtimeStatusReason } : {}),
    };
  }
  return {
    kind: 'unavailable',
    sessionId: projection.sessionId,
    runId: projection.runId,
    cursor: projection.cursor,
    status: projection.status,
    reason: projection.eventCount === 0
      ? 'empty_run'
      : projection.status === 'failed' || projection.status === 'interrupted'
        ? 'terminal_without_settlement'
        : 'not_settled',
  };
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
    stageTransitions: [],
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
  const next: MutableDurableRunProjection = {
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
    stageTransitions: projection.stageTransitions.map((transition) => ({ ...transition })),
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
    case 'stage_transition_recorded':
    case 'route_decided':
    case 'model_request_started':
    case 'model_response_received':
    case 'model_request_settled':
    case 'tool_call_proposed':
    case 'verification_recorded':
    case 'checkpoint_written':
      if (event.type === 'stage_transition_recorded') {
        const stage = event.payload.stage;
        const nextStage = event.payload.next;
        const attempt = event.payload.attempt;
        if (typeof stage !== 'string' || !stage.trim() || typeof nextStage !== 'string' || !nextStage.trim()) {
          throw new DurableKernelError('stage transition names must be non-empty', 'invalid');
        }
        if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) {
          throw new DurableKernelError('stage transition attempt must be a positive integer', 'invalid');
        }
        if (typeof event.payload.ok !== 'boolean') {
          throw new DurableKernelError('stage transition ok must be boolean', 'invalid');
        }
        next.stageTransitions.push({
          stage: stage.trim(),
          next: nextStage.trim(),
          ok: event.payload.ok,
          attempt: attempt as number,
          transitionEventId: event.eventId,
        });
        if (next.status === 'accepted') next.status = 'running';
      } else if (event.type === 'route_decided') {
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
          ...(typeof event.payload.stream === 'boolean' ? { stream: event.payload.stream } : {}),
          ...(isModelTransportStatus(event.payload.transportStatus)
            ? { transportStatus: event.payload.transportStatus }
            : {}),
          ...(isProviderReachStatus(event.payload.providerReachStatus)
            ? { providerReachStatus: event.payload.providerReachStatus }
            : {}),
          ...(event.payload.cacheObservation !== undefined
            ? { cacheObservation: readCacheObservation(event.payload.cacheObservation, requestId) }
            : {}),
          ...(typeof event.payload.retryOf === 'string' ? { retryOf: event.payload.retryOf } : {}),
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
        const providerUsage = readProviderUsage(event.payload);
        next.modelRequests[index] = {
          ...current,
          status: 'received',
          ...(typeof event.payload.stream === 'boolean' ? { stream: event.payload.stream } : {}),
          ...(isModelTransportStatus(event.payload.transportStatus)
            ? { transportStatus: event.payload.transportStatus }
            : {}),
          ...(isProviderReachStatus(event.payload.providerReachStatus)
            ? { providerReachStatus: event.payload.providerReachStatus }
            : {}),
          ...(event.payload.cacheObservation !== undefined
            ? { cacheObservation: readCacheObservation(event.payload.cacheObservation, requestId) }
            : {}),
          ...(providerUsage ? { providerUsage } : {}),
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
          ...(isModelTransportStatus(event.payload.transportStatus)
            ? { transportStatus: event.payload.transportStatus }
            : {}),
          ...(isProviderReachStatus(event.payload.providerReachStatus)
            ? { providerReachStatus: event.payload.providerReachStatus }
            : {}),
          ...(event.payload.cacheObservation !== undefined
            ? { cacheObservation: readCacheObservation(event.payload.cacheObservation, requestId) }
            : {}),
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
      if (typeof event.payload.reason === 'string' && event.payload.reason.trim()) {
        next.runtimeStatusReason = event.payload.reason.trim().slice(0, 128);
      }
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
  return freezeDurableRunProjection(next);
}

function validateTransition(projection: DurableRunProjection, event: DurableHarnessEventAppendInput | DurableHarnessEvent): void {
  const isFirst = projection.eventCount === 0;
  if (isFirst && event.type !== 'run_accepted') throw new DurableKernelError('run must begin with run_accepted', 'transition');
  if (!isFirst && event.type === 'run_accepted') throw new DurableKernelError('run_accepted may only be appended once', 'transition');
  const auditOnlyTransition = event.type === 'stage_transition_recorded';
  if (!auditOnlyTransition && (projection.status === 'completed' || projection.status === 'failed' || projection.status === 'interrupted')) {
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
    if (event.payload.cacheObservation !== undefined) {
      readCacheObservation(event.payload.cacheObservation, requestId);
    }
    if (event.payload.retryOf !== undefined) {
      const retryOf = requiredString(event.payload.retryOf, 'model_request_started.retryOf');
      if (retryOf === requestId) {
        throw new DurableKernelError(`model retry cannot point to itself: ${requestId}`, 'transition');
      }
      if (!projection.modelRequests.some((request) => request.requestId === retryOf)) {
        throw new DurableKernelError(`model retry parent is unknown: ${retryOf}`, 'transition');
      }
    }
  }
  if (event.type === 'model_response_received') {
    const requestId = requiredString(event.payload.requestId, 'model_response_received.requestId');
    const request = projection.modelRequests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.status !== 'started') {
      throw new DurableKernelError(`model response requires an unsettled request: ${requestId}`, 'transition');
    }
    readProviderUsage(event.payload);
    if (event.payload.cacheObservation !== undefined) {
      readCacheObservation(event.payload.cacheObservation, requestId);
    }
  }
  if (event.type === 'model_request_settled') {
    const requestId = requiredString(event.payload.requestId, 'model_request_settled.requestId');
    const request = projection.modelRequests.find((candidate) => candidate.requestId === requestId);
    if (!request || request.settlementEventId) {
      throw new DurableKernelError(`model settlement requires one unsettled request: ${requestId}`, 'transition');
    }
    const status = requiredModelRequestStatus(event.payload.status);
    if (status === 'received' && request.status !== 'received') {
      throw new DurableKernelError(`received model settlement requires a response event: ${requestId}`, 'transition');
    }
    if (event.payload.cacheObservation !== undefined) {
      readCacheObservation(event.payload.cacheObservation, requestId);
    }
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

function assertNeverEvent(event: never): never {
  throw new DurableKernelError(`unknown durable event type: ${String((event as { type?: unknown }).type)}`, 'invalid');
}

/** Only stale optimistic cursors are retryable; event/idempotency conflicts are not. */
function isCursorConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { kind?: unknown; message?: unknown };
  return candidate.kind === 'conflict'
    && typeof candidate.message === 'string'
    && candidate.message.startsWith('event cursor changed during append:');
}
