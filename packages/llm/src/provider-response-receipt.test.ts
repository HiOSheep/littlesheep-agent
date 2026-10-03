import { describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from './client.js';
import type { ChatRequest, ProviderResponseReceipt } from './types.js';

const request = (): ChatRequest => ({ model: 'fixture', messages: [{ role: 'user', content: 'test' }] });
const choice = { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' };
const report = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
function client(fetch: typeof globalThis.fetch) {
  return new OpenAIClient({ baseURL: 'http://provider.fixture', fetch, retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false } });
}

describe('physical Provider response receipts', () => {
  it('awaits each billable receipt before retrying an empty response', async () => {
    const receipts: ProviderResponseReceipt[] = [];
    const fetch = vi.fn(async () => {
      expect(receipts).toHaveLength(fetch.mock.calls.length - 1);
      return Response.json({ choices: fetch.mock.calls.length === 1 ? [] : [choice], usage: report });
    });
    const response = await client(fetch).chat({ ...request(), onProviderResponse: async receipt => {
      await Promise.resolve();
      receipts.push(receipt);
    } });
    expect(response.content).toBe('ok');
    expect(receipts.map(receipt => [receipt.attempt, receipt.completed, receipt.usage?.totalTokens])).toEqual([[1, true, 15], [2, true, 15]]);
    expect(receipts.every(receipt => receipt.usage?.observedAttemptCount === 1)).toBe(true);
  });

  it('keeps valid usage even when tool markup validation rejects the response', async () => {
    const receipts: ProviderResponseReceipt[] = [];
    const fetch = vi.fn(async () => Response.json({ choices: [{ ...choice,
      message: { role: 'assistant', content: '<｜DSML｜ calls><｜DSML｜ invoke name="unknown">' } }], usage: report }));
    await expect(client(fetch).chat({ ...request(), onProviderResponse: receipt => { receipts.push(receipt); } })).rejects.toThrow();
    expect(receipts[0]?.usage?.totalTokens).toBe(15);
  });

  it.each([{}, { prompt_tokens: 12 }, { completion_tokens: 3 },
    { prompt_tokens: -1, completion_tokens: 3 }, { prompt_tokens: 1.5, completion_tokens: 3 },
    { prompt_tokens: 12, completion_tokens: 3, total_tokens: 2 },
  ])('never fabricates zero for invalid or incomplete usage %j', async usage => {
    const receipts: ProviderResponseReceipt[] = [];
    const response = await client(async () => Response.json({ choices: [choice], usage })).chat({
      ...request(), onProviderResponse: receipt => { receipts.push(receipt); },
    });
    expect(response.usage).toBeUndefined();
    expect(receipts).toMatchObject([{ attempt: 1, completed: true, usage: undefined }]);
  });

  it('accepts real zero counts and derives total only from two real counters', async () => {
    const response = await client(async () => Response.json({ choices: [choice], usage: { prompt_tokens: 0, completion_tokens: 0 } })).chat(request());
    expect(response.usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('does not discard valid primary counters because an auxiliary cache counter is invalid', async () => {
    const response = await client(async () => Response.json({ choices: [choice], usage: {
      ...report, prompt_cache_hit_tokens: 99, prompt_cache_miss_tokens: -1,
      completion_tokens_details: { reasoning_tokens: 99 },
    } })).chat(request());
    expect(response.usage).toMatchObject({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
    expect(response.usage?.cachedPromptTokens).toBeUndefined();
    expect(response.usage?.reasoningTokens).toBeUndefined();
  });

  it('flushes an EOF usage frame without a trailing newline', async () => {
    const receipts: ProviderResponseReceipt[] = [];
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: report })}`;
    const response = await client(async () => new Response(body)).chatStream({
      ...request(), onProviderResponse: receipt => { receipts.push(receipt); },
    }, () => {});
    expect(response.content).toBe('你好');
    expect(response.usage?.totalTokens).toBe(15);
    expect(receipts).toMatchObject([{ attempt: 1, completed: true, usage: { totalTokens: 15 } }]);
  });

  it('records received usage on an interrupted stream before raising the error', async () => {
    const receipts: ProviderResponseReceipt[] = [];
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }], usage: report })}\n\n`));
      else controller.error(new Error('connection reset'));
    } });
    const llm = new OpenAIClient({ baseURL: 'http://provider.fixture', fetch: async () => new Response(stream), retry: { maxAttempts: 1 } });
    await expect(llm.chatStream({ ...request(), onProviderResponse: receipt => { receipts.push(receipt); } }, () => {})).rejects.toThrow();
    expect(receipts).toMatchObject([{ completed: false, usage: { totalTokens: 15 } }]);
  });

  it('does not reissue a billed request when durable receipt storage fails', async () => {
    const fetch = vi.fn(async () => Response.json({ choices: [choice], usage: report }));
    await expect(client(fetch).chat({ ...request(), onProviderResponse: async () => { throw new Error('disk failure'); } })).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
