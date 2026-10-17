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
  S3B_PROVIDER_BILLING_CAP_BASIS: 'provider_hard_cap_fixture',
} as NodeJS.ProcessEnv;

describe('S3B real Provider configuration and metering', () => {
  it('preflights provider identity and budgets without exposing the API key', () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    expect(profile.ready).toBe(true);
    expect(profile.provider).toMatchObject({
      id: 'fixture-provider', model: 'fixture-model-v1', apiProtocol: 'openai-chat-completions',
      endpointOrigin: 'https://provider.fixture', physicalRequestBudget: 2,
      outputTokenLimit: 256, maxCostUsd: 1.25, providerBillingCapConfirmed: true,
      maxCostCny: null, costBudgetCurrency: 'USD', costBudgetAmount: 1.25,
      billingCapBasis: 'provider_hard_cap_fixture',
      temperature: null, topP: null, seed: null,
    });
    expect(JSON.stringify({ ready: profile.ready, missing: profile.missing, provider: profile.provider }))
      .not.toContain('never-serialize-this-secret');
  });

  it('accepts a CNY prepaid balance ceiling and rejects ambiguous currency budgets', () => {
    const profile = resolveS3bProviderProfile({
      ...liveFixtureEnv,
      S3B_MAX_COST_USD: '',
      S3B_MAX_COST_CNY: '30.25',
      S3B_PROVIDER_BILLING_CAP_BASIS: 'prepaid_balance_exhaustion',
    });
    expect(profile.ready).toBe(true);
    expect(profile.provider).toMatchObject({
      maxCostUsd: null,
      maxCostCny: 30.25,
      costBudgetCurrency: 'CNY',
      costBudgetAmount: 30.25,
      billingCapBasis: 'prepaid_balance_exhaustion',
    });

    const ambiguous = resolveS3bProviderProfile({
      ...liveFixtureEnv,
      S3B_MAX_COST_CNY: '30',
    });
    expect(ambiguous.ready).toBe(false);
    expect(ambiguous.missing).toContain('exactly one of S3B_MAX_COST_USD or S3B_MAX_COST_CNY (explicit positive cost ceiling required)');
  });

  it('counts one physical HTTP response, one model call, one tool proposal and provider usage separately', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const requestBodies: string[] = [];
    const fetch = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(String(init?.body ?? ''));
      return Response.json({
      id: 'response-fixture',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'proposal-1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21, prompt_tokens_details: { cached_tokens: 3 } },
      });
    });
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    const response = await measured.client.chat({
      model: 'fixture-provider/fixture-model-v1',
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
      observedParameters: [{ model: 'fixture-model-v1', requestedModelRef: 'fixture-provider/fixture-model-v1', temperature: 0.2, maxOutputTokens: 256, requestedMaxOutputTokens: 1000 }],
      physicalResponses: [{ attempt: 1, status: 200, endpointOrigin: 'https://provider.fixture' }],
      responseModelIds: [],
    });
    expect(JSON.parse(requestBodies[0]!).model).toBe('fixture-model-v1');
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

  it('retains bounded structured HTTP error facts without storing provider error text', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn(async () => Response.json({
      error: { code: 'invalid_parameter', type: 'invalid_request_error', param: 'tools', message: 'private provider body text' },
    }, { status: 400 }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    await expect(measured.client.chat({
      model: 'fixture-model-v1',
      messages: [{ role: 'user', content: 'synthetic request only' }],
    })).rejects.toBeTruthy();

    const snapshot = measured.snapshot();
    expect(snapshot.physicalResponses).toEqual([{
      attempt: 1,
      status: 400,
      endpointOrigin: 'https://provider.fixture',
      errorCode: 'invalid_parameter',
      errorType: 'invalid_request_error',
      errorParam: 'tools',
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('private provider body text');
  });

  it('disables redirects so one metered request cannot fan out to another endpoint', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return Response.redirect('https://redirect.fixture/collect', 302);
    });
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });

    await expect(measured.client.chat({
      model: 'fixture-model-v1',
      messages: [{ role: 'user', content: 'synthetic request only' }],
    })).rejects.toBeTruthy();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(measured.snapshot()).toMatchObject({
      physicalProviderRequests: 1,
      blockedPhysicalRequests: 0,
      physicalResponses: [{ attempt: 1, status: 302, endpointOrigin: 'https://provider.fixture' }],
    });
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
