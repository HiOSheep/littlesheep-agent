import { LLM_CALL_CONTRACT_VERSION } from '@littlesheep/types';
import type {
  LlmCallContract,
  LlmCallPurpose,
  RunContext,
  StageName,
} from '@littlesheep/types';
import { LLM_CALL_CONTRACT_TEMPLATES } from './definitions.js';

export interface ResolveLlmCallContractOptions {
  allowedToolNames?: readonly string[];
  maxOutputTokens?: number;
  temperature?: number;
}

export type LlmCallContractViolationReason =
  | 'unknown_purpose'
  | 'unregistered_tool'
  | 'forbidden_model_call'
  | 'tool_forbidden'
  | 'tool_not_allowed'
  | 'output_budget_exceeded';

export class LlmCallContractViolationError extends Error {
  readonly reason: LlmCallContractViolationReason;
  readonly contractId?: string;

  constructor(reason: LlmCallContractViolationReason, message: string, contractId?: string) {
    super(contractId ? `LLM call contract ${contractId} rejected request: ${message}` : message);
    this.name = 'LlmCallContractViolationError';
    this.reason = reason;
    this.contractId = contractId;
  }
}

const LEGACY_STAGE_PURPOSE: Readonly<Record<StageName, LlmCallPurpose>> = {
  enter: 'finalize',
  classify: 'classify',
  decide: 'decide',
  execute: 'execute_tool_loop',
  recover: 'recover',
  verify: 'verify',
  evolve: 'evolve',
  capture: 'capture',
  reply: 'reply',
  ask_user: 'ask_user',
  finalize: 'finalize',
};

export function normalizeLlmCallPurpose(value: LlmCallPurpose | StageName): LlmCallPurpose {
  if (Object.prototype.hasOwnProperty.call(LLM_CALL_CONTRACT_TEMPLATES, value)) {
    return value as LlmCallPurpose;
  }
  const legacyPurpose = LEGACY_STAGE_PURPOSE[value as StageName];
  if (legacyPurpose) return legacyPurpose;
  throw new LlmCallContractViolationError('unknown_purpose', `Unknown LLM call purpose: ${String(value)}.`);
}

export function resolveLlmCallContract(
  ctx: RunContext,
  purposeOrStage: LlmCallPurpose | StageName,
  options: ResolveLlmCallContractOptions = {},
): LlmCallContract {
  const purpose = normalizeLlmCallPurpose(purposeOrStage);
  const template = LLM_CALL_CONTRACT_TEMPLATES[purpose];
  const registeredToolNames = new Set(ctx.tools.map((tool) => tool.name));
  const requestedToolNames = [...new Set(options.allowedToolNames ?? registeredToolNames)].sort();
  const unregisteredToolNames = requestedToolNames.filter((name) => !registeredToolNames.has(name));
  if (unregisteredToolNames.length > 0) {
    throw new LlmCallContractViolationError(
      'unregistered_tool',
      `tools are not registered for this run: ${unregisteredToolNames.join(', ')}.`,
      `core-flow/${purpose}@${LLM_CALL_CONTRACT_VERSION}`,
    );
  }
  const allowedToolNames = template.toolMode === 'none'
    ? []
    : requestedToolNames;
  const maxOutputTokens = Math.min(
    template.maxOutputTokens,
    Math.max(0, options.maxOutputTokens ?? template.maxOutputTokens),
  );
  return deepFreeze<LlmCallContract>({
    version: LLM_CALL_CONTRACT_VERSION,
    id: `core-flow/${purpose}@${LLM_CALL_CONTRACT_VERSION}`,
    purpose,
    stage: template.stage,
    modelCall: template.modelCall,
    goal: template.goal(ctx),
    inputs: {
      sourcePolicy: 'explicit_candidates_only',
      allowedContextKinds: [...template.allowedContextKinds],
      requiredContextKinds: [...template.requiredContextKinds],
      history: template.history,
      attachments: template.attachments,
    },
    allowedDecisions: [...template.allowedDecisions],
    outputSchema: { ...template.outputSchema },
    memoryIntentPolicy: {
      allowed: [...template.memoryIntents],
      defaultIntent: 'none',
      commitAuthority: 'runtime_only',
      requiresEvidence: template.requiresMemoryEvidence,
      writableBranches: template.writableBranches ? [...template.writableBranches] : undefined,
    },
    toolPolicy: {
      mode: template.toolMode,
      allowedToolNames,
      runtimeApprovalRequired: template.runtimeApprovalRequired,
      maxIterations: template.maxIterations,
    },
    budget: {
      maxAttempts: template.maxAttempts,
      maxOutputTokens,
      maxPromptTokens: template.maxPromptTokens,
      temperature: options.temperature ?? template.temperature,
      contextCompressionThresholdRatio: ctx.contextCompressionThresholdRatio,
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
