// Versioned contracts for the next durable Harness kernel.
// The types package owns the protocol; filesystem and model adapters stay in
// higher-level packages so the event contract cannot depend on infrastructure.

import type { CacheObservation } from './cache-observability.js';

export const DURABLE_HARNESS_EVENT_VERSION = 1 as const;
export const DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DURABLE_HARNESS_EVENT_MAX_EVENTS_PER_RUN = 4096;
export const DURABLE_HARNESS_INBOX_VERSION = 1 as const;

export type DurableHarnessEventType =
  | 'run_accepted'
  | 'user_input_appended'
  | 'capability_snapshot_read'
  | 'capability_probe_settled'
  | 'stage_transition_recorded'
  | 'route_decided'
  | 'model_request_started'
  | 'model_response_received'
  | 'model_request_settled'
  | 'tool_call_proposed'
  | 'effect_intent_created'
  | 'effect_settled'
  | 'verification_recorded'
  | 'checkpoint_written'
  | 'final_reply_proposed'
  | 'final_reply_settled'
  | 'runtime_status_settled'
  | 'run_failed'
  | 'run_interrupted'
  | 'run_completed';

export type DurableHarnessEventSource = 'runtime' | 'model' | 'tool' | 'app' | 'channel' | 'system';

export interface DurableHarnessEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly version: typeof DURABLE_HARNESS_EVENT_VERSION;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly runId: string;
  /** Monotonic per-run cursor assigned by the event store. */
  readonly cursor: number;
  readonly type: DurableHarnessEventType;
  readonly source: DurableHarnessEventSource;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface DurableHarnessEventAppendInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventId?: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly type: DurableHarnessEventType;
  readonly source: DurableHarnessEventSource;
  readonly occurredAt?: string;
  /** Optional optimistic-concurrency guard evaluated while the store is locked. */
  readonly expectedCursor?: number;
  readonly payload: TPayload;
}

export type DurableHarnessEventAppendOutcome<TPayload extends Record<string, unknown> = Record<string, unknown>> =
  | { readonly kind: 'appended'; readonly event: DurableHarnessEvent<TPayload> }
  | { readonly kind: 'duplicate'; readonly event: DurableHarnessEvent<TPayload> }
  | {
      readonly kind: 'conflict';
      readonly key: 'eventId' | 'idempotencyKey';
      readonly existing: DurableHarnessEvent;
    };

export interface DurableHarnessEventStoreLike {
  append<TPayload extends Record<string, unknown>>(
    input: DurableHarnessEventAppendInput<TPayload>,
  ): Promise<DurableHarnessEventAppendOutcome<TPayload>>;
  read(sessionId: string, runId: string): Promise<DurableHarnessEvent[]>;
  readAfter(sessionId: string, runId: string, cursor: number): Promise<DurableHarnessEvent[]>;
}

export interface DurableInboxCommand {
  readonly version: typeof DURABLE_HARNESS_INBOX_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly type: DurableHarnessEventType;
  readonly payload: Record<string, unknown>;
  readonly status: 'queued' | 'claimed' | 'completed' | 'failed';
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly leaseUntil?: string;
  readonly attempts: number;
  readonly resultEventIds?: string[];
  readonly failureReason?: string;
}

export interface DurableInboxEnqueueInput {
  readonly commandId?: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly type: DurableHarnessEventType;
  readonly payload: Record<string, unknown>;
}

export type DurableInboxEnqueueOutcome =
  | { readonly kind: 'enqueued'; readonly command: DurableInboxCommand }
  | { readonly kind: 'duplicate'; readonly command: DurableInboxCommand }
  | { readonly kind: 'conflict'; readonly command: DurableInboxCommand };

export interface DurableInboxStoreLike {
  enqueue(input: DurableInboxEnqueueInput): Promise<DurableInboxEnqueueOutcome>;
  claim(limit?: number): Promise<DurableInboxCommand[]>;
  complete(commandId: string, resultEventIds?: readonly string[]): Promise<DurableInboxCommand>;
  fail(commandId: string, reason: string, retryable?: boolean): Promise<DurableInboxCommand>;
  read(commandId: string): Promise<DurableInboxCommand | null>;
}

export type DurableRunStatus = 'accepted' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'interrupted';
export type DurableFinalReplyState = 'none' | 'proposed' | 'settled' | 'runtime_status';
export type DurableEffectStatus = 'planned' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type DurableModelRequestStatus =
  | 'started'
  | 'received'
  | 'missing'
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'connection_reset'
  | 'failed';

/** Runtime-owned transport state for one Provider attempt. */
export type DurableModelTransportStatus =
  | 'not_started'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'connection_reset'
  | 'failed'
  | 'unknown';

/** Provider usage and local-token reconciliation, with no raw prompt data. */
export interface DurableProviderUsageProjection {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheStatus: 'hit' | 'miss' | 'partial' | 'unavailable' | 'unknown';
  readonly reconciliation: 'exact_match' | 'within_tolerance' | 'mismatch' | 'unavailable';
}

