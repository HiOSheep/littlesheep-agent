#!/usr/bin/env node
// Read-only, aggregate-only inventory for an explicitly selected LS data root.
// This tool never discovers a user root, initializes stores, resumes runs, or writes files.

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const MAX_ENTRIES_PER_DIRECTORY = 50_000;
const MAX_JSON_FILE_BYTES = 8 * 1024 * 1024;
const RETIRED_STAGES = new Set(['decide', 'verify', 'evolve', 'capture']);
const CURRENT_STAGES = new Set(['enter', 'classify', 'execute', 'recover', 'reply', 'ask_user', 'finalize']);
const LEGACY_PERMISSION_IDS = new Set(['full', 'research', 'restricted']);
const DURABLE_EVENT_TYPES = new Set([
  'run_accepted', 'user_input_appended', 'capability_snapshot_read', 'capability_probe_settled',
  'stage_transition_recorded', 'route_decided', 'model_request_started', 'model_response_received',
  'provider_usage_recorded', 'model_request_settled', 'tool_call_proposed', 'effect_intent_created',
  'effect_settled', 'verification_recorded', 'checkpoint_written', 'final_reply_proposed',
  'final_reply_settled', 'runtime_status_settled', 'run_failed', 'run_interrupted', 'run_completed',
]);
const KNOWN_MIGRATION_PHASES = new Set([
  'requested', 'snapshot', 'building', 'validating', 'ready', 'committing', 'recovery',
]);
const KNOWN_ROLLBACK_PHASES = new Set(['requested', 'validating', 'committing', 'recovery']);
const INBOX_STATUSES = new Set(['queued', 'claimed', 'completed', 'failed']);
const LEASE_STATUSES = new Set(['active', 'released']);
const CHECKPOINT_DISPOSITION_STATUSES = new Set([
  'resuming', 'interrupted', 'resumed', 'completed', 'abandoned', 'deferred',
]);
const EVENT_FILE_PATTERN = /^\d{12}-[a-f0-9]{64}\.json$/u;
const HASHED_JSON_PATTERN = /^[a-f0-9]{64}\.json$/u;
const STORE_JSON_PATTERN = /^[^\\/:*?"<>|]{1,512}\.json$/u;

/**
 * Resolve and constrain the requested root before opening any data file.
 * The CLI is repo-scoped by default. An external root requires the explicit
 * --allow-external-root switch, and the root still must be named by the caller.
 */
export async function resolveExplicitDataRoot(dataRoot, options = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim().length === 0) {
    throw new Error('an explicit --data-root value is required');
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const requestedRoot = resolve(dataRoot);
  let requestedDetails;
  let canonicalRepositoryRoot;
  let canonicalRoot;
  try {
    requestedDetails = await lstat(requestedRoot);
    canonicalRepositoryRoot = await realpath(repositoryRoot);
    canonicalRoot = await realpath(requestedRoot);
  } catch {
    throw new Error('the explicit data root or repository root is unavailable');
  }
  if (requestedDetails.isSymbolicLink()) {
    throw new Error('the explicit data root cannot be a symbolic link');
  }
  let rootDetails;
  try {
    rootDetails = await lstat(canonicalRoot);
  } catch {
    throw new Error('the explicit data root is unavailable');
  }
  if (!rootDetails.isDirectory()) throw new Error('the explicit data root must be a directory');
  if (!options.allowExternalRoot && !isPathInside(canonicalRepositoryRoot, canonicalRoot)) {
    throw new Error('the explicit data root is outside the repository; external access requires --allow-external-root');
  }
  return { root: canonicalRoot, repositoryRoot: canonicalRepositoryRoot };
}

/**
 * Read only the known LS record locations under an explicit data root.
 * Output values are limited to counts, schema-version buckets and fixed enums.
 */
export async function scanCompatibilityDataRoot(dataRoot, options = {}) {
  const resolved = await resolveExplicitDataRoot(dataRoot, options);
  const root = resolved.root;
  const leaseInventory = await scanRunLeases(root);
  const checkpoints = await scanCheckpoints(root);
  const executionLogs = await scanExecutionLogs(root);
  const durableEvents = await scanDurableEvents(root, leaseInventory);
  const durableInbox = await scanStatusStore(
    root,
    'durable-inbox',
    HASHED_JSON_PATTERN,
    INBOX_STATUSES,
    'type',
    { countTaskBookPatch: true },
  );
  const durableEffectLeases = await scanStatusStore(root, 'durable-effect-leases', HASHED_JSON_PATTERN, LEASE_STATUSES);
  const checkpointDispositions = await scanStatusStore(
    root,
    'run-checkpoint-dispositions',
    HASHED_JSON_PATTERN,
    CHECKPOINT_DISPOSITION_STATUSES,
  );
  const sessionIndex = await scanSessionIndex(root);
  const memory = await scanMemoryMetadata(root);

  return {
    reportVersion: 1,
    mode: 'dry-run',
    dataRoot: 'explicit; absolute path omitted',
    externalRootAllowed: options.allowExternalRoot === true,
    stores: {
      checkpoints,
      executionLogs,
      durableEvents,
      durableRunLeases: publicLeaseInventory(leaseInventory),
      durableInbox,
      durableEffectLeases,
      checkpointDispositions,
      sessionIndex,
      memory,
      rendererLocalStorage: { status: 'not-scanned; separate browser profile boundary' },
    },
    guarantees: {
      writes: 0,
      recoveryOrReplay: false,
      credentialOrContentOutput: false,
      symlinksFollowed: false,
      unknownMeansAbsent: false,
    },
  };
}

async function scanCheckpoints(root) {
  const result = emptyFileStore('run-checkpoints');
  result.compatibilityFields = {
    retiredStageOccurrences: 0,
    taskBookRecords: 0,
    workPolicyUpgradeRequestRecords: 0,
    replanAttemptsRecords: 0,
    maxReplanAttemptsRecords: 0,
    permissionV1Values: 0,
    taskBookPatchOccurrences: 0,
    unknownStageOccurrences: 0,
  };
  const listing = await listDirectFiles(root, 'run-checkpoints', STORE_JSON_PATTERN);
  applyListing(result, listing);
  for (const file of listing.files) {
    const parsed = await readJsonObject(root, file);
    if (!parsed.ok) {
      result.unknownRecords += 1;
      continue;
    }
    const record = parsed.value;
    result.records += 1;
    bumpVersion(result.versions, record.version);
    if (record.version !== 1) {
      result.unknownRecords += 1;
      continue;
    }
    if (typeof record.currentStage !== 'string'
      || (!RETIRED_STAGES.has(record.currentStage) && !CURRENT_STAGES.has(record.currentStage))) {
      result.compatibilityFields.unknownStageOccurrences += 1;
      result.unknownRecords += 1;
    }
    const resume = isRecord(record.resumeState) ? record.resumeState : undefined;
    if (typeof record.currentStage === 'string' && RETIRED_STAGES.has(record.currentStage)) {
      result.compatibilityFields.retiredStageOccurrences += 1;
    }
    if (resume?.lastError?.stage !== undefined) {
      if (typeof resume.lastError.stage === 'string' && RETIRED_STAGES.has(resume.lastError.stage)) {
        result.compatibilityFields.retiredStageOccurrences += 1;
      } else if (typeof resume.lastError.stage !== 'string'
        || !CURRENT_STAGES.has(resume.lastError.stage)) {
        result.compatibilityFields.unknownStageOccurrences += 1;
        result.unknownRecords += 1;
      }
    }
    if (Object.hasOwn(record, 'taskBook')) result.compatibilityFields.taskBookRecords += 1;
    if (resume && Object.hasOwn(resume, 'workPolicyUpgradeRequest')) {
      result.compatibilityFields.workPolicyUpgradeRequestRecords += 1;
    }
    if (resume && Object.hasOwn(resume, 'replanAttempts')) result.compatibilityFields.replanAttemptsRecords += 1;
    if (resume && Object.hasOwn(resume, 'maxReplanAttempts')) result.compatibilityFields.maxReplanAttemptsRecords += 1;
    if (typeof resume?.permissionPolicyId === 'string' && LEGACY_PERMISSION_IDS.has(resume.permissionPolicyId)) {
      result.compatibilityFields.permissionV1Values += 1;
    }
    result.compatibilityFields.taskBookPatchOccurrences += countPatchEvents([
      ...(Array.isArray(resume?.deferredRuntimeEvents) ? resume.deferredRuntimeEvents : []),
      ...(Array.isArray(record.runtimeEventQueue?.events) ? record.runtimeEventQueue.events : []),
    ]);
  }
  finishFileStoreStatus(result);
  return result;
}

async function scanExecutionLogs(root) {
  const result = emptyFileStore('execution-logs');
  result.versions = { unversioned: 0 };
  result.modelRequestSnapshots = { records: 0, versions: {}, unknownRecords: 0, snapshotsMissingCallContract: 0 };
  result.compatibilityFields = {
    retiredStageOccurrences: 0,
    taskBookRecords: 0,
    verificationHistoryRecords: 0,
  };
  const listing = await listDirectFiles(root, 'execution-logs', STORE_JSON_PATTERN);
  applyListing(result, listing);
  for (const file of listing.files) {
    const parsed = await readJsonObject(root, file);
    if (!parsed.ok) {
      result.unknownRecords += 1;
      continue;
    }
    const record = parsed.value;
    result.records += 1;
    result.versions.unversioned += 1;
    if (Array.isArray(record.trace)) {
      for (const entry of record.trace) {
        if (isRecord(entry) && RETIRED_STAGES.has(entry.name)) {
          result.compatibilityFields.retiredStageOccurrences += 1;
        } else if (isRecord(entry) && typeof entry.name === 'string'
          && !CURRENT_STAGES.has(entry.name) && !RETIRED_STAGES.has(entry.name)) {
          result.unknownRecords += 1;
        }
      }
    }
    if (Array.isArray(record.modelRequests)) {
      for (const snapshot of record.modelRequests) {
        if (!isRecord(snapshot)) {
          result.modelRequestSnapshots.unknownRecords += 1;
          continue;
        }
        bumpVersion(result.modelRequestSnapshots.versions, snapshot.version);
        if (snapshot.version !== undefined && snapshot.version !== 1) {
          result.modelRequestSnapshots.unknownRecords += 1;
          continue;
        }
        result.modelRequestSnapshots.records += 1;
        if (!Object.hasOwn(snapshot, 'callContract')) {
          result.modelRequestSnapshots.snapshotsMissingCallContract += 1;
        }
        if (RETIRED_STAGES.has(snapshot.stage)) result.compatibilityFields.retiredStageOccurrences += 1;
        else if (typeof snapshot.stage === 'string' && !CURRENT_STAGES.has(snapshot.stage)) {
          result.modelRequestSnapshots.unknownRecords += 1;
        }
      }
    }
    if (Object.hasOwn(record, 'taskBook')) result.compatibilityFields.taskBookRecords += 1;
    if (Array.isArray(record.verificationHistory)) {
      result.compatibilityFields.verificationHistoryRecords += record.verificationHistory.length;
    }
  }
  finishFileStoreStatus(result);
  return result;
}

async function scanSessionIndex(root) {
  const result = {
    status: 'absent',
    records: 0,
    versions: { v2: 0, v1OrUnversioned: 0, other: 0 },
    legacyPermissionRows: 0,
    unknownRecords: 0,
  };
  const file = join(root, 'sessions.json');
  const read = await readJsonObject(root, file, { missingIsAbsent: true });
  if (read.missing) return result;
  if (!read.ok || !Array.isArray(read.value.sessions)) {
    result.status = 'unknown';
    result.unknownRecords = 1;
    return result;
  }
  result.status = 'complete';
  for (const session of read.value.sessions) {
    if (!isRecord(session)) {
      result.unknownRecords += 1;
      continue;
    }
    result.records += 1;
    if (session.permissionVersion === 2) result.versions.v2 += 1;
    else if (session.permissionVersion === 1 || session.permissionVersion === undefined) result.versions.v1OrUnversioned += 1;
    else result.versions.other += 1;
    if ((session.permissionVersion !== 2 || !isV2PermissionSelection(session.mode))
      && typeof session.mode === 'string' && LEGACY_PERMISSION_IDS.has(session.mode)) {
      result.legacyPermissionRows += 1;
    }
  }
  return result;
}

async function scanRunLeases(root) {
  const result = emptyFileStore('durable-run-leases');
  result.status = 'absent';
  result.recordsByStatus = { active: 0, released: 0, other: 0 };
  result.leaseKeys = new Set();
  const listing = await listDirectFiles(root, 'durable-run-leases', HASHED_JSON_PATTERN);
  applyListing(result, listing);
  if (listing.status === 'absent') return result;
  for (const file of listing.files) {
    const parsed = await readJsonObject(root, file);
    if (!parsed.ok) {
      result.unknownRecords += 1;
      continue;
    }
    const record = parsed.value;
    bumpVersion(result.versions, record.version);
    if (record.version !== 1) {
      result.unknownRecords += 1;
      continue;
    }
    if (typeof record.sessionId !== 'string' || typeof record.runId !== 'string') {
      result.unknownRecords += 1;
      continue;
    }
    result.records += 1;
    if (record.status === 'active' || record.status === 'released') result.recordsByStatus[record.status] += 1;
    else result.recordsByStatus.other += 1;
    result.leaseKeys.add(hashParts(record.sessionId, record.runId));
  }
  result.status = result.unknownRecords > 0 || result.unknownEntries > 0 || result.truncated ? 'partial' : 'complete';
  return result;
}

async function scanStatusStore(root, relativeDirectory, pattern, allowedStatuses, enumField, options = {}) {
  const result = emptyFileStore(relativeDirectory);
  result.statusCounts = {};
  if (enumField === 'type') result.typeCounts = {};
  if (options.countTaskBookPatch) result.taskBookPatchOccurrences = 0;
  const listing = await listDirectFiles(root, relativeDirectory, pattern);
  applyListing(result, listing);
  for (const file of listing.files) {
    const parsed = await readJsonObject(root, file);
    if (!parsed.ok) {
      result.unknownRecords += 1;
      continue;
    }
    const record = parsed.value;
    result.records += 1;
    bumpVersion(result.versions, record.version);
    if (record.version !== 1) {
      result.unknownRecords += 1;
      continue;
    }
    if (typeof record.status === 'string' && allowedStatuses.has(record.status)) {
      result.statusCounts[record.status] = (result.statusCounts[record.status] ?? 0) + 1;
    } else {
      result.statusCounts.unknown += 1;
    }
    if (enumField === 'type') {
      if (typeof record.type === 'string' && DURABLE_EVENT_TYPES.has(record.type)) {
        result.typeCounts[record.type] = (result.typeCounts[record.type] ?? 0) + 1;
      } else {
        result.typeCounts.unknown = (result.typeCounts.unknown ?? 0) + 1;
      }
    }
    if (options.countTaskBookPatch && isRecord(record.payload)) {
      result.taskBookPatchOccurrences += countPatchEvents([{ payload: record.payload }]);
    }
  }
  finishFileStoreStatus(result);
  return result;
}

async function scanDurableEvents(root, leaseInventory) {
  const result = {
    store: 'durable-events',
    status: 'absent',
    partitions: 0,
    records: 0,
    versions: {},
    eventTypes: {},
    taskBookPatchOccurrences: 0,
    partitionsWithoutMatchingLease: null,
    unknownRecords: 0,
    unknownEntries: 0,
    truncated: false,
  };
  const directory = await resolveStoreDirectory(root, 'durable-events');
  if (directory.status === 'absent') return result;
  if (directory.status !== 'complete') {
    result.status = 'unknown';
    result.unknownEntries += 1;
    return result;
  }
  result.status = 'complete';
  const entries = await safeReadDirectory(root, directory.path);
  if (!entries.ok) {
    result.status = 'unknown';
    result.unknownEntries += 1;
    return result;
  }
  if (entries.entries.length > MAX_ENTRIES_PER_DIRECTORY) {
    result.truncated = true;
    result.unknownEntries += entries.entries.length - MAX_ENTRIES_PER_DIRECTORY;
  }
  const leaseKeysUsable = leaseInventory.status === 'complete' || leaseInventory.status === 'absent';
  const partitionsWithoutLease = new Set();
  for (const entry of entries.entries.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
    if (!/^[a-f0-9]{64}$/u.test(entry.name)) {
      if (entry.name.startsWith('usage-pending-') || entry.name.startsWith('.')) continue;
      result.unknownEntries += 1;
      continue;
    }
    const partitionPath = join(directory.path, entry.name);
    const partition = await resolveDirectoryInsideRoot(root, partitionPath);
    if (partition.status !== 'complete') {
      result.unknownEntries += 1;
      continue;
    }
    const files = await safeReadDirectory(root, partition.path);
    if (!files.ok) {
      result.unknownEntries += 1;
      continue;
    }
    let partitionIdentity;
    let partitionWasValid = true;
    const eventFiles = files.entries.filter((item) => EVENT_FILE_PATTERN.test(item.name));
    if (files.entries.length > MAX_ENTRIES_PER_DIRECTORY) {
      result.truncated = true;
      result.unknownEntries += files.entries.length - MAX_ENTRIES_PER_DIRECTORY;
    }
    for (const file of eventFiles.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
      const parsed = await readJsonObject(root, join(partition.path, file.name));
      if (!parsed.ok) {
        result.unknownRecords += 1;
        partitionWasValid = false;
        continue;
      }
      const record = parsed.value;
      if (typeof record.sessionId !== 'string' || typeof record.runId !== 'string'
        || typeof record.type !== 'string' || record.version !== 1) {
        result.unknownRecords += 1;
        partitionWasValid = false;
        continue;
      }
      const identity = `${record.sessionId}\u0000${record.runId}`;
      if (partitionIdentity !== undefined && partitionIdentity !== identity) {
        result.unknownRecords += 1;
        partitionWasValid = false;
        continue;
      }
      partitionIdentity = identity;
      result.records += 1;
      bumpVersion(result.versions, record.version);
      const eventType = safeEventType(record.type);
      if (eventType) result.eventTypes[eventType] = (result.eventTypes[eventType] ?? 0) + 1;
      else {
        result.eventTypes.unknown = (result.eventTypes.unknown ?? 0) + 1;
        result.unknownRecords += 1;
        partitionWasValid = false;
      }
      if (isRecord(record.payload)
        && (Object.hasOwn(record.payload, 'taskBookPatch') || Object.hasOwn(record.payload, 'patch'))) {
        result.taskBookPatchOccurrences += 1;
      }
      if (hashParts(record.sessionId, record.runId) !== entry.name) {
        result.unknownRecords += 1;
        partitionWasValid = false;
      }
    }
    if (eventFiles.length > 0) {
      if (partitionWasValid && partitionIdentity !== undefined) {
        result.partitions += 1;
        if (leaseKeysUsable && !leaseInventory.leaseKeys.has(hashParts(...partitionIdentity.split('\u0000')))) {
          partitionsWithoutLease.add(entry.name);
        }
      } else {
        result.unknownEntries += 1;
      }
    }
    for (const file of files.entries) {
      if (!EVENT_FILE_PATTERN.test(file.name) && !file.name.startsWith('.')) result.unknownEntries += 1;
    }
  }
  if (leaseKeysUsable && !result.truncated) result.partitionsWithoutMatchingLease = partitionsWithoutLease.size;
  if (result.unknownEntries > 0 || result.unknownRecords > 0 || result.truncated) result.status = 'partial';
  return result;
}

async function scanMemoryMetadata(root) {
  const memoryRoot = 'memory-tree';
  const locatorRead = await readJsonObject(root, join(root, memoryRoot, 'repository-version.json'), { missingIsAbsent: true });
  const locator = locatorRead.ok ? locatorRead.value : undefined;
  const locatorValid = isRecord(locator) && locator.version === 1
    && (locator.activeBackend === 'v2' || locator.activeBackend === 'v3');
  const memory = {
    locator: locatorRead.missing
      ? { status: 'absent' }
      : !locatorValid
        ? { status: 'unknown' }
        : {
            status: 'readable',
            version: 'v1',
            activeBackend: locator.activeBackend,
            previousBackend: locator.previousBackend === 'v2' || locator.previousBackend === 'v3' ? locator.previousBackend : 'unknown',
            pendingMigrationPhase: fixedPhase(locator.pendingMigration?.phase, KNOWN_MIGRATION_PHASES),
            pendingRollbackPhase: fixedPhase(locator.pendingRollback?.phase, KNOWN_ROLLBACK_PHASES),
            lastMigrationPresent: isRecord(locator.lastMigration),
          },
    v2Document: { status: 'not-opened; memory content excluded', filePresent: false },
    v3Catalog: { status: 'not-opened; binary catalog excluded', filePresent: false },
    v3RecordFiles: {},
    legacyFileStores: { longTermFilePresent: false, dailyFileCount: 0, experienceDirectoryPresent: false },
    unknownEntries: 0,
    truncated: false,
  };

  const v2File = await inspectFileMetadata(root, join(memoryRoot, 'index.json'));
  memory.v2Document = { status: v2File.status === 'present' ? 'present-uninspected' : v2File.status, filePresent: v2File.status === 'present' };
  const catalogFile = await inspectFileMetadata(root, join(memoryRoot, 'v3', 'catalog.sqlite'));
  memory.v3Catalog = { status: catalogFile.status === 'present' ? 'present-uninspected' : catalogFile.status, filePresent: catalogFile.status === 'present' };

  const legacyMemory = await resolveStoreDirectory(root, 'memory');
  if (legacyMemory.status === 'complete') {
    const oldLongTerm = await inspectFileMetadata(root, 'MEMORY.md');
    memory.legacyFileStores.longTermFilePresent = oldLongTerm.status === 'present';
    const daily = await countFilesWithoutOpening(root, join('memory', 'daily'), name => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name));
    memory.legacyFileStores.dailyFileCount = daily.count;
    memory.unknownEntries += daily.unknownEntries;
    memory.truncated ||= daily.truncated;
  }
  const experience = await resolveStoreDirectory(root, 'experience');
  memory.legacyFileStores.experienceDirectoryPresent = experience.status === 'complete';

  for (const [label, relativePath] of [
    ['atoms', join(memoryRoot, 'v3', 'atoms')],
    ['rawRecords', join(memoryRoot, 'v3', 'raw-records')],
    ['events', join(memoryRoot, 'v3', 'events')],
    ['operations', join(memoryRoot, 'v3', 'operations')],
    ['graphEntities', join(memoryRoot, 'v3', 'graph', 'entities')],
    ['graphRelations', join(memoryRoot, 'v3', 'graph', 'relations')],
    ['repositoryLedger', join(memoryRoot, 'v3', 'repository')],
    ['resources', join(memoryRoot, 'v3', 'resources')],
    ['conversationSources', join(memoryRoot, 'v3', 'conversation-sources')],
    ['migrationWorkspaces', join(memoryRoot, 'migrations')],
  ]) {
    const counts = await countFilesWithoutOpening(root, relativePath, () => true, { recursive: true });
    memory.v3RecordFiles[label] = counts.count;
    memory.unknownEntries += counts.unknownEntries;
    memory.truncated ||= counts.truncated;
  }
  if (!locatorRead.ok && !locatorRead.missing) memory.unknownEntries += 1;
  return memory;
}

