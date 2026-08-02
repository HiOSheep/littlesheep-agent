// Bounds each DECIDE-authored proposal that may reach Runtime validation.

import type { PlanStep } from '@littlesheep/types';
import type { DecodedPlanStep } from './contracts.js';

const MAX_TOOL_PROPOSAL_CHARS = 8_192;

export function normalizeToolProposal(
  value: DecodedPlanStep['toolProposal'],
  stepTools: string[] | undefined,
  availableToolNames: Set<string>,
  explicitToolNames: ReadonlySet<string> | undefined,
): PlanStep['toolProposal'] {
  if (!explicitToolNames || !value || typeof value !== 'object') return undefined;
  const name = cleanString(value.name);
  if (!name
    || !explicitToolNames.has(name)
    || !availableToolNames.has(name)
    || stepTools?.length !== 1
    || stepTools[0] !== name
    || !('input' in value)
    || !value.input
    || typeof value.input !== 'object'
    || Array.isArray(value.input)) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value.input);
    if (!serialized || serialized.length > MAX_TOOL_PROPOSAL_CHARS) return undefined;
    return { name, input: JSON.parse(serialized) as unknown };
  } catch {
    return undefined;
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
