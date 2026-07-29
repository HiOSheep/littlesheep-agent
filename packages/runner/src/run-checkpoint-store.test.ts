import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSessionId, type RunCheckpoint } from '@littlesheep/types';
import {
  RunCheckpointStore,
  RunCheckpointValidationError,
  type RunCheckpointStoreOptions,
} from './run-checkpoint-store.js';

function checkpoint(id: string, runId = 'run-1', createdAt = '2026-07-18T10:00:00.000Z'): RunCheckpoint {
  return {
    version: 1,
    id,
    runId,
    sessionId: asSessionId(`session-${runId}`),
    status: 'paused',
    currentStage: 'execute',
    currentStepId: 'step-1',
    activeStepIds: ['step-1', 'step-2'],
    taskBookRevision: 1,
    eventCursor: 2,
    pendingEventIds: ['event-3'],
    contextSnapshotIds: ['context-1'],
    sideEffects: [{
      idempotencyKey: 'write:result.txt',
      toolName: 'write',
      status: 'succeeded',
      evidenceRef: 'tool-call-1',
    }],
    loopBudget: {
      attemptsUsed: 1,
      maxAttempts: 3,
      elapsedMs: 500,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
    createdAt,
    reason: 'User paused the active run.',
  };
}

async function tempStore(options: Omit<RunCheckpointStoreOptions, 'rootDir'> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ls-run-checkpoints-'));
  const store = new RunCheckpointStore({ rootDir: dir, ...options });
  await store.initialize();
  return { dir, store };
}

describe('RunCheckpointStore', () => {
  it('writes atomically, uses hashed filenames, and can be read after recreation', async () => {
    const { dir, store } = await tempStore();
    try {
      const source = checkpoint('checkpoint-readable');
      await expect(store.write(source)).resolves.toMatchObject({ kind: 'written' });
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain(source.id);
      expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);

      const reloaded = new RunCheckpointStore({ rootDir: dir });
      expect(await reloaded.read(source.id)).toEqual(source);
      reloaded.dispose();
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('makes same-id writes idempotent and reports conflicting content', async () => {
    const { dir, store } = await tempStore();
    try {
      const source = checkpoint('checkpoint-idempotent');
      expect((await store.write(source)).kind).toBe('written');
      expect((await store.write(structuredClone(source))).kind).toBe('duplicate');
      expect((await store.write({ ...source, reason: 'different content' })).kind).toBe('conflict');
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds global history and per-run history while retaining newest checkpoints', async () => {
    const { dir, store } = await tempStore({ maxCheckpoints: 3, maxPerRun: 2 });
    try {
      await store.write(checkpoint('old-run-1', 'run-1', '2026-07-18T10:00:00.000Z'));
      await store.write(checkpoint('old-run-2', 'run-1', '2026-07-18T10:01:00.000Z'));
      await store.write(checkpoint('new-run-1', 'run-2', '2026-07-18T10:02:00.000Z'));
      await store.write(checkpoint('new-run-2', 'run-2', '2026-07-18T10:03:00.000Z'));

      const all = await store.list();
      expect(all.map((item) => item.id)).toEqual(['new-run-2', 'new-run-1', 'old-run-2']);
      expect(await store.latestForRun('run-1')).toMatchObject({ id: 'old-run-2' });
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('diagnoses corrupt, incompatible, and temporary files without blocking valid reads', async () => {
    const { dir, store } = await tempStore();
    try {
      const valid = checkpoint('valid-after-corruption');
      await store.write(valid);
      const validFile = (await readdir(dir)).find((file) => file.endsWith('.json'))!;
      await writeFile(join(dir, validFile), '{not-json', 'utf8');
      await writeFile(join(dir, 'not-a-checkpoint.json'), JSON.stringify({ version: 99 }), 'utf8');
      await writeFile(join(dir, 'unfinished.tmp'), 'partial', 'utf8');

      expect(await store.read(valid.id)).toBeNull();
      expect(await store.list()).toEqual([]);
      const diagnostics = store.diagnostics();
      expect(diagnostics.invalidFiles).toBeGreaterThan(0);
      expect(diagnostics.diagnostics.some((item) => item.kind === 'corrupt')).toBe(true);

      const reloaded = new RunCheckpointStore({ rootDir: dir });
      await reloaded.initialize();
      expect(reloaded.diagnostics().diagnostics.some((item) => item.kind === 'temporary')).toBe(true);
      reloaded.dispose();
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent writes and leaves no unbounded write registry', async () => {
    const { dir, store } = await tempStore({ maxCheckpoints: 32, maxPerRun: 32 });
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) => store.write(
          checkpoint(`concurrent-${index}`, `run-${index}`, `2026-07-18T10:${String(index).padStart(2, '0')}:00.000Z`),
        )),
      );
      expect(outcomes.every((outcome) => outcome.kind === 'written')).toBe(true);
      expect(await store.list({ limit: 20 })).toHaveLength(12);
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid checkpoint payloads before touching disk', async () => {
    const { dir, store } = await tempStore();
    try {
      await expect(store.write({ ...checkpoint('invalid'), taskBookRevision: -1 })).rejects.toBeInstanceOf(RunCheckpointValidationError);
      await expect(store.write({
        ...checkpoint('too-many-active-steps'),
        activeStepIds: ['step-1', 'step-2', 'step-3', 'step-4', 'step-5'],
      })).rejects.toBeInstanceOf(RunCheckpointValidationError);
      expect((await readdir(dir))).toEqual([]);
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
