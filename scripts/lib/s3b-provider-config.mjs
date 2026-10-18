// @littlesheep evaluation — S3B real-Provider guard library.
//
// This module is the single place that decides whether a real-Provider evaluation
// run may exist at all: profile resolution, deterministic configuration errors,
// the internal-model-ref → wire-model-id mapping, output redaction, and the
// non-misleading failure attribution used by the ledger.
//
// It deliberately lives outside the production Runtime/Harness/Tools/Prompt
// packages: every rule here guards the *evaluator*, never the product.

const SUPPORTED_PROTOCOLS = new Set([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
]);

const MAX_PHYSICAL_REQUESTS = 128;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_INTERNAL_MODEL_REF_LENGTH = 240;

/**
 * HTTP statuses that describe a deterministic request, credential or model
 * defect. Replaying them cannot succeed, cannot be billed as progress, and only
 * burns physical requests: the evaluation transport must stop after the first
 * response instead of letting a retry policy re-send them.
 */
export const NON_RETRYABLE_PROVIDER_STATUSES = Object.freeze([400, 401, 403, 404, 422]);

/**
 * The only statuses the S3B metered transport may replay. Pinned here (rather
 * than inherited from the production default) so a future change to the
 * product retry policy cannot silently widen the evaluation transport.
 */
export const RETRYABLE_PROVIDER_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

/** Supported wire protocols, exposed for preflight/report output. */
export const SUPPORTED_PROVIDER_PROTOCOLS = Object.freeze([...SUPPORTED_PROTOCOLS]);

/** True when the status is one the S3B transport must never replay. */
export function isNonRetryableProviderStatus(status) {
  return Number.isInteger(status) && NON_RETRYABLE_PROVIDER_STATUSES.includes(status);
}

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

function positiveCny(value) {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value ?? '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : null;
}

function endpointFacts(raw) {
  try {
    const url = new URL(raw);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
    const hasUserinfo = url.username !== '' || url.password !== '';
    const protocolAllowed = url.protocol === 'https:' || (loopback && url.protocol === 'http:');
    const reason = hasUserinfo
      ? 'endpoint must not embed userinfo credentials'
      : !protocolAllowed
        ? 'HTTPS required; HTTP is allowed only for loopback fixtures'
        : null;
    return {
      valid: reason === null,
      reason,
      hasUserinfo,
      origin: url.origin,
      kind: loopback ? 'loopback' : url.protocol === 'https:' ? 'https' : 'unsupported',
    };
  } catch {
    return { valid: false, reason: 'endpoint is not a valid absolute URL', hasUserinfo: false, origin: null, kind: 'invalid' };
  }
}

/**
 * Provider model id facts. Rejects the shapes that make a wire id ambiguous:
 * empty values, embedded whitespace, URL fragments, and leading/trailing or
 * doubled slashes.
 *
 * NOTE (actual rule, verified): an interior slash passes THIS check but cannot
 * survive `resolveProviderWireModel` — the model segment after the provider
 * prefix must be slash-free, so a configured model like `meta-llama/Llama-3` is
 * rejected there as a nested path / provider-prefix residue. S3B therefore
 * supports only wire model ids WITHOUT a slash today. That fail-closed rejection
 * is intentional: an interior slash makes `provider/model` genuinely ambiguous
 * and re-opening it would also re-open the historical `deepseek/deepseek-flash`
 * prefix-residue defect. See the pinning test
 * `pins that a wire model id containing an interior slash is rejected as ambiguous`.
 */
function modelIdFacts(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { valid: false, reason: 'model id must not be empty' };
  if (value.length > MAX_MODEL_ID_LENGTH) return { valid: false, reason: `model id must be at most ${MAX_MODEL_ID_LENGTH} characters` };
  if (/\s/u.test(value)) return { valid: false, reason: 'model id must not contain whitespace' };
  if (value.includes('://')) return { valid: false, reason: 'model id must not contain a URL scheme' };
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return { valid: false, reason: 'model id must not carry a slash prefix, suffix or empty path segment' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) return { valid: false, reason: 'model id contains unsupported characters' };
  return { valid: true, reason: null };
}

/**
 * Resolve one internal model ref (`provider/model`, or a bare wire model id) to
 * exactly one Provider wire model id.
 *
 * Ambiguity is rejected instead of guessed: a ref whose provider segment
 * disagrees with the configured provider, a ref whose model segment disagrees
 * with the configured model, a ref that keeps a nested path, and a wire id that
 * still carries the `providerId/` prefix residue are all deterministic
 * configuration errors.
 *
 * Both the internal ref and the resolved wire id are returned so callers record
 * the mapping instead of only its result.
 */
