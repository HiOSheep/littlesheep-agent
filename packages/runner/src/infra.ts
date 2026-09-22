// @littlesheep/runner — infra.ts
// Constructs all infrastructure (LLM/Session/Memory/Tools/Harness) from
// Config + Branding. The runner's `run()` drives the assembled harness.

import { join, resolve } from 'node:path';
import type { LlmClient } from '@littlesheep/llm';
import { createLlmClient } from '@littlesheep/llm';
import { SessionManager } from '@littlesheep/session';
import { MemoryStore } from '@littlesheep/memory-core';
import type { Config, ModelProvider } from '@littlesheep/config';
import { parseModelRef, getProvider, resolveApiKey } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { dataSubdirs } from '@littlesheep/branding';
import type {
  AgentTool,
  AgentHarness,
  SessionId,
  MemoryStoreLike,
  WebProviderRuntimeSnapshot,
} from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import {
  ToolRegistry,
  registerBuiltinTools,
  createExecTool,
  createRequestUserInputTool,
  createSessionStatusTool,
  type ApprovalConfig,
} from '@littlesheep/tools';
import {
  createSkillLoader,
  createUseSkillTool,
  findBuiltinSkillsDir,
  type SkillLoader,
  type SkillSourceDefinition,
} from '@littlesheep/skills';
import {
  CacheObservationStore,
  createDefaultHarness,
  createNextHarness,
} from '@littlesheep/harness';
import {
  createLazyLocalExactContextTokenCounter,
  type ExactContextTokenCounter,
  type LazyExactContextTokenCounter,
} from '@littlesheep/context';
import { SafeMemoryStore, QuarantineStore, sanitizePreludeForInjection } from '@littlesheep/safety';
import { GitCheckpointCoordinator, SnapshotMemoryStore } from '@littlesheep/snapshot';
import { ExperienceStore } from '@littlesheep/experience';
import {
  buildProviderRegistry,
  MemoryWebCache,
  SearchProviderRegistry,
  type ProviderRegistry,
  type WebCache,
} from '@littlesheep/web';
import { ExecutionLogStore } from './execution-log.js';
import { loadCacheObservationKey } from './cache-observation-key.js';
import { RunCheckpointStore } from './run-checkpoint-store.js';
import { RunCheckpointDispositionStore } from './run-checkpoint-disposition-store.js';
import { CompactionOperationStore } from './compaction-operation-store.js';
import { SessionCompactionScheduler } from './session-compaction-scheduler.js';
import { SessionFileObservationRegistry } from './session-file-observations.js';
import {
  buildDurableHarnessInfrastructure,
  type DurableHarnessInfrastructure,
} from './durable-harness-infrastructure.js';
import {
  loadSessionDurableProjection,
  type SessionDurableProjection,
} from './session-durable-projection.js';
import {
  CompositeMemoryBranch,
  DEFAULT_BRANCH_SPECS,
  LegacyDailyBranch,
  LegacyExperienceBranch,
  LegacyLongTermBranch,
  MemoryRepository,
  MemoryService,
  MemoryTree,
  MemoryWriteService,
  ProjectMemoryBranch,
  TreeMemoryBranch,
  createMemoryTreeTool,
  migrateLegacyMemorySources,
} from '@littlesheep/memory-tree';

/** Logger sink forwarded to harness + tools. */
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** Mutable per-runner state (updated by run, read by session_status tool). */
export interface RunnerState {
  sessionId: SessionId | undefined;
  model: string;
}

