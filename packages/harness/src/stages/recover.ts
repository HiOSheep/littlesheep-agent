// @littlesheep/harness — stages/recover.ts
// RECOVER: LLM decides retry / escalate / abort when a prior stage failed.
// Increments recoveryAttempts; forces escalate once max is exceeded.

import type {
  RunContext,
  StageResult,
  StageName,
  PlanStep,
} from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import { toChatMessage, textOf, callLlmForJson } from './_shared.js';
import { appendSystemPromptAddons, buildUserFacingVoiceAddon } from '../profile-prompt.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { acceptUniqueUserFacingReply, type ReplyRewriteInput } from '../user-facing-reply.js';

export interface RecoverStageDeps {
  llm: LlmClient;
  model: string;
}

const SYSTEM_PROMPT = `You are the RECOVER stage of a hard-control-flow agent.
A prior stage failed. Decide how to proceed.

Return ONLY a JSON object, no markdown:
{"action":"retry"|"escalate"|"abort","revisedPlan":[{"description":"...","tools":["..."],"requiresApproval":false}],"reason":"short explanation"}

The reason may be shown to the user. Write it in the user's language, follow the active voice, keep it concise and do not expose private chain-of-thought.

Actions:
- "retry": try the failing stage again. Optionally provide a revisedPlan (replaces the current plan).
- "escalate": hand control back to the user (ask for clarification). Use when you cannot auto-recover.
- "abort": terminate the run entirely. Use only for unrecoverable failures.`;

interface DecodedRecovery {
  action?: string;
  revisedPlan?: Array<{ description?: string; tools?: unknown; requiresApproval?: boolean }>;
  reason?: string;
}

/** Validate + normalize a revisedPlan decoded from LLM output. */
function normalizePlan(
  raw: DecodedRecovery['revisedPlan'],
  availableToolNames: Set<string>,
): PlanStep[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const plan: PlanStep[] = [];
  for (const step of raw) {
    if (!step || typeof step.description !== 'string' || step.description.trim().length === 0) continue;
    const tools = Array.isArray(step.tools)
      ? step.tools.filter((t): t is string => typeof t === 'string' && availableToolNames.has(t))
      : undefined;
    plan.push({
      description: step.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      requiresApproval: step.requiresApproval === true ? true : undefined,
    });
  }
  return plan.length > 0 ? plan : undefined;
}

