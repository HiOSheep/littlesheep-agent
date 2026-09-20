import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.argv[2], 'execution-logs');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let log; try { log = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  const snaps = new Map((log.contextSnapshots ?? []).map((s) => [s.id, s]));
  const req = (log.modelRequests ?? []).find((r) => (r.callContract?.purpose ?? '') === 'reply');
  if (!req) continue;
  const items = snaps.get(req.contextSnapshotId)?.items ?? [];
  const isSystem = (id) => /system|identity|workspace|safety|core-flow|capabilit|memory|profile|tooling|directive|runtime|date|bootstrap|index|skill/i.test(id);
  console.log('run=' + String(log.runId ?? '').slice(-8) + ' snapshotItems=' + items.length);
  for (const it of items) {
    if (!isSystem(it.id)) continue;
    console.log(String(it.id).padEnd(46) + ' ' + String(it.characterCount ?? 0).padStart(6));
  }
  break;
}