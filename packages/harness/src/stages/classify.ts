// @littlesheep/harness — stages/classify.ts
// CLASSIFY is retained as a compatibility boundary, but semantically it is a
// deterministic activity router: respond / execute.
//
// It spends no model request. Rules decide the conversational routes; retrieval
// intent decides the ones that need sources; anything else goes to the single
// main loop, which itself chooses between answering and calling a tool. Routing
// therefore no longer needs to be right about "chat vs task" before the model
// has seen the request.

import {
  activityFromMessageClass,
  type Classification,
  type RunContext,
  type StageResult,
  type StageName,
} from '@littlesheep/types';
import { classifyByRules } from '@littlesheep/classifier';
import { attachmentManifestText } from './_shared.js';
import { writeDecisionState } from '../decision-state.js';
import { assessRetrievalIntent } from '../retrieval-intent.js';
import {
  capabilityProbeDurablePayload,
  capabilityProbeEvent,
  capabilitySnapshotDurablePayload,
} from '../capability-events.js';
import { writeCapabilityState } from '../capability-state.js';
import { selectWorkPolicy } from '../lean-work-policy.js';

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export interface ClassifyStageDeps {
  /** Rules confidence threshold to accept a rule result. Default 0.7. */
  rulesConfidenceThreshold?: number;
}

/** No rule matched: hand the request to the main loop, which answers or acts. */
function defaultExecuteClassification(): Classification {
  return {
    activity: 'execute',
    type: 'problem',
    confidence: 0.5,
    source: 'rules',
    reasonCode: 'deterministic_default_execute',
    reason: 'no routing rule matched; the main loop decides whether to answer or act',
  };
}

/** Factory: creates the deterministic classify stage. */
export function createClassifyStage(deps: ClassifyStageDeps = {}) {
  return async function classifyStage(ctx: RunContext): Promise<StageResult> {
    // Structural continuation binding is Runtime authority. If a future
    // coordinator accidentally sends a bound answer through this compatibility
    // stage, keep the binding and hand the turn to the one main loop, which
    // carries the restored conversation and evidence.
    if (ctx.resumedFromCheckpointId && ctx.clarificationResponse) {
      return {
        stage: 'classify',
        next: 'execute',
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
        const routedBase = {
          activity: 'respond' as const,
          type: 'chat' as const,
          confidence: 1,
          source: 'rules' as const,
          reasonCode: retrieval.intent === 'capability_probe'
            ? 'capability_probe' as const
            : 'capability_question' as const,
          reason: retrieval.intent === 'capability_probe'
            ? 'capability probe requested'
            : 'capability or status question',
          retrievalIntent: retrieval.intent,
        };
        const routed = { ...routedBase, workPolicy: selectWorkPolicy(ctx, routedBase) };
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
          payload: {
            route: routed.activity,
            source: routed.source,
            retrievalIntent: routed.retrievalIntent,
            reasonCode: routed.reasonCode,
            workPolicy: routed.workPolicy,
          },
        });
        next = 'reply';
        return {
          stage: 'classify',
          next,
          ok: true,
          meta: { activity: routed.activity, classification: routed, deterministic: true },
        };
      }
      // Deterministic routing: rules first, otherwise the main loop. No model
      // request is spent here, so the routing decision cannot alter the prompt
      // shape of the requests that follow.
      const manifest = attachmentManifestText(ctx.attachments);
      const routingText = manifest ? `${inboundText(ctx)}\n${manifest}` : inboundText(ctx);
      const ruleResult = classifyByRules(routingText);
      const threshold = deps.rulesConfidenceThreshold ?? 0.7;
      const cls: Classification = ruleResult && ruleResult.confidence >= threshold
        ? ruleResult
        : defaultExecuteClassification();
      const classifiedActivity = cls.activity ?? activityFromMessageClass(cls.type);
      // One main loop owns every non-capability request. Rules still decide the
      // *reading* of the turn (greeting, direct-response constraint, action
      // request, …) and keep it in `type`/`reasonCode`, but the runtime no longer
      // splits "conversation" and "work" into two prompt shapes: chat and tool
      // turns therefore share one system prompt and one tool set, which is what
      // makes a session's prefix reusable across turns.
      const activity = classifiedActivity === 'respond' ? 'execute' : classifiedActivity;
      const routedBase = { ...cls, activity, retrievalIntent: retrieval.intent };
      const routed = { ...routedBase, workPolicy: selectWorkPolicy(ctx, routedBase) };
      if (activity === 'execute') {
        writeDecisionState(ctx, 'classify', { classification: routed });
        next = routed.workPolicy.executionMode === 'bounded_loop' ? 'execute' : 'decide';
      } else {
        writeDecisionState(ctx, 'classify', { classification: routed });
        next = 'reply';
      }
      await ctx.appendDurableEvent?.({
        type: 'route_decided',
        source: 'runtime',
        eventId: `${ctx.runId}:route:${activity}`,
        idempotencyKey: `${ctx.runId}:route:${activity}`,
        payload: {
          route: activity,
          source: routed.source,
          retrievalIntent: routed.retrievalIntent,
          reasonCode: routed.reasonCode,
          workPolicy: routed.workPolicy,
        },
      });
    } catch (err) {
      // Routing is deterministic, so a failure here is an internal error rather
      // than a transport failure. Continue in the main loop instead of claiming
      // the message was understood as conversation.
      const fallbackBase = {
        activity: 'execute',
        type: 'problem',
        confidence: 0.3,
        source: 'rules',
        reasonCode: 'classifier_failed',
        reason: `classify error: ${(err as Error).message}`,
      } as const;
      writeDecisionState(ctx, 'classify', {
        classification: { ...fallbackBase, workPolicy: selectWorkPolicy(ctx, fallbackBase) },
      });
      next = 'execute';
      await ctx.appendDurableEvent?.({
        type: 'route_decided',
        source: 'runtime',
        eventId: `${ctx.runId}:route:execute`,
        idempotencyKey: `${ctx.runId}:route:execute`,
        payload: {
          route: 'execute',
          source: 'runtime_fallback',
          reasonCode: 'classifier_failed',
          error: 'classifier_failed',
        },
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
