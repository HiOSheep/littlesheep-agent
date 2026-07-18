// Bounded, run-scoped runtime event queue.
//
// The queue is deliberately separate from the Memory v3 event ledger. The
// ledger records an explainable projection; this class owns live delivery,
// deduplication, decision-boundary leasing, and recovery snapshots.

import { randomUUID } from 'node:crypto'
import type {
  RuntimeEventAppendInput,
  RuntimeEventAppendOutcome,
  RuntimeEventContextSummary,
  RuntimeEventDecision,
  RuntimeEventDecisionBatch,
  RuntimeEventDecisionStatus,
  RuntimeEventEnvelope,
  RuntimeEventQueueLike,
  RuntimeEventQueueRejectReason,
  RuntimeEventQueueSummary,
  RuntimeEventQueueSnapshot,
  RuntimeEventSource,
  RuntimeEventStatus,
  RuntimeEventType,
  SessionId,
} from '@littlesheep/types'
import { RUNTIME_EVENT_QUEUE_VERSION, RUNTIME_EVENT_VERSION } from '@littlesheep/types'

export type {
  RuntimeEventAppendInput,
  RuntimeEventAppendOutcome,
  RuntimeEventContextSummary,
  RuntimeEventDecision,
  RuntimeEventDecisionBatch,
  RuntimeEventDecisionStatus,
  RuntimeEventQueueRejectReason,
  RuntimeEventQueueSummary,
} from '@littlesheep/types'

export const DEFAULT_RUNTIME_EVENT_QUEUE_MAX_EVENTS = 128 as const
export const MAX_RUNTIME_EVENT_QUEUE_MAX_EVENTS = 512 as const
export const DEFAULT_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES = 32768 as const
export const MAX_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES = 262144 as const
export const DEFAULT_RUNTIME_EVENT_MAX_AGE_MS = 86400000 as const
export const MAX_RUNTIME_EVENT_MAX_AGE_MS = 604800000 as const
export const DEFAULT_RUNTIME_EVENT_BATCH_SIZE = 32 as const
export const MAX_RUNTIME_EVENT_BATCH_SIZE = 64 as const
export const DEFAULT_RUNTIME_EVENT_BATCH_LEASE_MS = 300000 as const
export const MAX_RUNTIME_EVENT_BATCH_LEASE_MS = 1800000 as const

const MAX_EVENT_ID_LENGTH = 256
const MAX_DEDUP_KEY_LENGTH = 512
const MAX_DECISION_REASON_LENGTH = 1_024
const MAX_PAYLOAD_DEPTH = 8
const MAX_PAYLOAD_NODES = 2_048
const MAX_PAYLOAD_KEYS_PER_OBJECT = 256
const MAX_PAYLOAD_STRING_LENGTH = 16 * 1024
const TERMINAL_STATUSES: ReadonlySet<RuntimeEventStatus> = new Set([
  'applied',
  'ignored',
  'conflict',
  'expired',
])
const EVENT_TYPES: ReadonlySet<RuntimeEventType> = new Set([
  'user_message',
  'pause_requested',
  'resume_requested',
  'interrupt_requested',
  'setting_changed',
  'workspace_file_saved',
])
const EVENT_SOURCES: ReadonlySet<RuntimeEventSource> = new Set([
  'app',
  'channel',
  'workspace',
  'system',
])

export interface RuntimeEventQueueOptions {
  runId: string
  sessionId: SessionId
  maxEvents?: number
  maxPayloadBytes?: number
  maxEventAgeMs?: number | null
  batchSize?: number
  batchLeaseMs?: number
  now?: () => Date
  idFactory?: () => string
}

export type RuntimeEventQueueRestoreOptions =
  Omit<RuntimeEventQueueOptions, 'runId' | 'sessionId'> & {
    runId?: string
    sessionId?: SessionId
  }

export class RuntimeEventQueueBusyError extends Error {
  readonly code = 'runtime-event-queue-busy' as const

  constructor() {
    super('Runtime event queue already has an open decision batch.')
    this.name = 'RuntimeEventQueueBusyError'
  }
}

export class RuntimeEventQueueSnapshotError extends Error {
  readonly code = 'runtime-event-queue-snapshot-invalid' as const
}

