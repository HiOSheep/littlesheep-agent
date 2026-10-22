// Offline real-Provider preflight for R4-D0. Never opens a network connection
// and never enables the live-run authorization gate.
import {
  NON_RETRYABLE_PROVIDER_STATUSES,
  RETRYABLE_PROVIDER_STATUSES,
  SUPPORTED_PROVIDER_PROTOCOLS,
  resolveProviderWireModel,
  resolveS3bProviderProfile,
  sanitizeS3bText,
} from '../s3b-provider-config.mjs';

const FAKE_KEY = 'r4d0-offline-fixture-not-a-real-key';

export const PREFLIGHT_ENV = Object.freeze({
  S3B_PROVIDER_ID: 'deepseek',
  S3B_MODEL: 'deepseek-chat',
  S3B_MODEL_REF: 'deepseek/deepseek-chat',
  S3B_API_PROTOCOL: 'openai-chat-completions',
  S3B_BASE_URL: 'https://api.deepseek.com',
  S3B_API_KEY: FAKE_KEY,
  S3B_MAX_PHYSICAL_REQUESTS: '8',
  S3B_MAX_OUTPUT_TOKENS: '2048',
  S3B_MAX_COST_USD: '5',
  S3B_PROVIDER_BILLING_CAP_CONFIRMED: 'true',
  S3B_PROVIDER_BILLING_CAP_BASIS: 'user-reported provider console hard limit (offline; not verified by this preflight)',
  S3B_TIMEOUT_SECONDS: '120',
  S3B_MAX_ATTEMPTS: '2',
});

function check(id, ok, detail) {
  return { id, ok, detail };
}

function profileFacts(env) {
  const profile = resolveS3bProviderProfile(env);
  return {
    ready: profile.ready,
    state: profile.state,
    errors: profile.configurationErrors,
    authorizationPending: profile.authorizationPending,
    provider: profile.provider,
    credentials: profile.credentials,
  };
}

