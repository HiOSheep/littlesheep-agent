// Maintains rebuildable Atom graph references and due-time projections inside the SQLite catalog.

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryAtom } from './contracts.js';

export function replaceAtomGraphReferences(db: DatabaseSync, atom: MemoryAtom): void {
  db.prepare('DELETE FROM atom_entity_refs WHERE atom_id = ?').run(atom.id);
  db.prepare('DELETE FROM atom_relation_refs WHERE atom_id = ?').run(atom.id);
  const insertEntity = db.prepare('INSERT INTO atom_entity_refs (atom_id, entity_id) VALUES (?, ?)');
  for (const entityId of new Set(atom.entityRefs)) insertEntity.run(atom.id, entityId);
  const insertRelation = db.prepare('INSERT INTO atom_relation_refs (atom_id, relation_id) VALUES (?, ?)');
  for (const relationId of new Set(atom.relationRefs)) insertRelation.run(atom.id, relationId);
}

export function replaceAtomDueRecords(db: DatabaseSync, atom: MemoryAtom): void {
  db.prepare('DELETE FROM memory_due WHERE atom_id = ?').run(atom.id);
  if (atom.status !== 'active') return;
  const insert = db.prepare('INSERT INTO memory_due (atom_id, due_kind, due_at) VALUES (?, ?, ?)');
  if (atom.effectiveAt) insert.run(atom.id, 'effective', atom.effectiveAt);
  if (atom.expiresAt) insert.run(atom.id, 'expiry', atom.expiresAt);
  if (atom.revalidateAt) insert.run(atom.id, 'revalidate', atom.revalidateAt);
}