interface ActiveDecisionBatch {
  token: string
  eventIds: string[]
  openedAtMs: number
}

/**
 * One active run owns one queue. All state is bounded by constructor limits.
 * Methods are synchronous on purpose: the queue only manages memory and does
 * not perform I/O, so a caller can make enqueue/settle atomic at a runtime
 * decision boundary without holding an async lock.
 */
export class RuntimeEventQueue implements RuntimeEventQueueLike {
  readonly runId: string
  readonly sessionId: SessionId

  private readonly maxEvents: number
  private readonly maxPayloadBytes: number
  private readonly maxEventAgeMs: number | null
  private readonly batchSize: number
  private readonly batchLeaseMs: number
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly events = new Map<string, RuntimeEventEnvelope>()
  private readonly sequenceOrder: string[] = []
  private readonly dedupIndex = new Map<string, string>()
  private activeBatch: ActiveDecisionBatch | undefined
  private cursor = 0
  private nextSequence = 1
  private overflowCount = 0
  private disposed = false

  constructor(options: RuntimeEventQueueOptions) {
    this.runId = requireNonEmpty(options.runId, 'runId')
    if (!String(options.sessionId).trim()) throw new Error('sessionId must be a non-empty string.')
    this.sessionId = options.sessionId
    this.maxEvents = boundedInteger(
      options.maxEvents,
      DEFAULT_RUNTIME_EVENT_QUEUE_MAX_EVENTS,
      1,
      MAX_RUNTIME_EVENT_QUEUE_MAX_EVENTS,
    )
    this.maxPayloadBytes = boundedInteger(
      options.maxPayloadBytes,
      DEFAULT_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES,
      256,
      MAX_RUNTIME_EVENT_QUEUE_MAX_PAYLOAD_BYTES,
    )
    this.maxEventAgeMs = options.maxEventAgeMs === null
      ? null
      : boundedInteger(
          options.maxEventAgeMs,
          DEFAULT_RUNTIME_EVENT_MAX_AGE_MS,
          1_000,
          MAX_RUNTIME_EVENT_MAX_AGE_MS,
        )
    this.batchSize = boundedInteger(
      options.batchSize,
      DEFAULT_RUNTIME_EVENT_BATCH_SIZE,
      1,
      MAX_RUNTIME_EVENT_BATCH_SIZE,
    )
    this.batchLeaseMs = boundedInteger(
      options.batchLeaseMs,
      DEFAULT_RUNTIME_EVENT_BATCH_LEASE_MS,
      1_000,
      MAX_RUNTIME_EVENT_BATCH_LEASE_MS,
    )
    this.now = options.now ?? (() => new Date())
    this.idFactory = options.idFactory ?? randomUUID
  }