/** The fully-assembled runtime. */
export interface Infrastructure extends DurableHarnessInfrastructure {
  llm: LlmClient;
  sessionManager: SessionManager;
  memoryStore: MemoryStoreLike;
  disposeEmbedding: () => Promise<void>;
  registry: ToolRegistry;
  harness: AgentHarness;
  /** Independent durable transition driver used only after next-mode admission. */
  nextHarness: AgentHarness;
  skillLoader: SkillLoader;
  executionLogStore: ExecutionLogStore;
  /** Bounded session-scoped durable projections for cache-quality reports. */
  loadSessionDurableProjection?: (sessionId: string) => Promise<SessionDurableProjection>;
  /** Activity checkpoints are separate from shadow Git rollback points. */
  runCheckpointStore?: RunCheckpointStore;
  /** Mutable resume/abandon decisions kept separate from immutable checkpoints. */
  runCheckpointDispositionStore: RunCheckpointDispositionStore;
  /** Durable session-scoped history of automatic compaction operations. */
  compactionOperationStore: CompactionOperationStore;
  /** One scheduler per Runner owns automatic compaction single-flight and cancellation. */
  compactionScheduler: SessionCompactionScheduler;
  experienceStore: ExperienceStore;
  memoryTree: MemoryTree;
  memoryRepository: MemoryRepository;
  memoryWriteService: MemoryWriteService;
  memoryService: MemoryService;
  /** Only explicitly selected providers are assembled; credentials never leave this boundary. */
  webProviders: ProviderRegistry;
  /** Redacted startup state used to freeze per-run configuration. */
  webProviderSnapshots: readonly WebProviderRuntimeSnapshot[];
  /** Process-local, bounded anonymous page cache. Quotas remain run-scoped. */
  webCache?: WebCache;
  versioning?: GitCheckpointCoordinator;
  /**
   * Process-held, session-scoped record of the file versions each session's
   * model actually read; the basis for refusing an overwrite of a changed file.
   */
  fileObservations: SessionFileObservationRegistry;
  /** Starts tokenizer preparation only after an Agent run actually begins. */
  prepareTokenCounter?: () => Promise<void>;
  disposeTokenCounter: () => void;
  /** Process-held reference to the data-root-local cache HMAC key. */
  cacheObservationKey: string | null;
  /** Durable, redacted cache observation store; unavailable is non-blocking. */
  cacheObservationStore?: CacheObservationStore;
  state: RunnerState;
}

export interface BuildInfrastructureOptions {
  config: Config;
  branding: BrandingConfig;
  model: string;
  /** Override LLM client (tests). */
  llm?: LlmClient;
  /** Override skills dirs (default: built-in + data + config.extraDirs). */
  skillsDirs?: string[];
  /** Stable user-data bootstrap directory, when provided by the owning adapter. */
  bootstrapDir?: string;
  /** Host-aware fetch implementation used only when verified tokenizer assets are absent. */
  tokenizerFetch?: typeof fetch;
  state: RunnerState;
  log?: LogFn;
}

/**
 * Resolve a model ref against config providers and build an LlmClient.
 * Throws if the provider is not configured.
 */
export function resolveLlm(
  config: Config,
  model: string,
  override?: LlmClient,
): { llm: LlmClient; modelName: string } {
  if (override) return { llm: override, modelName: model };
  const { provider: providerId, model: modelName } = parseModelRef(model);
  const provider: ModelProvider | undefined = getProvider(config, providerId);
  if (!provider) {
    throw new Error(`runner: no provider "${providerId}" for model ref "${model}"`);
  }
  const apiKey = resolveApiKey(provider.apiKey);
  const llm = createLlmClient({
    baseURL: provider.baseURL,
    apiKey,
    timeoutSeconds: provider.timeoutSeconds,
  });
  return { llm, modelName };
}

