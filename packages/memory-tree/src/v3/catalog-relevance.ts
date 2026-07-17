// Owns bounded relation relevance aggregation for memory candidate routing.

import type { DatabaseSync } from 'node:sqlite';

export function aggregateRelationRelevance(
  db: DatabaseSync,
  atomIds: readonly string[],
  now: string,
): Map<string, number> {
  const ids = [...new Set(atomIds.filter(Boolean))].slice(0, 1_000);
  const result = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT refs.atom_id, AVG(relation.relevance) AS average_relevance,
        MAX(relation.relevance) AS maximum_relevance
      FROM atom_relation_refs refs
      JOIN relations relation ON relation.relation_id = refs.relation_id
      WHERE refs.atom_id IN (${placeholders})
        AND relation.status = 'active'
        AND (relation.expires_at IS NULL OR relation.expires_at > ?)
      GROUP BY refs.atom_id
    `).all(...chunk, now) as unknown as Array<{
      atom_id: string;
      average_relevance: number;
      maximum_relevance: number;
    }>;
    for (const row of rows) {
      const relevance = Number(row.maximum_relevance) * 0.6 + Number(row.average_relevance) * 0.4;
      result.set(row.atom_id, Math.max(0, Math.min(1, relevance)));
    }
  }
  return result;
}
