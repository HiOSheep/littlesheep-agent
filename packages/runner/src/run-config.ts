import type { Config } from '@littlesheep/config';
import type { AgentTool } from '@littlesheep/types';
import type {
  PermissionPolicyId,
  ResolvedRunConfig,
  ReasoningLevel,
  RunConfigOrigin,
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
}

/** Resolve the complete run policy once, before any stage can call the model. */
export function resolveRunConfig(opts: ResolveRunConfigOptions): ResolvedRunConfig {
  const slash = opts.modelRef.indexOf('/');
  const provider = slash > 0 ? opts.modelRef.slice(0, slash) : 'unknown';
  const model = slash > 0 ? opts.modelRef.slice(slash + 1) : opts.modelRef;
  const availableToolNames = unique(opts.tools.map((tool) => tool.name));
  const approvalRequiredToolNames = unique(
    opts.tools
      .filter((tool) => opts.requireApprovalForAllTools || tool.requiresApproval)
      .map((tool) => tool.name),
  );
  const permissionPolicyId = opts.permissionPolicyId
    ?? (opts.requireApprovalForAllTools ? 'restricted' : 'research');
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
    },
    availableToolNames,
    approvalRequiredToolNames,
    userOverrides,
    projectOverrides: {},
    sourceConfigRevision: String(opts.config.version),
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
