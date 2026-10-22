import { describe, expect, it } from 'vitest';
import { publishableReply, type FinalReplySettlement } from './message.js';

function settlement(status: FinalReplySettlement['status'], reply: string): FinalReplySettlement {
  return {
    version: 1,
    settlementId: 'settlement-1',
    reply,
    replyFingerprint: 'fingerprint',
    modelRequestId: 'request-1',
    status,
  };
}

describe('publishableReply', () => {
  it('publishes the settled reply, never a provisional one', () => {
    expect(publishableReply({ reply: 'legacy', finalReplySettlement: settlement('settled', 'authoritative') })).toBe('authoritative');
    expect(publishableReply({ reply: 'legacy', finalReplySettlement: settlement('proposed', 'draft') })).toBe('');
    expect(publishableReply({ reply: 'legacy', finalReplySettlement: settlement('runtime_status', 'runtime note') })).toBe('');
  });

  it('falls back to the legacy reply only when no settlement exists', () => {
    expect(publishableReply({ reply: 'legacy answer' })).toBe('legacy answer');
    expect(publishableReply({})).toBe('');
  });
});
