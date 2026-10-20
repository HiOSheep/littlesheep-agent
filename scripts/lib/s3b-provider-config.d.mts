export interface S3bProviderModelMapping {
  status: 'resolved' | 'rejected';
  /** The internal evaluation ref, e.g. `provider/model`; null when unset. */
  internalModelRef: string | null;
  providerId: string | null;
  configuredModel: string | null;
  /** The single Provider wire model id; null when the mapping was rejected. */
  wireModelId: string | null;
  /** Why an ambiguous mapping was rejected; null when resolved. */
  reason: string | null;
}

export interface S3bFailureAttribution {
  primary: string;
  /** Machine-readable snake_case codes; existing enum values are neither added nor renamed. */
  secondary: string[];
  evidenceRefs: string[];
  confidence: 'high' | 'medium' | 'low';
  /**
   * Human-readable explanation of a deliberately weak (`unknown`) heuristic
   * attribution. It is projected OUTSIDE the schema-constrained
   * `failureAttribution` object (the frozen S3B metrics schema declares that
   * object `additionalProperties: false`), so this field must never be written
   * into it.
   */
  reason: string | null;
}

export interface S3bFailureClassificationInput {
  infrastructureStatus: string;
  oracle?: {
    result?: string | null;
    taskResult?: string | null;
    failureAttribution?: { primary?: string; secondary?: unknown; confidence?: string } | null;
    evidence?: unknown[];
    details?: Record<string, unknown> | null;
  } | null;
  observation?: {
    provider?: { physicalResponses?: Array<{ status?: number | null }> } | null;
    network?: { providerHttpFailures?: number | null } | null;
    deniedToolCalls?: number | null;
    unknownEffects?: number | null;
    failedToolCalls?: number | null;
  } | null;
}

export interface S3bProviderProfile {
  ready: boolean;
  /** `configuration_error` means a deterministic error must stop the run before any network path. */
  state: 'ready' | 'configuration_error';
  deterministicFailure: boolean;
  configurationErrors: string[];
  /** Direct user authorization is a separate gate from configuration validity. */
  authorizationPending: boolean;
  missing: string[];
  provider: {
    id: string | null;
    model: string | null;
    internalModelRef: string | null;
    wireModelId: string | null;
    modelMapping: S3bProviderModelMapping;
    apiProtocol: string | null;
    supportedProtocols: string[];
    endpointOrigin: string | null;
    endpointKind: string;
    endpointHasUserinfo: boolean;
    timeoutSeconds: number | null;
    maxAttempts: number | null;
    physicalRequestBudget: number | null;
    outputTokenLimit: number | null;
    maxCostUsd: number | null;
    maxCostCny: number | null;
    costBudgetCurrency: 'USD' | 'CNY' | null;
    costBudgetAmount: number | null;
    providerBillingCapConfirmed: boolean;
    billingCapBasis: string | null;
    nonRetryableStatuses: number[];
    retryableStatuses: number[];
    temperature: number | null;
    topP: number | null;
    seed: number | null;
    unsupportedParameters: string[];
    usageSource: string;
    costSource: string;
  };
  /** Private execution credentials; omit this field from reports and logs. */
  credentials?: {
    apiKey: string;
    baseURL: string;
    protocol: string;
    providerId: string;
    model: string;
    internalModelRef: string;
    wireModelId: string | null;
  };
}

export const NON_RETRYABLE_PROVIDER_STATUSES: readonly number[];
export const RETRYABLE_PROVIDER_STATUSES: readonly number[];
export const SUPPORTED_PROVIDER_PROTOCOLS: readonly string[];

export function isNonRetryableProviderStatus(status: unknown): boolean;
export function resolveProviderWireModel(internalModelRef: unknown, providerId: unknown, configuredModel: unknown): S3bProviderModelMapping;
export function sanitizeS3bText(value: unknown, secret?: string | null): string;
export function resolveS3bProviderProfile(env?: NodeJS.ProcessEnv): S3bProviderProfile;
export function hasS3bLiveRunAcknowledgement(env?: NodeJS.ProcessEnv): boolean;
export function classifyFailure(input: S3bFailureClassificationInput): S3bFailureAttribution | null;