export interface DurableModelRequestProjection {
  readonly requestId: string;
  readonly requestIndex?: number;
  readonly stage?: string;
  readonly purpose?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly stream?: boolean;
  readonly transportStatus?: DurableModelTransportStatus;
  /** Whether the request reached the Provider; unknown is intentionally explicit. */
  readonly providerReachStatus?: 'reached' | 'not_reached' | 'unknown';
  /** Redacted request-bound prefix/suffix and independent cache ledgers. */
  readonly cacheObservation?: CacheObservation;
  readonly providerUsage?: DurableProviderUsageProjection;
  readonly status: DurableModelRequestStatus;
  readonly startedEventId: string;
  readonly settlementEventId?: string;
  readonly providerReached?: boolean;
  readonly retryOf?: string;
  readonly usageStatus?: 'available' | 'unavailable' | 'unknown';
  readonly errorKind?: string;
}

export interface DurableEffectProjection {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly inputHash?: string;
  readonly effectKind: 'local_mutation' | 'external' | 'unknown';
  readonly status: DurableEffectStatus;
  readonly intentEventId: string;
  readonly settlementEventId?: string;
  readonly evidenceRef?: string;
  readonly error?: string;
}

export interface DurableFinalReplyProjection {
  readonly settlementId?: string;
  readonly reply?: string;
  readonly replyFingerprint?: string;
  readonly modelRequestId?: string;
  readonly state: DurableFinalReplyState;
}

/**
 * The only payload a channel, Renderer or CLI may use after a reconnect.
 * A proposed reply is intentionally not replayable; callers must wait for a
 * settled reply or render the Runtime status instead.
 */
export type DurableFinalReplyReplay =
  | {
      readonly kind: 'settled';
      readonly sessionId: string;
      readonly runId: string;
      readonly cursor: number;
      readonly settlementId: string;
      readonly reply: string;
      readonly replyFingerprint: string;
      readonly modelRequestId: string;
    }
  | {
      readonly kind: 'runtime_status';
      readonly sessionId: string;
      readonly runId: string;
      readonly cursor: number;
      readonly settlementId: string;
      readonly status: Extract<DurableRunStatus, 'waiting_user' | 'failed' | 'interrupted'>;
      readonly reason?: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly sessionId: string;
      readonly runId: string;
      readonly cursor: number;
      readonly status: DurableRunStatus;
      readonly reason: 'not_settled' | 'empty_run' | 'terminal_without_settlement';
    };

export type DurableRecoveryReason =
  | 'model_response_missing'
  | 'model_response_not_settled'
  | 'effect_settlement_unknown'
  | 'final_reply_persistence_unconfirmed'
  | 'run_incomplete_after_restart';

export interface DurableRecoveryAction {
  readonly kind: 'model_marked_missing' | 'model_marked_received' | 'effect_marked_unknown'
    | 'final_reply_settled' | 'runtime_status_settled' | 'run_completed';
  readonly eventId: string;
  readonly requestId?: string;
  readonly effectId?: string;
  readonly reason?: DurableRecoveryReason;
}

/** Result of one idempotent, conservative post-crash recovery pass. */
export interface DurableRunRecoveryResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly actions: readonly DurableRecoveryAction[];
  readonly projection: DurableRunProjection;
}

/** Redacted Runtime capability evidence retained by the durable projection. */
export interface DurableCapabilitySnapshotProjection {
  readonly capabilityEpoch: string;
  readonly permissionPolicyId: string;
  readonly workspace: 'available' | 'approval_required' | 'denied' | 'unavailable';
  readonly tools: readonly {
    readonly name: string;
    readonly status: 'available' | 'approval_required';
    readonly source: 'builtin' | 'external';
  }[];
  readonly network: {
    readonly enabled: boolean;
    readonly status: string;
    readonly providerId?: string;
  };
}

export interface DurableCapabilityProbeProjection {
  readonly probeId: string;
  readonly status: 'observed' | 'unavailable';
  readonly capabilityEpoch: string;
  readonly evidence: 'runtime_snapshot';
  readonly permissionDecision: 'allow' | 'approval_required' | 'deny' | 'unavailable';
}

/** Redacted audit record for one next-Harness stage transition. */
export interface DurableStageTransitionProjection {
  readonly stage: string;
  readonly next: string;
  readonly ok: boolean;
  readonly attempt: number;
  readonly transitionEventId: string;
}

export interface DurableRunProjection {
  readonly version: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly cursor: number;
  readonly status: DurableRunStatus;
  readonly route?: 'respond' | 'execute' | 'clarify';
  readonly eventCount: number;
  readonly finalReply: DurableFinalReplyProjection;
  /** Bounded Runtime-owned reason for a runtime_status_settled event. */
  readonly runtimeStatusReason?: string;
  readonly capabilitySnapshot?: DurableCapabilitySnapshotProjection;
  readonly capabilityProbe?: DurableCapabilityProbeProjection;
  readonly stageTransitions: readonly DurableStageTransitionProjection[];
  readonly modelRequests: readonly DurableModelRequestProjection[];
  readonly pendingModelRequestIds: readonly string[];
  readonly effects: readonly DurableEffectProjection[];
  readonly pendingEffectIds: readonly string[];
  readonly unknownEffectIds: readonly string[];
  readonly lastEventType?: DurableHarnessEventType;
}
