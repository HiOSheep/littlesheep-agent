import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  InjectionTier,
  MemoryAtomStore,
  MemoryCatalog,
  MemoryEventJournal,
  MemoryRawRecordStore,
  MemoryOperationJournal,
  MemoryTree,
  MemoryV3StorageCoordinator,
  createMemoryV3ExperimentMarker,
} from '../packages/memory-tree/dist/index.js';
import { DEFAULT_CONFIG, saveConfig } from '../packages/config/dist/index.js';

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();
const rssBefore = process.memoryUsage().rss;
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-memory-v3-soak-'));
assertIsolatedRoot(dataDir);

let runtime;
let eventSequence = 0;
let clock = Date.parse('2026-07-16T00:00:00.000Z');
const now = () => new Date(clock += 1_000);
const firstEvent = makeEvent('create', 'atom-000', 0);
const firstMutation = { kind: 'create', atom: makeAtom('atom-000', 0) };
let expectedRawRecordCount = 0;

try {
  runtime = openRuntime();
  assert.deepEqual((await runtime.coordinator.initialize()).failed, []);

  for (let index = 0; index < args.atoms; index += 1) {
    const event = index === 0 ? firstEvent : makeEvent('create', atomId(index), index);
    const mutation = index === 0
      ? firstMutation
      : { kind: 'create', atom: makeAtom(atomId(index), index) };
    await runtime.coordinator.apply(event, mutation);
    expectedRawRecordCount += 1;
  }

  await applyUpdate(runtime, atomId(10), {
    parentId: atomId(2),
    summary: 'Moved under a more relevant parent during the soak verification.',
  }, 'move');
  expectedRawRecordCount += 1;

  await applyMutation(runtime, 'archive', atomId(20), async (atom) => ({
    kind: 'archive', atomId: atom.id, expectedRevision: atom.revision,
  }));
  expectedRawRecordCount += 1;
  await applyMutation(runtime, 'restore', atomId(20), async (atom) => ({
    kind: 'restore', atomId: atom.id, expectedRevision: atom.revision,
  }));
  expectedRawRecordCount += 1;

  const mergeTarget = await requiredAtom(runtime, atomId(31));
  const mergeSource = await requiredAtom(runtime, atomId(30));
  await runtime.coordinator.apply(makeEvent('merge', mergeTarget.id, 30), {
    kind: 'merge',
    targetAtomId: mergeTarget.id,
    targetExpectedRevision: mergeTarget.revision,
    targetPatch: { mergedFromAtomIds: [mergeSource.id] },
    sourceAtomId: mergeSource.id,
    sourceExpectedRevision: mergeSource.revision,
    sourcePatch: {
      status: 'tombstone',
      merge: {
        intoAtomId: mergeTarget.id,
        at: now().toISOString(),
        reason: 'Soak verification duplicate projection.',
      },
    },
  });
  expectedRawRecordCount += 1;

  for (let restart = 0; restart < args.restarts; restart += 1) {
    closeRuntime(runtime);
    runtime = openRuntime();
    const recovery = await runtime.coordinator.initialize();
    assert.deepEqual(recovery.failed, []);
    assert.equal(await runtime.atomStore.count(), args.atoms);
    assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
    assert.equal(runtime.catalog.integrityCheck(), 'ok');

    for (let update = 0; update < 6; update += 1) {
      const index = 40 + ((restart * 6 + update) % Math.max(1, args.atoms - 40));
      await applyUpdate(runtime, atomId(index), {
        summary: `Restart ${restart + 1} verified this projection at update ${update + 1}.`,
        lastUsefulAt: now().toISOString(),
      }, `restart-${restart + 1}`);
      expectedRawRecordCount += 1;
    }
  }

  const recoveryAtomId = 'atom-recovery';
  closeRuntime(runtime);
  let injectedFailure = false;
  runtime = openRuntime((checkpoint, context) => {
    if (!injectedFailure && checkpoint === 'raw-record-captured' && context.eventId.includes('fault')) {
      injectedFailure = true;
      throw new Error('Intentional soak fault after raw record capture.');
    }
  });
  assert.deepEqual((await runtime.coordinator.initialize()).failed, []);
  await assert.rejects(
    runtime.coordinator.apply(
      makeEvent('fault', recoveryAtomId, args.atoms + 1),
      { kind: 'create', atom: makeAtom(recoveryAtomId, args.atoms + 1) },
    ),
    /intentional soak fault/iu,
  );
  expectedRawRecordCount += 1;
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
  assert.equal(await runtime.atomStore.read(recoveryAtomId), undefined);

  closeRuntime(runtime);
  runtime = openRuntime();
  const recovered = await runtime.coordinator.initialize();
  assert.deepEqual(recovered.failed, []);
  assert(recovered.recoveredEventIds.some((id) => id.includes('fault')));
  assert(await runtime.atomStore.read(recoveryAtomId));

  const firstRecordBefore = await runtime.rawRecordStore.get(firstEvent.id);
  assert(firstRecordBefore);
  await assert.rejects(
    runtime.rawRecordStore.capture(firstEvent, {
      ...firstMutation,
      atom: { ...firstMutation.atom, summary: 'Conflicting rewrite must be rejected.' },
    }),
    /already exists with different content/iu,
  );
  const firstRecordAfter = await runtime.rawRecordStore.get(firstEvent.id);
  assert.equal(firstRecordAfter?.contentHash, firstRecordBefore.contentHash);
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);

  const catalogPath = runtime.catalog.dbPath;
  closeRuntime(runtime);
  await removeCatalogFiles(catalogPath);
  runtime = openRuntime();
  const rebuilt = await runtime.coordinator.initialize();
  assert.deepEqual(rebuilt.failed, []);
  assert.equal(rebuilt.rebuiltCatalog, true);
  assert.equal(runtime.catalog.countAtoms(), args.atoms + 1);
  assert.equal(runtime.catalog.integrityCheck(), 'ok');
  assert.equal(await runtime.rawRecordStore.count(), expectedRawRecordCount);
  assert((await runtime.eventJournal.count()) <= args.maxCommittedJournalRecords);
  assert((await countFiles(runtime.operationJournal.rootDir, '.operation.json')) <= args.maxCommittedJournalRecords);
  assert.deepEqual(await runtime.eventJournal.listOutstanding(), []);
  assert.deepEqual(await runtime.operationJournal.listOutstanding(), []);

  const workingSet = await verifyWorkingSet(args.runs);
  if (args.prepareUi) await prepareUiEvaluationRoot();
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    isolatedDataRoot: dataDir,
    inputs: args,
    storage: {
      rawRecords: await runtime.rawRecordStore.count(),
      atomFiles: await runtime.atomStore.count(),
      catalogAtoms: runtime.catalog.countAtoms(),
      catalogIntegrity: runtime.catalog.integrityCheck(),
      eventJournalRecords: await runtime.eventJournal.count(),
      operationJournalRecords: await countFiles(runtime.operationJournal.rootDir, '.operation.json'),
      catalogRebuiltFromAtoms: rebuilt.rebuiltCatalog,
      rawRecordOnlyCrashRecovered: Boolean(await runtime.atomStore.read(recoveryAtomId)),
    },
    workingSet,
    uiEvaluationPrepared: args.prepareUi,
    timingMs: Math.round(performance.now() - startedAt),
    rssBytes: {
      before: rssBefore,
      after: process.memoryUsage().rss,
      delta: process.memoryUsage().rss - rssBefore,
    },
    cleanup: args.keep ? 'kept by request' : 'removed after verification',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  closeRuntime(runtime);
  if (!args.keep) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function prepareUiEvaluationRoot() {
  assert(args.keep, '--prepare-ui requires --keep so the Electron process can use the isolated data root.');
  await createMemoryV3ExperimentMarker(dataDir);
  const config = structuredClone(DEFAULT_CONFIG);
  config.memory.repositoryBackend = 'v3';
  config.agents.defaults.workspace = join(dataDir, 'workplace');
  await mkdir(config.agents.defaults.workspace, { recursive: true });
  await saveConfig(config, join(dataDir, 'config.json'));
}

