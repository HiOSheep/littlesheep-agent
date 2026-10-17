export interface S3bProviderProfile {
  ready: boolean;
  missing: string[];
  provider: {
    id: string | null;
    model: string | null;
    apiProtocol: string | null;
    endpointOrigin: string | null;
    endpointKind: string;
    timeoutSeconds: number | null;
    maxAttempts: number | null;
    physicalRequestBudget: number | null;
    outputTokenLimit: number | null;
    maxCostUsd: number | null;
    providerBillingCapConfirmed: boolean;
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
  };
}

export function resolveS3bProviderProfile(env?: NodeJS.ProcessEnv): S3bProviderProfile;
export function hasS3bLiveRunAcknowledgement(env?: NodeJS.ProcessEnv): boolean;
