// Ordered adapter from legacy Runner boundaries to the next Harness event log.
// It is observational: it never invokes a tool/model and never publishes UI text.
import { createHash } from 'node:crypto';
import type {
  DurableHarnessEventAppendInput,
  DurableHarnessEventStoreLike,
  DurableHarnessEventType,
  DurableHarnessEventSource,
  DurableInboxStoreLike,
  Message,
  FinalReplyReservation,
} from '@littlesheep/types';
import { DurableHarnessKernel } from '@littlesheep/harness';

export type DurableRunEventInput = Omit<DurableHarnessEventAppendInput, 'sessionId' | 'runId'>;

export interface DurableRunRecorderOptions {
  eventStore: DurableHarnessEventStoreLike;
  sessionId: string;
  runId: string;
  /** `shadow` never changes legacy outcomes; `next` fails closed on durable errors. */
  mode?: 'shadow' | 'next';
  /** Optional persistent inbox used as part of strict-path startup readiness. */
  inboxStore?: DurableInboxStoreLike;
  /** Session-level reservation owner used by the authoritative settlement. */
  reserveFinalReply?: (sessionId: string, reservation: FinalReplyReservation) => Promise<boolean>;
  /** Preserved startup failure from infrastructure initialization. */
  initializationError?: Error;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export interface DurableRunAcceptedOptions {
  eventStore: DurableHarnessEventStoreLike;
  sessionId: string;
  runId: string;
  origin: string;
  model: string;
  mode?: 'shadow' | 'next';
  inboxStore?: DurableInboxStoreLike;
  reserveFinalReply?: DurableRunRecorderOptions['reserveFinalReply'];
  initializationError?: Error;
  log?: DurableRunRecorderOptions['log'];
}

/**
 * One serialized append chain per run. The callback can be passed through
 * RunContext without making existing stage APIs depend on filesystem I/O.
 */
export class DurableRunRecorder {
  readonly kernel: DurableHarnessKernel;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  readonly mode: 'shadow' | 'next';
  private readonly initialization: Promise<void>;
  /** Resolves after the ingress run_accepted event has been attempted. */
  ready: Promise<void>;

  constructor(private readonly options: DurableRunRecorderOptions) {
    this.mode = options.mode ?? 'shadow';
    this.kernel = new DurableHarnessKernel({
      eventStore: options.eventStore,
      inboxStore: options.inboxStore,
      reserveFinalReply: options.reserveFinalReply,
    });
    this.initialization = this.mode === 'next'
      ? options.initializationError
        ? Promise.resolve().then(() => { throw options.initializationError; })
        : this.kernel.initialize()
      : Promise.resolve();
    this.initialization.catch((error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      this.options.log?.('error', `runner: durable Harness initialization failed: ${this.failure.message}`);
    });
    this.ready = this.initialization;
  }

  get runId(): string {
    return this.options.runId;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  append(event: DurableRunEventInput): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      if (this.mode === 'next') await this.initialization;
      const outcome = await this.kernel.append({
        ...event,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
      });
      if (outcome.kind === 'conflict') {
        throw new Error(`durable event conflict for ${event.idempotencyKey}`);
      }
    });
    this.tail = operation.catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.failure ??= normalized;
      this.options.log?.('error', `runner: durable Harness event append failed: ${normalized.message}`);
    });
    return operation;
  }

  /** Queue the immutable ingress event after strict-path initialization. */
  startIngress(event: DurableRunEventInput): void {
    const accepted = this.append(event);
    this.ready = this.mode === 'next' ? accepted : accepted.catch(() => undefined);
  }

  appendBestEffort(event: DurableRunEventInput): void {
    void this.append(event).catch(() => undefined);
  }

  /** Shadow adapter: enqueue evidence without changing legacy run semantics. */
  appendObserved(event: DurableRunEventInput): Promise<void> {
    if (this.mode === 'next') return this.append(event);
    this.appendBestEffort(event);
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  async flushBestEffort(): Promise<void> {
    await this.tail;
  }

  get error(): Error | undefined {
    return this.failure;
  }
}

export function durableEvent(
  type: DurableHarnessEventType,
  source: DurableHarnessEventSource,
  eventId: string,
  payload: Record<string, unknown>,
): DurableRunEventInput {
  return {
    type,
    source,
    eventId,
    idempotencyKey: eventId,
    payload,
  };
}

/** Hash free-form runtime text before it crosses the durable projection. */
export function durableTextDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Create the observational recorder and queue the immutable ingress events. */
export function createDurableRunRecorder(options: DurableRunAcceptedOptions): DurableRunRecorder {
  const recorder = new DurableRunRecorder(options);
  const ingress = durableEvent(
    'run_accepted',
    'runtime',
    `${options.runId}:run-accepted`,
    { origin: options.origin, model: options.model.slice(0, 256) },
  );
  // Keep construction synchronous for the legacy Runner, but expose the
  // ingress promise so next-mode callers can await the durable acceptance
  // boundary before writing user input or invoking a model.
  recorder.startIngress(ingress);
  return recorder;
}

/** Queue the redacted user-input receipt without persisting user text. */
export function recordDurableUserInput(
  recorder: DurableRunRecorder,
  origin: string,
  runId: string,
  inbound: Message,
): Promise<void> {
  const event = durableEvent(
    'user_input_appended',
    origin === 'channel' ? 'channel' : 'app',
    `${runId}:user-input`,
    { messageId: inbound.id, contentLength: inbound.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .reduce((total, block) => total + block.text.length, 0) },
  );
  return recorder.mode === 'next' ? recorder.append(event) : (recorder.appendBestEffort(event), Promise.resolve());
}

/** Append a terminal receipt after the legacy coordinator has settled. */
export async function recordDurableRunOutcome(
  recorder: DurableRunRecorder | undefined,
  result: { status: import('@littlesheep/types').RunStatus; error?: string },
): Promise<void> {
  if (!recorder) return;
  // runtime_status_settled is already a terminal durable outcome. Appending
  // run_failed/run_interrupted afterwards would violate the kernel transition
  // contract and obscure the Runtime-owned failure reason.
  try {
    const projection = await recorder.kernel.replay(recorder.sessionId, recorder.runId);
    if (projection.finalReply.state === 'runtime_status'
      || (projection.finalReply.state === 'settled' && result.status !== 'ok')) return;
  } catch {
    // Preserve the existing append path when the projection cannot be read;
    // the append itself remains the durable source of truth.
  }
  const type = result.status === 'ok'
    ? 'run_completed'
    : result.status === 'aborted' || result.status === 'timeout'
      ? 'run_interrupted'
      : 'run_failed';
  const append = recorder.append(durableEvent(
    type,
    'runtime',
    `${recorder.runId}:${type}`,
    result.error
      ? { errorHash: durableTextDigest(result.error), errorLength: result.error.length }
      : {},
  ));
  if (recorder.mode === 'next') {
    await append;
  } else {
    await append.catch(() => undefined);
  }
}