  append(input: RuntimeEventAppendInput): RuntimeEventAppendOutcome {
    if (this.disposed) return rejected('disposed', 'Runtime event queue has been disposed.')
    if (input.runId !== undefined && input.runId !== this.runId) {
      return rejected('run-mismatch', `Runtime event belongs to run "${input.runId}".`)
    }
    if (input.sessionId !== undefined && String(input.sessionId) !== String(this.sessionId)) {
      return rejected('session-mismatch', 'Runtime event belongs to another session.')
    }
    if (!EVENT_TYPES.has(input.type)) return rejected('invalid-type', `Unsupported runtime event type: ${String(input.type)}.`)
    if (!EVENT_SOURCES.has(input.source)) return rejected('invalid-source', `Unsupported runtime event source: ${String(input.source)}.`)

    const id = normalizeBoundedText(input.id ?? this.idFactory(), MAX_EVENT_ID_LENGTH)
    if (!id) return rejected('invalid-id', 'Runtime event id must be a non-empty bounded string.')
    const dedupKey = input.dedupKey === undefined
      ? undefined
      : normalizeBoundedText(input.dedupKey, MAX_DEDUP_KEY_LENGTH)
    if (input.dedupKey !== undefined && !dedupKey) {
      return rejected('invalid-dedup-key', 'Runtime event dedupKey must be a non-empty bounded string.')
    }

    const now = this.now()
    const receivedAt = normalizeTime(input.receivedAt ?? now.toISOString())
    if (!receivedAt) return rejected('invalid-time', 'Runtime event receivedAt must be a valid timestamp.')
    const expiresAt = input.expiresAt === undefined
      ? this.defaultExpiry(receivedAt)
      : normalizeTime(input.expiresAt)
    if (input.expiresAt !== undefined && !expiresAt) {
      return rejected('invalid-time', 'Runtime event expiresAt must be a valid timestamp.')
    }

    let payload: Record<string, unknown>
    try {
      payload = cloneBoundedPayload(input.payload, this.maxPayloadBytes)
    } catch (error) {
      const reason = error instanceof PayloadTooLargeError ? 'payload-too-large' : 'invalid-payload'
      return rejected(reason, error instanceof Error ? error.message : 'Runtime event payload is invalid.')
    }

    const fingerprint = eventFingerprint(input.type, input.source, dedupKey, payload)
    const priorById = this.events.get(id)
    if (priorById) return this.resolveDuplicate(priorById, fingerprint, 'id')
    if (dedupKey) {
      const priorId = this.dedupIndex.get(dedupKey)
      const prior = priorId ? this.events.get(priorId) : undefined
      if (prior) return this.resolveDuplicate(prior, fingerprint, 'dedupKey')
    }

    this.expireDue(now)
    if (!this.makeRoom()) {
      this.overflowCount = Math.min(Number.MAX_SAFE_INTEGER, this.overflowCount + 1)
      return rejected('capacity', `Runtime event queue reached its ${this.maxEvents} event limit.`)
    }
    if (this.nextSequence >= Number.MAX_SAFE_INTEGER) {
      return rejected('sequence-exhausted', 'Runtime event sequence limit was reached.')
    }

    const expired = isExpired(expiresAt, now)
    const event: RuntimeEventEnvelope = {
      version: RUNTIME_EVENT_VERSION,
      id,
      runId: this.runId,
      sessionId: this.sessionId,
      sequence: this.nextSequence++,
      type: input.type,
      source: input.source,
      status: expired ? 'expired' : 'queued',
      receivedAt,
      payload,
      dedupKey,
      expiresAt,
      ...(expired ? {
        appliedAt: now.toISOString(),
        decisionReason: 'expired-before-enqueue',
      } : {}),
    }
    this.events.set(event.id, event)
    this.sequenceOrder.push(event.id)
    if (dedupKey) this.dedupIndex.set(dedupKey, event.id)
    this.advanceCursor()
    this.pruneTerminal()
    return expired
      ? { kind: 'expired', event: cloneEvent(event) }
      : { kind: 'accepted', event: cloneEvent(event) }
  }

  /** Return queued events without claiming them for a decision. */
  pending(limit = this.batchSize): RuntimeEventEnvelope[] {
    this.ensureUsable()
    this.releaseExpiredBatch()
    this.expireDue(this.now())
    const boundedLimit = boundedInteger(limit, this.batchSize, 1, this.batchSize)
    const claimed = new Set(this.activeBatch?.eventIds ?? [])
    return this.sequenceOrder
      .map((id) => this.events.get(id))
      .filter((event): event is RuntimeEventEnvelope => Boolean(event))
      .filter((event) => event.status === 'queued' && !claimed.has(event.id))
      .slice(0, boundedLimit)
      .map(cloneEvent)
  }

  /**
   * Claim one bounded batch for a safe decision boundary. A second consumer
   * cannot observe or claim the same events until the first batch is settled
   * or released.
   */
  openDecisionBatch(limit = this.batchSize): RuntimeEventDecisionBatch | undefined {
    return this.claimDecisionBatch(limit)
  }

  /** Claim only selected event types without consuming unrelated queued work. */
  openDecisionBatchForTypes(
    types: readonly RuntimeEventType[],
    limit = this.batchSize,
  ): RuntimeEventDecisionBatch | undefined {
    const allowed = new Set(types.filter((type) => EVENT_TYPES.has(type)))
    if (allowed.size === 0) return undefined
    return this.claimDecisionBatch(limit, (event) => allowed.has(event.type))
  }

