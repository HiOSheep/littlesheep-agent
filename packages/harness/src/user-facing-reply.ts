import type {
  FinalReplyReservation,
  FinalReplySettlement,
  Message,
  ReplyProvenance,
  RunContext,
  RunContextContractStage,
  UserFacingReplyPurpose,
} from '@littlesheep/types';
import { filterAuthoritativeUserFacingMessages, normalizeUserFacingReply } from '@littlesheep/types';
import { textOf } from './stages/_shared.js';
import { writeReplyState } from './reply-state.js';
import { finalReplyFingerprint, finalReplySettlementId } from './final-reply-identity.js';

export { normalizeUserFacingReply } from '@littlesheep/types';

export const MAX_RECENT_VISIBLE_REPLIES = 12;
export const MAX_VISIBLE_REPLY_REWRITES = 2;
export const MAX_AVOID_REPLY_COUNT = 6;
export const MAX_AVOID_REPLY_CHARS = 800;

export type UserFacingReplyFailureReason =
  | 'empty_model_reply'
  | 'duplicate_model_reply'
  | 'rewrite_failed'
  | 'continuity_repair_failed'
  | 'reply_registry_failed'
  | 'missing_model_request_provenance';

export class UserFacingReplyError extends Error {
  readonly reason: UserFacingReplyFailureReason;

  constructor(reason: UserFacingReplyFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserFacingReplyError';
    this.reason = reason;
  }
}

export interface ReplyRewriteInput {
  generatedReply: string;
  avoidReplies: string[];
  attempt: number;
}

export type ReplyRewrite = (input: ReplyRewriteInput) => Promise<string>;

/**
 * Reserve one model-authored reply without generating replacement copy.
 * Returns undefined for a duplicate so a caller that already owns a richer
 * compatibility path can hand off to it. Empty output and registry failures
 * remain explicit errors.
 */
