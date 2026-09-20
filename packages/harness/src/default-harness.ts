// @littlesheep/harness — default-harness.ts
// The shared stage factory for the one Core Flow driver. Stage deps
// (llm/sessionManager/memoryStore/config/branding) are captured by the stage
// factories here; RunContext stays free of infrastructure. The transition loop
// itself lives in the durable driver, which is now the only driver.
import type {
  AgentHarness,
  MemoryStoreLike,
  Stage,
  StageName,
} from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import type { SessionManager } from '@littlesheep/session';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type {
  MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { createNextHarness } from './durable-harness.js';
import { enterStage } from './stages/enter.js';
import { createClassifyStage } from './stages/classify.js';
import { createExecuteStage } from './stages/execute.js';
import { createRecoverStage } from './stages/recover.js';
import { createVerifyStage } from './stages/verify.js';
import { createReplyStage } from './stages/reply.js';
import { createAskUserStage } from './stages/ask_user.js';
import { createFinalizeStage } from './stages/finalize.js';
import type { ExactContextTokenCounter } from '@littlesheep/context';

export interface DefaultHarnessOptions {
  llm: LlmClient;
  model: string;
  sessionManager: SessionManager;
  memoryStore: MemoryStoreLike;
  config: Config;
  branding: BrandingConfig;
  /** Indexed, guarded autonomous memory writer for explicit writes. */
  memoryWriter?: MemoryWriteServiceLike;
  /** Rules confidence threshold for CLASSIFY fast path. Default 0.7. */
  classifierThreshold?: number;
  /** Prepared at Runner startup; unavailable models continue with the non-displayable safety estimator. */
  tokenCounter?: ExactContextTokenCounter;
  /** Optional logger sink forwarded to HookRunner. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** Build the shared stage registry used by the one Core Flow driver. */
export function createHarnessStages(opts: DefaultHarnessOptions): Map<StageName, Stage> {
  const stages = new Map<StageName, Stage>();

  // enter is a plain function (no deps); the rest are factory-built closures.
  stages.set('enter', enterStage);
  stages.set('classify', createClassifyStage({
    rulesConfidenceThreshold: opts.classifierThreshold,
  }));
  // DECIDE is gone: the stage, its planning modules and its request contract were
  // deleted with the second execution system. `decide` survives only as a legacy
  // stage name in checkpoints; the driver maps it to the main loop.
  stages.set('execute', createExecuteStage({
    llm: opts.llm,
    model: opts.model,
    config: opts.config,
    branding: opts.branding,
  }));
  stages.set('recover', createRecoverStage());
  stages.set('verify', createVerifyStage());
  // EVOLVE and CAPTURE are gone: automatic memory evolution, automatic skill
  // creation, and the legacy per-run memory summary were all removed with the
  // lean plan. Durable memory now comes from explicit writes and from the
  // compaction path, not from a stage that runs after every task.
  stages.set('reply', createReplyStage({
    llm: opts.llm,
    model: opts.model,
    config: opts.config,
    branding: opts.branding,
  }));
  stages.set('ask_user', createAskUserStage({
    llm: opts.llm,
    model: opts.model,
  }));
  stages.set('finalize', createFinalizeStage({
    sessionManager: opts.sessionManager,
  }));

  return stages;
}

/**
 * Build the default Core Flow harness. Stages close over the supplied deps.
 */
export function createDefaultHarness(opts: DefaultHarnessOptions): AgentHarness {
  // One persistence driver. The legacy/shadow split is gone: every run uses the
  // durable loop, which records each executed transition in the durable event
  // stream. The shared stage factory above stays the single source of stages.
  return createNextHarness(opts);
}
