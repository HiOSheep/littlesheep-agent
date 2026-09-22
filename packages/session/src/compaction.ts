import { createHash } from 'node:crypto';
import {
  nextCacheCompressionDepth,
  type CompactionSummary,
  type CompactionSummaryV2,
  type Message,
  type SessionId,
} from '@littlesheep/types';
import type { SessionManager } from './manager.js';
import type { CompactionMemoryCandidate, CompactionMemoryProposal } from './compaction-store-codec.js';

const MAX_COMPACTION_SOURCE_RUN_IDS = 64;
const COMPACTION_POLICY_VERSION = 3;

export interface CompactionSummaryInput {
  sessionId: SessionId;
  previousSummary?: CompactionSummary;
  /** Complete preserved transcript range covered by the next summary. */
  coveredMessages: Message[];
  /** Newly covered messages since the previous summary. */
  messages: Message[];
  signal?: AbortSignal;
}

export interface CompactionSummaryOutput {
  summary: string;
  model?: string;
  requestId?: string;
  memoryCandidates?: CompactionMemoryCandidate[];
  memoryEvidenceComplete?: boolean;
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

  // Runtime tail sections travel in the transcript for byte-exact replay, but they
  // are not conversation: counting them would make compaction fire once every
  // couple of turns (a turn can carry ten of them) and would push the whole turn
  // out of the keep window.
  const uncompactedConversational = messages
    .slice(previousEndIndex + 1)
    .filter((message) => message.runtimeTail !== true)
    .length;
  if (!opts.force && uncompactedConversational < opts.threshold) return null;

  // Keep the last `keepRecent` conversational messages together with the tail
  // sections that follow them, so the kept range stays replayable.
  let keepFromIndex = 0;
  let keptConversational = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    keepFromIndex = index;
    if (messages[index]!.runtimeTail === true) continue;
    keptConversational += 1;
    if (keptConversational >= opts.keepRecent) break;
  }
  if (keptConversational < opts.keepRecent) keepFromIndex = 0;
  const compactThroughIndex = keepFromIndex - 1;
  if (compactThroughIndex <= previousEndIndex) return null;
  const newMessages = messages.slice(previousEndIndex + 1, compactThroughIndex + 1);
  if (newMessages.length === 0) return null;
  const coveredMessages = messages.slice(0, compactThroughIndex + 1);

  const output = await opts.summarize({
    sessionId,
    previousSummary: previous,
    coveredMessages,
    messages: newMessages,
    signal: opts.signal,
  });
  throwIfAborted(opts.signal);
  const summary = output.summary.trim();
  if (!summary) throw new Error('Session compaction produced an empty summary.');

  const first = messages[0]!;
  const last = messages[compactThroughIndex]!;
  // Counts describe the conversation the summary collapses. Runtime tail records
  // travel in the transcript for replay but are not collapsed content, so they are
  // not counted here even though the covered range spans them.
  const collapsedCount = coveredMessages.filter((message) => message.runtimeTail !== true).length;
  const sourceHash = hashCompactionMessages(coveredMessages);
  const sourceRunIds = uniqueSourceRunIds(coveredMessages);
  const sourceRunIdsTruncated = sourceRunIds.length > MAX_COMPACTION_SOURCE_RUN_IDS;
  const compactedAt = new Date().toISOString();
  const previousDepth = previous?.version === 2 ? previous.cache.compressionDepth : previous ? 1 : undefined;
  const compressionDepth = nextCacheCompressionDepth(previousDepth);
  const sourceSummaryIds = previous
    ? [...new Set([
        ...(previous.version === 2 ? previous.sourceSummaryIds : []),
        previous.id,
      ])].slice(-3)
    : [];
  const contentHash = hashText(summary);
  const lineageHash = hashText([
    previous?.version === 2 ? previous.lineageHash : previous?.id ?? 'root',
    sourceHash,
    contentHash,
  ].join('\0'));
  const cache: CompactionSummaryV2['cache'] = {
    version: 1,
    namespace: 'session-summary',
    dataClass: 'semantic',
    compressionDepth,
    disclosureLevel: 'D1',
    vectorClass: 'semantic-cache',
    sourceRefs: [
      `session:${sessionId}:messages:${previous?.sourceStartMessageId ?? first.id}..${last.id}`,
      ...sourceSummaryIds.map((id) => `session-summary:${id}`),
    ].slice(-4),
    contentHash,
    createdAt: compactedAt,
  };
  const transactionKey = hashText([
    String(sessionId),
    previous?.id ?? 'root',
    sourceHash,
    String(COMPACTION_POLICY_VERSION),
  ].join('\0'));
  const record: CompactionSummaryV2 = Object.freeze({
    version: 2,
    id: transactionKey,
    collapsedCount,
    summary,
    compactedAt,
    sourceStartMessageId: previous?.sourceStartMessageId ?? first.id,
    sourceEndMessageId: last.id,
    sourceStartAt: previous?.sourceStartAt ?? first.timestamp,
    sourceEndAt: last.timestamp,
    previousSummaryId: previousDepth === 3 ? undefined : previous?.id,
    model: output.model,
    cache,
    sourceRanges: [{
      messageCount: collapsedCount,
      sourceStartMessageId: previous?.sourceStartMessageId ?? first.id,
      sourceEndMessageId: last.id,
      sourceStartAt: previous?.sourceStartAt ?? first.timestamp,
      sourceEndAt: last.timestamp,
      sourceHash,
    }],
    sourceSummaryIds,
    sourceRunIds: sourceRunIds.slice(-MAX_COMPACTION_SOURCE_RUN_IDS),
    sourceRunIdsTruncated,
    mergedSummaryCount: (previous?.version === 2 ? previous.mergedSummaryCount : previous ? 1 : 0) + 1,
    sourceHash,
    lineageHash,
  });
  const memoryProposal: CompactionMemoryProposal | undefined = output.memoryCandidates
    ? {
        version: 1,
        requestId: output.requestId,
        evidenceComplete: output.memoryEvidenceComplete === true,
        candidates: structuredClone(output.memoryCandidates.slice(0, 8)),
        outcomes: [],
      }
    : undefined;
  await manager.commitCompaction(sessionId, record, {
    expectedPreviousSummaryId: previous?.id ?? null,
    sourceEndMessageId: last.id,
    sourceHash,
    policyVersion: COMPACTION_POLICY_VERSION,
    transactionKey,
  }, memoryProposal);
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

export function hashCompactionMessages(messages: readonly Message[]): string {
  return hashText(JSON.stringify(messages.map((message) => ({
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    content: message.content,
  }))));
}

function uniqueSourceRunIds(messages: readonly Message[]): string[] {
  const seen = new Set<string>();
  const runIds: string[] = [];
  for (const message of messages) {
    const runId = message.runId?.trim();
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    runIds.push(runId);
  }
  return runIds;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
