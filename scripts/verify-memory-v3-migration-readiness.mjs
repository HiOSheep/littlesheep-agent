import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MEMORY_REPOSITORY_LOCATOR_FILE,
  MemoryAtomStore,
  MemoryRepository,
  MemoryV2ToV3MigrationManager,
} from '../packages/memory-tree/dist/index.js';

const args = parseArgs(process.argv.slice(2));
const sourceDataDir = resolve(args.dataDir);
const sourceMemoryDir = join(sourceDataDir, 'memory-tree');
const isolatedDataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-readiness-'));
const isolatedMemoryDir = join(isolatedDataDir, 'memory-tree');
const startedAt = performance.now();
assertIsolatedRoot(isolatedDataDir);

let repository;
let report;
try {
  const sourceManager = new MemoryV2ToV3MigrationManager({ dataDir: sourceDataDir });
  const sourceBefore = await sourceManager.preflight();
  assertPreflightReady(sourceBefore, 'source');

  await cp(sourceMemoryDir, isolatedMemoryDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => shouldCopyMemoryV2Path(sourceMemoryDir, source),
  });

  const isolatedManager = new MemoryV2ToV3MigrationManager({ dataDir: isolatedDataDir });
  const isolatedBefore = await isolatedManager.preflight();
  assertPreflightReady(isolatedBefore, 'isolated copy');
  assertSameSource(sourceBefore, isolatedBefore, 'The isolated Memory v2 copy differs from its source.');

  const sourceAfterCopy = await sourceManager.preflight();
  assertSameSource(sourceBefore, sourceAfterCopy, 'Memory v2 changed while its isolated copy was created.');

  const migrated = await isolatedManager.migrate();
  assert.equal(migrated.locator.activeBackend, 'v3');
  assert.equal(migrated.migration.sourceIndexHash, sourceBefore.source.indexHash);
  assert.equal(migrated.migration.sourceManifestHash, sourceBefore.source.manifestHash);
  assert.equal(migrated.migration.nodeCount, sourceBefore.source.nodeCount);
  assert.equal(migrated.migration.resourceCount, sourceBefore.source.resourceCount);

  repository = new MemoryRepository({ dataDir: isolatedDataDir, backend: 'v3' });
  await repository.initialize();
  const firstSnapshot = await repository.snapshot();
  const firstStatus = await repository.management.status();
  const firstAtomMetrics = await assertV3Repository(firstSnapshot, firstStatus, sourceBefore);
  repository.close();
  repository = undefined;

  repository = new MemoryRepository({ dataDir: isolatedDataDir, backend: 'v3' });
  await repository.initialize();
  const restartSnapshot = await repository.snapshot();
  const restartStatus = await repository.management.status();
  const restartAtomMetrics = await assertV3Repository(restartSnapshot, restartStatus, sourceBefore);
  assert.deepEqual(restartAtomMetrics, firstAtomMetrics);
  repository.close();
  repository = undefined;

  const rolledBack = await isolatedManager.rollback();
  assert.equal(rolledBack.activeBackend, 'v2');
  assert.equal(rolledBack.previousBackend, 'v3');
  const isolatedAfterRollback = await isolatedManager.preflight();
  assertPreflightReady(isolatedAfterRollback, 'rolled-back isolated copy');
  assertSameSource(sourceBefore, isolatedAfterRollback, 'Rollback changed the isolated Memory v2 source.');

  const sourceAfterVerification = await sourceManager.preflight();
  assertSameSource(
    sourceBefore,
    sourceAfterVerification,
    'Memory v2 changed while migration readiness was being verified.',
  );

  report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    source: {
      fileCount: sourceBefore.source.fileCount,
      totalBytes: sourceBefore.source.totalBytes,
      nodeCount: sourceBefore.source.nodeCount,
      resourceCount: sourceBefore.source.resourceCount,
      indexHash: sourceBefore.source.indexHash,
      manifestHash: sourceBefore.source.manifestHash,
    },
    storage: sourceBefore.storage,
    migration: {
      validationHash: migrated.migration.validationHash,
      activeBackendVerified: 'v3',
      restartVerified: true,
      catalogIntegrity: restartStatus.catalog?.integrity,
      catalogAtomCount: restartStatus.catalog?.atomCount,
      publicAtomCount: restartAtomMetrics.publicAtomCount,
      internalRootCount: restartAtomMetrics.internalRootCount,
      rollbackVerified: true,
    },
    sourceUnchanged: true,
    isolatedCloneRemoved: true,
    timingMs: Math.round(performance.now() - startedAt),
  };
} finally {
  repository?.close();
  await rm(isolatedDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function assertPreflightReady(preflight, label) {
  assert.equal(preflight.locator.activeBackend, 'v2', `${label} is not using Memory v2.`);
  assert.equal(preflight.canMigrate, true, preflight.blockers.join('; ') || `${label} cannot migrate.`);
  assert.deepEqual(preflight.blockers, []);
  assert(preflight.source, `${label} has no readable Memory v2 source.`);
  assert(preflight.storage, `${label} has no storage readiness evidence.`);
}

function assertSameSource(expected, actual, message) {
  assert(expected.source && actual.source, message);
  assert.deepEqual(actual.source, expected.source, message);
}

async function assertV3Repository(snapshot, status, sourcePreflight) {
  const nodeCount = Object.values(snapshot.nodes).filter((node) => !node.isBranchRoot).length;
  const resourceCount = Object.keys(snapshot.resources).length;
  assert.equal(status.backendKind, 'v3');
  assert.equal(status.storageKind, 'atom-catalog');
  assert.equal(status.catalog?.integrity, 'ok');
  assert.equal(nodeCount, sourcePreflight.source.nodeCount);
  assert.equal(resourceCount, sourcePreflight.source.resourceCount);
  const atomStore = new MemoryAtomStore({ dataDir: isolatedDataDir });
  const scan = await atomStore.initialize();
  assert.deepEqual(scan.issues, []);
  const publicAtomIds = new Set(
    Object.values(snapshot.nodes)
      .filter((node) => !node.isBranchRoot)
      .map((node) => node.id),
  );
  const internalRoots = scan.entries.filter((entry) => isInternalScopeRoot(entry.id));
  const unexpected = scan.entries.filter((entry) => (
    !publicAtomIds.has(entry.id) && !isInternalScopeRoot(entry.id)
  ));
  assert.deepEqual(unexpected.map((entry) => entry.id), []);
  assert.equal(scan.entries.length, publicAtomIds.size + internalRoots.length);
  assert.equal(status.catalog?.atomCount, scan.entries.length);
  return {
    publicAtomCount: publicAtomIds.size,
    internalRootCount: internalRoots.length,
    totalAtomCount: scan.entries.length,
  };
}

function isInternalScopeRoot(atomId) {
  return atomId.startsWith('v3-scope-root:')
    || ['long-term:root', 'daily:root', 'project:root', 'experience:root'].includes(atomId);
}

function shouldCopyMemoryV2Path(root, source) {
  const path = relative(root, source).replace(/\\/gu, '/');
  if (!path) return true;
  const first = path.split('/')[0];
  return first !== 'v3'
    && first !== 'migrations'
    && path !== MEMORY_REPOSITORY_LOCATOR_FILE;
}

function assertIsolatedRoot(path) {
  const normalized = resolve(path);
  const tempRoot = resolve(tmpdir());
  assert(normalized.startsWith(`${tempRoot}${sep}`));
  assert(normalized.includes('littlesheep-memory-v3-readiness-'));
}

function parseArgs(values) {
  let dataDir = process.env.LITTLESHEEP_DATA_DIR?.trim();
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--data-dir=')) dataDir = value.slice('--data-dir='.length).trim();
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!dataDir) {
    throw new Error('Provide --data-dir=<LittleSheep data root> or LITTLESHEEP_DATA_DIR.');
  }
  return { dataDir };
}
