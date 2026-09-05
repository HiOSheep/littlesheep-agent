// @littlesheep/session — manager.ts
// SessionManager: JSONL-based session transcript storage.
//
// Sessions are stored as JSONL at <sessionsDir>/<sessionId>.jsonl.
// Each line is a Message record. Writes are serialized via file lock.

import { readFile, mkdir, appendFile, stat, unlink, open } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AtomicActivationEvidence,
  AtomicActivationLevelCounts,
  AtomicActivationObservation,
  CompactionSummary,
  CompactionSummaryV2,
  LockHandle,
  Message,
  FinalReplyReservation,
  Session,
  SessionId,
  SessionManagerLike,
  SessionMetadata,
} from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { acquireLock } from './lock.js';
import { atomicWriteText } from './atomic-file.js';
import { SessionCompactionStore } from './compaction-store.js';
import { ReplyFingerprintStore } from './reply-fingerprint-store.js';

/** Options for SessionManager. */
export interface SessionManagerOptions {
  /** Directory for session JSONL files. */
  sessionsDir: string;
  /** Lock acquire timeout in ms. */
  lockTimeoutMs?: number;
}

export interface SessionMessageWindow {
  messages: Message[];
  hasMore: boolean;
  beforeId?: string;
}

const SESSION_WINDOW_DEFAULT_LIMIT = 120;
const SESSION_WINDOW_MAX_LIMIT = 240;
const SESSION_READ_CHUNK_BYTES = 64 * 1024;
const SESSION_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Manages session transcripts on disk. */
export class SessionManager implements SessionManagerLike {
  private readonly compactions: SessionCompactionStore;
  private readonly replyFingerprints: ReplyFingerprintStore;
  private readonly compactionRecovery = new Map<SessionId, Promise<void>>();

  constructor(private opts: SessionManagerOptions) {
    this.compactions = new SessionCompactionStore(opts.sessionsDir);
    this.replyFingerprints = new ReplyFingerprintStore(opts.sessionsDir, opts.lockTimeoutMs ?? 60000);
  }

  /** Resolve the JSONL file path for a session. */
  sessionFile(sessionId: SessionId): string {
    return join(this.opts.sessionsDir, `${sessionId}.jsonl`);
  }

