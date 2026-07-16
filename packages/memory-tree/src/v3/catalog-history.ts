// Reads bounded atom history from rebuildable catalog projections.

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryAtomHistoryEntry } from './contracts.js';
import { boundedLimit } from './catalog-helpers.js';

export function listMemoryAtomHistory(
  db: DatabaseSync,
  atomId: string,
  limit = 40,
): MemoryAtomHistoryEntry[] {
  const bounded = boundedLimit(limit, 40, 200);
  const rows = db.prepare(`
    SELECT kind, id, at, summary FROM (
      SELECT 'access' AS kind, id, accessed_at AS at,
        retrieval_path || ':' || disclosure_level || ':' ||
        CASE entered_context WHEN 1 THEN 'entered' ELSE 'excluded' END || ':' || match_reason AS summary
      FROM atom_access WHERE atom_id = ?
      UNION ALL
      SELECT 'feedback' AS kind, id, created_at AS at,
        outcome || ':' || CASE verified WHEN 1 THEN 'verified' ELSE 'unverified' END || ':' || reason AS summary
      FROM atom_feedback WHERE atom_id = ?
      UNION ALL
      SELECT 'event' AS kind, event_id AS id, occurred_at AS at,
        event_kind || ':' || state || ':attempts=' || attempts AS summary
      FROM memory_events WHERE atom_id = ?
      UNION ALL
      SELECT 'audit' AS kind, id, created_at AS at,
        action || ':' || detail_json AS summary
      FROM audit WHERE atom_id = ?
    ) ORDER BY at DESC, id DESC LIMIT ?
  `).all(atomId, atomId, atomId, atomId, bounded) as unknown as Array<{
    kind: MemoryAtomHistoryEntry['kind'];
    id: string;
    at: string;
    summary: string;
  }>;
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    at: row.at,
    summary: row.summary.slice(0, 400),
  }));
}
