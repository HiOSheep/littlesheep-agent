// Durable, bounded history of automatic session-compaction operations.
//
// The in-memory scheduler is the live owner; this store is its append-only,
// session-scoped projection for activity history and restart reconciliation.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionCompactionOperationRecord } from './session-compaction-scheduler.js';

const MAX_RECORDS_PER_SESSION = 50;

export class CompactionOperationStore {
  constructor(private readonly rootDir: string) {}

  async append(record: SessionCompactionOperationRecord): Promise<void> {
    const path = this.pathFor(record.sessionId);
    await mkdir(this.rootDir, { recursive: true });
    const existing = await this.read(record.sessionId);
    const next = [...existing.filter((entry) => entry.id !== record.id), structuredClone(record)]
      .slice(-MAX_RECORDS_PER_SESSION);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next), 'utf8');
    await rename(temporary, path);
  }

  async list(sessionId: string): Promise<SessionCompactionOperationRecord[]> {
    return this.read(sessionId);
  }

  private async read(sessionId: string): Promise<SessionCompactionOperationRecord[]> {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) return [];
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter(isOperationRecord).slice(-MAX_RECORDS_PER_SESSION);
    } catch {
      return [];
    }
  }

  private pathFor(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    return join(this.rootDir, `${digest}.json`);
  }
}

function isOperationRecord(value: unknown): value is SessionCompactionOperationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SessionCompactionOperationRecord>;
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.status === 'string';
}
