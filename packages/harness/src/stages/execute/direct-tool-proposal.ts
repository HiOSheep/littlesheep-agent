import { describeToolAccess, shouldRequestPermissionApproval } from '@littlesheep/safety';
import {
  resolveToolExecutionPolicy,
  toolResourceAccessCovered,
} from '@littlesheep/tools';
import type {
  AgentTool,
  PlanStep,
  RunContext,
  TaskBook,
  TaskStepSideEffect,
  TaskStepResult,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types';
import { resolveExplicitToolInstructionSet } from '../../explicit-tool-instruction.js';

const MAX_DIRECT_PROPOSALS_PER_TASK = 8;

export interface ResolvedDirectToolProposal {
  tool: AgentTool;
  input: unknown;
}

/**
 * Admit one explicit DECIDE proposal only after Runtime revalidates its tool,
 * schema, resource envelope, side-effect class and permission boundary.
 */
export function resolveDirectToolProposal(
  ctx: RunContext,
  taskBook: TaskBook,
  step: PlanStep,
  previousResult: TaskStepResult | undefined,
  execution: {
    stepId: string;
    resources: readonly ToolResourceAccess[];
    sideEffect?: TaskStepSideEffect;
  },
): ResolvedDirectToolProposal | undefined {
  if (previousResult
    || taskBook.steps.filter((candidate) => candidate.toolProposal).length > MAX_DIRECT_PROPOSALS_PER_TASK) {
    return undefined;
  }

  const instructions = resolveExplicitToolInstructionSet(ctx);
  const proposal = step.toolProposal;
  if (!instructions
    || !proposal
    || step.tools?.length !== 1
    || step.tools[0] !== proposal.name) {
    return undefined;
  }
  const instruction = instructions.entries.find((entry) => entry.tool.name === proposal.name);
  if (!instruction) return undefined;

  let input: unknown;
  try {
    input = instruction.tool.inputSchema.parse(proposal.input);
  } catch {
    return undefined;
  }

  const descriptor = describeToolAccess(instruction.tool.name, input, ctx.toolContext);
  if (descriptor.action === 'unknown') return undefined;
  const directExec = descriptor.action === 'execute'
    && instruction.tool.name === 'exec'
    && ctx.toolSources?.[instruction.tool.name] === 'builtin'
    && ctx.toolContext.permissionMode === 'full'
    && !ctx.resumedFromCheckpointId;
  if (descriptor.action !== 'read' && descriptor.action !== 'write' && !directExec) return undefined;
  const policy = resolveToolExecutionPolicy(instruction.tool, input, ctx.toolContext);
  const actualSideEffect = resolveActualSideEffect(descriptor.action, policy.resources);
  if (actualSideEffect !== 'read'
    && !directExec
    && !sideEffectCovered(execution.sideEffect, actualSideEffect)) return undefined;
  if (directExec
    && execution.sideEffect
    && !sideEffectCovered(execution.sideEffect, actualSideEffect)) return undefined;
  if (actualSideEffect === 'read'
    && execution.sideEffect
    && !sideEffectCovered(execution.sideEffect, actualSideEffect)) return undefined;
  if (execution.resources.length > 0
    && policy.resources.length > 0
    && policy.resources.some((actual) => (
      !execution.resources.some((declared) => toolResourceAccessCovered(declared, actual))
    ))) {
    return undefined;
  }
  const requiresApproval = ctx.toolContext.permissionMode
    ? shouldRequestPermissionApproval(ctx.toolContext.permissionMode, descriptor)
    : instruction.tool.requiresApproval === true;
  if (requiresApproval) return undefined;
  if (actualSideEffect !== 'read'
    && ctx.resumedFromCheckpointId
    && (ctx.sideEffects ?? []).some((effect) => (
      effect.stepId === execution.stepId && effect.status !== 'failed'
    ))) {
    return undefined;
  }

  return { tool: instruction.tool, input };
}

function resolveActualSideEffect(
  action: 'read' | 'write' | 'execute',
  resources: readonly ToolResourceAccess[],
): TaskStepSideEffect {
  if (action === 'execute') return 'external';
  if (action === 'write' || resources.some((resource) => resource.mode === 'write')) return 'write';
  return resources.length > 0 || action === 'read' ? 'read' : 'none';
}

function sideEffectCovered(
  declared: TaskStepSideEffect | undefined,
  actual: TaskStepSideEffect,
): boolean {
  if (!declared) return false;
  const rank: Record<TaskStepSideEffect, number> = {
    none: 0,
    read: 1,
    write: 2,
    external: 3,
  };
  return rank[declared] >= rank[actual];
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
