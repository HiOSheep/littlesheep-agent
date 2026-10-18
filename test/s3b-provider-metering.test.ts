import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  NON_RETRYABLE_PROVIDER_STATUSES,
  RETRYABLE_PROVIDER_STATUSES,
  classifyFailure,
  isNonRetryableProviderStatus,
  resolveProviderWireModel,
  resolveS3bProviderProfile,
  sanitizeS3bText,
} from '../scripts/lib/s3b-provider-config.mjs';
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

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** Build a child environment with every inherited S3B_* variable removed, then the explicit overrides. */
function s3bEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('S3B_')) delete env[key];
  }
  return { ...env, ...overrides };
}

function runEvaluator(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['scripts/s3b-eval.mjs', ...args], {
    cwd: repositoryRoot,
    env: s3bEnv(overrides),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const syntheticRequest = {
  model: 'fixture-provider/fixture-model-v1',
  messages: [{ role: 'user' as const, content: 'synthetic request only' }],
};

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

  // ---- P04 item 1: explicit internal-ref → wire-model mapping ------------------

  it('resolves exactly one Provider wire model id per internal ref and records both fields', () => {
    expect(resolveProviderWireModel('fixture-provider/fixture-model-v1', 'fixture-provider', 'fixture-model-v1')).toMatchObject({
      status: 'resolved',
      internalModelRef: 'fixture-provider/fixture-model-v1',
      providerId: 'fixture-provider',
      configuredModel: 'fixture-model-v1',
      wireModelId: 'fixture-model-v1',
      reason: null,
    });
    expect(resolveProviderWireModel('fixture-model-v1', 'fixture-provider', 'fixture-model-v1')).toMatchObject({
      status: 'resolved', wireModelId: 'fixture-model-v1',
    });

    const rejectedCases: Array<[string, RegExp]> = [
      ['other-provider/fixture-model-v1', /provider segment/],
      ['fixture-provider/other-model', /model segment/],
      ['fixture-provider/fixture-model-v1/extra', /nested path/],
      ['fixture-provider/fixture-provider/fixture-model-v1', /provider prefix/],
      ['fixture-provider/', /no model segment/],
      ['fixture-provider/fixture model', /whitespace/],
      ['', /missing/],
    ];
    for (const [ref, reason] of rejectedCases) {
      const rejected = resolveProviderWireModel(ref, 'fixture-provider', 'fixture-model-v1');
      expect(rejected.status, ref).toBe('rejected');
      expect(rejected.wireModelId, ref).toBeNull();
      expect(rejected.reason, ref).toMatch(reason);
      expect(rejected.internalModelRef, ref).toBe(ref || null);
    }
  });

  it('records the internal ref and the resolved wire id on every metered request', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn(async () => Response.json({
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    await measured.client.chat(syntheticRequest);
    expect(measured.snapshot().observedParameters).toEqual([expect.objectContaining({
      requestedModelRef: 'fixture-provider/fixture-model-v1',
      internalModelRef: 'fixture-provider/fixture-model-v1',
      wireModelId: 'fixture-model-v1',
      model: 'fixture-model-v1',
      mappingStatus: 'resolved',
      mappingReason: null,
    })]);
  });

  it('refuses an ambiguous per-request model ref before any Provider request', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn();
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as unknown as typeof globalThis.fetch });
    await expect(measured.client.chat({
      model: 'other-provider/fixture-model-v1',
      messages: [{ role: 'user', content: 'synthetic request only' }],
    })).rejects.toThrow(/ambiguous internal model mapping/);
    expect(fetch).not.toHaveBeenCalled();
    const snapshot = measured.snapshot();
    expect(snapshot).toMatchObject({ physicalProviderRequests: 0, blockedPhysicalRequests: 0, budgetExhausted: false });
    expect(snapshot.modelMappingRejections).toEqual([{
      internalModelRef: 'other-provider/fixture-model-v1',
      reason: expect.stringMatching(/provider segment/),
    }]);
  });

  // ---- P04 item 2/4: preflight ↔ task entry consistency, deterministic stop ----

  it('classifies deterministic configuration errors separately from pending authorization', () => {
    const unconfigured = resolveS3bProviderProfile({} as NodeJS.ProcessEnv);
    expect(unconfigured).toMatchObject({
      ready: false,
      state: 'configuration_error',
      deterministicFailure: true,
      authorizationPending: true,
    });
    expect(unconfigured.configurationErrors).toEqual(unconfigured.missing);
    expect(unconfigured.credentials).toBeUndefined();

    const authorized = resolveS3bProviderProfile({
      ...liveFixtureEnv,
      S3B_REAL_PROVIDER_AUTHORIZED: 'I_AUTHORIZE_THIS_EVALUATION_RUN',
    });
    expect(authorized).toMatchObject({ ready: true, state: 'ready', deterministicFailure: false, authorizationPending: false });
    expect(authorized.provider.internalModelRef).toBe('fixture-provider/fixture-model-v1');
    expect(authorized.provider.modelMapping).toMatchObject({ status: 'resolved', wireModelId: 'fixture-model-v1' });
  });

  it('rejects an ambiguous internal model ref in the shared preflight profile', () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MODEL_REF: 'other-provider/fixture-model-v1' });
    expect(profile).toMatchObject({ ready: false, state: 'configuration_error', deterministicFailure: true });
    expect(profile.missing.some((item) => item.startsWith('S3B_MODEL_REF'))).toBe(true);
    expect(profile.provider.modelMapping).toMatchObject({ status: 'rejected', wireModelId: null });
    expect(profile.provider.modelMapping.reason).toMatch(/provider segment/);
    expect(profile.credentials).toBeUndefined();
  });

  it('refuses to build a metered Provider from a configuration_error profile without any fetch', () => {
    const fetch = vi.fn();
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MODEL_REF: 'other-provider/fixture-model-v1' });
    expect(() => createS3bMeasuredProvider({ profile, fetchImpl: fetch as unknown as typeof globalThis.fetch }))
      .toThrow(/configuration is incomplete/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exits non-zero with state=configuration_error and stays offline when preflight finds a deterministic error', () => {
    const result = runEvaluator(['--preflight']);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as {
      state: string; realProviderStatus: string; liveCallsMade: boolean; deterministicConfigurationError: boolean;
      provider: { ready: boolean; missing: string[]; configurationErrors: string[] };
    };
    expect(output.state).toBe('configuration_error');
    expect(output.realProviderStatus).toBe('real_provider_pending');
    expect(output.liveCallsMade).toBe(false);
    expect(output.deterministicConfigurationError).toBe(true);
    expect(output.provider.ready).toBe(false);
    expect(output.provider.missing).toContain('S3B_API_KEY');
    expect(output.provider.configurationErrors).toEqual(output.provider.missing);
  });

  it('shares one validation and one wire-model mapping between --preflight and the live task entry', () => {
    const ready = runEvaluator(['--preflight'], { ...liveFixtureEnv });
    expect(ready.status).toBe(0);
    const readyOutput = JSON.parse(ready.stdout) as {
      state: string; liveRunAcknowledgementPresent: boolean; authorizationPending: boolean;
      provider: { modelMapping: { status: string; wireModelId: string | null }; internalModelRef: string; wireModelId: string | null };
    };
    expect(readyOutput.state).toBe('ready_for_user_authorization');
    expect(readyOutput.liveRunAcknowledgementPresent).toBe(false);
    expect(readyOutput.authorizationPending).toBe(true);
    expect(readyOutput.provider.modelMapping).toMatchObject({ status: 'resolved', wireModelId: 'fixture-model-v1' });
    expect(readyOutput.provider.internalModelRef).toBe('fixture-provider/fixture-model-v1');
    expect(readyOutput.provider.wireModelId).toBe('fixture-model-v1');
    expect(ready.stdout).not.toContain(liveFixtureEnv.S3B_API_KEY);

    const ambiguous = runEvaluator(['--preflight'], { ...liveFixtureEnv, S3B_MODEL_REF: 'other-provider/fixture-model-v1' });
    expect(ambiguous.status).toBe(1);
    const ambiguousOutput = JSON.parse(ambiguous.stdout) as {
      state: string; provider: { missing: string[]; modelMapping: { status: string; wireModelId: string | null } };
    };
    expect(ambiguousOutput.state).toBe('configuration_error');
    expect(ambiguousOutput.provider.missing.some((item) => item.startsWith('S3B_MODEL_REF'))).toBe(true);
    expect(ambiguousOutput.provider.modelMapping).toMatchObject({ status: 'rejected', wireModelId: null });
    expect(ambiguous.stdout).not.toContain(liveFixtureEnv.S3B_API_KEY);
  });

  it('refuses --run-real before any Provider request when the configuration is deterministically wrong', () => {
    const result = runEvaluator([
      '--run-real', '--task=CODE-01', '--trial=1', '--authorize-live', '--max-cost-usd=1.25',
    ], {
      ...liveFixtureEnv,
      S3B_MODEL_REF: 'other-provider/fixture-model-v1',
      S3B_REAL_PROVIDER_AUTHORIZED: 'I_AUTHORIZE_THIS_EVALUATION_RUN',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/deterministic configuration error/);
    expect(result.stderr).toMatch(/S3B_MODEL_REF/);
    expect(result.stderr).not.toContain(liveFixtureEnv.S3B_API_KEY);
  });

  it('keeps direct user authorization a separate gate from configuration validity', () => {
    const result = runEvaluator([
      '--run-real', '--task=CODE-01', '--trial=1', '--authorize-live', '--max-cost-usd=1.25',
    ], { ...liveFixtureEnv });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Missing S3B_REAL_PROVIDER_AUTHORIZED acknowledgement.');
  });

  // ---- P04 item 3: model id / endpoint / protocol validation ------------------

  it('rejects malformed model ids, endpoints and protocols before any request', () => {
    const malformedModels = [
      'fixture model',
      'https://provider.fixture/fixture-model-v1',
      '/fixture-model-v1',
      `${'x'.repeat(201)}`,
    ];
    for (const model of malformedModels) {
      const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MODEL: model });
      expect(profile.ready, model).toBe(false);
      expect(profile.missing.some((item) => item.startsWith('S3B_MODEL')), model).toBe(true);
      expect(profile.state, model).toBe('configuration_error');
    }

    const userinfo = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_BASE_URL: 'https://user:userinfo-secret@provider.fixture/v1' });
    expect(userinfo.ready).toBe(false);
    expect(userinfo.missing.some((item) => item.startsWith('S3B_BASE_URL'))).toBe(true);
    expect(userinfo.provider.endpointHasUserinfo).toBe(true);
    expect(userinfo.provider.endpointOrigin).toBeNull();
    expect(JSON.stringify(userinfo)).not.toContain('userinfo-secret');

    const unsupportedProtocol = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_API_PROTOCOL: 'grpc' });
    expect(unsupportedProtocol.ready).toBe(false);
    expect(unsupportedProtocol.missing).toContain('S3B_API_PROTOCOL (supported protocol required)');
    expect(unsupportedProtocol.provider.apiProtocol).toBeNull();

    const loopback = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_BASE_URL: 'http://127.0.0.1:8123/v1' });
    expect(loopback.ready).toBe(true);
    expect(loopback.provider).toMatchObject({ endpointKind: 'loopback', endpointOrigin: 'http://127.0.0.1:8123', endpointHasUserinfo: false });
  });

  it('pins that a wire model id containing an interior slash is rejected as ambiguous', () => {
    // Intentional, not accidental: an interior slash makes `provider/model`
    // ambiguous, so S3B currently supports only wire model ids without a slash.
    // (The historical `deepseek/deepseek-flash` prefix-residue defect stays rejected.)
    const slashed = 'meta-llama/Llama-3';

    const defaultRef = resolveProviderWireModel(`fixture-provider/${slashed}`, 'fixture-provider', slashed);
    expect(defaultRef).toMatchObject({ status: 'rejected', wireModelId: null });
    expect(defaultRef.reason).toMatch(/nested path/);

    const bareRef = resolveProviderWireModel(slashed, 'fixture-provider', slashed);
    expect(bareRef).toMatchObject({ status: 'rejected', wireModelId: null });
    expect(bareRef.reason).toMatch(/provider segment/);

    const doublePrefixedRef = resolveProviderWireModel(`fixture-provider/fixture-provider/${slashed}`, 'fixture-provider', slashed);
    expect(doublePrefixedRef).toMatchObject({ status: 'rejected', wireModelId: null });
    expect(doublePrefixedRef.reason).toMatch(/provider prefix/);

    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MODEL: slashed });
    expect(profile).toMatchObject({ ready: false, state: 'configuration_error' });
    expect(profile.missing.some((item) => item.startsWith('S3B_MODEL_REF'))).toBe(true);
    expect(profile.provider.wireModelId).toBeNull();

    // No accepted mapping may ever produce a wire id that contains a slash.
    const accepted = [
      resolveProviderWireModel('fixture-provider/fixture-model-v1', 'fixture-provider', 'fixture-model-v1'),
      resolveProviderWireModel('fixture-model-v1', 'fixture-provider', 'fixture-model-v1'),
    ];
    expect(accepted.every((mapping) => mapping.status === 'resolved' && !mapping.wireModelId!.includes('/'))).toBe(true);
  });

  // ---- P04 item 5: never replay deterministic 4xx -----------------------------

  it('pins the replayable status set so a deterministic 4xx can never be replayed', () => {
    expect([...NON_RETRYABLE_PROVIDER_STATUSES]).toEqual([400, 401, 403, 404, 422]);
    expect([...RETRYABLE_PROVIDER_STATUSES]).toEqual([429, 500, 502, 503, 504]);
    expect(RETRYABLE_PROVIDER_STATUSES.some((status) => NON_RETRYABLE_PROVIDER_STATUSES.includes(status))).toBe(false);

    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    expect(profile.provider.nonRetryableStatuses).toEqual([400, 401, 403, 404, 422]);
    expect(profile.provider.retryableStatuses).toEqual([429, 500, 502, 503, 504]);
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: vi.fn() as unknown as typeof globalThis.fetch });
    expect(measured.snapshot().retryPolicyStatuses).toEqual([429, 500, 502, 503, 504]);
  });

  it.each([400, 404, 422])('actively suppresses a replay that a widened retry policy would re-send (HTTP %i)', async (status) => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_ATTEMPTS: '2' });
    const fetch = vi.fn(async () => Response.json({
      error: { code: 'deterministic_failure', type: 'invalid_request_error', message: 'no replay expected' },
    }, { status }));
    const measured = createS3bMeasuredProvider({
      profile,
      fetchImpl: fetch as typeof globalThis.fetch,
      retryOverrides: { retryableStatuses: [status], baseDelayMs: 1, jitter: false },
    });
    await expect(measured.client.chat(syntheticRequest)).rejects.toBeTruthy();

    expect(fetch).toHaveBeenCalledTimes(1);
    const snapshot = measured.snapshot();
    expect(snapshot.physicalProviderRequests).toBe(1);
    expect(snapshot.nonRetryableResponses).toBe(1);
    // The retry policy was widened to replay this status; the per-logical-call guard stopped it.
    expect(snapshot.suppressedNonRetryableReplays).toBe(1);
    expect(snapshot.blockedPhysicalRequests).toBe(0);
    expect(snapshot.physicalResponses).toHaveLength(1);
    expect(snapshot.physicalResponses[0]).toMatchObject({ attempt: 1, status });
  });

  it.each([401, 403])('never re-sends HTTP %i even when the retry policy is widened to allow it', async (status) => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_ATTEMPTS: '2' });
    const fetch = vi.fn(async () => Response.json({
      error: { code: 'invalid_api_key', type: 'authentication_error', message: 'no replay expected' },
    }, { status }));
    const measured = createS3bMeasuredProvider({
      profile,
      fetchImpl: fetch as typeof globalThis.fetch,
      retryOverrides: { retryableStatuses: [status], baseDelayMs: 1, jitter: false },
    });
    await expect(measured.client.chat(syntheticRequest)).rejects.toBeTruthy();

    expect(fetch).toHaveBeenCalledTimes(1);
    const snapshot = measured.snapshot();
    expect(isNonRetryableProviderStatus(status)).toBe(true);
    expect(snapshot.physicalProviderRequests).toBe(1);
    expect(snapshot.nonRetryableResponses).toBe(1);
    // The shared retry classifier already refuses the `auth` class outright, so
    // the metering poison is a second line of defence here rather than the trigger.
    expect(snapshot.suppressedNonRetryableReplays).toBe(0);
    expect(snapshot.blockedPhysicalRequests).toBe(0);
    expect(snapshot.physicalResponses).toHaveLength(1);
    expect(snapshot.physicalResponses[0]).toMatchObject({ attempt: 1, status });
  });

  it('keeps one physical request per logical call for a pinned non-retryable status under interleaving', async () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_PHYSICAL_REQUESTS: '8', S3B_MAX_ATTEMPTS: '2' });
    let dispatched = 0;
    const statuses: number[] = [];
    const fetch = vi.fn(async () => {
      dispatched += 1;
      if (dispatched === 1) {
        statuses.push(400);
        return Response.json({ error: { code: 'deterministic_failure', type: 'invalid_request_error', message: 'no replay expected' } }, { status: 400 });
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      statuses.push(200);
      return Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    // Timing-only override: the replayable set stays pinned, which is the authoritative guarantee.
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch, retryOverrides: { baseDelayMs: 20, jitter: false } });

    // Capture settlement immediately so a rejection during the interleaving window is never unhandled.
    const callA = measured.client.chat(syntheticRequest).then(() => 'fulfilled' as const, () => 'rejected' as const);
    await new Promise(resolve => setTimeout(resolve, 30));
    const callB = measured.client.chat(syntheticRequest).then(() => 'fulfilled' as const, () => 'rejected' as const);

    expect(await callA).toBe('rejected');
    expect(await callB).toBe('fulfilled');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([400, 200]);
    expect(measured.snapshot()).toMatchObject({
      logicalModelRequests: 2,
      physicalProviderRequests: 2,
      nonRetryableResponses: 1,
      suppressedNonRetryableReplays: 0,
      blockedPhysicalRequests: 0,
      budgetExhausted: false,
      retryPolicyStatuses: [429, 500, 502, 503, 504],
    });
  });

  it('keeps one physical request per logical call when a widened retry overlaps another logical call', async () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_PHYSICAL_REQUESTS: '8', S3B_MAX_ATTEMPTS: '2' });
    let dispatched = 0;
    const statuses: number[] = [];
    const fetch = vi.fn(async () => {
      dispatched += 1;
      if (dispatched === 1) {
        // Logical call A: deterministic status; with a widened policy its retry is scheduled ~300 ms later.
        statuses.push(400);
        return Response.json({ error: { code: 'deterministic_failure', type: 'invalid_request_error', message: 'no replay expected' } }, { status: 400 });
      }
      if (dispatched === 2) {
        // Logical call B starts inside A's retry window and stays in flight past A's retry.
        await new Promise(resolve => setTimeout(resolve, 600));
        statuses.push(200);
        return Response.json({
          choices: [{ index: 0, message: { role: 'assistant', content: 'b' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      // Only reached if A's replay was wrongly dispatched (the pre-fix hole).
      statuses.push(200);
      return Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: 'replay' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const measured = createS3bMeasuredProvider({
      profile,
      fetchImpl: fetch as typeof globalThis.fetch,
      // Hostile policy: 400 is made replayable on purpose, so the guard must attribute A's retry correctly.
      retryOverrides: { retryableStatuses: [400], baseDelayMs: 300, jitter: false },
    });

    const callA = measured.client.chat(syntheticRequest).then(() => 'fulfilled' as const, () => 'rejected' as const);
    await new Promise(resolve => setTimeout(resolve, 50));
    const callB = measured.client.chat(syntheticRequest).then(() => 'fulfilled' as const, () => 'rejected' as const);

    expect(await callA).toBe('rejected');
    expect(await callB).toBe('fulfilled');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([400, 200]);
    expect(measured.snapshot()).toMatchObject({
      logicalModelRequests: 2,
      physicalProviderRequests: 2,
      nonRetryableResponses: 1,
      suppressedNonRetryableReplays: 1,
      blockedPhysicalRequests: 0,
      budgetExhausted: false,
    });
  });

  // ---- P04 item 6: every physical attempt, including failures, is budgeted ----

  it('charges failed physical attempts to the request budget before they are sent', async () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_PHYSICAL_REQUESTS: '1' });
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });

    await expect(measured.client.chat(syntheticRequest)).rejects.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(measured.snapshot()).toMatchObject({
      physicalProviderRequests: 1,
      blockedPhysicalRequests: 0,
      budgetExhausted: false,
      physicalResponses: [{ attempt: 1, status: null, endpointOrigin: 'https://provider.fixture' }],
    });

    await expect(measured.client.chat(syntheticRequest)).rejects.toThrow('physical Provider request budget exhausted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(measured.snapshot()).toMatchObject({ physicalProviderRequests: 1, blockedPhysicalRequests: 1, budgetExhausted: true });
  });

  it('meters every retried physical attempt even when each attempt fails', async () => {
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_MAX_PHYSICAL_REQUESTS: '3', S3B_MAX_ATTEMPTS: '2' });
    const fetch = vi.fn(async () => Response.json({ error: { code: 'server_error', type: 'server_error' } }, { status: 500 }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });

    await expect(measured.client.chat(syntheticRequest)).rejects.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
    const snapshot = measured.snapshot();
    expect(snapshot).toMatchObject({ physicalProviderRequests: 2, blockedPhysicalRequests: 0, budgetExhausted: false, nonRetryableResponses: 0 });
    expect(snapshot.physicalResponses).toEqual([
      { attempt: 1, status: 500, endpointOrigin: 'https://provider.fixture', errorCode: 'server_error', errorType: 'server_error', errorParam: null },
      { attempt: 2, status: 500, endpointOrigin: 'https://provider.fixture', errorCode: 'server_error', errorType: 'server_error', errorParam: null },
    ]);
  });

  // ---- P04 item 7: missing usage stays unavailable ---------------------------

  it('keeps usage unavailable with null tokens when a successful response carries no usage', async () => {
    const profile = resolveS3bProviderProfile(liveFixtureEnv);
    const fetch = vi.fn(async () => Response.json({
      id: 'response-without-usage',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });
    const response = await measured.client.chat(syntheticRequest);

    expect(response.content).toBe('ok');
    expect(measured.snapshot()).toMatchObject({
      providerResponseReceipts: 1,
      responsesWithoutUsage: 1,
      usage: { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, responseCount: 1 },
    });
  });

  // ---- P04 item 8: no credential ever reaches a snapshot or an error ---------

  it('redacts Authorization, api-key, x-api-key and Bearer secrets from text', () => {
    const secret = 'sk-live-0123456789abcdef';
    const cases = [
      `Authorization: Bearer ${secret}`,
      `{"Authorization":"Bearer ${secret}"}`,
      `api-key: ${secret}`,
      `x-api-key: ${secret}`,
      `access_token=${secret}`,
      `Bearer ${secret}`,
      `{"error":{"message":"rejected ${secret}","code":"invalid_api_key"}}`,
    ];
    for (const raw of cases) {
      const safe = sanitizeS3bText(raw, secret);
      expect(safe, raw).not.toContain(secret);
      expect(safe, raw).toContain('[redacted]');
    }
  });

  it('never serializes the API key even when the Provider echoes it in an error body', async () => {
    const secret = 'sk-live-0123456789abcdef';
    const profile = resolveS3bProviderProfile({ ...liveFixtureEnv, S3B_API_KEY: secret });
    const sentHeaders: string[] = [];
    const fetch = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders.push(JSON.stringify(init?.headers ?? {}));
      return Response.json({
        error: {
          code: secret,
          type: 'invalid_api_key',
          param: secret,
          message: `Authorization: Bearer ${secret} was rejected`,
        },
      }, { status: 401 });
    });
    const measured = createS3bMeasuredProvider({ profile, fetchImpl: fetch as typeof globalThis.fetch });

    let thrown: unknown;
    try {
      await measured.client.chat(syntheticRequest);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).toContain('[redacted]');
    expect((thrown as { status?: number }).status).toBe(401);

    const snapshot = measured.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.nonRetryableResponses).toBe(1);
    expect(snapshot.physicalResponses[0]).toMatchObject({ status: 401, errorCode: null, errorParam: null });
    // The credential really was sent on the wire, so the redaction assertions above are meaningful.
    expect(sentHeaders.join('\n')).toContain(secret);
  });

  // ---- P04 item 9: heuristic attribution must not contradict the Oracle ------

  it('stops claiming artifact_wrong_or_missing when the oracle details show the artifact matched', () => {
    const attribution = classifyFailure({
      infrastructureStatus: 'executed',
      oracle: {
        result: 'failed',
        taskResult: 'failed',
        evidence: [{ path: 'result.txt', sha256: '69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0', bytes: 15 }],
        details: { status: 'failed', evaluationCheck: 'failed', validationFailure: false, fixtureExecutions: 1, contentMatches: true },
      },
      observation: {},
    });
    expect(attribution).toMatchObject({
      primary: 'unknown',
      confidence: 'low',
      secondary: ['oracle_failed_on_unmet_task_precondition', 'artifact_content_matched'],
    });
    expect(attribution?.evidenceRefs).toEqual(['fixture://result.txt']);
    expect(attribution?.reason).toMatch(/artifact matched/);
  });

  it('records unknown/low with an explicit code when the oracle gives no artifact-wrongness evidence', () => {
    const attribution = classifyFailure({
      infrastructureStatus: 'executed',
      oracle: { result: 'failed', evidence: ['result.txt'] },
      observation: {},
    });
    expect(attribution).toMatchObject({
      primary: 'unknown',
      confidence: 'low',
      secondary: ['oracle_failed_without_artifact_wrongness_evidence'],
    });
    expect(attribution?.reason).toMatch(/without artifact-wrongness evidence/);
  });

  it('still attributes artifact_wrong_or_missing when the artifact is genuinely wrong', () => {
    const attribution = classifyFailure({
      infrastructureStatus: 'executed',
      oracle: {
        result: 'failed',
        evidence: [{ path: 'result.txt' }],
        details: { contentMatches: false, validationFailure: true },
      },
      observation: {},
    });
    expect(attribution).toMatchObject({ primary: 'artifact_wrong_or_missing', confidence: 'high', secondary: [], reason: null });
  });

  it('preserves declared attributions and the observation precedence order', () => {
    const declared = classifyFailure({
      infrastructureStatus: 'executed',
      oracle: {
        result: 'failed',
        failureAttribution: { primary: 'insufficient_verification', secondary: ['strict_requirement_parser_did_not_recognize_task_text'], confidence: 'high' },
        details: { contentMatches: true },
      },
      observation: {},
    });
    expect(declared).toMatchObject({
      primary: 'insufficient_verification',
      secondary: ['strict_requirement_parser_did_not_recognize_task_text'],
      confidence: 'high',
    });

    expect(classifyFailure({ infrastructureStatus: 'blocked', oracle: { result: 'failed' }, observation: {} }))
      .toMatchObject({ primary: 'evaluation_infrastructure', confidence: 'high' });
    expect(classifyFailure({
      infrastructureStatus: 'executed',
      oracle: { result: 'failed', details: { contentMatches: true } },
      observation: { deniedToolCalls: 2 },
    })).toMatchObject({ primary: 'permission_or_safety', confidence: 'high' });
    expect(classifyFailure({
      infrastructureStatus: 'executed',
      oracle: { result: 'failed', details: { contentMatches: true } },
      observation: { failedToolCalls: 1 },
    })).toMatchObject({ primary: 'tool_parameter_or_schema', confidence: 'medium' });
    expect(classifyFailure({
      infrastructureStatus: 'executed',
      oracle: { result: 'unverified' },
      observation: {},
    })).toBeNull();
  });
});
