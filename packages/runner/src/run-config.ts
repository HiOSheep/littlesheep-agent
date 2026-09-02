import type { Config } from '@littlesheep/config';
import type { AgentTool } from '@littlesheep/types';
import type {
  NetworkReadPolicy,
  PermissionPolicyId,
  ResolvedRunConfig,
  ReasoningLevel,
  RunConfigOrigin,
  WebProviderRuntimeSnapshot,
} from '@littlesheep/types';

export interface ResolveRunConfigOptions {
  runId: string;
  config: Config;
  modelRef: string;
  origin: RunConfigOrigin;
  profile?: string;
  permissionPolicyId?: PermissionPolicyId;
  reasoning?: ReasoningLevel;
  tools: AgentTool[];
  requireApprovalForAllTools: boolean;
  toolFilterApplied: boolean;
  cwdOverridden: boolean;
  /** Registry-resolved provider state; omitted until the web package is assembled. */
  webProviderSnapshot?: WebProviderRuntimeSnapshot;
}

/** Resolve the complete run policy once, before any stage can call the model. */
export function resolveRunConfig(opts: ResolveRunConfigOptions): ResolvedRunConfig {
  const slash = opts.modelRef.indexOf('/');
  const provider = slash > 0 ? opts.modelRef.slice(0, slash) : 'unknown';
  const model = slash > 0 ? opts.modelRef.slice(slash + 1) : opts.modelRef;
  const availableToolNames = unique(opts.tools.map((tool) => tool.name));
  const permissionPolicyId = opts.permissionPolicyId
    ?? (opts.requireApprovalForAllTools ? 'restricted' : 'research');
  const networkPolicy = resolveNetworkReadPolicy(opts.config);
  const approvalRequiredToolNames = permissionPolicyId === 'full'
    ? []
    : unique(
        opts.tools
          .filter((tool) => (
            (opts.requireApprovalForAllTools || tool.requiresApproval)
            && shouldProjectApproval(tool.name, networkPolicy)
          ))
          .map((tool) => tool.name),
      );
  const webProvider = resolveWebProviderSnapshot(opts.config, networkPolicy, opts.webProviderSnapshot);
  const userOverrides: Record<string, unknown> = {};
  if (opts.profile) userOverrides.profile = opts.profile;
  if (opts.reasoning) userOverrides.reasoning = opts.reasoning;
  if (opts.permissionPolicyId) userOverrides.permissionPolicyId = opts.permissionPolicyId;
  if (opts.toolFilterApplied) userOverrides.toolFilterApplied = true;
  if (opts.cwdOverridden) userOverrides.workspaceOverridden = true;

  return deepFreeze({
    version: 1,
    runId: opts.runId,
    resolvedAt: new Date().toISOString(),
    origin: opts.origin,
    behaviorModeId: opts.profile ?? opts.config.agents.defaults.profile,
    permissionPolicyId,
    workflowStrategyId: opts.config.agents.defaults.harness,
    contextStrategyId: 'legacy-stage-assembly-v1',
    memoryStrategyId: 'index-first-v1',
    toolSelectionStrategyId: 'registered-tools-v1',
    outputContractId: 'user-reply-v1',
    provider,
    model,
    reasoning: opts.reasoning ?? opts.config.agents.defaults.reasoning,
    parameters: {
      maxRecoveryAttempts: opts.config.agents.defaults.maxRecoveryAttempts,
      runTimeoutSeconds: opts.config.agents.defaults.timeoutSeconds,
      maxModelCallsPerRun: opts.config.agents.defaults.maxModelCallsPerRun,
    },
    availableToolNames,
    approvalRequiredToolNames,
    networkPolicy,
    ...(webProvider ? { webProvider } : {}),
    userOverrides,
    projectOverrides: {},
    sourceConfigRevision: String(opts.config.version),
  });
}

/** Resolve config into a closed immutable policy; callers cannot supply per-tool overrides. */
export function resolveNetworkReadPolicy(config: Config): NetworkReadPolicy {
  const web = config.web;
  const enabled = web.enabled && web.readMode !== 'disabled';
  return deepFreeze({
    version: 1,
    enabled,
    ...(web.defaultProvider ? { providerId: web.defaultProvider } : {}),
    mode: enabled ? web.readMode : 'disabled',
    allowDomains: [...web.allowDomains],
    blockDomains: [...web.blockDomains],
    dnsResolver: web.dnsResolver,
    strictReadApproval: web.strictReadApproval,
    maxQueryChars: web.maxQueryChars,
    maxResults: web.maxResults,
    maxQueriesPerRun: web.maxQueriesPerRun,
    maxFetchesPerRun: web.maxFetchesPerRun,
    maxConcurrentRequests: web.maxConcurrentRequests,
    searchTimeoutMs: web.searchTimeoutMs,
    fetchTimeoutMs: web.fetchTimeoutMs,
    totalTimeoutMs: web.totalTimeoutMs,
    maxResponseBytes: web.maxResponseBytes,
    maxExtractedChars: web.maxExtractedChars,
    maxRedirects: web.maxRedirects,
    cacheEnabled: web.cache.enabled,
    cacheTtlSeconds: web.cache.ttlSeconds,
    cacheMaxBytes: web.cache.maxBytes,
    browserFallback: web.browserFallback,
    sensitiveQueryPolicy: web.sensitiveQueryPolicy,
  });
}

function resolveWebProviderSnapshot(
  config: Config,
  policy: Readonly<NetworkReadPolicy>,
  snapshot: WebProviderRuntimeSnapshot | undefined,
): WebProviderRuntimeSnapshot | undefined {
  const providerId = config.web.defaultProvider;
  if (!providerId) return undefined;
  const provider = config.web.providers.find((candidate) => candidate.id === providerId);
  if (!policy.enabled) {
    return deepFreeze({
      id: providerId,
      adapterType: provider?.type ?? 'unknown',
      status: 'disabled',
    });
  }
  if (snapshot?.id === providerId) return deepFreeze({ ...snapshot });
  if (!provider) {
    return deepFreeze({
      id: providerId,
      adapterType: 'unknown',
      status: 'unconfigured',
      detailCode: 'web_provider_unconfigured',
    });
  }
  return deepFreeze({
    id: provider.id,
    adapterType: provider.type,
    status: 'configured_unchecked',
  });
}

/**
 * This list is only a UI/model projection. The actual call-level decision is
 * always recomputed by the permission boundary after schema validation.
 */
function shouldProjectApproval(toolName: string, policy: Readonly<NetworkReadPolicy>): boolean {
  if (!policy.strictReadApproval) {
    if (toolName === 'web_search' || toolName === 'web_fetch') return false;
    if (toolName === 'memory_tree' || toolName === 'memory_search' || toolName === 'memory_deep_search') return false;
  }
  return true;
}

export function reasoningPromptAddon(reasoning: Config['agents']['defaults']['reasoning']): string | undefined {
  switch (reasoning) {
    case 'low': return 'Reasoning budget: low. Prefer a direct answer or the smallest safe tool plan.';
    case 'medium': return 'Reasoning budget: medium. Balance speed with enough planning to avoid obvious mistakes.';
    case 'high': return 'Reasoning budget: high. Think through edge cases before acting and verify important results.';
    case 'ultra': return 'Reasoning budget: ultra. Use a careful multi-step approach, inspect assumptions, and verify thoroughly before finalizing.';
    default: return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