/** Build the full Infrastructure from config + branding. Async (skill loader reads dirs). */
export async function buildInfrastructure(
  opts: BuildInfrastructureOptions,
): Promise<Infrastructure> {
  const dirs = dataSubdirs(opts.branding);
  const cacheObservationKey = await loadCacheObservationKey(dirs.root);
  const cacheObservationStore = new CacheObservationStore({
    rootDir: join(dirs.root, 'cache-observations'),
  });
  try {
    await cacheObservationStore.initialize();
  } catch (error) {
    opts.log?.('warn', `runner: cache observation store initialization degraded: ${(error as Error).message}`);
  }
  const lazyTokenCounter: LazyExactContextTokenCounter | undefined = createLazyLocalExactContextTokenCounter({
    modelRef: opts.model,
    modelRootDir: join(opts.bootstrapDir ?? dirs.root, 'models', 'tokenizer'),
    fetchFn: opts.tokenizerFetch,
    onPreparationError: (error) => {
      opts.log?.('warn', `runner: local tokenizer preparation degraded: ${error.message}`);
    },
  });
  const tokenCounter: ExactContextTokenCounter | undefined = lazyTokenCounter;
  const versioning = opts.config.versioning.enabled
    ? new GitCheckpointCoordinator({
        dataRoot: dirs.root,
        maxCheckpoints: opts.config.versioning.maxCheckpoints,
        maxFileBytes: opts.config.versioning.maxFileBytes,
        maxWorkspaceFiles: opts.config.versioning.maxWorkspaceFiles,
        maxWorkspaceBytes: opts.config.versioning.maxWorkspaceBytes,
        log: opts.log,
      })
    : undefined;
  await versioning?.initialize();
  // One registry per host process; each session gets its own bounded table and
  // they share the path mutex that serializes "re-verify then write".
  const fileObservations = new SessionFileObservationRegistry();
  const { llm, modelName } = resolveLlm(opts.config, opts.model, opts.llm);
  opts.state.model = modelName;

  // Do not resolve a key, select an adapter, or send any request while public
  // retrieval is disabled. When enabled, only the explicit default provider
  // is assembled; configuring a future fallback does not activate it.
  const webEnabled = opts.config.web.enabled && opts.config.web.readMode !== 'disabled';
  const selectedWebProviders = webEnabled && opts.config.web.defaultProvider
    ? opts.config.web.providers.filter((provider) => provider.id === opts.config.web.defaultProvider)
    : [];
  const webProviderBuild = webEnabled
    ? await buildProviderRegistry({
        providers: selectedWebProviders,
        defaultProvider: opts.config.web.defaultProvider,
        log: opts.log,
      })
    : {
        registry: new SearchProviderRegistry(),
        snapshots: opts.config.web.providers.map((provider) => ({
          id: provider.id,
          adapterType: provider.type,
          status: 'disabled' as const,
        })),
      };
  const webCache = webEnabled && opts.config.web.cache.enabled
    ? new MemoryWebCache(
        opts.config.web.cache.maxBytes,
        opts.config.web.cache.ttlSeconds * 1_000,
      )
    : undefined;

  // M3: execution log store — one JSON file per run, for replay/audit.
  const executionLogStore = new ExecutionLogStore({ rootDir: dirs.executionLogs });
  const durableHarnessInfrastructure = await buildDurableHarnessInfrastructure(dirs.root, opts.log);
  const { durableEventStore } = durableHarnessInfrastructure;
  const loadSessionDurableProjectionFor = (sessionId: string) =>
    loadSessionDurableProjection(durableEventStore, sessionId);
  const runCheckpointDispositionStore = new RunCheckpointDispositionStore({
    rootDir: join(dirs.root, 'run-checkpoint-dispositions'),
  });
  try {
    await runCheckpointDispositionStore.initialize();
  } catch (error) {
    opts.log?.('warn', `runner: run checkpoint disposition initialization degraded: ${(error as Error).message}`);
  }
  const runCheckpointStore = new RunCheckpointStore({
    rootDir: join(dirs.root, 'run-checkpoints'),
    protectedCheckpointIds: async () => {
      const active = await runCheckpointDispositionStore.list({
        statuses: ['resuming', 'interrupted', 'deferred'],
      });
      return new Set(active.flatMap((disposition) => [
        disposition.checkpointId,
        ...(disposition.nextCheckpointId ? [disposition.nextCheckpointId] : []),
      ]));
    },
    protectedRunIds: async () => new Set((await runCheckpointDispositionStore.list({
      statuses: ['resuming'],
    })).flatMap((disposition) => disposition.resumeRunId ? [disposition.resumeRunId] : [])),
  });
  try {
    await runCheckpointStore.initialize();
  } catch (error) {
    opts.log?.('warn', `runner: run checkpoint store initialization degraded: ${(error as Error).message}`);
  }

  const sessionManager = new SessionManager({
    sessionsDir: dirs.sessions,
    lockTimeoutMs: opts.config.sessions.writeLock.acquireTimeoutMs,
  });
  const baseMemory = new MemoryStore({ rootDir: dirs.root });

  const safetyCF = opts.config.safety;
  let memoryStore: MemoryStoreLike = baseMemory;
  if (safetyCF.enabled) {
    // Wrap order (outer → inner): Snapshot → Safe → base.
    //   - Safe validates writes against injection patterns (rejects → quarantine).
    //   - Snapshot captures pre-write content for rollback (Phase B).
    //   - Safe's rejects never reach Snapshot: validation happens
    //     before the write forwards inward, so no snapshot is taken for rejects.
    const safeMemory = new SafeMemoryStore(baseMemory, {
      source: 'runtime',
      quarantine: new QuarantineStore({
        rootDir: dirs.root,
        subdir: safetyCF.quarantineDir,
      }),
      maxLength: safetyCF.maxEntryChars,
    });
    memoryStore = new SnapshotMemoryStore(safeMemory, {
      snapshotDir: dirs.backups,
      maxSnapshots: 50,
    });
  }

  // Phase C: experience DB (structured, searchable, decay-tracked).
  // Constructed unconditionally — EVOLVE double-write + memory_search fusion
  // both depend on it; absence is handled gracefully via optional deps.
  const experienceStore = new ExperienceStore({ rootDir: dirs.experience });

  let embeddingEngine: import('@littlesheep/memory-tree').EmbeddingEngine | undefined;
  let disposeEmbedding = async (): Promise<void> => undefined;
  if (opts.config.memory.repositoryBackend === 'v3') {
    const {
      DEFAULT_LOCAL_EMBEDDING_MODEL,
      LocalTransformersEmbeddingEngine,
    } = await import('@littlesheep/embedding');
    const localEngine = new LocalTransformersEmbeddingEngine({
      model: DEFAULT_LOCAL_EMBEDDING_MODEL,
      modelRootDir: join(dirs.root, 'models', 'embedding'),
    });
    embeddingEngine = localEngine;
    disposeEmbedding = () => localEngine.dispose();
  }

  // One memory runtime per Runner. Prompt, read tools and autonomous writes all
  // share this instance, so cache invalidation and run ledgers cannot diverge.
  const memoryRepository = new MemoryRepository({
    dataDir: dirs.root,
    backend: opts.config.memory.repositoryBackend,
    policy: { experienceThreshold: opts.config.memory.experienceWriteThreshold },
    log: opts.log,
    v3: { embeddingEngine },
  });
  await memoryRepository.initialize();
  await memoryRepository.retryRecoveryQueue();
  let legacyMigrationCompleted = false;
  try {
    const migration = await migrateLegacyMemorySources({
      repository: memoryRepository,
      memoryStore,
      experienceStore,
      log: opts.log,
    });
    legacyMigrationCompleted = migration.completed;
  } catch (error) {
    opts.log?.('warn', `memory-tree: legacy migration failed; compatibility sources remain active: ${(error as Error).message}`);
  }
  const memoryTree = new MemoryTree({
    totalRunTokenBudget: opts.config.memory.treeRunTokenBudget,
    perBranchTokenBudget: opts.config.memory.treeBranchTokenBudget,
    rootIndexMaxChars: opts.config.memory.treeRootIndexMaxChars,
    log: opts.log,
  });

  const externalSources = {
    'long-term': legacyMigrationCompleted ? [] : [new LegacyLongTermBranch(memoryStore)],
    daily: [
      ...(legacyMigrationCompleted ? [] : [new LegacyDailyBranch(memoryStore)]),
    ],
    project: [new ProjectMemoryBranch({ dataDir: dirs.root, log: opts.log })],
    experience: legacyMigrationCompleted ? [] : [new LegacyExperienceBranch(experienceStore)],
  } as const;
  for (const spec of DEFAULT_BRANCH_SPECS) {
    const stored = new TreeMemoryBranch({ repository: memoryRepository, ...spec });
    memoryTree.register(new CompositeMemoryBranch({
      id: spec.kind,
      displayName: spec.displayName,
      purpose: spec.purpose,
      whenToUse: spec.whenToUse,
      searchHints: spec.searchHints,
      sources: [stored, ...externalSources[spec.kind]],
    }));
  }
  const memoryWriteService = new MemoryWriteService({
    repository: memoryRepository,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
    log: opts.log,
  });
  const memoryService = new MemoryService({
    tree: memoryTree,
    repository: memoryRepository,
    writer: memoryWriteService,
    dataDir: dirs.root,
    rootIndexMaxChars: opts.config.memory.treeRootIndexMaxChars,
    resolveSessionSummary: async (sessionId, summaryId) => {
      const projection = await sessionManager.loadCompactionProjection(sessionId, summaryId);
      if (projection) return projection;
      const summary = (await sessionManager.loadMetadata(sessionId))?.compaction;
      return summary?.id === summaryId ? summary : undefined;
    },
    log: opts.log,
  });
  if (opts.bootstrapDir) {
    await memoryService.loadBootstrapFiles(opts.bootstrapDir);
  }

  // Skills loader: built-in + data dir + extra dirs from config.
  const builtinSkillsDir = findBuiltinSkillsDir();
  const skillSources: SkillSourceDefinition[] = opts.skillsDirs
    ? opts.skillsDirs.map((dir) => ({
        id: `external:${resolve(dir).toLocaleLowerCase()}`,
        kind: 'external',
        dir,
      }))
    : [
        ...(builtinSkillsDir ? [{ id: 'builtin', kind: 'builtin' as const, dir: builtinSkillsDir }] : []),
        { id: 'user', kind: 'user' as const, dir: dirs.skills },
        ...opts.config.skills.extraDirs.map((dir) => ({
          id: `external:${resolve(dir).toLocaleLowerCase()}`,
          kind: 'external' as const,
          dir,
        })),
      ];
  const skillLoader = await createSkillLoader({
    sources: skillSources,
    disabled: opts.config.skills.disabled,
  });
  await memoryService.syncSkillResources(skillLoader.index.discovered, skillLoader.index.sources);

  // Tool registry: builtins + skills + memory + session_status.
  // Only use_skill is registered: skills are loaded on demand, and the agent no
  // longer writes new SKILL.md files as an automatic side effect of a run.
  const registry = new ToolRegistry();
  const memoryEnvelope = safetyCF.enabled && safetyCF.sanitizePrelude
    ? sanitizePreludeForInjection
    : undefined;
  const extras: AgentTool[] = [
    createUseSkillTool(skillLoader),
    // One memory navigation entry point: the tree tool already covers
    // root_index, branch_index, expand and deep_search.
    createMemoryTreeTool(memoryService, { envelope: memoryEnvelope }),
    createSessionStatusTool({
      sessionId: () => opts.state.sessionId ?? asSessionId(''),
      sessionManager,
      model: () => opts.state.model,
    }),
    // Asking the user is a capability the model invokes, not a routing outcome.
    createRequestUserInputTool(),
  ];
  registerBuiltinTools(registry, extras);

  // Override exec tool: default is interactive (steals stdin via readline).
  // Use non-interactive variant so ctx.approve is consulted (REPL-friendly).
  registry.unregister('exec');
  const approvalConfig: ApprovalConfig = {
    whitelist: opts.config.tools.exec.whitelist,
    blacklist: opts.config.tools.exec.blacklist,
    approvalMode: opts.config.tools.exec.approvalMode,
  };
  registry.register(createExecTool({ interactive: false, approvalConfig }), 'builtin');

  const harness = createDefaultHarness({
    llm,
    model: modelName,
    sessionManager,
    memoryStore,
    config: opts.config,
    branding: opts.branding,
    log: opts.log,
    tokenCounter,
  });
  const nextHarness = createNextHarness({
    llm,
    model: modelName,
    sessionManager,
    memoryStore,
    config: opts.config,
    branding: opts.branding,
    log: opts.log,
    tokenCounter,
  });

  void memoryRepository.startBackgroundMaintenance().catch((error) => {
    opts.log?.('warn', `memory-v3: background maintenance stopped: ${(error as Error).message}`);
  });

  const compactionOperationStore = new CompactionOperationStore(join(dirs.root, 'compaction-operations'));
  const compactionScheduler = new SessionCompactionScheduler({
    log: opts.log,
    onSettled: (record) => compactionOperationStore.append(record),
  });

  return {
    llm,
    sessionManager,
    memoryStore,
    disposeEmbedding,
    registry,
    harness,
    nextHarness,
    skillLoader,
    executionLogStore,
    ...durableHarnessInfrastructure,
    loadSessionDurableProjection: loadSessionDurableProjectionFor,
    runCheckpointStore,
    runCheckpointDispositionStore,
    compactionOperationStore,
    compactionScheduler,
    experienceStore,
    memoryTree,
    memoryRepository,
    memoryWriteService,
    memoryService,
    webProviders: webProviderBuild.registry,
    webProviderSnapshots: webProviderBuild.snapshots,
    webCache,
    versioning,
    fileObservations,
    prepareTokenCounter: lazyTokenCounter
      ? () => lazyTokenCounter.prepare()
      : undefined,
    disposeTokenCounter: () => lazyTokenCounter?.dispose(),
    cacheObservationKey,
    cacheObservationStore,
    state: opts.state,
  };
}