  private claimDecisionBatch(
    limit: number,
    predicate?: (event: RuntimeEventEnvelope) => boolean,
  ): RuntimeEventDecisionBatch | undefined {
    this.ensureUsable()
    this.releaseExpiredBatch()
    this.expireDue(this.now())
    if (this.activeBatch) throw new RuntimeEventQueueBusyError()
    const boundedLimit = boundedInteger(limit, this.batchSize, 1, this.batchSize)
    const events = this.sequenceOrder
      .map((id) => this.events.get(id))
      .filter((event): event is RuntimeEventEnvelope => Boolean(event))
      .filter((event) => event.status === 'queued')
      .filter((event) => predicate?.(event) ?? true)
      .slice(0, boundedLimit)
    if (events.length === 0) return undefined
    const openedAt = this.now()
    const token = this.idFactory()
    this.activeBatch = {
      token,
      eventIds: events.map((event) => event.id),
      openedAtMs: openedAt.getTime(),
    }
    return {
      token,
      openedAt: openedAt.toISOString(),
      cursor: this.cursor,
      events: events.map(cloneEvent),
    }
  }

  /** Atomically settle every event in a claimed decision batch. */
  settleDecisionBatch(token: string, decisions: readonly RuntimeEventDecision[]): RuntimeEventEnvelope[] {
    this.ensureUsable()
    this.releaseExpiredBatch()
    const batch = this.activeBatch
    if (!batch || batch.token !== token) throw new Error('Runtime event decision batch is missing or no longer active.')
    const expected = new Set(batch.eventIds)
    if (decisions.length !== batch.eventIds.length || new Set(decisions.map((decision) => decision.eventId)).size !== decisions.length) {
      throw new Error('Runtime event decision must settle every claimed event exactly once.')
    }
    for (const decision of decisions) {
      if (!expected.has(decision.eventId)) throw new Error(`Event "${decision.eventId}" is not part of the decision batch.`)
      if (!TERMINAL_STATUSES.has(decision.status)) throw new Error(`Invalid terminal event status: ${decision.status}.`)
    }

    const now = this.now()
    const next = new Map<string, RuntimeEventEnvelope>()
    for (const eventId of batch.eventIds) {
      const current = this.events.get(eventId)
      if (!current) throw new Error(`Runtime event disappeared before settlement: ${eventId}.`)
      const decision = decisions.find((candidate) => candidate.eventId === eventId)!
      const expired = isExpired(current.expiresAt, now)
      const status: RuntimeEventDecisionStatus = expired ? 'expired' : decision.status
      next.set(eventId, {
        ...current,
        status,
        appliedAt: now.toISOString(),
        decisionReason: boundedReason(
          expired && decision.status !== 'expired'
            ? 'expired-before-decision'
            : decision.reason,
        ),
      })
    }
    for (const [eventId, event] of next) this.events.set(eventId, event)
    this.activeBatch = undefined
    this.advanceCursor()
    this.pruneTerminal()
    return batch.eventIds
      .map((eventId) => this.events.get(eventId))
      .filter((event): event is RuntimeEventEnvelope => Boolean(event))
      .map(cloneEvent)
  }

  /** Return claimed events to queued state after a failed decision attempt. */
  releaseDecisionBatch(token: string): boolean {
    this.ensureUsable()
    this.releaseExpiredBatch()
    if (!this.activeBatch || this.activeBatch.token !== token) return false
    this.activeBatch = undefined
    return true
  }

  snapshot(): RuntimeEventQueueSnapshot {
    this.ensureUsable()
    this.releaseExpiredBatch()
    this.expireDue(this.now())
    return {
      version: RUNTIME_EVENT_QUEUE_VERSION,
      runId: this.runId,
      sessionId: this.sessionId,
      cursor: this.cursor,
      nextSequence: this.nextSequence,
      overflowCount: this.overflowCount,
      events: this.sequenceOrder
        .map((id) => this.events.get(id))
        .filter((event): event is RuntimeEventEnvelope => Boolean(event))
        .map(cloneEvent),
    }
  }

