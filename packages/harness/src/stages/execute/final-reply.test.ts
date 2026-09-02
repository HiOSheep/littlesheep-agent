import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { TaskBook, TaskStepResult } from '@littlesheep/types';
import { createMockLlm, makeCtx, textResponse } from '../../tests/helpers.js';
import { synthesizeFinalReply } from './final-reply.js';

describe('web-aware final reply synthesis', () => {
  it('repairs forged citation ids against the durable Runtime projection', async () => {
    const validId = 'web-runtime-1-valid';
    const llm = createMockLlm([
      textResponse('Draft [citation:web-forged-1-source].'),
      textResponse(`Verified result [citation:${validId}].`),
    ]);
    const ctx = makeCtx();
    ctx.webEvidence = {
      version: 1,
      providerId: 'fixture',
      generatedAt: '2026-08-29T00:00:00.000Z',
      completeness: 'complete',
      citationIds: [validId],
      citations: [{
        id: validId,
        url: 'https://example.com/docs',
        origin: 'https://example.com',
        urlHash: 'a'.repeat(64),
        title: 'Current docs',
        provider: 'fixture',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        status: 'fetched',
        truncated: false,
      }],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: false,
      truncated: false,
      blocked: false,
      stale: false,
      errorKinds: ['web_provider_rate_limited'],
    };
    const taskBook: TaskBook = {
      assessment: {
        userNeed: 'compare current docs', complexity: 'standard', goal: 'compare current docs',
        successCriteria: ['cite the current source'], requiresTaskBook: true, maxExtraScopeRatio: 1,
      },
      goal: 'compare current docs',
      complexity: 'standard',
      successCriteria: ['cite the current source'],
      steps: [{ id: 'web', description: 'inspect current docs', tools: ['web_fetch'] }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
    };
    const stepResults: TaskStepResult[] = [{
      stepId: 'web', description: 'inspect current docs', status: 'done',
      output: `Current docs support the result [citation:${validId}].`,
      toolCallIds: [], toolResults: [],
    }];

    const reply = await synthesizeFinalReply(
      { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, llm },
      ctx,
      taskBook,
      stepResults,
    );

    expect(reply).toBe(`Verified result [citation:${validId}].`);
    expect(llm.chat).toHaveBeenCalledTimes(2);
    const repairRequest = llm.chat.mock.calls[1]?.[0];
    expect(JSON.stringify(repairRequest?.messages)).toContain(validId);
    expect(JSON.stringify(repairRequest?.messages)).toContain('Current docs');
    expect(JSON.stringify(repairRequest?.messages)).not.toContain('page body');
    expect(JSON.stringify(repairRequest?.messages)).not.toContain('web_provider_rate_limited');
  });
});
