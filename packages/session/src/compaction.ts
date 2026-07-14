import { randomUUID } from 'node:crypto';
import type { CompactionSummary, Message, SessionId } from '@littlesheep/types';
import type { SessionManager } from './manager.js';

export interface CompactionSummaryInput {
  sessionId: SessionId;
  previousSummary?: CompactionSummary;
  messages: Message[];
  signal?: AbortSignal;
}

export interface CompactionSummaryOutput {
  summary: string;
  model?: string;
}

export interface CompactionOptions {
  threshold: number;
  keepRecent: number;
  force?: boolean;
  signal?: AbortSignal;
  summarize(input: CompactionSummaryInput): Promise<CompactionSummaryOutput>;
}

/**
 * Create a versioned, non-destructive summary of old session messages.
 * Original JSONL messages remain untouched; only session metadata is updated.
 */
export async function maybeCompact(
  manager: SessionManager,
  sessionId: SessionId,
  opts: CompactionOptions,
): Promise<CompactionSummary | null> {
  if (!Number.isSafeInteger(opts.threshold) || opts.threshold <= 0) {
    throw new Error('Compaction threshold must be a positive integer.');
  }
  if (!Number.isSafeInteger(opts.keepRecent) || opts.keepRecent <= 0) {
    throw new Error('Compaction keepRecent must be a positive integer.');
  }
  throwIfAborted(opts.signal);

  const [messages, metadata] = await Promise.all([
    manager.read(sessionId),
    manager.loadMetadata(sessionId),
  ]);
  const previous = metadata?.compaction;
  const previousEndIndex = previous
    ? messages.findIndex((message) => message.id === previous.sourceEndMessageId)
    : -1;
  if (previous && previousEndIndex < 0) {
    throw new Error('The previous session summary no longer matches the preserved transcript.');
  }

  const uncompactedCount = messages.length - (previousEndIndex + 1);
  if (!opts.force && uncompactedCount < opts.threshold) return null;

  const compactThroughIndex = messages.length - opts.keepRecent - 1;
  if (compactThroughIndex <= previousEndIndex) return null;
  const newMessages = messages.slice(previousEndIndex + 1, compactThroughIndex + 1);
  if (newMessages.length === 0) return null;

  const output = await opts.summarize({
    sessionId,
    previousSummary: previous,
    messages: newMessages,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  const summary = output.summary.trim();
  if (!summary) throw new Error('Session compaction produced an empty summary.');

  const first = messages[0]!;
  const last = messages[compactThroughIndex]!;
  const record: CompactionSummary = Object.freeze({
    version: 1,
    id: randomUUID(),
    collapsedCount: compactThroughIndex + 1,
    summary,
    compactedAt: new Date().toISOString(),
    sourceStartMessageId: previous?.sourceStartMessageId ?? first.id,
    sourceEndMessageId: last.id,
    sourceStartAt: previous?.sourceStartAt ?? first.timestamp,
    sourceEndAt: last.timestamp,
    previousSummaryId: previous?.id,
    model: output.model,
  });
  await manager.updateMetadata(sessionId, { compacted: true, compaction: record });
  return record;
}

/** Select messages to compact (all but the most recent `keepRecent`). */
export function selectForCompaction(messages: Message[], keepRecent: number): Message[] {
  if (messages.length <= keepRecent) return [];
  return messages.slice(0, messages.length - keepRecent);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Session compaction aborted.');
}
