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
  MemoryStoreLike,
  RunContext,
  Stage,
  StageName,
  StageResult,
} from '@littlesheep/types';
import { inspectStageTransition, stageNames } from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import type { SessionManager } from '@littlesheep/session';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type {
  MemoryAtomCorrectionServiceLike,
  MemoryAtomHierarchyServiceLike,
  MemoryAtomReconciliationServiceLike,
  MemoryAtomRevisionServiceLike,
  MemoryAtomSubtreeServiceLike,
  MemoryRunRefinementServiceLike,
  MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
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
import { consumeRuntimeControlEvents, consumeRuntimeTaskEvents } from './runtime-control-boundary.js';
import type { ExactContextTokenCounter } from '@littlesheep/context';
import { bindExactContextTokenCounter } from './model-observability.js';
import { resolveCheckpointResumeStage } from './checkpoint-resume.js';
import { recordFailure } from './failure-state.js';

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
  /** Runtime-owned boundary for model-proposed multi-Atom reconciliation. */
  memoryReconciler?: MemoryAtomReconciliationServiceLike;
  /** Runtime-owned boundary for model-proposed semantic parent corrections. */
  memoryHierarchy?: MemoryAtomHierarchyServiceLike;
  /** Runtime-owned boundary for bounded non-leaf Atom subtree movement. */
  memorySubtree?: MemoryAtomSubtreeServiceLike;
  /** Runtime-owned boundary for evidence-preserving Atom projection refinement. */
  memoryReviser?: MemoryAtomRevisionServiceLike;
  /** Runtime-owned boundary for evidence-backed fact correction and replacement. */
  memoryCorrector?: MemoryAtomCorrectionServiceLike;
  /**
   * Optional: if provided, EVOLVE may autonomously create skills when it
   * identifies a reusable pattern. This is the agent's self-evolution
   * mechanism — skills are created without user direction.
   */
  createSkill?: CreateSkillFn;
  /** Rules confidence threshold for CLASSIFY fast path. Default 0.7. */
  classifierThreshold?: number;
  /** Prepared at Runner startup; unavailable models continue with the non-displayable safety estimator. */
  tokenCounter?: ExactContextTokenCounter;
  /** Optional logger sink forwarded to HookRunner. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

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
    memoryReconciler: opts.memoryReconciler,
    memoryHierarchy: opts.memoryHierarchy,
    memorySubtree: opts.memorySubtree,
    memoryReviser: opts.memoryReviser,
    memoryCorrector: opts.memoryCorrector,
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
      bindExactContextTokenCounter(ctx, opts.tokenCounter);
      let current: StageName | 'exit' = resolveCheckpointResumeStage(ctx, ctx.entryStage ?? 'enter');
      const trace: Array<{ name: StageName; startedAt: string; endedAt: string; ok: boolean }> = [];
      let lastResult: StageResult = {
        stage: 'enter',
        next: 'exit',
        ok: false,
        error: 'no stage executed',
      };

      while (current !== 'exit') {
        current = resolveCheckpointResumeStage(ctx, current);
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

        const runtimeControl = consumeRuntimeControlEvents(ctx);
        if (runtimeControl.shouldStop) {
          const endedAt = new Date().toISOString();
          const error = runtimeControl.error
            ?? (runtimeControl.state === 'paused'
              ? 'run paused at a safe boundary'
              : 'run interrupted at a safe boundary');
          const controlResult: StageResult = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error,
            meta: {
              runtimeControl: ctx.runtimeControl,
              runtimeEventIds: runtimeControl.settledEventIds,
            },
          };
          trace.push({ name: stageName, startedAt, endedAt, ok: false });
          recordFailure(ctx, stageName, stageName, error);
          lastResult = controlResult;
          current = 'exit';
          continue;
        }

        const runtimeTasks = consumeRuntimeTaskEvents(ctx);
        if (runtimeTasks.error) {
          const endedAt = new Date().toISOString();
          const error = runtimeTasks.error;
          const boundaryResult: StageResult = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error,
            meta: {
              runtimeEventIds: runtimeTasks.settledEventIds,
              deferredRuntimeEventIds: runtimeTasks.deferredEventIds,
              appliedTaskBookPatchIds: runtimeTasks.appliedPatchIds,
            },
          };
          trace.push({ name: stageName, startedAt, endedAt, ok: false });
          recordFailure(ctx, stageName, stageName, error);
          lastResult = boundaryResult;
          current = 'exit';
          continue;
        }
        if (runtimeTasks.shouldReplan && stageName !== 'decide') {
          current = ctx.classification ? 'decide' : 'classify';
          continue;
        }
        if (runtimeTasks.taskBookChanged && stageName !== 'execute' && !runtimeTasks.shouldReplan) {
          current = ctx.taskBook ? 'execute' : 'decide';
          continue;
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

        const transition = inspectStageTransition(stageName, result.next);
        if (!transition.ok) {
          const attempted = String(transition.violation.attempted);
          const allowed = transition.violation.allowed.join(', ');
          const error = `invalid stage transition '${stageName}' -> '${attempted}'; allowed targets: ${allowed}`;
          result = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error,
            meta: {
              ...(result.meta ?? {}),
              transitionViolation: {
                from: stageName,
                attempted: transition.violation.attempted,
                allowed: transition.violation.allowed,
              },
            },
          };
        }

        const endedAt = new Date().toISOString();
        trace.push({ name: stageName, startedAt, endedAt, ok: result.ok });

        // Record lastError for RECOVER (only if the stage set one isn't already present).
        if (!result.ok && result.error) {
          if (!ctx.lastError || ctx.lastError.stage !== stageName) {
            recordFailure(ctx, stageName, stageName, result.error);
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
      if (!stageNames.includes(name)) {
        throw new Error(`registerStage: unknown stage '${name}'`);
      }
      stages.set(name, stage);
    },
  };
}
