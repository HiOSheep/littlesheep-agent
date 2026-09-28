// Codec for the derived daily usage index (O5).
//
// The index is a derived cache, so an unreadable file is discarded and rebuilt
// instead of being repaired: the decoder therefore answers "is this file
// entirely usable?" with a value or `undefined`, never with a partial result.
import type {
  ProviderUsageDailyCountedAttempt,
  ProviderUsageDailyMissingFact,
} from './provider-usage-daily-series.js';
import {
  PROVIDER_USAGE_DAILY_INDEX_VERSION,
  type ProviderUsageDailyBackfillRecord,
  type ProviderUsageDailyClearRecord,
  type ProviderUsageDailyRunRecord,
} from './provider-usage-daily-index-records.js';

/** Compact on-disk attempt tuple; the index is derived, so it stays small. */
type StoredAttempt = [string, number, number, number, number, number, string, string, string];
/** `[at, kind, provider, model, requestId]`, kind 0 = response without usage. */
type StoredMissing = [string, number, string, string, string];

interface StoredRun {
  sessionId: string;
  runId: string;
  mode: 'next' | 'shadow' | 'unknown';
  revision: string;
  indexedAt: string;
  attempts: StoredAttempt[];
  missing: StoredMissing[];
  unreadable?: boolean;
  reason?: string;
}

export interface StoredIndexFile {
  version: number;
  updatedAt: string;
  scannedAt?: string;
  lastError?: string;
  backfill: ProviderUsageDailyBackfillRecord;
  runs: Record<string, StoredRun>;
}

export interface DecodedIndexFile {
  readonly runs: Map<string, ProviderUsageDailyRunRecord>;
  readonly updatedAt: string | undefined;
  readonly scannedAt: string | undefined;
  readonly lastError: string | undefined;
  readonly backfill: ProviderUsageDailyBackfillRecord;
}

export function encodeIndexFile(input: {
  runs: readonly ProviderUsageDailyRunRecord[];
  scannedAt: string | undefined;
  lastError: string | undefined;
  backfill: ProviderUsageDailyBackfillRecord;
}): StoredIndexFile {
  const runs: Record<string, StoredRun> = {};
  for (const record of input.runs) runs[record.partitionKey] = encodeRun(record);
  return {
    version: PROVIDER_USAGE_DAILY_INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    ...(input.scannedAt === undefined ? {} : { scannedAt: input.scannedAt }),
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    backfill: input.backfill,
    runs,
  };
}

export function decodeIndexFile(raw: string): DecodedIndexFile | undefined {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<StoredIndexFile>;
  if (record.version !== PROVIDER_USAGE_DAILY_INDEX_VERSION) return undefined;
  if (!record.runs || typeof record.runs !== 'object' || Array.isArray(record.runs)) return undefined;
  const runs = new Map<string, ProviderUsageDailyRunRecord>();
  for (const [partitionKey, value] of Object.entries(record.runs)) {
    const decoded = decodeRun(partitionKey, value);
    if (!decoded) return undefined;
    runs.set(partitionKey, decoded);
  }
  return {
    runs,
    updatedAt: asTimestamp(record.updatedAt),
    scannedAt: asTimestamp(record.scannedAt),
    lastError: asBoundedText(record.lastError, 512),
    backfill: decodeBackfill(record.backfill),
  };
}

export function decodeClearRecord(raw: string): ProviderUsageDailyClearRecord | undefined {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<ProviderUsageDailyClearRecord>;
  if (record.version !== PROVIDER_USAGE_DAILY_INDEX_VERSION) return undefined;
  const clearedThrough = asTimestamp(record.clearedThrough);
  const clearedAt = asTimestamp(record.clearedAt);
  if (!clearedThrough || !clearedAt) return undefined;
  return { version: PROVIDER_USAGE_DAILY_INDEX_VERSION, clearedThrough, clearedAt };
}

