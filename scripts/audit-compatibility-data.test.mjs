import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanCompatibilityDataRoot } from './audit-compatibility-data.mjs';

const roots = [];
const SECRET_MARKER = 'synthetic-private-body-must-not-appear';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compatibility data inventory', () => {
  it('reports aggregate compatibility evidence and keeps undecodable records unknown', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ls-lcda02b-'));
    roots.push(parent);
    const dataRoot = join(parent, 'synthetic-data-root');
    const checkpointDir = join(dataRoot, 'run-checkpoints');
    const logDir = join(dataRoot, 'execution-logs');
    const eventRoot = join(dataRoot, 'durable-events');
    const leaseRoot = join(dataRoot, 'durable-run-leases');
    const inboxRoot = join(dataRoot, 'durable-inbox');
    const effectLeaseRoot = join(dataRoot, 'durable-effect-leases');
    const dispositionRoot = join(dataRoot, 'run-checkpoint-dispositions');
    const sessionId = 'synthetic-session';
    const runId = 'synthetic-run';
    const oldRunId = 'synthetic-event-only-run';
    const futureEventRunId = 'synthetic-future-event-run';
    const partitionKey = hashParts(sessionId, runId);
    const oldPartitionKey = hashParts(sessionId, oldRunId);
    const futurePartitionKey = hashParts(sessionId, futureEventRunId);
    const checkpointPath = join(checkpointDir, 'checkpoint-one.json');

    await Promise.all([
      mkdir(checkpointDir, { recursive: true }),
      mkdir(logDir, { recursive: true }),
      mkdir(join(eventRoot, partitionKey), { recursive: true }),
      mkdir(join(eventRoot, oldPartitionKey), { recursive: true }),
      mkdir(join(eventRoot, futurePartitionKey), { recursive: true }),
      mkdir(leaseRoot, { recursive: true }),
      mkdir(inboxRoot, { recursive: true }),
      mkdir(effectLeaseRoot, { recursive: true }),
      mkdir(dispositionRoot, { recursive: true }),
      mkdir(join(dataRoot, 'memory-tree', 'v3', 'atoms'), { recursive: true }),
      mkdir(join(dataRoot, 'memory', 'daily'), { recursive: true }),
    ]);

    await writeFile(checkpointPath, JSON.stringify({
      version: 1,
      currentStage: 'verify',
      taskBook: { title: SECRET_MARKER },
      resumeState: {
        version: 1,
        permissionPolicyId: 'research',
        workPolicyUpgradeRequest: { remainingGoal: SECRET_MARKER },
        replanAttempts: 3,
        maxReplanAttempts: 4,
        deferredRuntimeEvents: [{ payload: { taskBookPatch: { operations: [] } } }],
      },
      runtimeEventQueue: { events: [] },
    }));
    await writeFile(join(checkpointDir, 'unreadable.json'), '{not-json');
    await writeFile(join(checkpointDir, 'future-version.json'), JSON.stringify({ version: 9, currentStage: 'verify' }));
    await writeFile(join(checkpointDir, 'future-stage.json'), JSON.stringify({ version: 1, currentStage: 'new-stage' }));
    await writeFile(join(logDir, 'execution.json'), JSON.stringify({
      inboundText: SECRET_MARKER,
      reply: SECRET_MARKER,
      trace: [{ name: 'verify' }],
      taskBook: { title: SECRET_MARKER },
      modelRequests: [{
        version: 1,
        stage: 'verify',
        messages: [{ content: SECRET_MARKER }],
      }],
    }));
    await writeFile(join(leaseRoot, `${partitionKey}.json`), JSON.stringify({
      version: 1,
      sessionId,
      runId,
      status: 'active',
    }));
    await writeFile(join(inboxRoot, `${hashParts('synthetic-command')}.json`), JSON.stringify({
      version: 1,
      commandId: 'synthetic-command',
      type: 'run_accepted',
      status: 'queued',
      payload: { taskBookPatch: { operations: [] }, text: SECRET_MARKER },
    }));
    await writeFile(join(effectLeaseRoot, `${hashParts('synthetic-effect')}.json`), JSON.stringify({
      version: 1,
      status: 'active',
      ownerToken: SECRET_MARKER,
    }));
    await writeFile(join(effectLeaseRoot, `${hashParts('synthetic-future-effect')}.json`), JSON.stringify({
      version: 9,
      status: 'active',
    }));
    await writeFile(join(dispositionRoot, `${hashParts('synthetic-checkpoint')}.json`), JSON.stringify({
      version: 1,
      status: 'resumed',
      reason: SECRET_MARKER,
    }));
    await writeEvent(eventRoot, partitionKey, sessionId, runId, 'run_accepted', {});
    await writeEvent(eventRoot, oldPartitionKey, sessionId, oldRunId, 'user_input_appended', {
      taskBookPatch: { operations: [] },
      text: SECRET_MARKER,
    });
    await writeEvent(eventRoot, futurePartitionKey, sessionId, futureEventRunId, 'future_event_type', {});
    await writeFile(join(dataRoot, 'sessions.json'), JSON.stringify({
      sessions: [
        { id: 'old', title: SECRET_MARKER, permissionVersion: 1, mode: 'restricted', workspacePath: SECRET_MARKER },
        { id: 'new', title: SECRET_MARKER, permissionVersion: 2, mode: 'workspace-write' },
      ],
    }));
    await writeFile(join(dataRoot, 'memory-tree', 'repository-version.json'), JSON.stringify({
      version: 1,
      activeBackend: 'v3',
      pendingMigration: { phase: 'validating', error: SECRET_MARKER },
      lastMigration: { id: SECRET_MARKER },
    }));
    await writeFile(join(dataRoot, 'memory-tree', 'index.json'), SECRET_MARKER);
    await writeFile(join(dataRoot, 'memory-tree', 'v3', 'catalog.sqlite'), SECRET_MARKER);
    await writeFile(join(dataRoot, 'memory-tree', 'v3', 'atoms', 'atom.synthetic.json'), SECRET_MARKER);
    await writeFile(join(dataRoot, 'MEMORY.md'), SECRET_MARKER);
    await writeFile(join(dataRoot, 'memory', 'daily', '2026-10-16.md'), SECRET_MARKER);

    const originalFiles = await snapshotFiles(dataRoot);
    const report = await scanCompatibilityDataRoot(dataRoot, { repositoryRoot: parent });
    const serialized = JSON.stringify(report);

    expect(report.mode).toBe('dry-run');
    expect(report.stores.checkpoints.records).toBe(3);
    expect(report.stores.checkpoints.unknownRecords).toBe(3);
    expect(report.stores.checkpoints.compatibilityFields).toMatchObject({
      retiredStageOccurrences: 1,
      taskBookRecords: 1,
      workPolicyUpgradeRequestRecords: 1,
      replanAttemptsRecords: 1,
      maxReplanAttemptsRecords: 1,
      permissionV1Values: 1,
      taskBookPatchOccurrences: 1,
      unknownStageOccurrences: 1,
    });
    expect(report.stores.executionLogs.modelRequestSnapshots).toMatchObject({
      records: 1,
      versions: { v1: 1 },
      snapshotsMissingCallContract: 1,
    });
    expect(report.stores.executionLogs.compatibilityFields.retiredStageOccurrences).toBe(2);
    expect(report.stores.durableEvents.taskBookPatchOccurrences).toBe(1);
    expect(report.stores.durableEvents.partitionsWithoutMatchingLease).toBe(1);
    expect(report.stores.durableEvents.eventTypes.unknown).toBe(1);
    expect(report.stores.durableEvents.unknownRecords).toBe(1);
    expect(report.stores.durableInbox).toMatchObject({
      records: 1,
      statusCounts: { queued: 1 },
      typeCounts: { run_accepted: 1 },
      taskBookPatchOccurrences: 1,
    });
    expect(report.stores.durableEffectLeases).toMatchObject({
      records: 2,
      unknownRecords: 1,
      statusCounts: { active: 1 },
    });
    expect(report.stores.checkpointDispositions).toMatchObject({
      records: 1,
      statusCounts: { resumed: 1 },
    });
    expect(report.stores.sessionIndex.legacyPermissionRows).toBe(1);
    expect(report.stores.memory.locator).toMatchObject({
      status: 'readable',
      activeBackend: 'v3',
      pendingMigrationPhase: 'validating',
      lastMigrationPresent: true,
    });
    expect(report.stores.memory.v2Document).toMatchObject({ filePresent: true, status: 'present-uninspected' });
    expect(report.stores.memory.v3RecordFiles.atoms).toBe(1);
    expect(report.stores.memory.legacyFileStores).toMatchObject({ longTermFilePresent: true, dailyFileCount: 1 });
    expect(report.stores.rendererLocalStorage.status).toContain('not-scanned');
    expect(report.stores.durableRunLeases).not.toHaveProperty('leaseKeys');
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(report.guarantees).toMatchObject({ writes: 0, recoveryOrReplay: false, credentialOrContentOutput: false });
    expect(await snapshotFiles(dataRoot)).toEqual(originalFiles);
  });

  it('requires an explicit root and rejects an unapproved root outside the repository boundary', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ls-lcda02b-boundary-'));
    roots.push(parent);
    const repository = join(parent, 'repository');
    const outside = join(parent, 'outside');
    await mkdir(repository);
    await mkdir(outside);

    await expect(scanCompatibilityDataRoot(undefined, { repositoryRoot: repository }))
      .rejects.toThrow('explicit --data-root');
    await expect(scanCompatibilityDataRoot(outside, { repositoryRoot: repository }))
      .rejects.toThrow('outside the repository');
    await expect(scanCompatibilityDataRoot(repository, { repositoryRoot: repository }))
      .resolves.toMatchObject({ mode: 'dry-run', dataRoot: 'explicit; absolute path omitted' });
    const explicitlyAllowed = await scanCompatibilityDataRoot(outside, {
      repositoryRoot: repository,
      allowExternalRoot: true,
    });
    expect(explicitlyAllowed).toMatchObject({ externalRootAllowed: true, mode: 'dry-run' });
    expect(JSON.stringify(explicitlyAllowed)).not.toContain(parent);
  });

  it('counts unmatched event partitions without treating them as proven pre-lease records', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ls-lcda02b-prelease-candidate-'));
    roots.push(parent);
    const dataRoot = join(parent, 'synthetic-data-root');
    const eventsRoot = join(dataRoot, 'durable-events');
    const sessionId = 'synthetic-session';
    const runId = 'synthetic-run-without-lease';
    const partition = hashParts(sessionId, runId);
    await mkdir(join(eventsRoot, partition), { recursive: true });
    await writeEvent(eventsRoot, partition, sessionId, runId, 'run_accepted', {});

    const report = await scanCompatibilityDataRoot(dataRoot, { repositoryRoot: parent });

    expect(report.stores.durableRunLeases.status).toBe('absent');
    expect(report.stores.durableEvents.partitionsWithoutMatchingLease).toBe(1);
    expect(report.stores.durableEvents).not.toHaveProperty('preLeaseRecords');
  });
});

async function writeEvent(root, partition, sessionId, runId, type, payload) {
  const eventId = `${runId}:${type}`;
  const digest = createHash('sha256').update(eventId, 'utf8').digest('hex');
  await writeFile(join(root, partition, `000000000001-${digest}.json`), JSON.stringify({
    version: 1,
    eventId,
    idempotencyKey: eventId,
    sessionId,
    runId,
    cursor: 1,
    type,
    source: 'runtime',
    occurredAt: '2026-10-16T00:00:00.000Z',
    payload,
  }));
}

function hashParts(...parts) {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

async function snapshotFiles(root) {
  const result = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        result.set(`${path.slice(root.length)}\\`, '<directory>');
        pending.push(path);
      }
      else if (entry.isFile()) result.set(path.slice(root.length), await readFile(path, 'utf8'));
    }
  }
  return result;
}