export function resolveProviderWireModel(internalModelRef, providerId, configuredModel) {
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  const configured = typeof configuredModel === 'string' ? configuredModel.trim() : '';
  const ref = typeof internalModelRef === 'string' ? internalModelRef.trim() : '';
  const base = {
    status: 'rejected',
    internalModelRef: ref || null,
    providerId: provider || null,
    configuredModel: configured || null,
    wireModelId: null,
    reason: null,
  };
  const reject = reason => ({ ...base, status: 'rejected', wireModelId: null, reason });

  if (!provider) return reject('configured provider id is missing');
  if (/\s/u.test(provider) || provider.includes('/') || provider.length > MAX_MODEL_ID_LENGTH) {
    return reject('configured provider id is not a valid provider identifier');
  }
  const configuredFacts = modelIdFacts(configured);
  if (!configuredFacts.valid) return reject(`configured model is invalid: ${configuredFacts.reason}`);
  if (!ref) return reject('internal model ref is missing');
  if (ref.length > MAX_INTERNAL_MODEL_REF_LENGTH) return reject(`internal model ref must be at most ${MAX_INTERNAL_MODEL_REF_LENGTH} characters`);
  if (/\s/u.test(ref) || ref.includes('://')) return reject('internal model ref must not contain whitespace or a URL');

  const separator = ref.indexOf('/');
  let wireModelId;
  if (separator === -1) {
    if (ref !== configured) return reject(`internal model ref "${ref}" does not match the configured model "${configured}"`);
    wireModelId = configured;
  } else {
    const providerSegment = ref.slice(0, separator);
    const modelSegment = ref.slice(separator + 1);
    if (providerSegment !== provider) return reject(`internal model ref provider segment "${providerSegment}" does not match the configured provider "${provider}"`);
    if (!modelSegment) return reject('internal model ref has no model segment after the provider prefix');
    if (modelSegment.startsWith(`${provider}/`)) return reject('internal model ref keeps the provider prefix in the wire model id');
    if (modelSegment.includes('/')) return reject('internal model ref keeps a nested path after the provider segment');
    if (modelSegment !== configured) return reject(`internal model ref model segment "${modelSegment}" does not match the configured model "${configured}"`);
    wireModelId = modelSegment;
  }

  const wireFacts = modelIdFacts(wireModelId);
  if (!wireFacts.valid) return reject(`resolved wire model id is invalid: ${wireFacts.reason}`);
  if (wireModelId.startsWith(`${provider}/`)) return reject('resolved wire model id still carries the provider prefix');
  return { ...base, status: 'resolved', wireModelId, reason: null };
}

/**
 * Redact credentials from evaluator output, snapshots and error messages.
 *
 * Covers the exact configured secret, named credential headers/fields
 * (`Authorization`, `api-key`, `x-api-key`, `*_token`) in header and JSON form,
 * and standalone `Bearer`/`Basic` credential schemes. Provider error bodies are
 * untrusted input: they are the most likely place a key gets echoed back.
 */
