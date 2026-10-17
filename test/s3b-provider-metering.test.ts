import { describe, expect, it, vi } from 'vitest';
import { resolveS3bProviderProfile } from '../scripts/lib/s3b-provider-config.mjs';
import { createS3bMeasuredProvider } from './s3b-provider-metering.js';

const liveFixtureEnv = {
  S3B_PROVIDER_ID: 'fixture-provider',
  S3B_MODEL: 'fixture-model-v1',
  S3B_API_PROTOCOL: 'openai-chat-completions',
  S3B_BASE_URL: 'https://provider.fixture/v1',
  S3B_API_KEY: 'never-serialize-this-secret',
  S3B_MAX_PHYSICAL_REQUESTS: '2',
  S3B_MAX_OUTPUT_TOKENS: '256',
  S3B_MAX_COST_USD: '1.25',
  S3B_PROVIDER_BILLING_CAP_CONFIRMED: 'true',
} as NodeJS.ProcessEnv;

describe('S3B real Provider configuration and metering', () => {
  it('preflights provider identity and budgets without exposing the API key', () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    expect(profile.ready).toBe(true);
    expect(profile.provider).toMatchObject({
      id: 'fixture-provider', model: 'fixture-model-v1', apiProtocol: 'openai-chat-completions',
      endpointOrigin: 'https://provider.fixture', physicalRequestBudget: 2,
      outputTokenLimit: 256, maxCostUsd: 1.25, providerBillingCapConfirmed: true,
      temperature: null, topP: null, seed: null,
    });
    expect(JSON.stringify({ ready: profile.ready, missing: profile.missing, provider: profile.provider }))
      .not.toContain('never-serialize-this-secret');
  });

  it('counts one physical HTTP response, one model call, one tool proposal and provider usage separately', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn(async () => Response.json({
      id: 'response-fixture',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal-1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21, prompt_tokens_details: { cached_tokens: 3 } },
    }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    const response = await measured.client.chat({
      model: 'fixture-model-v1',
      messages: [{ role: 'user', content: 'synthetic request only' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'read fixture', parameters: { type: 'object' } } }],
      max_tokens: 1000,
      temperature: 0.2,
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(measured.snapshot()).toMatchObject({
      logicalModelRequests: 1,
      physicalProviderRequests: 1,
      toolCallProposals: 1,
      providerResponseReceipts: 1,
      usage: { status: 'available', inputTokens: 17, outputTokens: 4, cachedInputTokens: 3, responseCount: 1 },
      observedParameters: [{ model: 'fixture-model-v1', temperature: 0.2, maxOutputTokens: 256, requestedMaxOutputTokens: 1000 }],
      physicalResponses: [{ attempt: 1, status: 200, endpointOrigin: 'https://provider.fixture' }],
    });
  });

  it('blocks the next physical request before dispatch after the configured budget', async () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_PHYSICAL_REQUESTS: '1' });
    const fetch = vi.fn(async () => Response.json({
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    const request = { model: 'fixture-model-v1', messages: [{ role: 'user' as const, content: 'synthetic request only' }] };
    await measured.client.chat(request);
    await expect(measured.client.chat(request)).rejects.toThrow('physical Provider request budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(measured.snapshot()).toMatchObject({ physicalProviderRequests: 1, blockedPhysicalRequests: 1, budgetExhausted: true });
  });

  it('keeps incomplete usage unavailable and requires explicit limits for live use', () => {
    const incomplete = resolveS3bProviderProfile({
      S3B_PROVIDER_ID: 'fixture', S3B_MODEL: 'model', S3B_API_PROTOCOL: 'openai-chat-completions',
      S3B_BASE_URL: 'http://remote.example/v1', S3B_MAX_PHYSICAL_REQUESTS: '999999',
      S3B_MAX_OUTPUT_TOKENS: '0', S3B_MAX_COST_USD: '', S3B_PROVIDER_BILLING_CAP_CONFIRMED: 'false',
    } as NodeJS.ProcessEnv);
    expect(incomplete.ready).toBe(false);
    expect(incomplete.missing).toContain('S3B_API_KEY');
    expect(incomplete.missing.some((item) => item.startsWith('S3B_MAX_PHYSICAL_REQUESTS'))).toBe(true);
    expect(incomplete.missing.some((item) => item.startsWith('S3B_BASE_URL'))).toBe(true);
    expect(JSON.stringify(incomplete)).not.toContain('secret');
  });
});
