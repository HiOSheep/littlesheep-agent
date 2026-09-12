// Reservation, FINALIZE and durable replay must derive the same identity for
// the same reply, or the "one authoritative settlement" contract breaks.
import { describe, expect, it } from 'vitest';
import { normalizeUserFacingReply } from '@littlesheep/types';
import { finalReplyFingerprint, finalReplySettlementId } from './final-reply-identity.js';

describe('final reply identity', () => {
  it('derives one fingerprint per normalized reply', () => {
    const canonical = finalReplyFingerprint('Hello world');
    expect(canonical).toMatch(/^[a-f0-9]{64}$/u);
    // Case, surrounding space and internal whitespace runs normalize away.
    expect(finalReplyFingerprint('  HELLO   WORLD  ')).toBe(canonical);
    expect(finalReplyFingerprint('Hello world.')).not.toBe(canonical);
  });

  it('binds the settlement id to both the run and the reply fingerprint', () => {
    const fingerprint = finalReplyFingerprint('A durable answer');
    expect(finalReplySettlementId('run-1', fingerprint)).toBe(`run-1:final-reply:${fingerprint}`);
    expect(finalReplySettlementId('run-2', fingerprint)).not.toBe(finalReplySettlementId('run-1', fingerprint));
  });

  it('uses the same normalization the registry exposes', () => {
    const reply = '  Mixed   Case Reply  ';
    expect(finalReplyFingerprint(reply)).toBe(finalReplyFingerprint(normalizeUserFacingReply(reply)));
  });
});