function encodeRun(record: ProviderUsageDailyRunRecord): StoredRun {
  return {
    sessionId: record.sessionId,
    runId: record.runId,
    mode: record.mode,
    revision: record.revision,
    indexedAt: record.indexedAt,
    attempts: record.attempts.map((attempt) => [
      attempt.at,
      attempt.total,
      attempt.input,
      attempt.output,
      attempt.cached,
      attempt.reasoning,
      attempt.provider,
      attempt.model,
      attempt.requestId,
    ]),
    missing: record.missing.map((mark) => (
      [mark.at, mark.kind === 'response_without_usage' ? 0 : 1, mark.provider, mark.model, mark.requestId]
    )),
    ...(record.unreadable ? { unreadable: true } : {}),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

function decodeRun(partitionKey: string, value: unknown): ProviderUsageDailyRunRecord | undefined {
  if (!/^[a-f0-9]{64}$/.test(partitionKey)) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const run = value as Partial<StoredRun>;
  const sessionId = asBoundedText(run.sessionId, 256);
  const runId = asBoundedText(run.runId, 256);
  const revision = asBoundedText(run.revision, 256);
  const indexedAt = asTimestamp(run.indexedAt);
  if (!sessionId || !runId || !revision || !indexedAt) return undefined;
  if (run.mode !== 'next' && run.mode !== 'shadow' && run.mode !== 'unknown') return undefined;
  if (!Array.isArray(run.attempts) || !Array.isArray(run.missing)) return undefined;
  const attempts: ProviderUsageDailyCountedAttempt[] = [];
  for (const entry of run.attempts) {
    const attempt = decodeAttempt(entry);
    if (!attempt) return undefined;
    attempts.push(attempt);
  }
  const missing: ProviderUsageDailyMissingFact[] = [];
  for (const entry of run.missing) {
    const mark = decodeMissing(entry);
    if (!mark) return undefined;
    missing.push(mark);
  }
  const reason = asBoundedText(run.reason, 512);
  return {
    partitionKey,
    sessionId,
    runId,
    mode: run.mode,
    revision,
    indexedAt,
    attempts,
    missing,
    unreadable: run.unreadable === true,
    ...(reason === undefined ? {} : { reason }),
  };
}

function decodeAttempt(value: unknown): ProviderUsageDailyCountedAttempt | undefined {
  if (!Array.isArray(value) || value.length !== 9) return undefined;
  const [at, total, input, output, cached, reasoning, provider, model, requestId] = value as StoredAttempt;
  const timestamp = asTimestamp(at);
  const providerId = asBoundedText(provider, 128);
  const modelId = asBoundedText(model, 128);
  const request = asBoundedText(requestId, 256);
  if (!timestamp || !providerId || !modelId || !request) return undefined;
  const counts = [total, input, output, cached, reasoning];
  if (!counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) {
    return undefined;
  }
  return {
    at: timestamp,
    total: total as number,
    input: input as number,
    output: output as number,
    cached: cached as number,
    reasoning: reasoning as number,
    provider: providerId,
    model: modelId,
    requestId: request,
  };
}

function decodeMissing(value: unknown): ProviderUsageDailyMissingFact | undefined {
  if (!Array.isArray(value) || value.length !== 5) return undefined;
  const [at, kind, provider, model, requestId] = value as StoredMissing;
  const timestamp = asTimestamp(at);
  const providerId = asBoundedText(provider, 128);
  const modelId = asBoundedText(model, 128);
  const request = asBoundedText(requestId, 256);
  if (!timestamp || (kind !== 0 && kind !== 1) || !providerId || !modelId || !request) return undefined;
  return {
    at: timestamp,
    kind: kind === 0 ? 'response_without_usage' : 'request_without_response',
    provider: providerId,
    model: modelId,
    requestId: request,
  };
}

function decodeBackfill(value: unknown): ProviderUsageDailyBackfillRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return idleBackfill();
  const record = value as Partial<ProviderUsageDailyBackfillRecord>;
  const status = record.status;
  if (status !== 'idle' && status !== 'partial' && status !== 'running' && status !== 'cancelled'
    && status !== 'complete' && status !== 'failed') {
    return idleBackfill();
  }
  const cursor = asBoundedText(record.cursor, 64);
  const startedAt = asTimestamp(record.startedAt);
  const finishedAt = asTimestamp(record.finishedAt);
  const error = asBoundedText(record.error, 512);
  return {
    // A pass that was running when the process died is resumable, not running.
    status: status === 'running' ? 'cancelled' : status,
    partitions: asCount(record.partitions),
    processed: asCount(record.processed),
    indexed: asCount(record.indexed),
    failed: asCount(record.failed),
    ...(cursor === undefined ? {} : { cursor }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(error === undefined ? {} : { error }),
  };
}

function idleBackfill(): ProviderUsageDailyBackfillRecord {
  return { status: 'idle', partitions: 0, processed: 0, indexed: 0, failed: 0 };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return Number.isFinite(Date.parse(value)) ? value.trim() : undefined;
}

function asBoundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