export async function reserveUserFacingReplyOnce(
  ctx: RunContext,
  purpose: UserFacingReplyPurpose,
  apiGeneratedReply: string,
  rewriteCount = 0,
  stage?: RunContextContractStage,
): Promise<string | undefined> {
  const generatedReply = cleanModelReply(apiGeneratedReply);
  if (!generatedReply) {
    throw new UserFacingReplyError(
      'empty_model_reply',
      'The model returned no user-facing reply.',
    );
  }

  const recentReplies = collectRecentAssistantReplies(ctx);
  const recentNormalized = new Set(recentReplies.map(normalizeUserFacingReply));
  if (recentNormalized.has(normalizeUserFacingReply(generatedReply))) return undefined;

  const provenance = createReplyProvenance(ctx, purpose, rewriteCount);
  const replyFingerprint = finalReplyFingerprint(generatedReply);
  const reservation: FinalReplyReservation = {
    version: 1,
    settlementId: finalReplySettlementId(ctx.runId, replyFingerprint),
    reply: generatedReply,
    replyFingerprint,
    modelRequestId: provenance.modelRequestId,
  };

  if (ctx.reserveUserFacingReplySettlement) {
    let reserved: boolean;
    try {
      reserved = await ctx.reserveUserFacingReplySettlement(reservation);
    } catch (error) {
      throw new UserFacingReplyError(
        'reply_registry_failed',
        `The reply registry could not reserve the model-authored reply: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!reserved) return undefined;
  } else if (ctx.reserveUserFacingReply) {
    let reserved: boolean;
    try {
      reserved = await ctx.reserveUserFacingReply(generatedReply);
    } catch (error) {
      throw new UserFacingReplyError(
        'reply_registry_failed',
        `The reply registry could not reserve the model-authored reply: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!reserved) return undefined;
  }

  const finalReplySettlement: FinalReplySettlement = {
    version: 1,
    settlementId: reservation.settlementId,
    reply: generatedReply,
    replyFingerprint,
    modelRequestId: provenance.modelRequestId,
    status: 'proposed',
  };
  writeReplyState(ctx, stage ?? replyStageForPurpose(purpose), {
    reply: generatedReply,
    replyProvenance: provenance,
    finalReplySettlement,
  });
  return generatedReply;
}

/**
 * Publish one reply returned by the current Provider API call only after
 * atomically reserving it in the durable session registry. Runtime may reject
 * the response or request another real-time API generation, but it never owns
 * a candidate-copy library and never authors replacement text.
 */
export async function acceptUniqueUserFacingReply(
  ctx: RunContext,
  purpose: UserFacingReplyPurpose,
  apiGeneratedReply: string,
  rewrite: ReplyRewrite,
  stage?: RunContextContractStage,
): Promise<string> {
  const recentReplies = collectRecentAssistantReplies(ctx);
  let generatedReply = cleanModelReply(apiGeneratedReply);

  for (let rewriteCount = 0; rewriteCount <= MAX_VISIBLE_REPLY_REWRITES; rewriteCount += 1) {
    const reserved = await reserveUserFacingReplyOnce(ctx, purpose, generatedReply, rewriteCount, stage);
    if (reserved) return reserved;

    if (rewriteCount >= MAX_VISIBLE_REPLY_REWRITES) {
      throw new UserFacingReplyError(
        'duplicate_model_reply',
        `The model repeated a previously published reply after ${MAX_VISIBLE_REPLY_REWRITES} rewrite attempts.`,
      );
    }

    try {
      generatedReply = cleanModelReply(await rewrite({
        generatedReply,
        avoidReplies: recentReplies
          .slice(-MAX_AVOID_REPLY_COUNT)
          .map((reply) => reply.slice(0, MAX_AVOID_REPLY_CHARS)),
        attempt: rewriteCount + 1,
      }));
    } catch (error) {
      throw new UserFacingReplyError(
        'rewrite_failed',
        `The model could not produce a distinct user-facing reply: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  throw new UserFacingReplyError('duplicate_model_reply', 'No distinct user-facing reply was produced.');
}

export function collectRecentAssistantReplies(ctx: Pick<RunContext, 'history' | 'produced'>): string[] {
  const replies: string[] = [];
  for (const message of filterAuthoritativeUserFacingMessages([...ctx.history, ...ctx.produced])) {
    if (message.role !== 'assistant') continue;
    const text = messageText(message).trim();
    if (!text) continue;
    replies.push(text);
  }
  return replies.slice(-MAX_RECENT_VISIBLE_REPLIES);
}

function cleanModelReply(value: string): string {
  return value.trim();
}

function messageText(message: Message): string {
  return textOf(message);
}

function createReplyProvenance(
  ctx: Pick<RunContext, 'model' | 'modelRequests' | 'runtimeNow'>,
  purpose: UserFacingReplyPurpose,
  rewriteCount: number,
): ReplyProvenance {
  const request = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === purpose);
  if (!request) {
    throw new UserFacingReplyError(
      'missing_model_request_provenance',
      `No recorded Provider API request can prove the ${purpose} user-facing reply.`,
    );
  }
  return {
    version: 1,
    source: 'llm',
    purpose,
    modelRequestId: request.id,
    modelRequestIndex: request.requestIndex,
    provider: request.provider,
    model: request.model || ctx.model,
    generatedAt: (ctx.runtimeNow?.() ?? new Date()).toISOString(),
    rewriteCount,
  };
}

function replyStageForPurpose(
  purpose: UserFacingReplyPurpose,
): 'decide' | 'execute' | 'recover' | 'reply' | 'ask_user' {
  switch (purpose) {
    case 'decide':
    case 'decide_explicit_tool':
      return 'decide';
    case 'execute_tool_loop':
    case 'execute_final_reply':
      return 'execute';
    case 'recover':
      return 'recover';
    case 'ask_user':
      return 'ask_user';
    case 'reply':
      return 'reply';
    case 'capability_reply':
      return 'reply';
  }
}
