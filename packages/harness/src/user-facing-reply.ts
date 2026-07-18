import type {
  Message,
  ReplyProvenance,
  RunContext,
  UserFacingReplyPurpose,
} from '@littlesheep/types';
import { normalizeUserFacingReply } from '@littlesheep/types';
import { textOf } from './stages/_shared.js';

export { normalizeUserFacingReply } from '@littlesheep/types';

export const MAX_RECENT_VISIBLE_REPLIES = 12;
export const MAX_VISIBLE_REPLY_REWRITES = 2;
export const MAX_AVOID_REPLY_COUNT = 6;
export const MAX_AVOID_REPLY_CHARS = 800;

export type UserFacingReplyFailureReason =
  | 'empty_model_reply'
  | 'duplicate_model_reply'
  | 'rewrite_failed'
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
): Promise<string> {
  const recentReplies = collectRecentAssistantReplies(ctx);
  const recentNormalized = new Set(recentReplies.map(normalizeUserFacingReply));
  let generatedReply = cleanModelReply(apiGeneratedReply);

  for (let rewriteCount = 0; rewriteCount <= MAX_VISIBLE_REPLY_REWRITES; rewriteCount += 1) {
    if (!generatedReply) {
      throw new UserFacingReplyError(
        'empty_model_reply',
        'The model returned no user-facing reply.',
      );
    }
    const provenance = createReplyProvenance(ctx, purpose, rewriteCount);

    const duplicateInCurrentContext = recentNormalized.has(normalizeUserFacingReply(generatedReply));
    let reserved = !duplicateInCurrentContext;
    if (reserved && ctx.reserveUserFacingReply) {
      try {
        reserved = await ctx.reserveUserFacingReply(generatedReply);
      } catch (error) {
        throw new UserFacingReplyError(
          'reply_registry_failed',
          `The reply registry could not reserve the model-authored reply: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
    if (reserved) {
      ctx.replyProvenance = provenance;
      return generatedReply;
    }

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
  for (const message of [...ctx.history, ...ctx.produced]) {
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
