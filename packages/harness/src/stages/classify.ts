// @littlesheep/harness — stages/classify.ts
// CLASSIFY is retained as a compatibility boundary, but semantically it is a
// compact activity router: respond / execute / clarify.
//
// Design principle: "understanding is the agent's job, not the user's."
// Casual ambiguity should be classified as chat and handled naturally. The
// classifier reserves unclear for input with no actionable meaning, which is a
// first-class clarification request rather than an execution error.

import {
  activityFromMessageClass,
  type RunContext,
  type StageResult,
  type StageName,
} from '@littlesheep/types';
import type { LlmClient } from '@littlesheep/llm';
import { classify } from '@littlesheep/classifier';
import {
  preferDirectModelOutput,
  prepareModelRequest,
  recordProviderUsage,
  ensureModelRequestStarted,
  recordModelRequestFailure,
} from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import { attachmentManifestText, recentHistoryForModel } from './_shared.js';
import { writeDecisionState } from '../decision-state.js';
import { assessRetrievalIntent } from '../retrieval-intent.js';
import {
  capabilityProbeDurablePayload,
  capabilityProbeEvent,
  capabilitySnapshotDurablePayload,
} from '../capability-events.js';
import { writeCapabilityState } from '../capability-state.js';

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export interface ClassifyStageDeps {
  llm: LlmClient;
  model: string;
  /** Rules confidence threshold to bypass LLM. Default 0.7. */
  rulesConfidenceThreshold?: number;
}

