// Ordered adapter from Runner boundaries to the durable event log.
// It never invokes a tool/model or publishes UI text; durable writes gate new runs.
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
  /** Optional persistent inbox used as part of strict-path startup readiness. */
  inboxStore: DurableInboxStoreLike;
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
  inboxStore: DurableInboxStoreLike;
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
  private readonly initialization: Promise<void>;
  /** Resolves after the ingress run_accepted event has been durably appended. */
  ready: Promise<void>;

  constructor(private readonly options: DurableRunRecorderOptions) {
    this.kernel = new DurableHarnessKernel({
      eventStore: options.eventStore,
      inboxStore: options.inboxStore,
      reserveFinalReply: options.reserveFinalReply,
    });
    this.initialization = options.initializationError
      ? Promise.resolve().then(() => { throw options.initializationError; })
      : this.kernel.initialize();
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
      const input = {
        ...event,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
      };
      await this.initialization;
      if (event.type === 'run_accepted' || event.type === 'user_input_appended') {
        const disposition = await this.kernel.appendViaInbox(input);
        if (disposition === 'duplicate') {
          throw new Error(`durable ingress already belongs to another run worker: ${event.type}`);
        }
      } else {
        const outcome = await this.kernel.append(input);
        if (outcome.kind === 'conflict') {
          throw new Error(`durable event conflict for ${event.idempotencyKey}`);
        }
      }
    });
    this.tail = operation.catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.failure ??= normalized;
      this.options.log?.('error', `runner: durable Harness event append failed: ${normalized.message}`);
    });
    return operation;
  }

  /** Queue and await the immutable ingress event after initialization. */
  startIngress(event: DurableRunEventInput): void {
    this.ready = this.append(event);
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

/** Create the durable recorder and queue the immutable ingress events. */
export function createDurableRunRecorder(options: DurableRunAcceptedOptions): DurableRunRecorder {
  const recorder = new DurableRunRecorder(options);
  const ingress = durableEvent(
    'run_accepted',
    'runtime',
    `${options.runId}:run-accepted`,
    { origin: options.origin, model: options.model.slice(0, 256), durableHarnessMode: 'next' },
  );
  // Keep construction synchronous while exposing the durable acceptance
  // promise before user input or model work begins.
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
  return recorder.append(event);
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
  await recorder.append(durableEvent(
    type,
    'runtime',
    `${recorder.runId}:${type}`,
    result.error
      ? { errorHash: durableTextDigest(result.error), errorLength: result.error.length }
      : {},
  ));
}
