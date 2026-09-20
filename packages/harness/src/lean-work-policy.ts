import type { Classification, RunContext, WorkPolicy } from '@littlesheep/types';
import { assessRetrievalIntent } from './retrieval-intent.js';

const WORK_POLICY_VERSION = 1 as const;
const MAX_BOUNDED_REQUEST_CHARS = 2_000;
const COMPLEX_SCOPE = /(?:多阶段|多步骤|完整系统|整个项目|全项目|架构|迁移|重构|批量|并行|分别|多个|所有文件|端到端)|\b(?:multi[- ]stage|multi[- ]step|architecture|migrate|refactor|batch|parallel|entire project|all files|end-to-end)\b/iu;

/** Select one versioned execution policy from structured route facts. */
export function selectWorkPolicy(ctx: RunContext, classification: Classification): WorkPolicy {
  const route = classification.activity ?? 'respond';
  const sourceMessageId = String(ctx.inbound.id);
  if (route !== 'execute') {
    return Object.freeze({
      version: WORK_POLICY_VERSION,
      route,
      sourceMessageId,
      reasonCode: classification.reasonCode ?? (route === 'clarify' ? 'llm_route_clarify' : 'llm_route_respond'),
    });
  }
  // A rule-matched conversational turn is answered in one loop request: a
  // leftover plan, a resume marker or a queued runtime event must not turn a
  // greeting into a planning request.
  if (classification.source === 'rules'
    && classification.type === 'chat'
    && assessRetrievalIntent(inboundText(ctx)).intent === 'none') {
    return policy(sourceMessageId, 'bounded_loop', 'conversational_default');
  }
  // One execution system. Every new request runs in the main loop, whatever its
  // size, scope, retrieval need or continuation state: the loop executes
  // multi-step work serially and the model decides when to answer. The reason
  // codes below are kept so a heavy request can still be explained in the audit
  // trail, but none of them buys a second executor any more. An already
  // persisted TaskBook still needs its own executor until that path is deleted.
  if (ctx.taskBook) return policy(sourceMessageId, 'task_book', 'existing_task_book');
  if (ctx.resumedFromCheckpointId || ctx.clarificationResponse || ctx.partialReplanRequest || ctx.verifyFeedback) {
    return policy(sourceMessageId, 'bounded_loop', 'continuation');
  }
  if ((ctx.deferredRuntimeEvents?.length ?? 0) > 0) {
    return policy(sourceMessageId, 'bounded_loop', 'deferred_runtime_event');
  }
  const text = inboundText(ctx);
  if (text.length > MAX_BOUNDED_REQUEST_CHARS) return policy(sourceMessageId, 'bounded_loop', 'large_request');
  if (COMPLEX_SCOPE.test(text)) return policy(sourceMessageId, 'bounded_loop', 'complex_scope');
  const retrievalIntent = assessRetrievalIntent(text).intent;
  if (classification.source === 'rules'
    && classification.confidence >= 0.8
    && classification.reasonCode === 'explicit_tool_instruction'
    && (retrievalIntent === 'none' || retrievalIntent === 'local_workspace' || retrievalIntent === 'local_memory')) {
    return policy(sourceMessageId, 'bounded_loop', 'bounded_single_goal');
  }
  if (retrievalIntent !== 'none') return policy(sourceMessageId, 'bounded_loop', 'retrieval_required');
  if (classification.source === 'rules'
    && classification.confidence >= 0.8
    && classification.reasonCode === 'action_request') {
    return policy(sourceMessageId, 'bounded_loop', 'bounded_single_goal');
  }
  // Default to the single main loop: the model either answers or calls a tool.
  return policy(sourceMessageId, 'bounded_loop', 'bounded_default');
}

/** Resolve a policy at EXECUTE, including one explicit legacy checkpoint path. */
export function resolveExecutionWorkPolicy(ctx: RunContext): WorkPolicy {
  const existing = ctx.classification?.workPolicy as unknown;
  if (existing !== undefined) {
    if (!isSupportedWorkPolicy(existing)) throw new Error('unsupported work policy version or shape');
    if (existing.route !== 'execute' || !existing.executionMode) {
      throw new Error('execution requires an execute work policy');
    }
    // Promotion is gone with the TaskBook upgrade path: a bounded loop always
    // runs in the single main loop.
    return existing;
  }
  if (ctx.resumedFromCheckpointId) {
    return policy(String(ctx.inbound.id), ctx.taskBook ? 'task_book' : 'bounded_loop', 'legacy_checkpoint');
  }
  if (!ctx.classification) throw new Error('execution requires a classification');
  return selectWorkPolicy(ctx, ctx.classification);
}

/** Compatibility facade retained while callers migrate to the policy object. */
export function canUseLeanWorkLoop(ctx: RunContext): boolean {
  return resolveExecutionWorkPolicy(ctx).executionMode === 'bounded_loop';
}

export function isSupportedWorkPolicy(value: unknown): value is WorkPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkPolicy>;
  if (candidate.version !== WORK_POLICY_VERSION
    || (candidate.route !== 'respond' && candidate.route !== 'execute' && candidate.route !== 'clarify')
    || typeof candidate.sourceMessageId !== 'string' || !candidate.sourceMessageId.trim()
    || typeof candidate.reasonCode !== 'string' || !candidate.reasonCode.trim()) return false;
  return candidate.route === 'execute'
    ? candidate.executionMode === 'bounded_loop' || candidate.executionMode === 'task_book'
    : candidate.executionMode === undefined;
}

function policy(
  sourceMessageId: string,
  executionMode: NonNullable<WorkPolicy['executionMode']>,
  reasonCode: WorkPolicy['reasonCode'],
): WorkPolicy {
  return Object.freeze({
    version: WORK_POLICY_VERSION,
    route: 'execute',
    sourceMessageId,
    executionMode,
    reasonCode,
  });
}

function inboundText(ctx: RunContext): string {
  return ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