  /** Restore a queue without restoring an in-flight decision lease. */
  static fromSnapshot(snapshot: RuntimeEventQueueSnapshot, options: RuntimeEventQueueRestoreOptions = {}): RuntimeEventQueue {
    if (snapshot.version !== RUNTIME_EVENT_QUEUE_VERSION) throw new RuntimeEventQueueSnapshotError(`Unsupported runtime event queue version: ${String(snapshot.version)}.`)
    const runId = options.runId ?? snapshot.runId
    const sessionId = options.sessionId ?? snapshot.sessionId
    const rebound = runId === snapshot.runId && String(sessionId) === String(snapshot.sessionId)
      ? snapshot
      : rebindSnapshot(snapshot, runId, sessionId)
    const queue = new RuntimeEventQueue({
      ...options,
      runId,
      sessionId,
    })
    queue.restore(rebound)
    return queue
  }

  summary(): RuntimeEventQueueSummary {
    this.ensureUsable()
    this.releaseExpiredBatch()
    this.expireDue(this.now())
    const counts = { queued: 0, applied: 0, ignored: 0, conflict: 0, expired: 0 }
    for (const event of this.events.values()) counts[event.status] += 1
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      cursor: this.cursor,
      nextSequence: this.nextSequence,
      ...counts,
      pendingEventIds: this.sequenceOrder
        .map((id) => this.events.get(id))
        .filter((event): event is RuntimeEventEnvelope => event?.status === 'queued')
        .map((event) => event.id),
      overflowCount: this.overflowCount,
      activeDecisionBatch: Boolean(this.activeBatch),
    }
  }

  /** Redacted summaries are safe for diagnostics and default Context disclosure. */
  contextSummary(limit = this.batchSize): RuntimeEventContextSummary[] {
    this.ensureUsable()
    this.releaseExpiredBatch()
    this.expireDue(this.now())
    const boundedLimit = boundedInteger(limit, this.batchSize, 1, this.batchSize)
    return this.sequenceOrder
      .map((id) => this.events.get(id))
      .filter((event): event is RuntimeEventEnvelope => Boolean(event))
      .filter((event) => event.status === 'queued')
      .slice(0, boundedLimit)
      .map((event) => ({
        id: event.id,
        sequence: event.sequence,
        type: event.type,
        source: event.source,
        status: event.status,
        receivedAt: event.receivedAt,
        ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
        payloadKeys: Object.keys(event.payload).slice(0, MAX_PAYLOAD_KEYS_PER_OBJECT),
        decisionReasonRecorded: Boolean(event.decisionReason),
      }))
  }

  /** Drop all in-memory references when the owning run is definitely over. */
  dispose(): void {
    this.disposed = true
    this.activeBatch = undefined
    this.events.clear()
    this.sequenceOrder.length = 0
    this.dedupIndex.clear()
  }

  private restore(snapshot: RuntimeEventQueueSnapshot): void {
    if (snapshot.runId !== this.runId) throw new RuntimeEventQueueSnapshotError('Runtime event queue run id mismatch.')
    if (String(snapshot.sessionId) !== String(this.sessionId)) throw new RuntimeEventQueueSnapshotError('Runtime event queue session id mismatch.')
    if (!Array.isArray(snapshot.events) || snapshot.events.length > this.maxEvents) {
      throw new RuntimeEventQueueSnapshotError(`Runtime event queue snapshot exceeds the ${this.maxEvents} event limit.`)
    }
    this.events.clear()
    this.sequenceOrder.length = 0
    this.dedupIndex.clear()
    let highestSequence = 0
    for (const raw of snapshot.events) {
      if (raw.runId !== this.runId || String(raw.sessionId) !== String(this.sessionId)) {
        throw new RuntimeEventQueueSnapshotError('Runtime event queue snapshot contains an event from another run or session.')
      }
      if (raw.version !== RUNTIME_EVENT_VERSION
        || !normalizeBoundedText(raw.id, MAX_EVENT_ID_LENGTH)
        || !EVENT_TYPES.has(raw.type)
        || !EVENT_SOURCES.has(raw.source)
        || !normalizeTime(raw.receivedAt)
        || (raw.expiresAt !== undefined && !normalizeTime(raw.expiresAt))
        || (raw.dedupKey !== undefined && !normalizeBoundedText(raw.dedupKey, MAX_DEDUP_KEY_LENGTH))
        || !Number.isSafeInteger(raw.sequence)
        || raw.sequence <= 0
        || this.events.has(raw.id)
        || this.sequenceOrder.some((id) => this.events.get(id)?.sequence === raw.sequence)) {
        throw new RuntimeEventQueueSnapshotError('Runtime event queue snapshot contains duplicate or invalid event sequence data.')
      }
      if (raw.status !== 'queued' && !TERMINAL_STATUSES.has(raw.status)) {
        throw new RuntimeEventQueueSnapshotError(`Runtime event queue snapshot contains invalid status: ${String(raw.status)}.`)
      }
      let payload: Record<string, unknown>
      try {
        payload = cloneBoundedPayload(raw.payload, this.maxPayloadBytes)
      } catch (error) {
        throw new RuntimeEventQueueSnapshotError(error instanceof Error ? error.message : 'Runtime event queue snapshot payload is invalid.')
      }
      const event = cloneEvent({ ...raw, payload })
      this.events.set(event.id, event)
      this.sequenceOrder.push(event.id)
      if (event.dedupKey) {
        if (this.dedupIndex.has(event.dedupKey)) throw new RuntimeEventQueueSnapshotError('Runtime event queue snapshot contains duplicate dedup keys.')
        this.dedupIndex.set(event.dedupKey, event.id)
      }
      highestSequence = Math.max(highestSequence, event.sequence)
    }
    this.sequenceOrder.sort((left, right) => this.events.get(left)!.sequence - this.events.get(right)!.sequence)
    this.nextSequence = Number.isSafeInteger(snapshot.nextSequence) && snapshot.nextSequence > highestSequence
      ? snapshot.nextSequence
      : highestSequence + 1
    const maxCursor = Math.max(0, this.nextSequence - 1)
    this.cursor = Number.isSafeInteger(snapshot.cursor) ? Math.max(0, Math.min(snapshot.cursor, maxCursor)) : 0
    this.overflowCount = Number.isSafeInteger(snapshot.overflowCount) ? Math.max(0, snapshot.overflowCount) : 0
    this.advanceCursor()
    this.pruneTerminal()
  }

  private resolveDuplicate(
    prior: RuntimeEventEnvelope,
    fingerprint: string,
    keyKind: 'id' | 'dedupKey',
  ): RuntimeEventAppendOutcome {
    if (eventFingerprint(prior.type, prior.source, prior.dedupKey, prior.payload) === fingerprint) {
      return { kind: 'duplicate', event: cloneEvent(prior) }
    }
    return rejected('conflict', `Runtime event ${keyKind} conflicts with an existing event.`, prior.id)
  }

  private defaultExpiry(receivedAt: string): string | undefined {
    if (this.maxEventAgeMs === null) return undefined
    const timestamp = Date.parse(receivedAt)
    return Number.isFinite(timestamp) ? new Date(timestamp + this.maxEventAgeMs).toISOString() : undefined
  }

  private expireDue(now: Date): void {
    for (const event of this.events.values()) {
      if (event.status !== 'queued' || !isExpired(event.expiresAt, now)) continue
      event.status = 'expired'
      event.appliedAt = now.toISOString()
      event.decisionReason = 'expired-before-decision'
    }
    this.advanceCursor()
    this.pruneTerminal()
  }

  private makeRoom(): boolean {
    if (this.events.size < this.maxEvents) return true
    this.advanceCursor()
    this.pruneTerminal()
    return this.events.size < this.maxEvents
  }

  private pruneTerminal(): void {
    if (this.events.size < this.maxEvents) return
    const claimed = new Set(this.activeBatch?.eventIds ?? [])
    for (const eventId of [...this.sequenceOrder]) {
      if (this.events.size < this.maxEvents) break
      const event = this.events.get(eventId)
      if (!event || !TERMINAL_STATUSES.has(event.status) || claimed.has(event.id) || event.sequence > this.cursor) continue
      this.events.delete(event.id)
      if (event.dedupKey && this.dedupIndex.get(event.dedupKey) === event.id) this.dedupIndex.delete(event.dedupKey)
      const index = this.sequenceOrder.indexOf(event.id)
      if (index >= 0) this.sequenceOrder.splice(index, 1)
    }
  }

  private advanceCursor(): void {
    while (true) {
      const next = this.sequenceOrder
        .map((id) => this.events.get(id))
        .find((event) => event !== undefined && event.sequence > this.cursor)
      if (!next || !TERMINAL_STATUSES.has(next.status) || next.sequence !== this.cursor + 1) return
      this.cursor = next.sequence
    }
  }

  private releaseExpiredBatch(): void {
    if (!this.activeBatch) return
    if (this.now().getTime() - this.activeBatch.openedAtMs <= this.batchLeaseMs) return
    this.activeBatch = undefined
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error('Runtime event queue has been disposed.')
  }
}

