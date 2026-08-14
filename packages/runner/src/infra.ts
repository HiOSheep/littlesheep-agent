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
import type { AgentTool, AgentHarness, SessionId, MemoryStoreLike } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import {
  ToolRegistry,
  registerBuiltinTools,
  createExecTool,
  createSessionStatusTool,
  type ApprovalConfig,
} from '@littlesheep/tools';
import {
  createSkillLoader,
  createUseSkillTool,
  createCreateSkillTool,
  writeSkillFile,
  findBuiltinSkillsDir,
  type SkillLoader,
  type SkillSourceDefinition,
} from '@littlesheep/skills';
import { createDefaultHarness } from '@littlesheep/harness';
import {
  createLazyLocalExactContextTokenCounter,
  type ExactContextTokenCounter,
  type LazyExactContextTokenCounter,
} from '@littlesheep/context';
import { SafeMemoryStore, QuarantineStore, sanitizePreludeForInjection } from '@littlesheep/safety';
import { GitCheckpointCoordinator, SnapshotMemoryStore } from '@littlesheep/snapshot';
import { ExperienceStore } from '@littlesheep/experience';
import { ExecutionLogStore } from './execution-log.js';
import { RunCheckpointStore } from './run-checkpoint-store.js';
import { RunCheckpointDispositionStore } from './run-checkpoint-disposition-store.js';
import {
  CompositeMemoryBranch,
  DEFAULT_BRANCH_SPECS,
  LegacyDailyBranch,
  LegacyExperienceBranch,
  LegacyLongTermBranch,
  MemoryRepository,
  MemoryAtomCorrectionService,
  MemoryAtomHierarchyService,
  MemoryAtomReconciliationService,
  MemoryAtomRevisionService,
  MemoryAtomSubtreeService,
  MemoryService,
  MemoryTree,
  MemoryWriteService,
  ProjectMemoryBranch,
  TreeMemoryBranch,
  createMemoryDeepSearchCompatibilityTool,
  createMemorySearchCompatibilityTool,
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
export interface Infrastructure {
  llm: LlmClient;
  sessionManager: SessionManager;
  memoryStore: MemoryStoreLike;
  disposeEmbedding: () => Promise<void>;
  registry: ToolRegistry;
  harness: AgentHarness;
  skillLoader: SkillLoader;
  executionLogStore: ExecutionLogStore;
  /** Activity checkpoints are separate from shadow Git rollback points. */
  runCheckpointStore?: RunCheckpointStore;
  /** Mutable resume/abandon decisions kept separate from immutable checkpoints. */
  runCheckpointDispositionStore: RunCheckpointDispositionStore;
  experienceStore: ExperienceStore;
  memoryTree: MemoryTree;
  memoryRepository: MemoryRepository;
  memoryWriteService: MemoryWriteService;
  memoryService: MemoryService;
  versioning?: GitCheckpointCoordinator;
  /** Starts tokenizer preparation only after an Agent run actually begins. */
  prepareTokenCounter?: () => Promise<void>;
  disposeTokenCounter: () => void;
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
  const { llm, modelName } = resolveLlm(opts.config, opts.model, opts.llm);
  opts.state.model = modelName;

  // M3: execution log store — one JSON file per run, for replay/audit.
  const executionLogStore = new ExecutionLogStore({ rootDir: dirs.executionLogs });
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
  const memoryReconciliationService = new MemoryAtomReconciliationService({
    management: memoryRepository.management,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
  });
  const memoryHierarchyService = new MemoryAtomHierarchyService({
    management: memoryRepository.management,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
  });
  const memorySubtreeService = new MemoryAtomSubtreeService({
    management: memoryRepository.management,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
  });
  const memoryRevisionService = new MemoryAtomRevisionService({
    management: memoryRepository.management,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
  });
  const memoryCorrectionService = new MemoryAtomCorrectionService({
    management: memoryRepository.management,
    invalidate: (branch) => memoryTree.invalidateBranch(branch),
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
  // create_skill enables self-evolution: the agent writes new SKILL.md files
  // to dirs.skills, then the shared skillLoader hot-reloads so use_skill
  // can load the new skill immediately — no runner restart needed.
  const registry = new ToolRegistry();
  const memoryEnvelope = safetyCF.enabled && safetyCF.sanitizePrelude
    ? sanitizePreludeForInjection
    : undefined;
  const extras: AgentTool[] = [
    createUseSkillTool(skillLoader),
    createCreateSkillTool({ loader: skillLoader, skillsDir: dirs.skills }),
    createMemoryTreeTool(memoryService, { envelope: memoryEnvelope }),
    createMemorySearchCompatibilityTool(memoryService, { envelope: memoryEnvelope }),
    createMemoryDeepSearchCompatibilityTool(memoryService, { envelope: memoryEnvelope }),
    createSessionStatusTool({
      sessionId: () => opts.state.sessionId ?? asSessionId(''),
      sessionManager,
      model: () => opts.state.model,
    }),
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

  // Self-evolution: EVOLVE stage can autonomously create skills when it
  // identifies a reusable pattern. The callback writes a SKILL.md to the
  // user skills dir and hot-reloads the shared skillLoader, so the new
  // skill is immediately available to use_skill on the next run.
  const createSkillFn = async (skillOpts: {
    name: string;
    description: string;
    whenToUse?: string;
    body: string;
  }): Promise<string> => {
    // Skip if a skill with this name already exists (don't overwrite).
    const exists = skillLoader.index.discovered.some((s) => s.name === skillOpts.name);
    if (exists) {
      throw new Error(`Skill "${skillOpts.name}" already exists`);
    }
    const path = await writeSkillFile({
      skillsDir: dirs.skills,
      name: skillOpts.name,
      description: skillOpts.description,
      whenToUse: skillOpts.whenToUse,
      body: skillOpts.body,
    });
    await skillLoader.reload();
    await memoryService.syncSkillResources(skillLoader.index.discovered, skillLoader.index.sources);
    return path;
  };

  const harness = createDefaultHarness({
    llm,
    model: modelName,
    sessionManager,
    memoryStore,
    memoryWriter: memoryService,
    memoryRefiner: memoryService,
    memoryReconciler: memoryReconciliationService,
    memoryHierarchy: memoryHierarchyService,
    memorySubtree: memorySubtreeService,
    memoryReviser: memoryRevisionService,
    memoryCorrector: memoryCorrectionService,
    config: opts.config,
    branding: opts.branding,
    log: opts.log,
    createSkill: createSkillFn,
    tokenCounter,
  });

  void memoryRepository.startBackgroundMaintenance().catch((error) => {
    opts.log?.('warn', `memory-v3: background maintenance stopped: ${(error as Error).message}`);
  });

  return {
    llm,
    sessionManager,
    memoryStore,
    disposeEmbedding,
    registry,
    harness,
    skillLoader,
    executionLogStore,
    runCheckpointStore,
    runCheckpointDispositionStore,
    experienceStore,
    memoryTree,
    memoryRepository,
    memoryWriteService,
    memoryService,
    versioning,
    prepareTokenCounter: lazyTokenCounter
      ? () => lazyTokenCounter.prepare()
      : undefined,
    disposeTokenCounter: () => lazyTokenCounter?.dispose(),
    state: opts.state,
  };
}
