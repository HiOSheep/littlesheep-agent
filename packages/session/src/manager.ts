// @littlesheep/session — manager.ts
// SessionManager: JSONL-based session transcript storage.
//
// Sessions are stored as JSONL at <sessionsDir>/<sessionId>.jsonl.
// Each line is a Message record. Writes are serialized via file lock.

import { readFile, writeFile, mkdir, appendFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Session, SessionId, SessionMetadata, LockHandle, SessionManagerLike } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { acquireLock } from './lock.js';

/** Options for SessionManager. */
export interface SessionManagerOptions {
  /** Directory for session JSONL files. */
  sessionsDir: string;
  /** Lock acquire timeout in ms. */
  lockTimeoutMs?: number;
}

/** Manages session transcripts on disk. */
export class SessionManager implements SessionManagerLike {
  constructor(private opts: SessionManagerOptions) {}

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
    await writeFile(this.sessionFile(id), header, 'utf8');
    return { id, metadata, messages: [] };
  }

  /** Load metadata from the session file header. */
  async loadMetadata(sessionId: SessionId): Promise<SessionMetadata | null> {
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

  /** Read the last N messages (more efficient than full read for long sessions). */
  async readRecent(sessionId: SessionId, count: number): Promise<Message[]> {
    const all = await this.read(sessionId);
    return all.slice(-count);
  }

  /** Update session metadata (rewrites the file header). */
  async updateMetadata(sessionId: SessionId, patch: Partial<SessionMetadata>): Promise<void> {
    const file = this.sessionFile(sessionId);
    let handle: LockHandle | null = null;
    try {
      handle = await acquireLock(file, this.opts.lockTimeoutMs ?? 60000);
      const existing = await this.read(sessionId);
      const oldMeta = (await this.loadMetadata(sessionId)) ?? {
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
      await writeFile(file, header + body, 'utf8');
    } finally {
      await handle?.release();
    }
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
}