function openRuntime(onCheckpoint) {
  const atomStore = new MemoryAtomStore({ dataDir, now });
  const catalog = new MemoryCatalog({ dataDir });
  const eventJournal = new MemoryEventJournal({
    dataDir,
    now,
    maxCommittedRecords: args.maxCommittedJournalRecords,
    maxTotalRecords: 2_000,
  });
  const operationJournal = new MemoryOperationJournal({
    dataDir,
    now,
    maxCommittedRecords: args.maxCommittedJournalRecords,
    maxTotalRecords: 2_000,
  });
  const rawRecordStore = new MemoryRawRecordStore({ dataDir, now });
  return {
    atomStore,
    catalog,
    eventJournal,
    operationJournal,
    rawRecordStore,
    coordinator: new MemoryV3StorageCoordinator({
      atomStore,
      catalog,
      eventJournal,
      operationJournal,
      rawRecordStore,
      onCheckpoint,
    }),
    closed: false,
  };
}

function closeRuntime(value) {
  if (!value || value.closed) return;
  value.catalog.close();
  value.closed = true;
}

async function applyUpdate(value, id, patch, label) {
  return applyMutation(value, label, id, async (atom) => ({
    kind: 'update',
    atomId: atom.id,
    expectedRevision: atom.revision,
    patch,
  }));
}

