// Ordered adapter from legacy Runner boundaries to the next Harness event log.
// It is observational: it never invokes a tool/model and never publishes UI text.
import { createHash } from 'node:crypto';
import type {
  DurableHarnessEventAppendInput,
  DurableHarnessEventStoreLike,
  DurableHarnessEventType,
  DurableHarnessEventSource,
  Message,
} from '@littlesheep/types';
import { DurableHarnessKernel } from '@littlesheep/harness';

export type DurableRunEventInput = Omit<DurableHarnessEventAppendInput, 'sessionId' | 'runId'>;

export interface DurableRunRecorderOptions {
  eventStore: DurableHarnessEventStoreLike;
  sessionId: string;
  runId: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export interface DurableRunAcceptedOptions {
  eventStore: DurableHarnessEventStoreLike;
  sessionId: string;
  runId: string;
  origin: string;
  model: string;
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

  constructor(private readonly options: DurableRunRecorderOptions) {
    this.kernel = new DurableHarnessKernel({ eventStore: options.eventStore });
  }

  get runId(): string {
    return this.options.runId;
  }

  append(event: DurableRunEventInput): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
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

  appendBestEffort(event: DurableRunEventInput): void {
    void this.append(event).catch(() => undefined);
  }

  /** Shadow adapter: enqueue evidence without changing legacy run semantics. */
  appendObserved(event: DurableRunEventInput): Promise<void> {
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
  recorder.appendBestEffort(durableEvent(
    'run_accepted',
    'runtime',
    `${options.runId}:run-accepted`,
    { origin: options.origin, model: options.model.slice(0, 256) },
  ));
  return recorder;
}

/** Queue the redacted user-input receipt without persisting user text. */
export function recordDurableUserInput(
  recorder: DurableRunRecorder,
  origin: string,
  runId: string,
  inbound: Message,
): void {
  recorder.appendBestEffort(durableEvent(
    'user_input_appended',
    origin === 'channel' ? 'channel' : 'app',
    `${runId}:user-input`,
    { messageId: inbound.id, contentLength: inbound.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .reduce((total, block) => total + block.text.length, 0) },
  ));
}

/** Append a terminal receipt after the legacy coordinator has settled. */
export async function recordDurableRunOutcome(
  recorder: DurableRunRecorder | undefined,
  result: { status: import('@littlesheep/types').RunStatus; error?: string },
): Promise<void> {
  if (!recorder) return;
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
  )).catch(() => undefined);
}
