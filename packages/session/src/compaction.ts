// @littlesheep/session — compaction.ts
// Long-session compaction: when a session exceeds a threshold, old messages
// are distilled into a summary. MVP stub — full implementation in Phase 10.

import type { Message, SessionId } from '@littlesheep/types';
import type { SessionManager } from './manager.js';
import type { CompactionSummary } from '@littlesheep/types';

export interface CompactionOptions {
  threshold: number;
  keepRecent: number;
}

/**
 * Check if a session needs compaction and run it.
 * MVP: returns null (no compaction yet). Full LLM distillation in Phase 10.
 */
export async function maybeCompact(
  _manager: SessionManager,
  _sessionId: SessionId,
  _opts: CompactionOptions
): Promise<CompactionSummary | null> {
  // TODO Phase 10: implement LLM-based compaction
  return null;
}

/** Select messages to compact (all but the most recent `keepRecent`). */
export function selectForCompaction(messages: Message[], keepRecent: number): Message[] {
  if (messages.length <= keepRecent) return [];
  return messages.slice(0, messages.length - keepRecent);
}