async function applyMutation(value, label, id, mutation) {
  const atom = await requiredAtom(value, id);
  return value.coordinator.apply(makeEvent(label, id, atom.revision), await mutation(atom));
}

async function requiredAtom(value, id) {
  const atom = await value.atomStore.read(id);
  assert(atom, `Missing expected atom ${id}.`);
  return atom;
}

function makeAtom(id, index) {
  const parentIndex = index > 0 ? Math.floor((index - 1) / 8) : undefined;
  const timestamp = now().toISOString();
  return {
    id,
    domain: 'project',
    branch: 'project',
    parentId: parentIndex === undefined ? undefined : atomId(parentIndex),
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    tier: InjectionTier.T2_RELEVANT,
    statementKind: 'factual-claim',
    epistemicStatus: 'verified',
    authorityScope: {
      kind: 'tool-evidence',
      scope: 'project',
      scopeKey: 'memory-v3-soak',
      topics: ['memory-v3', 'soak'],
    },
    assertedBy: { kind: 'tool', id: 'verify-memory-v3-soak' },
    evidenceRefs: [`soak:${id}`],
    entityRefs: [],
    relationRefs: [],
    title: index === 0 ? 'Special alpha retention root' : `Soak atom ${index}`,
    summary: index === 0
      ? 'Project memory catalog root for special alpha retention.'
      : `Durable atomic projection ${index}.`,
    content: index === 0
      ? 'The special alpha project uses a raw record store and a rebuildable local memory catalog.'
      : `Atomic project record ${index} remains recoverable across restarts.`,
    retrievalKeys: index === 0
      ? ['special', 'alpha', 'retention', 'memory', 'catalog']
      : ['soak', 'project', `atom-${index}`],
    importance: 0.7,
    confidence: 0.95,
    basePriority: index === 0 ? 0.95 : 0.5,
    verifiedUsefulness: { useful: 1, notUseful: 0, conflicts: 0, stale: 0, lastOutcome: 'useful' },
    feedbackRevision: 1,
    lastUsefulAt: timestamp,
    lastVerifiedAt: timestamp,
    reason: 'Memory v3 isolated soak verification.',
    sourceRunIds: ['run-memory-v3-soak'],
    sourceStages: ['tool'],
    status: 'active',
    resolutionStatus: 'resolved',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeEvent(kind, id, index) {
  const sequence = String(++eventSequence).padStart(5, '0');
  const timestamp = now().toISOString();
  return {
    version: 1,
    id: `soak-${kind}-${sequence}`,
    idempotencyKey: `memory-v3-soak:${kind}:${sequence}`,
    kind: kind === 'fault' ? 'tool-evidence' : 'user-statement',
    domain: 'project',
    scope: 'project',
    scopeKey: 'memory-v3-soak',
    atomId: kind === 'create' || kind === 'fault' ? undefined : id,
    source: { kind: 'tool', id: 'verify-memory-v3-soak' },
    occurredAt: timestamp,
    observedAt: timestamp,
    evidenceRefs: [`soak-event:${sequence}`],
    payload: { kind, atomId: id, index },
  };
}

async function verifyWorkingSet(runCount) {
  const fragments = [
    {
      id: 'working-target',
      title: 'Special alpha retention',
      summary: 'Exact project memory needed for the first user request.',
      content: 'The special alpha project keeps raw records and rebuildable atom projections.',
      keys: ['special', 'alpha', 'retention'],
      priority: 10,
    },
    {
      id: 'working-other',
      title: 'Unrelated display preference',
      summary: 'A lower relevance memory atom.',
      content: 'The interface uses a dark gray background.',
      keys: ['display', 'interface'],
      priority: 2,
    },
    {
      id: 'working-third',
      title: 'Channel connector',
      summary: 'External channels are optional plugins.',
      content: 'External channels do not control the local agent runtime.',
      keys: ['channel', 'plugin'],
      priority: 1,
    },
  ];
  const branch = {
    id: 'project',
    kind: 'project',
    displayName: 'Project memory',
    purpose: 'Project-specific durable memory.',
    whenToUse: 'The current request concerns one project.',
    searchHints: ['project', 'memory'],
    async getIndex(context) {
      return {
        branchId: 'project',
        displayName: 'Project memory',
        summary: 'Isolated working-set verification index.',
        entries: fragments.map((fragment) => ({
          id: fragment.id,
          title: fragment.title,
          summary: fragment.summary,
          searchKeys: fragment.keys,
          hasChildren: false,
        })),
        generatedAt: context.now.toISOString(),
        source: 'memory-v3-soak',
      };
    },
    async expand(_context, request) {
      const selected = fragments.filter((fragment) => !request.nodeId || fragment.id === request.nodeId);
      return {
        branchId: 'project',
        fragments: selected.slice(0, request.limit ?? 12).map(toFragment),
        truncated: false,
      };
    },
    async search(_context, request) {
      const query = request.query.toLocaleLowerCase();
      return fragments
        .filter((fragment) => [fragment.title, fragment.summary, ...fragment.keys].join(' ').toLocaleLowerCase().includes(query))
        .map(toFragment);
    },
  };
  const tree = new MemoryTree({
    totalRunTokenBudget: 1_000,
    perBranchTokenBudget: 600,
    maxRetainedLedgers: 16,
  });
  tree.register(branch);

  tree.beginRun({
    runId: 'working-set-main',
    sessionId: 'session-working-set-main',
    query: 'Recall the special alpha retention memory catalog.',
    recentHistory: [],
    workspace: dataDir,
  });
  const primed = await tree.prime('working-set-main', { maxAtoms: 2, tokenBudget: 300, query: 'special alpha retention' });
  assert(primed.fragments.some((fragment) => fragment.id === 'working-target'));
  assert(primed.fragments.length <= 2);
  const released = await tree.release('working-set-main', ['working-target']);
  assert.deepEqual(released.releasedAtomIds, ['working-target']);
  assert(released.freedTokens > 0);
  const readmitted = await tree.expand('working-set-main', {
    branchId: 'project',
    nodeId: 'working-target',
    limit: 1,
    tokenBudget: 200,
  });
  assert.deepEqual(readmitted.fragments.map((fragment) => fragment.id), ['working-target']);
  const releasedAgain = await tree.release('working-set-main', ['working-target']);
  assert.deepEqual(releasedAgain.releasedAtomIds, ['working-target']);
  const readmittedAgain = await tree.expand('working-set-main', {
    branchId: 'project',
    nodeId: 'working-target',
    limit: 1,
    tokenBudget: 200,
  });
  assert.deepEqual(readmittedAgain.fragments.map((fragment) => fragment.id), ['working-target']);
  tree.finishRun('working-set-main');

  for (let index = 0; index < runCount; index += 1) {
    const runId = `working-set-retained-${String(index).padStart(4, '0')}`;
    tree.beginRun({
      runId,
      sessionId: `session-${index}`,
      query: 'project memory',
      recentHistory: [],
      workspace: dataDir,
    });
    await tree.branchIndex(runId, 'project');
    await tree.expand(runId, { branchId: 'project', nodeId: 'working-target', limit: 1, tokenBudget: 160 });
    tree.finishRun(runId);
  }
  const retained = tree.listLedgers(200);
  assert.equal(retained.length, Math.min(16, runCount + 1));
  if (runCount > 16) assert.equal(tree.getLedger('working-set-retained-0000'), undefined);
  return {
    initialAtomIds: primed.fragments.map((fragment) => fragment.id),
    releasedTokens: released.freedTokens,
    readmitted: readmittedAgain.fragments.map((fragment) => fragment.id),
    retainedLedgers: retained.length,
    requestedRuns: runCount,
  };
}

function toFragment(fragment) {
  return {
    id: fragment.id,
    branchId: 'project',
    tier: InjectionTier.T2_RELEVANT,
    priority: fragment.priority,
    content: fragment.content,
    tokenEstimate: Math.ceil(fragment.content.length / 4),
    truncatable: true,
    dedupKey: fragment.id,
    matchReason: 'Memory v3 soak working-set candidate.',
    metadata: {
      source: 'memory-v3-soak',
      kind: 'indexed',
      generatedAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

async function removeCatalogFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    await rm(candidate, { force: true });
  }
}

async function countFiles(root, suffix) {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  }
  return count;
}

function atomId(index) {
  return `atom-${String(index).padStart(3, '0')}`;
}

function assertIsolatedRoot(path) {
  const normalized = resolve(path);
  const tempRoot = resolve(tmpdir());
  assert(normalized.startsWith(`${tempRoot}\\`) || normalized.startsWith(`${tempRoot}/`));
  assert(normalized.includes('littlesheep-memory-v3-soak-'));
  assert(!normalized.toLocaleLowerCase().endsWith('\\.littlesheep'));
}

function parseArgs(values) {
  const options = {
    atoms: 120,
    restarts: 4,
    runs: 96,
    maxCommittedJournalRecords: 8,
    keep: false,
    prepareUi: false,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--atoms=')) options.atoms = integer(value, '--atoms=', 48, 1_000);
    else if (value.startsWith('--restarts=')) options.restarts = integer(value, '--restarts=', 1, 20);
    else if (value.startsWith('--runs=')) options.runs = integer(value, '--runs=', 1, 2_000);
    else if (value === '--keep') options.keep = true;
    else if (value === '--prepare-ui') options.prepareUi = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function integer(value, prefix, minimum, maximum) {
  const parsed = Number(value.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${prefix.slice(2, -1)} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