/** Factory: creates a recover stage. */
export function createRecoverStage(deps: RecoverStageDeps) {
  return async function recoverStage(ctx: RunContext): Promise<StageResult> {
    ctx.recoveryAttempts = (ctx.recoveryAttempts ?? 0) + 1;

    // Force-escalate once we've exhausted retries.
    if (ctx.recoveryAttempts > ctx.maxRecoveryAttempts) {
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: { forcedEscalate: true, attempts: ctx.recoveryAttempts },
      };
    }

    const lastError = ctx.lastError;
    const availableToolNames = new Set(ctx.tools.map((t) => t.name));

    const recentResults = (ctx.toolResults ?? []).slice(-3).map((r) => ({
      ok: r.ok,
      error: r.error,
    }));

    const userMsg =
      `Last error: stage=${lastError?.stage ?? 'unknown'}, message=${lastError?.message ?? 'unknown'}\n`
      + `Recovery attempt: ${ctx.recoveryAttempts}/${ctx.maxRecoveryAttempts}\n`
      + `Recent tool results: ${JSON.stringify(recentResults)}\n`
      + `Current plan: ${ctx.plan ? JSON.stringify(ctx.plan.map((p) => p.description)) : '(none)'}\n`
      + `Inbound: ${textOf(ctx.inbound).slice(0, 500)}`;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: appendSystemPromptAddons(
          SYSTEM_PROMPT,
          ctx.profilePromptAddon,
          buildUserFacingVoiceAddon(ctx),
        ),
      },
      ...ctx.history.slice(-3).map(toChatMessage),
      { role: 'user', content: userMsg },
    ];

    let parsed: DecodedRecovery | null;
    const recoveryHistory = ctx.history.slice(-3);
    try {
      ({ parsed } = await callLlmForJson<DecodedRecovery>(
        deps.llm,
        deps.model,
        messages,
        {
          maxAttempts: 3,
          maxTokens: 800,
          signal: ctx.signal,
          onRequest: (request) => prepareModelRequest(
            ctx,
            'recover',
            request,
            buildRunRequestCandidates(ctx, 'recover', request.messages, {
              history: recoveryHistory,
              primaryUserKind: 'workflow_state',
            }),
          ),
          onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
        },
      ));
    } catch (e) {
      // Transport error during recovery — escalate to the user instead of
      // propagating to default-harness → exit. RECOVER itself failing must
      // not silently kill the run.
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: {
          fallbackEscalate: true,
          attempts: ctx.recoveryAttempts,
          transportError: (e as Error).message,
        },
      };
    }

    if (!parsed || (parsed.action !== 'retry' && parsed.action !== 'escalate' && parsed.action !== 'abort')) {
      // Could not decode → escalate conservatively.
      return {
        stage: 'recover',
        next: 'ask_user',
        ok: true,
        meta: { fallbackEscalate: true, attempts: ctx.recoveryAttempts },
      };
    }

    let next: StageName;
    if (parsed.action === 'retry') {
      const revised = normalizePlan(parsed.revisedPlan, availableToolNames);
      if (revised) {
        ctx.plan = revised;
        ctx.taskBook = undefined;
      }
      next = 'execute';
    } else if (parsed.action === 'escalate') {
      const originalRequest = textOf(ctx.inbound);
      const chinese = /[\u3400-\u9fff]/u.test(originalRequest);
      ctx.clarificationRequest = {
        id: `${ctx.runId}:clarification`,
        kind: 'recovery_decision',
        sourceStage: 'recover',
        createdAt: new Date().toISOString(),
        originalRequest,
        copySource: 'runtime_fallback',
        blockingReason: parsed.reason?.trim()
          || `${lastError?.stage ?? 'recover'}: ${lastError?.message ?? 'execution could not continue'}`,
        questions: [{
          id: 'question-1',
          field: 'recoveryDecision',
          prompt: chinese ? '你希望我接下来如何处理？' : 'How would you like me to proceed?',
          required: true,
        }],
      };
      next = 'ask_user';
    } else {
      try {
        ctx.reply = await acceptUniqueUserFacingReply(
          ctx,
          'recover',
          parsed.reason ?? '',
          (input) => rewriteAbortReason(deps, ctx, lastError, input),
        );
      } catch (error) {
        ctx.reply = undefined;
        ctx.replyProvenance = undefined;
        ctx.lastError = { stage: 'recover', message: `user-facing recovery reply generation failed: ${(error as Error).message}` };
        return { stage: 'recover', next: 'exit', ok: false, error: ctx.lastError.message };
      }
      next = 'finalize';
    }

    return {
      stage: 'recover',
      next,
      ok: true,
      meta: { action: parsed.action, attempts: ctx.recoveryAttempts, reason: parsed.reason },
    };
  };
}

async function rewriteAbortReason(
  deps: RecoverStageDeps,
  ctx: RunContext,
  lastError: RunContext['lastError'],
  input: ReplyRewriteInput,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: appendSystemPromptAddons(
        SYSTEM_PROMPT,
        buildUserFacingVoiceAddon(ctx),
        'The previous abort reason exactly repeats a previously published LS reply. Return action "abort" again, but rewrite reason with a genuinely different opening and sentence structure. Preserve the same failure facts and do not mention the rewrite.',
      ),
    },
    {
      role: 'user',
      content: [
        `Last error: stage=${lastError?.stage ?? 'unknown'}, message=${lastError?.message ?? 'unknown'}`,
        `Prior API-generated reason: ${input.generatedReply}`,
        `Recent replies to avoid repeating exactly:\n${input.avoidReplies.map((reply, index) => `${index + 1}. ${reply}`).join('\n')}`,
      ].join('\n\n'),
    },
  ];
  const { parsed } = await callLlmForJson<DecodedRecovery>(deps.llm, deps.model, messages, {
    maxAttempts: 2,
    maxTokens: 800,
    signal: ctx.signal,
    onRequest: (request) => prepareModelRequest(
      ctx,
      'recover',
      request,
      buildRunRequestCandidates(ctx, 'recover', request.messages, {
        history: [],
        primaryUserKind: 'workflow_state',
      }),
    ),
    onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
  });
  return parsed?.action === 'abort' ? parsed.reason ?? '' : '';
}