  /** Create a new session with a fresh id. The optional `meta` merges into
   *  the metadata header (used by ChannelManager to bind sessions to channels). */
  async create(model?: string, title?: string, meta?: Partial<SessionMetadata>): Promise<Session> {
    const id = asSessionId(randomUUID());
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      title,
      model,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      ...meta,
    };
    await mkdir(this.opts.sessionsDir, { recursive: true });
    // Write empty file with metadata header (first line is metadata, not a message).
    const header = JSON.stringify({ type: 'metadata', metadata }) + '\n';
    await atomicWriteText(this.sessionFile(id), header);
    return { id, metadata, messages: [] };
  }

  /** Load metadata from the session file header. */
  async loadMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
    await this.recoverCompactions(sessionId);
    return this.readMetadata(sessionId);
  }

  private async readMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const firstLine = raw.split('\n')[0];
    if (!firstLine) return null;
    try {
      const parsed = JSON.parse(firstLine);
      if (parsed && parsed.type === 'metadata') {
        return parsed.metadata as SessionMetadata;
      }
    } catch {
      // not a metadata line
    }
    return null;
  }

  /** Append messages to a session (acquires write lock). */
  async append(sessionId: SessionId, messages: Message[]): Promise<void> {
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      await mkdir(this.opts.sessionsDir, { recursive: true });
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
      await appendFile(file, lines, 'utf8');
    } finally {
      await handle?.release();
    }
  }

  /** Read all messages from a session (skips metadata header). */
  async read(sessionId: SessionId): Promise<Message[]> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return [];
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const messages: Message[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.type !== 'metadata' && parsed.id && parsed.role) {
          messages.push(parsed as Message);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return messages;
  }

  /**
   * Atomically append a conversation turn only when its stable message id has
   * not already been accepted. The check and append share the session lock so
   * concurrent HTTP/SSE retries cannot both enter an effectful Agent run.
   */
  async appendIfAbsent(
    sessionId: SessionId,
    messages: Message[],
    uniqueMessageId: string,
  ): Promise<boolean> {
    const normalizedId = uniqueMessageId.trim();
    if (!normalizedId) throw new Error('unique conversation message id must be non-empty');
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      if (await this.findMessage(sessionId, normalizedId)) return false;
      await mkdir(this.opts.sessionsDir, { recursive: true });
      const lines = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
      await appendFile(file, lines, 'utf8');
      return true;
    } finally {
      await handle?.release();
    }
  }

  /**
   * Find one message without materializing the whole transcript. This is
   * used by checkpoint continuation, where the original inbound message may
   * be far outside the normal recent-history window.
   */
  async findMessage(sessionId: SessionId, messageId: string): Promise<Message | null> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file) || !messageId.trim()) return null;
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length === 0 || Buffer.byteLength(line, 'utf8') > SESSION_MAX_LINE_BYTES) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const candidate = parsed as Partial<Message> & { type?: string };
        if (candidate.type === 'metadata' || candidate.id !== messageId || !candidate.role) continue;
        return parsed as Message;
      }
      return null;
    } finally {
      lines.close();
      input.destroy();
    }
  }

  /** Read the last N messages (more efficient than full read for long sessions). */
  async readRecent(sessionId: SessionId, count: number): Promise<Message[]> {
    return (await this.readWindow(sessionId, count)).messages;
  }

  /** Read a bounded transcript window from the end of the JSONL file. */
  async readWindow(
    sessionId: SessionId,
    count = SESSION_WINDOW_DEFAULT_LIMIT,
    beforeId?: string,
  ): Promise<SessionMessageWindow> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return { messages: [], hasMore: false };

    const limit = Math.max(1, Math.min(SESSION_WINDOW_MAX_LIMIT, Math.floor(count) || SESSION_WINDOW_DEFAULT_LIMIT));
    const handle = await open(file, 'r');
    try {
      const fileStats = await handle.stat();
      let position = fileStats.size;
      let carry = Buffer.alloc(0);
      let boundaryFound = beforeId === undefined;
      let hasMore = false;
      const reversed: Message[] = [];

      const consume = (lineBuffer: Buffer): boolean => {
        if (lineBuffer.length === 0 || lineBuffer.length > SESSION_MAX_LINE_BYTES) return false;
        const line = lineBuffer.toString('utf8').trim();
        if (!line) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return false;
        }
        if (!parsed || typeof parsed !== 'object') return false;
        const candidate = parsed as Partial<Message> & { type?: string };
        if (candidate.type === 'metadata' || typeof candidate.id !== 'string' || !candidate.role) return false;
        const message = parsed as Message;
        if (!boundaryFound) {
          if (message.id === beforeId) boundaryFound = true;
          return false;
        }
        if (reversed.length < limit) {
          reversed.push(message);
        } else {
          hasMore = true;
        }
        return hasMore;
      };

      while (position > 0 && !hasMore) {
        const start = Math.max(0, position - SESSION_READ_CHUNK_BYTES);
        const length = position - start;
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, start);
        const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
        const lines: Buffer[] = [];
        let lineEnd = combined.length;
        for (let index = combined.length - 1; index >= 0; index -= 1) {
          if (combined[index] !== 0x0a) continue;
          lines.push(combined.subarray(index + 1, lineEnd));
          lineEnd = index;
        }
        if (start === 0) {
          lines.push(combined.subarray(0, lineEnd));
          carry = Buffer.alloc(0);
        } else {
          carry = combined.subarray(0, lineEnd);
          if (carry.length > SESSION_MAX_LINE_BYTES) carry = Buffer.alloc(0);
        }
        for (const line of lines) {
          if (consume(line)) break;
        }
        position = start;
      }

      if (!hasMore && position === 0 && carry.length > 0) consume(carry);
      const messages = reversed.reverse();
      return {
        messages,
        hasMore: beforeId !== undefined && !boundaryFound ? false : hasMore,
        beforeId: messages[0]?.id,
      };
    } finally {
      await handle.close();
    }
  }

  /** Update session metadata (rewrites the file header). */
  async updateMetadata(sessionId: SessionId, patch: Partial<SessionMetadata>): Promise<void> {
    await this.recoverCompactions(sessionId);
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      const existing = await this.read(sessionId);
      const oldMeta = (await this.readMetadata(sessionId)) ?? {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: existing.length,
      };
      const metadata: SessionMetadata = {
        ...oldMeta,
        ...patch,
        updatedAt: new Date().toISOString(),
        messageCount: existing.length,
      };
      const header = JSON.stringify({ type: 'metadata', metadata }) + '\n';
      const body = existing.map((m) => JSON.stringify(m)).join('\n') + (existing.length > 0 ? '\n' : '');
      await atomicWriteText(file, header + body);
    } finally {
      await handle?.release();
    }
  }

  /** Atomically reserve text that is about to become visible as an Assistant reply. */
  reserveAssistantReply(sessionId: SessionId, reply: string): Promise<boolean> {
    return this.replyFingerprints.reserve(sessionId, reply);
  }

  /** Reserve a final reply under its durable settlement identity. */
  reserveAssistantReplySettlement(
    sessionId: SessionId,
    reservation: FinalReplyReservation,
  ): Promise<boolean> {
    return this.replyFingerprints.reserveSettlement(sessionId, reservation);
  }

  /** Mark a previously reserved final reply settled after transcript append. */
  settleAssistantReplySettlement(
    sessionId: SessionId,
    reservation: FinalReplyReservation,
  ): Promise<void> {
    return this.settleAssistantReplySettlementAndTranscript(sessionId, reservation);
  }

  assistantReplySettlementStatus(
    sessionId: SessionId,
    settlementId: string,
  ): Promise<'reserved' | 'settled' | undefined> {
    return this.replyFingerprints.settlementStatus(sessionId, settlementId);
  }

  /**
   * Settle the registry and promote the matching transcript proposal. The two
   * stores remain independently recoverable: if the transcript rewrite fails
   * after the sidecar commit, the next recovery pass retries this idempotently.
   */
  private async settleAssistantReplySettlementAndTranscript(
    sessionId: SessionId,
    reservation: FinalReplyReservation,
  ): Promise<void> {
    await this.replyFingerprints.settleSettlement(sessionId, reservation);
    await this.promoteSettledReplyInTranscript(sessionId, reservation);
  }

  private async promoteSettledReplyInTranscript(
    sessionId: SessionId,
    reservation: FinalReplyReservation,
  ): Promise<void> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return;
    const handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
    try {
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n');
      let changed = false;
      const next = lines.map((line) => {
        if (!line.trim()) return line;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Preserve corrupt/unknown lines exactly as the normal session
          // reader does; a settlement repair must not discard user data.
          return line;
        }
        if (!parsed || typeof parsed !== 'object') return line;
        const candidate = parsed as Partial<Message> & { type?: string };
        if (candidate.type === 'metadata'
          || candidate.role !== 'assistant'
          || candidate.stage !== 'finalize'
          || !candidate.finalReplySettlement
          || candidate.finalReplySettlement.settlementId !== reservation.settlementId) {
          return line;
        }
        const current = candidate.finalReplySettlement;
        if (current.reply !== reservation.reply
          || current.replyFingerprint !== reservation.replyFingerprint
          || current.modelRequestId !== reservation.modelRequestId) {
          throw new Error(`session: final reply transcript conflicts: ${reservation.settlementId}`);
        }
        if (current.status === 'settled') return line;
        if (current.status !== 'proposed') {
          throw new Error(`session: final reply transcript has invalid status: ${reservation.settlementId}`);
        }
        changed = true;
        return JSON.stringify({
          ...candidate,
          finalReplySettlement: {
            ...reservation,
            status: 'settled',
          },
        });
      });
      if (!changed) return;
      await atomicWriteText(file, next.join('\n'));
    } finally {
      await handle.release();
    }
  }

  async commitCompaction(sessionId: SessionId, summary: CompactionSummaryV2): Promise<void> {
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      await this.compactions.commit(sessionId, summary, async (projection) => {
        await this.writeMetadataWithoutLock(sessionId, { compacted: true, compaction: projection });
      });
    } finally {
      await handle?.release();
    }
  }

  loadCompactionProjection(sessionId: SessionId, summaryId: string): Promise<CompactionSummary | undefined> {
    return this.compactions.load(sessionId, summaryId);
  }

  recordCompactionActivation(
    sessionId: SessionId,
    summaryId: string,
    observation: AtomicActivationObservation,
  ): Promise<AtomicActivationEvidence> {
    return this.compactions.recordActivation(sessionId, summaryId, observation);
  }

  loadCompactionActivation(
    sessionId: SessionId,
    summaryId: string,
  ): Promise<AtomicActivationEvidence | undefined> {
    return this.compactions.loadActivation(sessionId, summaryId);
  }

  semanticCacheActivationOverview(now?: string): Promise<AtomicActivationLevelCounts> {
    return this.compactions.activationOverview(now);
  }

  /** Load a full session (metadata + messages). */
  async load(sessionId: SessionId): Promise<Session | null> {
    const metadata = await this.loadMetadata(sessionId);
    if (!metadata) return null;
    const messages = await this.read(sessionId);
    return { id: sessionId, metadata, messages };
  }

  /** List all session ids in the sessions dir. */
  async list(): Promise<SessionId[]> {
    if (!existsSync(this.opts.sessionsDir)) return [];
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.opts.sessionsDir);
    return entries
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => asSessionId(f.replace(/\.jsonl$/, '')));
  }

  /**
   * Delete a session's JSONL file. Acquires the write lock first (to avoid
   * racing with concurrent appends), then unlinks. Tolerates ENOENT (already
   * deleted) — used by ChannelManager.remove for cascade deletion.
   *
   * Note: the lock file (`<file>.lock`) is cleaned up by handle.release().
   */
  async delete(sessionId: SessionId): Promise<void> {
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      await unlink(file).catch((err: NodeJS.ErrnoException) => {
        // ENOENT = file already gone (e.g. double delete). Not an error.
        if (err.code !== 'ENOENT') throw err;
      });
    } finally {
      await handle?.release();
    }
    await this.compactions.removeSession(sessionId);
    await this.replyFingerprints.delete(sessionId);
  }

  /**
   * List session ids bound to a specific channel. Reads each session's
   * metadata header and filters by `channelId`.
   *
   * Performance: O(n) where n = total sessions (reads every metadata header).
   * ChannelSessionStore (Phase 4) will provide a faster index; this is the
   * fallback / source of truth.
   */
  async listByChannel(channelId: string): Promise<SessionId[]> {
    const ids = await this.list();
    const matched: SessionId[] = [];
    for (const id of ids) {
      const meta = await this.loadMetadata(id);
      if (meta?.channelId === channelId) {
        matched.push(id);
      }
    }
    return matched;
  }

  /** Get file stats (size, mtime) for diagnostics. */
  async stat(sessionId: SessionId): Promise<{ size: number; mtime: Date } | null> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return null;
    const s = await stat(file);
    return { size: s.size, mtime: s.mtime };
  }

  private async writeMetadataWithoutLock(sessionId: SessionId, patch: Partial<SessionMetadata>): Promise<void> {
    const existing = await this.read(sessionId);
    const oldMeta = (await this.readMetadata(sessionId)) ?? {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: existing.length,
    };
    const metadata: SessionMetadata = {
      ...oldMeta,
      ...patch,
      updatedAt: new Date().toISOString(),
      messageCount: existing.length,
    };
    const header = JSON.stringify({ type: 'metadata', metadata }) + '\n';
    const body = existing.map((message) => JSON.stringify(message)).join('\n') + (existing.length > 0 ? '\n' : '');
    await atomicWriteText(this.sessionFile(sessionId), header + body);
  }

  private recoverCompactions(sessionId: SessionId): Promise<void> {
    if (!this.compactions.hasPending(sessionId)) return Promise.resolve();
    const existing = this.compactionRecovery.get(sessionId);
    if (existing) return existing;
    const run = (async () => {
      const file = this.sessionFile(sessionId);
      let handle: LockHandle | null = null;
      try {
        handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
        await this.compactions.recover(sessionId, async (summary) => {
          await this.writeMetadataWithoutLock(sessionId, { compacted: true, compaction: summary });
        });
      } finally {
        await handle?.release();
      }
    })().finally(() => {
      this.compactionRecovery.delete(sessionId);
    });
    this.compactionRecovery.set(sessionId, run);
    return run;
  }
}