export function runOfflinePreflight() {
  const checks = [];
  const ready = profileFacts(PREFLIGHT_ENV);
  checks.push(check('ready-config', ready.ready && ready.state === 'ready' && ready.errors.length === 0, 'synthetic offline config resolves without contacting a Provider'));
  checks.push(check('model-mapping', ready.provider.modelMapping.status === 'resolved' && ready.provider.wireModelId === 'deepseek-chat', 'internal deepseek/deepseek-chat maps to wire id deepseek-chat'));
  checks.push(check('tool-call-protocol', SUPPORTED_PROVIDER_PROTOCOLS.includes(ready.provider.apiProtocol), `supported protocols: ${SUPPORTED_PROVIDER_PROTOCOLS.join(', ')}`));
  checks.push(check('request-budget', ready.provider.physicalRequestBudget === 8, 'explicit per-trial physical request ceiling present'));
  checks.push(check('output-token-budget', ready.provider.outputTokenLimit === 2048, 'explicit per-request output token ceiling present'));
  checks.push(check('cost-budget-currency', ready.provider.costBudgetCurrency === 'USD' && ready.provider.costBudgetAmount === 5, 'exactly one explicit cost ceiling and currency present'));
  checks.push(check('billing-cap-declared', ready.provider.providerBillingCapConfirmed === true && Boolean(ready.provider.billingCapBasis), 'provider-side billing cap must be declared with a basis; a local request/token limit is not a cost cap'));
  checks.push(check('authorization-still-pending', ready.authorizationPending === true, 'offline preflight never enables the live-run authorization gate'));

  const noCost = profileFacts({ ...PREFLIGHT_ENV, S3B_MAX_COST_USD: undefined });
  checks.push(check('missing-cost-budget-blocked', noCost.ready === false && noCost.errors.some((item) => item.includes('S3B_MAX_COST_USD')), 'missing cost ceiling is a deterministic configuration error before any request'));
  const bothCurrencies = profileFacts({ ...PREFLIGHT_ENV, S3B_MAX_COST_CNY: '10' });
  checks.push(check('ambiguous-cost-currency-blocked', bothCurrencies.ready === false, 'both USD and CNY ceilings are rejected as ambiguous'));
  const noBillingCap = profileFacts({ ...PREFLIGHT_ENV, S3B_PROVIDER_BILLING_CAP_CONFIRMED: 'false' });
  checks.push(check('unconfirmed-billing-cap-blocked', noBillingCap.ready === false && noBillingCap.errors.some((item) => item.includes('BILLING_CAP')), 'provider-side billing cap must be explicitly confirmed'));
  const liveGate = profileFacts({ ...PREFLIGHT_ENV, S3B_REAL_PROVIDER_AUTHORIZED: 'I_AUTHORIZE_THIS_EVALUATION_RUN' });
  checks.push(check('live-gate-recognized-but-not-armed', liveGate.authorizationPending === false, 'the explicit authorization token is recognized; this preflight does not set it'));

  const mappingCases = [
    ['wrong-provider', { internalModelRef: 'other/deepseek-chat', providerId: 'deepseek', configuredModel: 'deepseek-chat' }],
    ['nested-model-path', { internalModelRef: 'deepseek/vendor/deepseek-chat', providerId: 'deepseek', configuredModel: 'deepseek-chat' }],
    ['residual-prefix', { internalModelRef: 'deepseek/deepseek/deepseek-chat', providerId: 'deepseek', configuredModel: 'deepseek-chat' }],
    ['model-mismatch', { internalModelRef: 'deepseek/other-model', providerId: 'deepseek', configuredModel: 'deepseek-chat' }],
  ].map(([id, input]) => ({ id, result: resolveProviderWireModel(input.internalModelRef, input.providerId, input.configuredModel) }));
  checks.push(check('ambiguous-model-refs-rejected', mappingCases.every((item) => item.result.status === 'rejected'), mappingCases.map((item) => `${item.id}: ${item.result.reason}`).join(' | ')));

  const nonRetryable = [...NON_RETRYABLE_PROVIDER_STATUSES];
  const retryable = [...RETRYABLE_PROVIDER_STATUSES];
  checks.push(check('deterministic-4xx-stop-list', [400, 401, 403, 404, 422].every((status) => nonRetryable.includes(status)), `non-retryable: ${nonRetryable.join(',')}`));
  checks.push(check('retryable-status-list', [429, 500, 502, 503, 504].every((status) => retryable.includes(status)), `retryable: ${retryable.join(',')}`));

  const sanitized = sanitizeS3bText(`Authorization: Bearer ${FAKE_KEY}\napi-key=${FAKE_KEY}\n${FAKE_KEY}`, FAKE_KEY);
  checks.push(check('credential-redaction', !sanitized.includes(FAKE_KEY) && sanitized.includes('[redacted]'), 'configured key and authorization forms are redacted'));

  checks.push(check('usage-policy', ready.provider.usageSource.includes('unavailable') && ready.provider.costSource.includes('billing receipt'), 'missing usage/cost stays unavailable; never inferred from tokens'));
  checks.push(check('provider-side-cost-cap-unverified', true, 'this offline preflight cannot verify the provider console cap; Go/No-Go keeps it as an explicit user authorization item'));

  const modelConfig = {
    providerId: 'deepseek',
    internalModelRef: 'deepseek/deepseek-chat',
    wireModelId: ready.provider.wireModelId,
    apiProtocol: 'openai-chat-completions',
    baseURL: 'https://api.deepseek.com',
    supportsToolCalls: true,
    temperature: 0,
    maxOutputTokens: 2048,
    timeoutSeconds: 120,
    maxAttempts: 2,
  };
  checks.push(check('model-config-complete', modelConfig.wireModelId === 'deepseek-chat' && modelConfig.supportsToolCalls === true, 'frozen model config template is complete'));
  checks.push(check('no-credentials-in-output', !JSON.stringify({ ...ready.provider }).includes(FAKE_KEY), 'provider projection contains no credential material'));

  return {
    ok: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    networkUsed: false,
    liveAuthorizationArmed: false,
    fakeCredentialUsed: 'offline fixture only; not a real key',
    checks,
    providerProjection: ready.provider,
    modelConfig,
    costCap: {
      providerSideVerified: false,
      required: true,
      note: 'local request/token limits are not a real USD/CNY hard cap; user must confirm the provider-side billing limit and amount before any paid run',
    },
  };
}
