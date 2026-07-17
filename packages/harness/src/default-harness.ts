// @littlesheep/harness — default-harness.ts
// The Core Flow state machine driver. Hard-coded stage transitions via switch:
// the LLM never chooses which stage comes next. Hooks (Layer 3) and
// registerStage (Layer 2) are honored at each step.
//
// Stage deps (llm/sessionManager/memoryStore/config/branding) are captured by
// the stage factories here; RunContext stays free of infrastructure.

import type {
  AgentHarness,
  AnyHook,
  RunContext,
  Stage,
  StageName,
  StageResult,
} from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import type { SessionManager } from '@littlesheep/session';
import type { MemoryStoreLike } from '@littlesheep/types';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type { MemoryRunRefinementServiceLike, MemoryWriteServiceLike } from '@littlesheep/memory-tree';
import { HookRunner } from './hooks/runner.js';
import { enterStage } from './stages/enter.js';
import { createClassifyStage } from './stages/classify.js';
import { createDecideStage } from './stages/decide.js';
import { createExecuteStage } from './stages/execute.js';
import { createRecoverStage } from './stages/recover.js';
import { createVerifyStage } from './stages/verify.js';
import { createEvolveStage, type CreateSkillFn } from './stages/evolve.js';
import { createCaptureStage } from './stages/capture.js';
import { createReplyStage } from './stages/reply.js';
import { createAskUserStage } from './stages/ask_user.js';
import { createFinalizeStage } from './stages/finalize.js';

export interface DefaultHarnessOptions {
  llm: LlmClient;
  model: string;
  sessionManager: SessionManager;
  memoryStore: MemoryStoreLike;
  config: Config;
  branding: BrandingConfig;
  /** Indexed, guarded autonomous memory writer used by EVOLVE/CAPTURE. */
  memoryWriter?: MemoryWriteServiceLike;
  /** Bounded post-DECIDE memory refinement using the normalized TaskBook. */
  memoryRefiner?: MemoryRunRefinementServiceLike;
  /**
   * Optional: if provided, EVOLVE may autonomously create skills when it
   * identifies a reusable pattern. This is the agent's self-evolution
   * mechanism — skills are created without user direction.
   */
  createSkill?: CreateSkillFn;
  /** Rules confidence threshold for CLASSIFY fast path. Default 0.7. */
  classifierThreshold?: number;
  /** Optional logger sink forwarded to HookRunner. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** All stage names in the Core Flow (used to seed the registry). */
const ALL_STAGES: readonly StageName[] = [
  'enter', 'classify', 'decide', 'execute', 'recover',
  'verify',
  'evolve', 'capture', 'reply', 'ask_user', 'finalize',
];

/**
 * Build the default Core Flow harness. Stages close over the supplied deps.
 */
export function createDefaultHarness(opts: DefaultHarnessOptions): AgentHarness {
  const hooks = new HookRunner(opts.log);
  const stages = new Map<StageName, Stage>();

  // enter is a plain function (no deps); the rest are factory-built closures.
  stages.set('enter', enterStage);
  stages.set('classify', createClassifyStage({
    llm: opts.llm,
    model: opts.model,
    rulesConfidenceThreshold: opts.classifierThreshold,
  }));
  stages.set('decide', createDecideStage({
    llm: opts.llm,
    model: opts.model,
    config: opts.config,
    branding: opts.branding,
    memoryRefiner: opts.memoryRefiner,
    log: opts.log,
  }));
  stages.set('execute', createExecuteStage({
    llm: opts.llm,
    model: opts.model,
    config: opts.config,
    branding: opts.branding,
  }));
  stages.set('recover', createRecoverStage({
    llm: opts.llm,
    model: opts.model,
  }));
  stages.set('verify', createVerifyStage({
    llm: opts.llm,
    model: opts.model,
  }));
  stages.set('evolve', createEvolveStage({
    llm: opts.llm,
    model: opts.model,
    memoryWriter: opts.memoryWriter,
    createSkill: opts.createSkill,
    llmPolicy: opts.config.memory.llmEvolve,
  }));
  stages.set('capture', createCaptureStage({
    llm: opts.llm,
    model: opts.model,
    memoryWriter: opts.memoryWriter,
    llmEnabled: opts.config.memory.llmCapture,
  }));
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

  return {
    name: 'core-flow',

    async run(ctx: RunContext): Promise<StageResult> {
      let current: StageName | 'exit' = 'enter';
      const trace: Array<{ name: StageName; startedAt: string; endedAt: string; ok: boolean }> = [];
      let lastResult: StageResult = {
        stage: 'enter',
        next: 'exit',
        ok: false,
        error: 'no stage executed',
      };

      while (current !== 'exit') {
        const stageName = current as StageName;
        const stage = stages.get(stageName);
        const startedAt = new Date().toISOString();

        if (!stage) {
          // No stage registered for this node — abort.
          return {
            stage: stageName,
            next: 'exit',
            ok: false,
            error: `no stage registered for '${stageName}'`,
            meta: { trace },
          };
        }

        // before hooks (void → modifying → claiming)
        const before = await hooks.runBefore(ctx, stageName);
        let result: StageResult;
        if (before.claimed) {
          result = before.claimed;
        } else {
          try {
            result = await stage(ctx);
          } catch (err) {
            // Stage threw (shouldn't happen — stages return ok:false — but defend).
            result = {
              stage: stageName,
              next: 'exit',
              ok: false,
              error: `stage threw: ${(err as Error).message}`,
            };
          }
        }

        // after hooks (void → modifying)
        result = await hooks.runAfter(ctx, stageName, result);
        // Normalize the stage tag in case a hook replaced result without it.
        result = { ...result, stage: stageName };

        const endedAt = new Date().toISOString();
        trace.push({ name: stageName, startedAt, endedAt, ok: result.ok });

        // Record lastError for RECOVER (only if the stage set one isn't already present).
        if (!result.ok && result.error) {
          if (!ctx.lastError || ctx.lastError.stage !== stageName) {
            ctx.lastError = { stage: stageName, message: result.error };
          }
        }

        lastResult = result;
        current = result.next;
      }

      // Return the final stage's result with the trace merged into meta.
      return {
        ...lastResult,
        next: 'exit',
        meta: { ...(lastResult.meta ?? {}), trace },
      };
    },

    on(hook: AnyHook): void {
      hooks.register(hook);
    },

    registerStage(name: StageName, stage: Stage): void {
      if (!ALL_STAGES.includes(name)) {
        throw new Error(`registerStage: unknown stage '${name}'`);
      }
      stages.set(name, stage);
    },
  };
}
