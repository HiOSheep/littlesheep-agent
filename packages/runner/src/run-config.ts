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
  const permissionPolicyId = opts.permissionPolicyId
    ?? (opts.requireApprovalForAllTools ? 'restricted' : 'research');
  const approvalRequiredToolNames = permissionPolicyId === 'full'
    ? []
    : unique(
        opts.tools
          .filter((tool) => opts.requireApprovalForAllTools || tool.requiresApproval)
          .map((tool) => tool.name),
      );
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
    userOverrides,
    projectOverrides: {},
    sourceConfigRevision: String(opts.config.version),
  });
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