export function sanitizeS3bText(value, secret) {
  let safe = String(value ?? '');
  if (secret) safe = safe.replaceAll(secret, '[redacted]');
  safe = safe.replace(
    /((?:proxy-)?authorization|(?:x[-_])?api[-_]?key|x-auth-token|access[-_]?token|refresh[-_]?token|auth[-_]?token|token)(\s*["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?)[^\s"',;}]+/giu,
    '$1$2[redacted]',
  );
  safe = safe.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{4,}/giu, '$1 [redacted]');
  return safe;
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
  const maxCostCny = positiveCny(env.S3B_MAX_COST_CNY);
  const hasUsdBudget = Boolean(env.S3B_MAX_COST_USD?.trim());
  const hasCnyBudget = Boolean(env.S3B_MAX_COST_CNY?.trim());
  const costBudgetCurrency = hasUsdBudget && !hasCnyBudget ? 'USD' : hasCnyBudget && !hasUsdBudget ? 'CNY' : null;
  const costBudgetAmount = costBudgetCurrency === 'USD' ? maxCostUsd : costBudgetCurrency === 'CNY' ? maxCostCny : null;
  const billingCapBasis = env.S3B_PROVIDER_BILLING_CAP_BASIS?.trim() || null;
  const timeoutSeconds = positiveInteger(env.S3B_TIMEOUT_SECONDS ?? '120', 600);
  const maxAttempts = positiveInteger(env.S3B_MAX_ATTEMPTS ?? '1', 3);
  const modelFacts = modelIdFacts(model);
  const internalModelRef = (env.S3B_MODEL_REF?.trim() || (providerId && model ? `${providerId}/${model}` : ''));
  const modelMapping = resolveProviderWireModel(internalModelRef, providerId, model);
  const missing = [];

  if (!providerId) missing.push('S3B_PROVIDER_ID');
  if (!model) missing.push('S3B_MODEL');
  else if (!modelFacts.valid) missing.push(`S3B_MODEL (valid Provider model id required: ${modelFacts.reason})`);
  if (!SUPPORTED_PROTOCOLS.has(protocol)) missing.push('S3B_API_PROTOCOL (supported protocol required)');
  if (!endpoint.valid) missing.push(`S3B_BASE_URL (${endpoint.reason ?? 'HTTPS required; HTTP is allowed only for loopback fixtures'})`);
  if (!apiKey) missing.push('S3B_API_KEY');
  if (physicalRequestBudget === null) missing.push(`S3B_MAX_PHYSICAL_REQUESTS (integer 1..${MAX_PHYSICAL_REQUESTS})`);
  if (outputTokenLimit === null) missing.push(`S3B_MAX_OUTPUT_TOKENS (integer 1..${MAX_OUTPUT_TOKENS})`);
  if (costBudgetCurrency === null) missing.push('exactly one of S3B_MAX_COST_USD or S3B_MAX_COST_CNY (explicit positive cost ceiling required)');
  if (costBudgetCurrency === 'USD' && maxCostUsd === null) missing.push('S3B_MAX_COST_USD (positive USD ceiling up to 100 required)');
  if (costBudgetCurrency === 'CNY' && maxCostCny === null) missing.push('S3B_MAX_COST_CNY (positive CNY ceiling up to 1000000 required)');
  if (env.S3B_PROVIDER_BILLING_CAP_CONFIRMED !== 'true') missing.push('S3B_PROVIDER_BILLING_CAP_CONFIRMED=true (provider-side billing limit must be configured)');
  if (env.S3B_PROVIDER_BILLING_CAP_CONFIRMED === 'true' && !billingCapBasis) missing.push('S3B_PROVIDER_BILLING_CAP_BASIS (describe the verified provider-side cap)');
  if (timeoutSeconds === null) missing.push('S3B_TIMEOUT_SECONDS (integer 1..600)');
  if (maxAttempts === null) missing.push('S3B_MAX_ATTEMPTS (integer 1..3)');
  // Only report the mapping separately once its inputs exist; otherwise the
  // provider/model errors above already explain why no mapping is possible.
  if (providerId && modelFacts.valid && modelMapping.status !== 'resolved') {
    missing.push(`S3B_MODEL_REF (internal model ref must resolve unambiguously to the configured Provider model: ${modelMapping.reason})`);
  }

  const ready = missing.length === 0;
  const configurationErrors = [...missing];
  return {
    ready,
    // Deterministic configuration errors stop the run before any retry or
    // network path; "pending authorization" is a separate, user-owned gate.
    state: ready ? 'ready' : 'configuration_error',
    deterministicFailure: !ready,
    configurationErrors,
    authorizationPending: !hasS3bLiveRunAcknowledgement(env),
    missing,
    provider: {
      id: providerId || null,
      model: model || null,
      internalModelRef: internalModelRef || null,
      wireModelId: modelMapping.wireModelId,
      modelMapping,
      apiProtocol: SUPPORTED_PROTOCOLS.has(protocol) ? protocol : null,
      supportedProtocols: [...SUPPORTED_PROTOCOLS],
      endpointOrigin: endpoint.valid ? endpoint.origin : null,
      endpointKind: endpoint.kind,
      endpointHasUserinfo: endpoint.hasUserinfo,
      timeoutSeconds,
      maxAttempts,
      physicalRequestBudget,
      outputTokenLimit,
      maxCostUsd,
      maxCostCny,
      costBudgetCurrency,
      costBudgetAmount,
      providerBillingCapConfirmed: env.S3B_PROVIDER_BILLING_CAP_CONFIRMED === 'true',
      billingCapBasis,
      nonRetryableStatuses: [...NON_RETRYABLE_PROVIDER_STATUSES],
      retryableStatuses: [...RETRYABLE_PROVIDER_STATUSES],
      temperature: null,
      topP: null,
      seed: null,
      unsupportedParameters: ['top_p', 'seed'],
      usageSource: 'Provider response receipt when supplied; otherwise unavailable',
      costSource: 'Provider billing receipt only; otherwise unavailable',
    },
    // Keep the secret out of every public result object. Callers can pass this private
    // value directly to createLlmClient after the explicit live-run gate succeeds.
    credentials: ready ? { apiKey, baseURL, protocol, providerId, model, internalModelRef, wireModelId: modelMapping.wireModelId } : undefined,
  };
}

/** Validate the explicit live-run acknowledgement without printing the acknowledgement value. */
export function hasS3bLiveRunAcknowledgement(env = process.env) {
  return env.S3B_REAL_PROVIDER_AUTHORIZED === 'I_AUTHORIZE_THIS_EVALUATION_RUN';
}

const FAILURE_PRIMARY_CLASSES = new Set([
  'model_understanding_or_decision', 'tool_discovery_or_selection', 'tool_parameter_or_schema', 'tool_execution',
  'permission_or_safety', 'network_or_external_service', 'budget_or_no_progress', 'context_or_memory',
  'recovery_or_settlement', 'artifact_wrong_or_missing', 'insufficient_verification', 'evaluation_infrastructure', 'unknown',
]);

/**
 * What the Oracle's own details say about the artifact. `matched` is positive
 * evidence that the artifact was correct; `wrong` is positive evidence that it
 * was not; `absent` means the Oracle recorded no artifact judgement at all.
 */
function artifactEvidence(oracle) {
  const details = oracle?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return 'absent';
  if (details.contentMatches === true || details.artifactMatches === true) return 'matched';
  if (
    details.contentMatches === false || details.artifactMatches === false
    || details.validationFailure === true || details.artifactMissing === true
    || details.artifactPresent === false || details.fixtureExecutions === 0
  ) return 'wrong';
  return 'absent';
}

/**
 * Attribute a task failure from bounded observation facts.
 *
 * An Oracle-declared `failureAttribution` always wins. Otherwise the heuristic
 * must not assert more than the evidence supports: a failed Oracle whose own
 * details show the artifact matched (the DELIV-01 shape) is recorded as
 * `unknown`/`low` with an explicit reason instead of a high-confidence
 * `artifact_wrong_or_missing` claim that the details contradict.
 */
export function classifyFailure({ infrastructureStatus, oracle, observation }) {
  const evidenceRefs = (oracle?.evidence ?? []).map(item => typeof item === 'string' ? item : `fixture://${item.path ?? item.ref ?? 'evidence'}`);
  if (infrastructureStatus !== 'executed') return { primary: 'evaluation_infrastructure', secondary: [], evidenceRefs, confidence: 'high', reason: null };
  const declared = oracle?.failureAttribution;
  if (declared && FAILURE_PRIMARY_CLASSES.has(declared.primary) && Array.isArray(declared.secondary)) {
    return { primary: declared.primary, secondary: declared.secondary, evidenceRefs, confidence: declared.confidence ?? 'medium', reason: null };
  }
  const responseFailures = observation?.provider?.physicalResponses?.filter(response => response.status === null || response.status >= 400).length ?? observation?.network?.providerHttpFailures ?? 0;
  if (responseFailures > 0) return { primary: 'network_or_external_service', secondary: [], evidenceRefs, confidence: 'high', reason: null };
  if ((observation?.deniedToolCalls ?? 0) > 0) return { primary: 'permission_or_safety', secondary: [], evidenceRefs, confidence: 'high', reason: null };
  if ((observation?.unknownEffects ?? 0) > 0) return { primary: 'recovery_or_settlement', secondary: [], evidenceRefs, confidence: 'high', reason: null };
  if ((observation?.failedToolCalls ?? 0) > 0) return { primary: 'tool_parameter_or_schema', secondary: [], evidenceRefs, confidence: 'medium', reason: null };
  if (oracle?.result === 'failed' || oracle?.taskResult === 'failed') {
    const artifact = artifactEvidence(oracle);
    if (artifact === 'wrong') {
      return { primary: 'artifact_wrong_or_missing', secondary: [], evidenceRefs, confidence: evidenceRefs.length ? 'high' : 'low', reason: null };
    }
    // `primary: 'unknown'` + `confidence: 'low'`: the Oracle failed but its own
    // details either show the artifact matched or say nothing about the artifact,
    // so the evaluator must not assert artifact wrongness. The machine-readable
    // why is carried as snake_case `secondary` codes (the frozen S3B metrics
    // schema keeps `failureAttribution` at additionalProperties: false, so no new
    // property may be added there); `reason` is the human-readable projection
    // that callers record outside that object.
    return {
      primary: 'unknown',
      secondary: artifact === 'matched'
        ? ['oracle_failed_on_unmet_task_precondition', 'artifact_content_matched']
        : ['oracle_failed_without_artifact_wrongness_evidence'],
      evidenceRefs,
      confidence: 'low',
      reason: artifact === 'matched'
        ? 'oracle failed on an unmet process precondition; the independently read artifact matched'
        : 'oracle failed without artifact-wrongness evidence; the evaluator cannot attribute the failure to the artifact',
    };
  }
  return null;
}
