const SUPPORTED_PROTOCOLS = new Set([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
]);

const MAX_PHYSICAL_REQUESTS = 128;
const MAX_OUTPUT_TOKENS = 16_384;

function positiveInteger(value, maximum) {
  if (!/^\d+$/u.test(value ?? '')) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function positiveUsd(value) {
  if (!/^\d+(?:\.\d{1,6})?$/u.test(value ?? '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

function endpointFacts(raw) {
  try {
    const url = new URL(raw);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return {
      valid: (url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
        && url.username === '' && url.password === '',
      origin: url.origin,
      kind: loopback ? 'loopback' : url.protocol === 'https:' ? 'https' : 'unsupported',
    };
  } catch {
    return { valid: false, origin: null, kind: 'invalid' };
  }
}

/** Resolve a real-Provider profile from process environment without exposing credentials. */
export function resolveS3bProviderProfile(env = process.env) {
  const providerId = env.S3B_PROVIDER_ID?.trim() ?? '';
  const model = env.S3B_MODEL?.trim() ?? '';
  const protocol = env.S3B_API_PROTOCOL?.trim() ?? '';
  const baseURL = env.S3B_BASE_URL?.trim() ?? '';
  const endpoint = endpointFacts(baseURL);
  const apiKey = env.S3B_API_KEY ?? '';
  const physicalRequestBudget = positiveInteger(env.S3B_MAX_PHYSICAL_REQUESTS, MAX_PHYSICAL_REQUESTS);
  const outputTokenLimit = positiveInteger(env.S3B_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  const maxCostUsd = positiveUsd(env.S3B_MAX_COST_USD);
  const timeoutSeconds = positiveInteger(env.S3B_TIMEOUT_SECONDS ?? '120', 600);
  const maxAttempts = positiveInteger(env.S3B_MAX_ATTEMPTS ?? '1', 3);
  const missing = [];

  if (!providerId) missing.push('S3B_PROVIDER_ID');
  if (!model) missing.push('S3B_MODEL');
  if (!SUPPORTED_PROTOCOLS.has(protocol)) missing.push('S3B_API_PROTOCOL (supported protocol required)');
  if (!endpoint.valid) missing.push('S3B_BASE_URL (HTTPS required; HTTP is allowed only for loopback fixtures)');
  if (!apiKey) missing.push('S3B_API_KEY');
  if (physicalRequestBudget === null) missing.push(`S3B_MAX_PHYSICAL_REQUESTS (integer 1..${MAX_PHYSICAL_REQUESTS})`);
  if (outputTokenLimit === null) missing.push(`S3B_MAX_OUTPUT_TOKENS (integer 1..${MAX_OUTPUT_TOKENS})`);
  if (maxCostUsd === null) missing.push('S3B_MAX_COST_USD (explicit positive USD ceiling required)');
  if (env.S3B_PROVIDER_BILLING_CAP_CONFIRMED !== 'true') missing.push('S3B_PROVIDER_BILLING_CAP_CONFIRMED=true (provider-side billing limit must be configured)');
  if (timeoutSeconds === null) missing.push('S3B_TIMEOUT_SECONDS (integer 1..600)');
  if (maxAttempts === null) missing.push('S3B_MAX_ATTEMPTS (integer 1..3)');

  const ready = missing.length === 0;
  return {
    ready,
    missing,
    provider: {
      id: providerId || null,
      model: model || null,
      apiProtocol: SUPPORTED_PROTOCOLS.has(protocol) ? protocol : null,
      endpointOrigin: endpoint.valid ? endpoint.origin : null,
      endpointKind: endpoint.kind,
      timeoutSeconds,
      maxAttempts,
      physicalRequestBudget,
      outputTokenLimit,
      maxCostUsd,
      providerBillingCapConfirmed: env.S3B_PROVIDER_BILLING_CAP_CONFIRMED === 'true',
      temperature: null,
      topP: null,
      seed: null,
      unsupportedParameters: ['top_p', 'seed'],
      usageSource: 'Provider response receipt when supplied; otherwise unavailable',
      costSource: 'Provider billing receipt only; otherwise unavailable',
    },
    // Keep the secret out of every public result object. Callers can pass this private
    // value directly to createLlmClient after the explicit live-run gate succeeds.
    credentials: ready ? { apiKey, baseURL, protocol, providerId, model } : undefined,
  };
}

/** Validate the explicit live-run acknowledgement without printing the acknowledgement value. */
export function hasS3bLiveRunAcknowledgement(env = process.env) {
  return env.S3B_REAL_PROVIDER_AUTHORIZED === 'I_AUTHORIZE_THIS_EVALUATION_RUN';
}