class PayloadTooLargeError extends Error {}

function rejected(
  reason: RuntimeEventQueueRejectReason,
  message: string,
  existingEventId?: string,
): RuntimeEventAppendOutcome {
  return { kind: 'rejected', reason, message, ...(existingEventId ? { existingEventId } : {}) }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value!))
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must be a non-empty string.`)
  return normalized
}

function normalizeBoundedText(value: string, maximum: number): string {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maximum ? normalized : ''
}

function normalizeTime(value: string): string | undefined {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= now.getTime())
}

function boundedReason(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, MAX_DECISION_REASON_LENGTH) : undefined
}

function cloneEvent(event: RuntimeEventEnvelope): RuntimeEventEnvelope {
  return {
    ...event,
    sessionId: event.sessionId,
    payload: clonePlainValue(event.payload) as Record<string, unknown>,
  }
}

function cloneBoundedPayload(value: unknown, maxBytes: number): Record<string, unknown> {
  const nodes = { count: 0 }
  const cloned = clonePlainValue(value, 0, nodes)
  if (!isRecord(cloned)) throw new Error('Runtime event payload must be a plain object.')
  const bytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8')
  if (bytes > maxBytes) throw new PayloadTooLargeError(`Runtime event payload exceeds ${maxBytes} bytes.`)
  return cloned
}

function clonePlainValue(value: unknown, depth = 0, nodes = { count: 0 }): unknown {
  nodes.count += 1
  if (nodes.count > MAX_PAYLOAD_NODES) throw new Error(`Runtime event payload exceeds ${MAX_PAYLOAD_NODES} values.`)
  if (depth > MAX_PAYLOAD_DEPTH) throw new Error(`Runtime event payload exceeds depth ${MAX_PAYLOAD_DEPTH}.`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > MAX_PAYLOAD_STRING_LENGTH) throw new Error(`Runtime event payload string exceeds ${MAX_PAYLOAD_STRING_LENGTH} characters.`)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Runtime event payload numbers must be finite.')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => clonePlainValue(item, depth + 1, nodes))
  if (!isRecord(value)) throw new Error('Runtime event payload contains an unsupported value.')
  const keys = Object.keys(value).sort()
  if (keys.length > MAX_PAYLOAD_KEYS_PER_OBJECT) throw new Error(`Runtime event payload object exceeds ${MAX_PAYLOAD_KEYS_PER_OBJECT} keys.`)
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    if (key.length > MAX_EVENT_ID_LENGTH) throw new Error('Runtime event payload key is too long.')
    output[key] = clonePlainValue(value[key], depth + 1, nodes)
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function eventFingerprint(
  type: RuntimeEventType,
  source: RuntimeEventSource,
  dedupKey: string | undefined,
  payload: Record<string, unknown>,
): string {
  return `${type}\u0000${source}\u0000${dedupKey ?? ''}\u0000${JSON.stringify(payload)}`
}

function rebindSnapshot(
  snapshot: RuntimeEventQueueSnapshot,
  runId: string,
  sessionId: SessionId,
): RuntimeEventQueueSnapshot {
  return {
    ...snapshot,
    runId,
    sessionId,
    events: snapshot.events.map((event) => ({
      ...event,
      runId,
      sessionId,
      payload: rebindTaskPatchPayload(event.payload, runId),
    })),
  }
}

function rebindTaskPatchPayload(payload: Record<string, unknown>, runId: string): Record<string, unknown> {
  const next = clonePlainValue(payload) as Record<string, unknown>
  for (const key of ['taskBookPatch', 'patch'] as const) {
    const patch = next[key]
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue
    const record = patch as Record<string, unknown>
    if (typeof record.runId === 'string') record.runId = runId
  }
  return next
}
