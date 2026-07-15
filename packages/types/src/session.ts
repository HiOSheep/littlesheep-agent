// @littlesheep/types — session.ts
// Session identity + transcript shape.

import type { Message } from './message.js';

/** Branded session id (string). */
export type SessionId = string & { readonly __brand: 'SessionId' };

export function asSessionId(s: string): SessionId {
  return s as SessionId;
}

export interface SessionRunToolTiming {
  name: string;
  status: 'succeeded' | 'failed';
  durationMs?: number;
  stepId?: string;
}

/** Bounded execution facts retained for an immediate follow-up turn. */
export interface SessionRunSummary {
  version: 1;
  runId: string;
  status: 'queued' | 'running' | 'ok' | 'error' | 'timeout' | 'aborted';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  task?: {
    status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'partial';
    completedSteps: number;
    totalSteps: number;
  };
  tools: {
    total: number;
    succeeded: number;
    failed: number;
    totalDurationMs: number;
    recent: SessionRunToolTiming[];
    truncated: boolean;
  };
}

/** Session metadata persisted alongside the transcript. */
export interface SessionMetadata {
  /** Human label for the session. */
  title?: string;
  /** Model ref used for this session (provider/model). */
  model?: string;
  /** When the session was created. */
  createdAt: string;
  /** When the session was last updated. */
  updatedAt: string;
  /** Number of messages (denormalized for quick status). */
  messageCount: number;
  /** Whether compaction has been applied. */
  compacted?: boolean;
  /** Latest non-destructive summary of older messages. Original messages remain in JSONL. */
  compaction?: CompactionSummary;
  /** Free-form tags. */
  tags?: string[];
  /** Channel id when this session is bound to a communication channel.
   *  Set by ChannelManager when origin === 'channel'; undefined for local sessions.
   *  Sessions with a channelId cannot be deleted independently — only via
   *  channel removal (cascade delete). */
  channelId?: string;
  /** External conversation id within the channel (e.g. Telegram chat.id,
   *  QQ group id). Used by ChannelManager to resolve sessions. */
  externalConversationId?: string;
  /** Where this session originated: 'app' (local UI), 'channel' (external
   *  messaging channel), or 'cli' (terminal). Undefined for legacy sessions. */
  origin?: 'app' | 'channel' | 'cli';
}

/** A session = metadata + ordered messages. */
export interface Session {
  id: SessionId;
  metadata: SessionMetadata;
  messages: Message[];
}

/** Result of acquiring the session write lock. */
export interface LockHandle {
  release(): Promise<void>;
}

/** Compaction summary written when a session is compacted. */
export interface CompactionSummary {
  version: 1;
  id: string;
  /** Messages collapsed into the summary. */
  collapsedCount: number;
  /** The distilled summary text inserted in place. */
  summary: string;
  /** When compaction happened. */
  compactedAt: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceStartAt: string;
  sourceEndAt: string;
  previousSummaryId?: string;
  model?: string;
}

/**
 * Structural interface for a session manager.
 *
 * `SessionManager` (in `@littlesheep/session`) implements this. Decorators
 * (`SnapshotSessionManager`) depend on this interface so they can wrap either
 * the real manager or test mocks interchangeably.
 */
export interface SessionManagerLike {
  /** Resolve the JSONL file path for a session. Sync. */
  sessionFile(sessionId: SessionId): string;
  /** Create a new session. The optional `meta` merges into the metadata header
   *  (used by ChannelManager to set channelId/origin/externalConversationId). */
  create(model?: string, title?: string, meta?: Partial<SessionMetadata>): Promise<Session>;
  loadMetadata(sessionId: SessionId): Promise<SessionMetadata | null>;
  append(sessionId: SessionId, messages: Message[]): Promise<void>;
  read(sessionId: SessionId): Promise<Message[]>;
  readRecent(sessionId: SessionId, count: number): Promise<Message[]>;
  updateMetadata(sessionId: SessionId, patch: Partial<SessionMetadata>): Promise<void>;
  load(sessionId: SessionId): Promise<Session | null>;
  list(): Promise<SessionId[]>;
  /** Delete a session's JSONL file (and its lock). Tolerates missing files
   *  (ENOENT) — used by ChannelManager.remove for cascade deletion. */
  delete(sessionId: SessionId): Promise<void>;
  /** List session ids bound to a specific channel (reads metadata to filter). */
  listByChannel(channelId: string): Promise<SessionId[]>;
  stat(sessionId: SessionId): Promise<{ size: number; mtime: Date } | null>;
}
