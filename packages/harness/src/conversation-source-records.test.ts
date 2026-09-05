import { describe, expect, it } from 'vitest';
import { asSessionId, textMessage, type RunContext } from '@littlesheep/types';
import { collectConversationSourceRecords, conversationSourceRefs } from './conversation-source-records.js';

describe('conversation source records', () => {
  it('captures only user-visible run material with stable source ids', () => {
    const ctx = {
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      startedAt: '2026-07-16T06:00:00.000Z',
      inbound: textMessage('user', 'build it', {
        id: 'message-1',
        timestamp: '2026-07-16T06:00:00.000Z',
      }),
      produced: [{
        id: 'tool-result-message',
        role: 'tool',
        timestamp: '2026-07-16T06:00:02.000Z',
        content: [{
          type: 'tool_result',
          result: { callId: 'call-1', ok: true, output: 'done', meta: { stepId: 'step-1' } },
        }],
      }],
      reply: 'completed',
      verificationHistory: [{
        attempt: 1,
        verdict: 'pass',
        reason: 'verified',
        verifiedAt: '2026-07-16T06:00:03.000Z',
        source: 'structural',
      }],
    } as unknown as RunContext;

    const records = collectConversationSourceRecords(ctx);
    expect(records.map((record) => record.kind)).toEqual([
      'user-message',
      'assistant-reply',
      'tool-result',
      'verification',
    ]);
    expect(conversationSourceRefs(ctx)).toEqual(records.map((record) => record.id));
    expect(records[0]?.payload).toMatchObject({ role: 'user' });
  });

  it('keeps a pre-FINALIZE reply for memory capture but hides an unsettled FINALIZE proposal', () => {
    const ctx = {
      runId: 'run-proposal',
      sessionId: asSessionId('session-proposal'),
      startedAt: '2026-07-16T06:00:00.000Z',
      inbound: textMessage('user', 'inspect', { id: 'message-proposal' }),
      produced: [],
      reply: 'candidate reply',
    } as unknown as RunContext;

    expect(collectConversationSourceRecords(ctx).map((record) => record.kind))
      .toContain('assistant-reply');

    ctx.produced.push({
      id: 'finalize-proposal',
      role: 'assistant',
      stage: 'finalize',
      timestamp: '2026-07-16T06:00:01.000Z',
      content: [{ type: 'text', text: 'candidate reply' }],
      finalReplySettlement: {
        version: 1,
        settlementId: 'settlement-proposal',
        reply: 'candidate reply',
        replyFingerprint: 'fingerprint-proposal',
        modelRequestId: 'request-proposal',
        status: 'proposed',
      },
    } as never);

    expect(collectConversationSourceRecords(ctx).map((record) => record.kind))
      .not.toContain('assistant-reply');
  });
});
