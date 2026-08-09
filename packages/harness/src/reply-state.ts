import type { ReplyProvenance, RunContext } from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** The reply boundary keeps visible text and its model provenance together. */
export interface ReplyStateUpdate {
  reply?: string;
  replyProvenance?: ReplyProvenance;
}

const REPLY_FIELDS = ['reply', 'replyProvenance'] as const satisfies readonly (keyof ReplyStateUpdate)[];

/**
 * Commit one validated reply update. Validate the complete batch before
 * mutating RunContext so a forbidden provenance write cannot leave visible
 * text without its audit record (or vice versa).
 */
export function writeReplyState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: ReplyStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof ReplyStateUpdate>;
  for (const field of fields) {
    if (!REPLY_FIELDS.includes(field)) {
      throw new Error(`Unknown reply state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Clear a provisional or completed reply at a stage boundary. */
export function clearReplyState(ctx: RunContext, stage: RunContextContractStage): void {
  writeReplyState(ctx, stage, {
    reply: undefined,
    replyProvenance: undefined,
  });
}
