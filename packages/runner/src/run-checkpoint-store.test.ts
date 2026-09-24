import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSessionId, type RunCheckpoint } from '@littlesheep/types';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
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
      ownerId: 'a'.repeat(64),
      leaseUntil: '2026-07-18T10:00:30.000Z',
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
  it('preserves only the bounded web evidence projection across reload', async () => {
    const { dir, store } = await tempStore();
    try {
      const source = {
        ...checkpoint('checkpoint-web-evidence'),
        webEvidence: {
          version: 1 as const,
          providerId: 'tavily',
          generatedAt: '2026-07-18T10:00:00.000Z',
          completeness: 'complete' as const,
          citationIds: ['web-checkpoint-citation'],
          citations: [{
            id: 'web-checkpoint-citation',
            origin: 'https://example.com',
            url: 'https://example.com/article',
            urlHash: 'a'.repeat(64),
            title: 'Checkpoint source',
            fetchedAt: '2026-07-18T10:00:00.000Z',
            status: 'fetched' as const,
            truncated: false,
          }],
          citationCount: 1,
          documentCount: 1,
          cached: false,
          partial: false,
          truncated: false,
          blocked: false,
          stale: false,
        },
      };
      await expect(store.write(source)).resolves.toMatchObject({ kind: 'written' });
      const reloaded = new RunCheckpointStore({ rootDir: dir });
      await expect(reloaded.read(source.id)).resolves.toMatchObject({
        webEvidence: {
          citationIds: ['web-checkpoint-citation'],
          citationCount: 1,
          documentCount: 1,
        },
      });
      reloaded.dispose();
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('round-trips promotion identity and the exhausted progress budget without resetting either', async () => {
    const { dir, store } = await tempStore();
    try {
      const source: RunCheckpoint = {
        ...checkpoint('checkpoint-promotion'),
        loopBudget: {
          ...checkpoint('checkpoint-promotion-budget').loopBudget,
          noProgressRounds: 2,
          toolLoopIterationsUsed: 7,
          maxToolLoopIterations: 20,
          evidenceFingerprints: ['a'.repeat(64), 'b'.repeat(64)],
          evidenceFingerprintSaturated: true,
        },
        resumeState: {
          version: 1,
          inboundMessageId: 'message-1',
          cwd: 'D:/workspace',
          model: 'test-model',
          origin: 'test',
          permissionPolicyId: 'research',
          reasoning: 'medium',
          behaviorModeId: 'general',
          availableToolNames: ['read', 'write'],
          attachmentCount: 0,
          appliedTaskBookPatchIds: [],
          deferredRuntimeEvents: [],
          recoveryAttempts: 0,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
          workPolicyUpgradeRequest: {
            version: 1,
            id: 'upgrade-1',
            runId: 'run-1',
            sourceMessageId: 'message-1',
            goalVersion: 1,
            requestedAt: '2026-09-13T00:00:00.000Z',
            reasonCode: 'dependency_discovered',
            reason: 'A dependent change remains.',
            remainingGoal: 'Complete the dependent change.',
            completedToolCallIds: ['call-1'],
            pendingToolCallIds: [],
            completedEffectRefs: [],
            modelAttemptsUsed: 3,
            budget: {
              maxModelAttempts: 64,
              toolLoopIterationsUsed: 7,
              maxToolLoopIterations: 20,
              noProgressRounds: 2,
            },
          },
        },
      };

      await store.write(source);
      const restored = await store.read(source.id);
      expect(restored?.resumeState?.workPolicyUpgradeRequest).toEqual(source.resumeState?.workPolicyUpgradeRequest);
      expect(restored?.loopBudget).toMatchObject({
        noProgressRounds: 2,
        toolLoopIterationsUsed: 7,
        evidenceFingerprintSaturated: true,
        evidenceFingerprints: ['a'.repeat(64), 'b'.repeat(64)],
      });
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits undefined object fields instead of persisting them as null', async () => {
    const { dir, store } = await tempStore();
    try {
      const source = {
        ...checkpoint('checkpoint-json-semantics'),
        runtimeControl: {
          version: 1 as const,
          state: 'running' as const,
          changedAt: '2026-07-18T10:00:00.000Z',
          reason: undefined,
          eventIds: [],
        },
      };
      await store.write(source);
      const file = (await readdir(dir)).find((entry) => entry.endsWith('.json'))!;
      const raw = await readFile(join(dir, file), 'utf8');
      expect(raw).not.toContain('"reason":null');
      expect(JSON.parse(raw).runtimeControl).not.toHaveProperty('reason');
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

  it('retains disposition-protected checkpoint ids and active resume runs beyond ordinary history limits', async () => {
    const protectedIds = new Set<string>(['active-source'])
    const protectedRunIds = new Set<string>(['active-resume'])
    const { dir, store } = await tempStore({
      maxCheckpoints: 2,
      maxPerRun: 1,
      protectedCheckpointIds: async () => protectedIds,
      protectedRunIds: async () => protectedRunIds,
    });
    try {
      await store.write(checkpoint('active-source', 'source-run', '2026-07-18T09:00:00.000Z'));
      await store.write(checkpoint('active-started', 'active-resume', '2026-07-18T09:01:00.000Z'));
      await store.write(checkpoint('active-finished', 'active-resume', '2026-07-18T09:02:00.000Z'));
      await store.write(checkpoint('history-1', 'history-1', '2026-07-18T10:01:00.000Z'));
      await store.write(checkpoint('history-2', 'history-2', '2026-07-18T10:02:00.000Z'));
      await store.write(checkpoint('history-3', 'history-3', '2026-07-18T10:03:00.000Z'));

      await expect(store.read('active-source')).resolves.toMatchObject({ id: 'active-source' });
      await expect(store.read('active-started')).resolves.toMatchObject({ id: 'active-started' });
      await expect(store.read('active-finished')).resolves.toMatchObject({ id: 'active-finished' });
      await expect(store.read('history-1')).resolves.toBeNull();

      protectedIds.clear();
      protectedRunIds.clear();
      await store.prune();
      await expect(store.read('active-source')).resolves.toBeNull();
      expect((await readdir(dir)).filter((file) => file.endsWith('.json'))).toHaveLength(2);
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips pruning when protected checkpoint resolution is unavailable', async () => {
    const { dir, store } = await tempStore({
      maxCheckpoints: 1,
      protectedCheckpointIds: async () => { throw new Error('disposition store unavailable') },
    });
    try {
      await store.write(checkpoint('retained-old', 'run-old', '2026-07-18T10:00:00.000Z'));
      await store.write(checkpoint('retained-new', 'run-new', '2026-07-18T10:01:00.000Z'));

      await expect(store.read('retained-old')).resolves.toMatchObject({ id: 'retained-old' });
      await expect(store.read('retained-new')).resolves.toMatchObject({ id: 'retained-new' });
      expect(store.diagnostics().diagnostics.some((item) => (
        item.kind === 'io' && item.message.includes('pruning skipped')
      ))).toBe(true);
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

  it('reports one unreadable record once, however often the directory is checked', async () => {
    const { dir, store } = await tempStore();
    try {
      await store.write(checkpoint('readable'));
      await writeFile(join(dir, 'unreadable.json'), '{not-json', 'utf8');

      // Three checks of the same directory: the counts used to accumulate for the
      // whole process, so a user who retried the startup discovery was told there
      // were two, then three, unreadable records for one broken file.
      for (let check = 0; check < 3; check += 1) {
        expect(await store.list()).toHaveLength(1);
        expect(store.diagnostics().invalidFiles).toBe(1);
      }
      const diagnostics = store.diagnostics();
      expect(diagnostics.readFiles).toBe(2);
      expect(diagnostics.validFiles).toBe(1);
      expect(diagnostics.warningFindings).toEqual([]);
      expect(diagnostics.diagnostics.filter((item) => item.kind === 'corrupt')).toHaveLength(1);
      expect(await store.read('readable')).not.toBeNull();
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps startup and pruning findings out of the per-record counts', async () => {
    const { dir, store } = await tempStore();
    try {
      await writeFile(join(dir, 'leftover.tmp'), 'partial', 'utf8');
      const reloaded = new RunCheckpointStore({ rootDir: dir });
      await reloaded.initialize();
      const diagnostics = reloaded.diagnostics();

      expect(diagnostics.invalidFiles).toBe(0);
      expect(diagnostics.warningFindings.some((item) => item.kind === 'temporary')).toBe(true);
      // A stale temporary file is not a recovery record, so it must not appear as
      // one of the unreadable records the desktop surface counts.
      expect(diagnostics.diagnostics.some((item) => item.kind === 'temporary')).toBe(true);
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

  it('enforces the current snapshot window for new writes', async () => {
    const { dir, store } = await tempStore();
    try {
      const oversized = {
        ...checkpoint('oversized-snapshot-write'),
        contextSnapshotIds: Array.from(
          { length: MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN + 1 },
          (_, index) => `context-${index}`,
        ),
      };
      await expect(store.write(oversized)).rejects.toThrow(/contextSnapshotIds.*limit/);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the legacy read boundary for pre-5M checkpoints', async () => {
    const { dir, store } = await tempStore();
    try {
      const legacy = {
        ...checkpoint('legacy-snapshot-window'),
        contextSnapshotIds: Array.from({ length: 128 }, (_, index) => `legacy-context-${index}`),
      };
      const hash = (await import('node:crypto')).createHash('sha256')
        .update(legacy.id, 'utf8')
        .digest('hex');
      await writeFile(join(dir, `${hash}.json`), JSON.stringify(legacy), 'utf8');

      const loaded = await store.read(legacy.id);
      expect(loaded?.contextSnapshotIds).toHaveLength(128);
      expect(loaded?.contextSnapshotIds.at(-1)).toBe('legacy-context-127');
    } finally {
      store.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