async function countFilesWithoutOpening(root, relativePath, includeName, options = {}) {
  const result = { count: 0, unknownEntries: 0, truncated: false };
  const resolved = await resolveStoreDirectory(root, relativePath);
  if (resolved.status === 'absent') return result;
  if (resolved.status !== 'complete') {
    result.unknownEntries += 1;
    return result;
  }
  const pending = [{ path: resolved.path, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const listing = await safeReadDirectory(root, current.path);
    if (!listing.ok) {
      result.unknownEntries += 1;
      continue;
    }
    for (const entry of listing.entries) {
      visited += 1;
      if (visited > MAX_ENTRIES_PER_DIRECTORY) {
        result.truncated = true;
        result.unknownEntries += 1;
        return result;
      }
      const child = join(current.path, entry.name);
      const details = await safeLstat(root, child);
      if (!details.ok || details.details.isSymbolicLink()) {
        result.unknownEntries += 1;
        continue;
      }
      if (details.details.isFile()) {
        if (includeName(entry.name)) result.count += 1;
        continue;
      }
      if (details.details.isDirectory()) {
        if (options.recursive && current.depth < 5) pending.push({ path: child, depth: current.depth + 1 });
        else if (options.recursive) result.unknownEntries += 1;
      } else result.unknownEntries += 1;
    }
  }
  return result;
}

async function listDirectFiles(root, relativeDirectory, pattern) {
  const directory = await resolveStoreDirectory(root, relativeDirectory);
  if (directory.status !== 'complete') return { status: directory.status, files: [], unknownEntries: directory.status === 'absent' ? 0 : 1, truncated: false };
  const listing = await safeReadDirectory(root, directory.path);
  if (!listing.ok) return { status: 'unknown', files: [], unknownEntries: 1, truncated: false };
  const files = [];
  let unknownEntries = 0;
  for (const entry of listing.entries.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
    if (!pattern.test(entry.name)) {
      if (!entry.name.startsWith('.') && !entry.name.endsWith('.tmp')) unknownEntries += 1;
      continue;
    }
    const candidate = join(directory.path, entry.name);
    const details = await safeLstat(root, candidate);
    if (!details.ok || !details.details.isFile() || details.details.isSymbolicLink()) {
      unknownEntries += 1;
      continue;
    }
    files.push(candidate);
  }
  const truncated = listing.entries.length > MAX_ENTRIES_PER_DIRECTORY;
  if (truncated) unknownEntries += listing.entries.length - MAX_ENTRIES_PER_DIRECTORY;
  return { status: 'complete', files, unknownEntries, truncated };
}

function applyListing(target, listing) {
  target.status = listing.status;
  target.unknownEntries += listing.unknownEntries;
  target.truncated ||= listing.truncated;
}

function finishFileStoreStatus(result) {
  if (result.status === 'complete'
    && (result.unknownRecords > 0 || result.unknownEntries > 0 || result.truncated)) {
    result.status = 'partial';
  }
}

function publicLeaseInventory(inventory) {
  const { leaseKeys, ...publicInventory } = inventory;
  void leaseKeys;
  return publicInventory;
}

function emptyFileStore(store) {
  return {
    store,
    status: 'absent',
    records: 0,
    versions: {},
    unknownRecords: 0,
    unknownEntries: 0,
    truncated: false,
  };
}

async function resolveStoreDirectory(root, relativePath) {
  const target = join(root, relativePath);
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { status: 'absent' };
    return { status: 'unknown' };
  }
  if (details.isSymbolicLink() || !details.isDirectory()) return { status: 'unknown' };
  return resolveDirectoryInsideRoot(root, target);
}

