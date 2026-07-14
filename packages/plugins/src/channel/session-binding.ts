// @littlesheep/plugins — channel/session-binding.ts
// ChannelSessionStore: persists channel↔session bindings to a JSON file.
//
// The bindings file (~/.littlesheep/channels/bindings.json) is a simple index
// that maps each channel to its bound sessions. It complements the per-session
// metadata (which also carries channelId) — this file is the fast lookup index,
// while SessionManager.listByChannel() is the source of truth (scans metadata).
//
// Used by ChannelManager (Phase 4) to:
//   - bind(): record a new channel→session binding when a channel creates a session
//   - unbindChannel(): cascade-delete all sessions for a channel when it's removed
//   - findByChannel(): list sessions bound to a channel
//   - findBySession(): resolve which channel a session belongs to

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionId } from '@littlesheep/types';

/** One channel↔session binding record. */
export interface ChannelBinding {
  /** Channel instance id (e.g. "telegram:bot-123"). */
  channelId: string;
  /** Bound session id (UUID). */
  sessionId: string;
  /** External conversation id within the channel (e.g. Telegram chat.id). */
  externalConversationId?: string;
  /** When the binding was created (ISO timestamp). */
  createdAt: string;
}

/** Shape of the bindings.json file. */
interface BindingsFile {
  bindings: ChannelBinding[];
}

/** Options for ChannelSessionStore. */
export interface ChannelSessionStoreOptions {
  /** Path to the bindings.json file. */
  bindingsFile: string;
}

/**
 * Persistent index of channel↔session bindings.
 *
 * Thread-safety: all mutations are atomic (read-modify-write). Concurrent calls
 * are safe as long as they use the same store instance (Node.js single-threaded
 * event loop serializes the async steps).
 */
export class ChannelSessionStore {
  constructor(private opts: ChannelSessionStoreOptions) {}

  /** Load all bindings from disk. Returns [] if file is missing or corrupt. */
  async load(): Promise<ChannelBinding[]> {
    const file = this.opts.bindingsFile;
    if (!existsSync(file)) return [];
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as BindingsFile;
      if (parsed && Array.isArray(parsed.bindings)) {
        return parsed.bindings;
      }
      return [];
    } catch {
      // Corrupt JSON — treat as empty (rebuilds on next write).
      return [];
    }
  }

  /** Save all bindings to disk (atomic write). */
  async save(bindings: ChannelBinding[]): Promise<void> {
    const file = this.opts.bindingsFile;
    await mkdir(dirname(file), { recursive: true });
    const data: BindingsFile = { bindings };
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Record a channel→session binding. If a binding with the same
   * (channelId, sessionId) pair already exists, it's updated in place.
   */
  async bind(binding: Omit<ChannelBinding, 'createdAt'>): Promise<ChannelBinding> {
    const bindings = await this.load();
    // Find existing binding with same channelId + sessionId.
    const idx = bindings.findIndex(
      (b) => b.channelId === binding.channelId && b.sessionId === binding.sessionId,
    );
    const record: ChannelBinding = {
      ...binding,
      createdAt: idx >= 0 ? bindings[idx]!.createdAt : new Date().toISOString(),
    };
    if (idx >= 0) {
      bindings[idx] = record;
    } else {
      bindings.push(record);
    }
    await this.save(bindings);
    return record;
  }

  /**
   * Remove all bindings for a channel. Returns the removed bindings (so
   * ChannelManager can cascade-delete the bound sessions via SessionManager).
   */
  async unbindChannel(channelId: string): Promise<ChannelBinding[]> {
    const bindings = await this.load();
    const removed = bindings.filter((b) => b.channelId === channelId);
    const remaining = bindings.filter((b) => b.channelId !== channelId);
    await this.save(remaining);
    return removed;
  }

  /** List all bindings for a channel. */
  async findByChannel(channelId: string): Promise<ChannelBinding[]> {
    const bindings = await this.load();
    return bindings.filter((b) => b.channelId === channelId);
  }

  /** Find which channel a session belongs to (returns null if unbound). */
  async findBySession(sessionId: SessionId): Promise<ChannelBinding | null> {
    const bindings = await this.load();
    return bindings.find((b) => b.sessionId === sessionId) ?? null;
  }
}
