import type {
  FinalReplyReservation,
  FinalReplySettlement,
  ReplyProvenance,
  RunContext,
  RunContextContractStage,
  UserFacingReplyPurpose,
} from '@littlesheep/types';
import { containsUnquotedDsmlControlMarkup } from '@littlesheep/llm';
import { writeReplyState } from './reply-state.js';
import { finalReplyFingerprint, finalReplySettlementId } from './final-reply-identity.js';

export { normalizeUserFacingReply } from '@littlesheep/types';

export type UserFacingReplyFailureReason =
  | 'empty_model_reply'
  | 'continuity_repair_failed'
  | 'reply_registry_failed'
  | 'missing_model_request_provenance'
  | 'invalid_control_markup';

export class UserFacingReplyError extends Error {
  readonly reason: UserFacingReplyFailureReason;

  constructor(reason: UserFacingReplyFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserFacingReplyError';
    this.reason = reason;
  }
}

/**
 * Publish one model-authored reply after reserving its settlement identity.
 *
 * Repeating an earlier turn's wording is allowed: identical wording is a UX
 * preference, not a safety property, and when the user repeats a question the
 * same answer is the correct answer. What this boundary still enforces is
 * identity and provenance — the text must come from a recorded Provider
 * request, empty output and unquoted DSML control markup fail closed, a
 * registry failure is never papered over with Runtime-authored text, and one
 * settlement (run + text identity) can never be published twice with different
 * content. Returns undefined only for that last conflict so the caller can
 * fail loudly instead of publishing a second, different reply.
 */
export async function publishUserFacingReply(
  ctx: RunContext,
  purpose: UserFacingReplyPurpose,
  apiGeneratedReply: string,
  stage?: RunContextContractStage,
  /** Pin the proof to one recorded request when the text was not just generated. */
  expectedModelRequestId?: string,
): Promise<string | undefined> {
  const generatedReply = cleanModelReply(apiGeneratedReply);
  if (!generatedReply) {
    throw new UserFacingReplyError(
      'empty_model_reply',
      'The model returned no user-facing reply.',
    );
  }
  if (containsUnquotedDsmlControlMarkup(generatedReply)) {
    throw new UserFacingReplyError(
      'invalid_control_markup',
      'The model returned tool-control markup as a user-facing reply.',
    );
  }

  const provenance = createReplyProvenance(ctx, purpose, expectedModelRequestId);
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
    let recorded: boolean;
    try {
      recorded = await ctx.reserveUserFacingReply(generatedReply);
    } catch (error) {
      throw new UserFacingReplyError(
        'reply_registry_failed',
        `The reply registry could not reserve the model-authored reply: ${(error as Error).message}`,
        { cause: error },
      );
    }
    // The text-only ledger answers `false` when this exact wording is already
    // recorded in the session. That is the repeat case, which is now published
    // as-is; it stays observable instead of being refused or rewritten.
    if (!recorded) {
      ctx.toolContext.log?.(
        'warn',
        `publishing a reply that repeats text already recorded in the session ledger `
        + `(purpose=${purpose}, fingerprint=${replyFingerprint.slice(0, 12)})`,
      );
    }
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

function cleanModelReply(value: string): string {
  return value.trim();
}

function createReplyProvenance(
  ctx: Pick<RunContext, 'model' | 'modelRequests' | 'runtimeNow'>,
  purpose: UserFacingReplyPurpose,
  expectedModelRequestId?: string,
): ReplyProvenance {
  const request = [...(ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === purpose
      && (!expectedModelRequestId || snapshot.id === expectedModelRequestId));
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
    // Reply wording is published exactly as the Provider produced it. No
    // Runtime regeneration path exists any more, so this is always zero.
    rewriteCount: 0,
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
