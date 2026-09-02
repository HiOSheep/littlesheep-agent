// Shared final-reply identity helpers. The same normalization and digest must
// be used by candidate reservation, FINALIZE and durable replay.

import { createHash } from 'node:crypto';
import { normalizeUserFacingReply } from '@littlesheep/types';

export function finalReplyFingerprint(reply: string): string {
  return createHash('sha256')
    .update(normalizeUserFacingReply(reply), 'utf8')
    .digest('hex');
}

/** Stable for one run and one candidate, including after reconnect/replay. */
export function finalReplySettlementId(runId: string, replyFingerprint: string): string {
  return `${runId}:final-reply:${replyFingerprint}`;
}
