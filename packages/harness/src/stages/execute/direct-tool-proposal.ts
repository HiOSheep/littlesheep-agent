import { describeToolAccess, shouldRequestPermissionApproval } from '@littlesheep/safety';
import { resolveToolExecutionPolicy } from '@littlesheep/tools';
import type {
  AgentTool,
  PlanStep,
  RunContext,
  TaskBook,
  TaskStepResult,
  ToolResult,
} from '@littlesheep/types';
import { resolveExplicitSingleToolInstruction } from '../../explicit-tool-instruction.js';

export interface ResolvedDirectToolProposal {
  tool: AgentTool;
  input: unknown;
}

/**
 * Admit only a fresh, explicit, single-call read. Every rejected proposal
 * falls back to the ordinary model-driven tool loop without executing here.
 */
export function resolveDirectReadOnlyToolProposal(
  ctx: RunContext,
  taskBook: TaskBook,
  step: PlanStep,
  previousResult: TaskStepResult | undefined,
): ResolvedDirectToolProposal | undefined {
  if ((taskBook.complexity !== 'trivial' && taskBook.complexity !== 'simple')
    || taskBook.steps.length !== 1
    || previousResult
    || ctx.resumedFromCheckpointId) {
    return undefined;
  }

  const instruction = resolveExplicitSingleToolInstruction(ctx);
  const proposal = step.toolProposal;
  if (!instruction
    || !proposal
    || step.requiresApproval === true
    || (step.execution?.sideEffect !== undefined && step.execution.sideEffect !== 'read')
    || step.execution?.resources?.some((resource) => resource.mode !== 'read')
    || step.tools?.length !== 1
    || step.tools[0] !== instruction.tool.name
    || proposal.name !== instruction.tool.name) {
    return undefined;
  }

  let input: unknown;
  try {
    input = instruction.tool.inputSchema.parse(proposal.input);
  } catch {
    return undefined;
  }

  const descriptor = describeToolAccess(instruction.tool.name, input, ctx.toolContext);
  if (descriptor.action !== 'read') return undefined;
  const policy = resolveToolExecutionPolicy(instruction.tool, input, ctx.toolContext);
  if (policy.resources.some((resource) => resource.mode !== 'read')) return undefined;
  const requiresApproval = ctx.toolContext.permissionMode
    ? shouldRequestPermissionApproval(ctx.toolContext.permissionMode, descriptor)
    : instruction.tool.requiresApproval === true;
  if (requiresApproval) return undefined;

  return { tool: instruction.tool, input };
}

export function directToolEvidenceText(result: ToolResult): string {
  if (!result.ok) return result.error?.trim() || 'Tool execution failed without an error message.';
  if (typeof result.output === 'string' && result.output.trim()) return result.output.trim();
  if (result.output !== undefined) {
    try {
      const serialized = JSON.stringify(result.output);
      if (serialized) return serialized;
    } catch {
      // Fall through to a stable evidence summary.
    }
  }
  const meta = result.meta && Object.keys(result.meta).length > 0
    ? ` Metadata: ${JSON.stringify(result.meta)}`
    : '';
  return `Tool completed successfully without textual output.${meta}`;
}
