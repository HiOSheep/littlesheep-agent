import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStoreLike } from '@littlesheep/types';
import {
  LEGACY_MEMORY_MIGRATION_ID,
  migrateLegacyMemorySources,
  type ExperienceStoreLike,
} from './legacy-memory-branches.js';
import { MemoryRepository } from './memory-repository.js';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('legacy memory migration', () => {
  it('copies each legacy source once without modifying the original stores', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-migration-'));
    createdDirs.push(dataDir);
    const repository = new MemoryRepository({ dataDir });
    await repository.initialize();

    const memoryStore: MemoryStoreLike = {
      longTermPath: join(dataDir, 'MEMORY.md'),
      dailyDirPath: join(dataDir, 'memory'),
      readLongTerm: vi.fn(async () => '# Memory\n\n## 2026-07-01T10:00:00.000Z\n- User prefers dark interfaces.'),
      writeLongTerm: vi.fn(async () => undefined),
      appendLongTerm: vi.fn(async () => undefined),
      dailyFile: (date) => join(dataDir, 'memory', `${date}.md`),
      readDaily: vi.fn(async () => '- Finished the indexed memory prototype.'),
      appendDaily: vi.fn(async () => undefined),
      writeDaily: vi.fn(async () => undefined),
      listDailyDates: vi.fn(async () => ['2026-07-02']),
      today: () => '2026-07-02',
    };
    const experienceStore: ExperienceStoreLike = {
      list: vi.fn(async () => [{
        id: 'experience-1',
        category: 'workflow',
        content: 'Verify the focused test before running the complete suite.',
        confidence: 0.5,
        source: 'evolve',
        tags: ['testing'],
        createdAt: '2026-07-03T10:00:00.000Z',
        runId: 'run-experience',
      }]),
      search: vi.fn(async () => []),
    };

    const first = await migrateLegacyMemorySources({ repository, memoryStore, experienceStore });
    expect(first).toMatchObject({ completed: true, alreadyCompleted: false, sourceCount: 3, created: 3 });
    expect(await repository.listNodes('long-term')).toHaveLength(1);
    expect(await repository.listNodes('daily')).toHaveLength(1);
    expect(await repository.listNodes('experience')).toHaveLength(1);
    expect((await repository.listNodes('long-term'))[0]?.sourceRefs).toEqual([memoryStore.longTermPath]);
    expect(memoryStore.writeLongTerm).not.toHaveBeenCalled();
    expect(memoryStore.writeDaily).not.toHaveBeenCalled();

    const auditCount = (await repository.snapshot()).writeAudit.length;
    const second = await migrateLegacyMemorySources({ repository, memoryStore, experienceStore });
    expect(second).toMatchObject({ id: LEGACY_MEMORY_MIGRATION_ID, completed: true, alreadyCompleted: true });
    expect((await repository.snapshot()).writeAudit).toHaveLength(auditCount);
    expect(memoryStore.readLongTerm).toHaveBeenCalledTimes(1);
    expect(experienceStore.list).toHaveBeenCalledTimes(1);
  });
});
