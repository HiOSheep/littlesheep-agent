import type { RunContext, TaskBook, TaskStepResult } from '@littlesheep/types';

const COMPACT_READ_ONLY_TOOLS = new Set(['glob', 'grep', 'read']);

/**
 * Keep the reduced final-reply Context behind evidence Runtime can prove.
 * Tool naming alone is insufficient: the source, lifecycle record, result,
 * side-effect ledger, and TaskBook shape must all agree.
 */
export function isCompactReadOnlyResult(
  ctx: RunContext,
  taskBook: TaskBook | undefined = ctx.taskBook,
  stepResults: readonly TaskStepResult[] | undefined = ctx.taskExecution?.steps,
): boolean {
  if (!taskBook
    || taskBook.complexity !== 'trivial'
    || taskBook.steps.length !== 1
    || stepResults?.length !== 1
    || ctx.taskExecution?.status !== 'done'
    || ctx.resumedFromCheckpointId
    || ctx.toolInvocationsTruncated
    || (ctx.sideEffects?.length ?? 0) > 0) {
    return false;
  }

  const classification = ctx.classification;
  if (classification?.activity !== 'execute'
    || classification.source !== 'rules'
    || classification.reason !== 'explicit tool instruction') {
    return false;
  }

  const step = taskBook.steps[0]!;
  const proposal = step.toolProposal;
  if (!proposal
    || !COMPACT_READ_ONLY_TOOLS.has(proposal.name)
    || ctx.toolSources?.[proposal.name] !== 'builtin'
    || step.tools?.length !== 1
    || step.tools[0] !== proposal.name
    || (step.execution?.sideEffect !== undefined
      && step.execution.sideEffect !== 'none'
      && step.execution.sideEffect !== 'read')) {
    return false;
  }

  const result = stepResults[0]!;
  const toolResult = result.toolResults[0];
  const callId = result.toolCallIds[0];
  if (result.status !== 'done'
    || result.error
    || !result.output?.trim()
    || result.toolCallIds.length !== 1
    || result.toolResults.length !== 1
    || !callId
    || toolResult?.callId !== callId
    || toolResult.ok !== true
    || toolResult.sanitized === true) {
    return false;
  }

  const invocations = ctx.toolInvocations ?? [];
  return invocations.length === 1
    && invocations[0]?.callId === callId
    && invocations[0]?.toolName === proposal.name
    && invocations[0].toolSource === 'builtin'
    && invocations[0].status === 'succeeded'
    && invocations[0].approval.required === false
    && invocations[0].approval.decision === 'not_required'
    && invocations[0].outputSanitized !== true
    && invocations[0].outputTruncated !== true;
}