async function resolveDirectoryInsideRoot(root, path) {
  try {
    const requestedDetails = await lstat(path);
    if (requestedDetails.isSymbolicLink() || !requestedDetails.isDirectory()) return { status: 'unknown' };
    const actual = await realpath(path);
    if (!isPathInside(root, actual)) return { status: 'unknown' };
    return { status: 'complete', path: actual };
  } catch {
    return { status: 'unknown' };
  }
}

async function safeReadDirectory(root, directory) {
  const resolved = await resolveDirectoryInsideRoot(root, directory);
  if (resolved.status !== 'complete') return { ok: false, entries: [] };
  try {
    return { ok: true, entries: await readdir(resolved.path, { withFileTypes: true }) };
  } catch {
    return { ok: false, entries: [] };
  }
}

async function safeLstat(root, path) {
  try {
    const actual = await realpath(path);
    if (!isPathInside(root, actual)) return { ok: false };
    return { ok: true, details: await lstat(path), actual };
  } catch {
    return { ok: false };
  }
}

async function readJsonObject(root, path, options = {}) {
  let before;
  try {
    before = await safeLstat(root, path);
  } catch {
    return { ok: false };
  }
  if (!before.ok) {
    if (options.missingIsAbsent) {
      try {
        await lstat(path);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { ok: false, missing: true };
      }
    }
    return { ok: false };
  }
  if (before.details.isSymbolicLink() || !before.details.isFile() || before.details.size > MAX_JSON_FILE_BYTES) {
    return { ok: false };
  }
  let raw;
  try {
    raw = await readFile(path, 'utf8');
    const after = await safeLstat(root, path);
    if (!after.ok || after.details.size !== before.details.size || after.details.mtimeMs !== before.details.mtimeMs) {
      return { ok: false };
    }
    const value = JSON.parse(raw);
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function inspectFileMetadata(root, relativePath) {
  const file = join(root, relativePath);
  const result = await safeLstat(root, file);
  if (!result.ok) {
    try {
      await lstat(file);
      return { status: 'unknown' };
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { status: 'absent' } : { status: 'unknown' };
    }
  }
  return result.details.isFile() && !result.details.isSymbolicLink()
    ? { status: 'present' }
    : { status: 'unknown' };
}

function countPatchEvents(events) {
  return events.reduce((count, event) => (
    count + (isRecord(event) && isRecord(event.payload)
      && (Object.hasOwn(event.payload, 'taskBookPatch') || Object.hasOwn(event.payload, 'patch')) ? 1 : 0)
  ), 0);
}

function bumpVersion(versions, version) {
  let bucket = 'unknown';
  if (version === undefined) bucket = 'unversioned';
  else if (Number.isSafeInteger(version) && version >= 0) bucket = `v${version}`;
  versions[bucket] = (versions[bucket] ?? 0) + 1;
}

function fixedPhase(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : 'none-or-unknown';
}

function safeEventType(value) {
  return DURABLE_EVENT_TYPES.has(value) ? value : undefined;
}

function isV2PermissionSelection(value) {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hashParts(...parts) {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

function isPathInside(parent, child) {
  const relativePath = relative(parent, child);
  if (relativePath === '') return true;
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) return false;
  return true;
}

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function parseCli(argv) {
  let dataRoot;
  let allowExternalRoot = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') continue;
    if (argument === '--allow-external-root') {
      allowExternalRoot = true;
      continue;
    }
    if (argument === '--data-root') {
      dataRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--data-root=')) {
      dataRoot = argument.slice('--data-root='.length);
      continue;
    }
    throw new Error('unsupported option; use --data-root=<explicit-path> [--dry-run] [--allow-external-root]');
  }
  if (!dataRoot?.trim()) throw new Error('an explicit --data-root=<path> is required; default mode is dry-run');
  return { dataRoot, allowExternalRoot };
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = await scanCompatibilityDataRoot(options.dataRoot, {
      repositoryRoot: REPOSITORY_ROOT,
      allowExternalRoot: options.allowExternalRoot,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'inventory failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
