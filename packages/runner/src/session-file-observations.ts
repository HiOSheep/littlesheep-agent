// @littlesheep/runner — session-file-observations.ts
//
// Session-scoped file observation tables for one host process.
//
// The table records the file versions a session's model actually read, so a
// later overwrite can be refused when the file moved on. It must outlive a run
// (a read in one run is a legitimate basis for a write in the next one) but must
// never be shared across sessions, and it is intentionally not persisted: a
// Runner rebuild or an application restart simply means the model reads again.
//
// One path mutex is shared by every session of the host, so two sessions that
// write the same file serialize on "re-verify then write". Cross-process writers
// are out of scope; see the runtime state-consistency taskbook.
import type { FileObservationPort, SessionId } from '@littlesheep/types';
import { createFileObservationTable, createPathMutexTable } from '@littlesheep/tools';

export interface SessionFileObservationOptions {
  /** Bounded number of live session tables; the least recently used is dropped. */
  maxSessions?: number;
  /** Bounded number of observations inside one session table. */
  maxEntriesPerSession?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface SessionEntry {
  port: FileObservationPort;
  touchedAt: number;
}

const DEFAULT_MAX_SESSIONS = 16;

export class SessionFileObservationRegistry {
  private readonly mutex = createPathMutexTable();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number | undefined;
  private readonly now: () => number;

  constructor(options: SessionFileObservationOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxEntriesPerSession = options.maxEntriesPerSession;
    this.now = options.now ?? (() => Date.now());
  }

  /** The observations belonging to one session. Other sessions cannot see them. */
  forSession(sessionId: SessionId): FileObservationPort {
    const key = String(sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.touchedAt = this.now();
      return existing.port;
    }
    const port = createFileObservationTable({
      mutex: this.mutex,
      ...(this.maxEntriesPerSession === undefined ? {} : { maxEntries: this.maxEntriesPerSession }),
    });
    this.sessions.set(key, { port, touchedAt: this.now() });
    this.evictLeastRecentlyUsed();
    return port;
  }

  /**
   * Drop every table; called while the Runner shuts down.
   *
   * Eviction and disposal bound memory only: a port already handed to a run in
   * flight keeps its own bounded table, so a run never loses the basis for a
   * write halfway through. A session the registry forgot simply starts empty on
   * its next run and must read again.
   */
  dispose(): void {
    this.sessions.clear();
  }

  private evictLeastRecentlyUsed(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.sessions) {
        if (entry.touchedAt < oldest) {
          oldest = entry.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      this.sessions.delete(oldestKey);
    }
  }
}