/** Factory: creates a classify stage that closes over the LLM deps. */
export function createClassifyStage(deps: ClassifyStageDeps) {
  return async function classifyStage(ctx: RunContext): Promise<StageResult> {
    // Structural continuation binding is Runtime authority. If a future
    // coordinator accidentally sends a bound answer through this compatibility
    // stage, bypass the probabilistic activity router and re-enter planning.
    if (ctx.resumedFromCheckpointId && ctx.clarificationResponse) {
      return {
        stage: 'classify',
        next: 'decide',
        ok: true,
        meta: {
          continuationGuard: true,
          checkpointId: ctx.resumedFromCheckpointId,
          requestId: ctx.clarificationResponse.requestId,
        },
      };
    }
    let next: StageName;
    try {
      // Capability questions and probes are Runtime-owned facts. Route them
      // deterministically before the generic classifier so a repeated status
      // question does not spend another model call or alter cache shape.
      const retrieval = assessRetrievalIntent(inboundText(ctx));
      if (retrieval.intent === 'capability_question' || retrieval.intent === 'capability_probe') {
        const routed = {
          activity: 'respond' as const,
          type: 'chat' as const,
          confidence: 1,
          source: 'rules' as const,
          reason: retrieval.intent === 'capability_probe'
            ? 'capability probe requested'
            : 'capability or status question',
          retrievalIntent: retrieval.intent,
        };
        // Persist the exact, redacted Runtime snapshot before routing. This is
        // the authority for capability answers; it is deliberately distinct
        // from a Web tool call and contains no model/user text.
        try {
          await ctx.appendDurableEvent?.({
            type: 'capability_snapshot_read',
            source: 'runtime',
            eventId: `${ctx.runId}:capability-snapshot:${ctx.capabilitySnapshot?.epoch ?? 'unavailable'}`,
            idempotencyKey: `${ctx.runId}:capability-snapshot`,
            payload: capabilitySnapshotDurablePayload(ctx.capabilitySnapshot),
          });
        } catch (error) {
          return {
            stage: 'classify',
            next: 'exit',
            ok: false,
            error: `capability snapshot could not be durably recorded: ${(error as Error).message}`,
          };
        }
        if (retrieval.intent === 'capability_probe') {
          const probe = capabilityProbeEvent(ctx.capabilitySnapshot, `${ctx.runId}:capability-probe`);
          writeCapabilityState(ctx, 'classify', {
            capabilityProbe: probe.probe,
            capabilityPermissionEvent: probe.permission,
          });
          ctx.onToolEvent?.({
            type: 'capability_probe',
            visibility: 'silent',
            capabilitySnapshot: ctx.capabilitySnapshot,
            capabilityProbe: probe.probe,
            permissionEvent: probe.permission,
          });
          try {
            await ctx.appendDurableEvent?.({
              type: 'capability_probe_settled',
              source: 'runtime',
              eventId: `${ctx.runId}:capability-probe-settled`,
              idempotencyKey: `${ctx.runId}:capability-probe-settled`,
              payload: capabilityProbeDurablePayload(probe.probe, probe.permission),
            });
          } catch (error) {
            return {
              stage: 'classify',
              next: 'exit',
              ok: false,
              error: `capability probe could not be durably recorded: ${(error as Error).message}`,
            };
          }
        }
        writeDecisionState(ctx, 'classify', { classification: routed });
        await ctx.appendDurableEvent?.({
          type: 'route_decided',
          source: 'runtime',
          eventId: `${ctx.runId}:route:${routed.activity}`,
          idempotencyKey: `${ctx.runId}:route:${routed.activity}`,
          payload: { route: routed.activity, source: routed.source, retrievalIntent: routed.retrievalIntent },
        });
        next = 'reply';
        return {
          stage: 'classify',
          next,
          ok: true,
          meta: { activity: routed.activity, classification: routed, deterministic: true },
        };
      }
      const classifierHistory = recentHistoryForModel(ctx.history, 4, 1_800);
      const manifest = attachmentManifestText(ctx.attachments);
      const classificationInbound = manifest
        ? { ...ctx.inbound, content: [...ctx.inbound.content, { type: 'text' as const, text: manifest }] }
        : ctx.inbound;
      const cls = await classify(classificationInbound, classifierHistory, {
        llm: deps.llm,
        model: deps.model,
        rulesConfidenceThreshold: deps.rulesConfidenceThreshold ?? 0.7,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'classify',
          preferDirectModelOutput(ctx, request, { force: true }),
          buildRunRequestCandidates(ctx, 'classify', request.messages, { history: classifierHistory }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
        beforeRequest: (request) => ensureModelRequestStarted(ctx, request),
        onError: (request, error) => recordModelRequestFailure(ctx, request, error, ctx.signal),
      });
      const classifiedActivity = cls.activity ?? activityFromMessageClass(cls.type);
      const activity = retrieval.intent === 'web_search'
          || retrieval.intent === 'web_fetch'
          || retrieval.intent === 'combined_memory_web'
          || retrieval.intent === 'browser_required'
          ? 'execute'
          : classifiedActivity;
      const routed = { ...cls, activity, retrievalIntent: retrieval.intent };
      if (activity === 'execute') {
        writeDecisionState(ctx, 'classify', { classification: routed });
        next = 'decide';
      } else if (activity === 'clarify') {
        const originalRequest = inboundText(ctx);
        writeDecisionState(ctx, 'classify', {
          classification: routed,
          clarificationRequest: {
          id: `${ctx.runId}:clarification`,
          kind: 'ambiguous_request',
          sourceStage: 'classify',
          createdAt: new Date().toISOString(),
          originalRequest,
          copySource: 'runtime_fallback',
          blockingReason: /[\u3400-\u9fff]/u.test(originalRequest)
            ? '当前消息不足以判断一个安全、明确的下一步。'
            : 'The message does not contain enough meaning to identify a safe next action.',
          questions: [{
            id: 'question-1',
            field: 'intent',
            prompt: /[\u3400-\u9fff]/u.test(originalRequest)
              ? '请补充你希望 LS 帮你完成的具体事情。'
              : 'What would you like LS to help you accomplish?',
            required: true,
          }],
          },
        });
        next = 'ask_user';
      } else {
        writeDecisionState(ctx, 'classify', { classification: routed });
        next = 'reply';
      }
      await ctx.appendDurableEvent?.({
        type: 'route_decided',
        source: 'runtime',
        eventId: `${ctx.runId}:route:${activity}`,
        idempotencyKey: `${ctx.runId}:route:${activity}`,
        payload: { route: activity, source: routed.source, retrievalIntent: routed.retrievalIntent },
      });
    } catch (err) {
      // Classifier never throws in practice, but defend against transport errors.
      writeDecisionState(ctx, 'classify', { classification: {
        activity: 'respond',
        type: 'chat',
        confidence: 0.3,
        source: 'llm',
        reason: `classify error: ${(err as Error).message}`,
      } });
      // A classifier transport failure is internal; do not make the user
      // clarify a message that may already be clear.
      next = 'reply';
      await ctx.appendDurableEvent?.({
        type: 'route_decided',
        source: 'runtime',
        eventId: `${ctx.runId}:route:respond`,
        idempotencyKey: `${ctx.runId}:route:respond`,
        payload: { route: 'respond', source: 'runtime_fallback', error: 'classifier_failed' },
      });
    }
    return {
      stage: 'classify',
      next,
      ok: true,
      meta: {
        activity: ctx.classification?.activity
          ?? activityFromMessageClass(ctx.classification?.type),
        classification: ctx.classification,
      },
    };
  };
}
