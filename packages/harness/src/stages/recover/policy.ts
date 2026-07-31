import type { PlanStep, RunContext, StageName } from '@littlesheep/types';
import type { DecodedRecovery } from './contracts.js';

export function normalizeRecoveryPlan(
  raw: DecodedRecovery['revisedPlan'],
  availableToolNames: Set<string>,
): PlanStep[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const plan: PlanStep[] = [];
  for (const step of raw) {
    if (!step || typeof step.description !== 'string' || step.description.trim().length === 0) continue;
    const tools = Array.isArray(step.tools)
      ? step.tools.filter((tool): tool is string => (
          typeof tool === 'string' && availableToolNames.has(tool)
        ))
      : undefined;
    plan.push({
      description: step.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      requiresApproval: step.requiresApproval === true ? true : undefined,
    });
  }
  return plan.length > 0 ? plan : undefined;
}

export function isStructuredDecodeFailure(error: RunContext['lastError']): boolean {
  if (!error) return false;
  return /(?:decode|invalid json|valid json|structured output|parse)/i.test(error.message);
}

export function retryStageFor(stage: StageName | undefined): StageName {
  switch (stage) {
    case 'classify':
    case 'decide':
    case 'execute':
    case 'verify':
    case 'reply':
      return stage;
    default:
      return 'execute';
  }
}
