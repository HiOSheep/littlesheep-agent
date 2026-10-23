// Durable final-reply publication artifacts owned by the Runner.
import type { RunContext } from '@littlesheep/types';
import type { RunnerResult } from './runner.js';
import { collectConversationSourceRecords } from '@littlesheep/harness';
import type { Infrastructure, LogFn } from './infra.js';

export function settledReplyResult(result: RunnerResult, ctx: RunContext): RunnerResult {
    const settlement = ctx.finalReplySettlement;
    if (!settlement || settlement.status !== 'settled') {
      throw new Error('durable harness settled without a final reply projection');
    }
    return {
      ...result,
      status: 'ok',
      reply: settlement.reply,
      finalReplySettlement: settlement,
      runtimeStatus: undefined,
      error: undefined,
      messages: result.messages.map((message) => (
        message.role === 'assistant' && message.stage === 'finalize'
          ? { ...message, finalReplySettlement: settlement }
          : message
      )),
    };
}

/**
 * Repair the secondary projections after the authoritative final-reply
 * settlement. Neither repair is allowed to downgrade an already settled
 * user-visible reply; startup recovery can retry either projection later.
 */
export async function settleFinalReplyArtifacts(
  ctx: RunContext,
  infra: Infrastructure,
  log?: LogFn,
): Promise<void> {
  const settlement = ctx.finalReplySettlement;
  if (!settlement || settlement.status !== 'settled') return;

  try {
    await promoteExecutionLogSettlement(infra.executionLogStore, { runId: ctx.runId, finalReplySettlement: settlement }, log);
  } catch (error) {
    log?.('error', 'runner: settled execution-log repair guard failed: ' + (error as Error).message);
  }

  try {
    await infra.memoryService.captureConversationSources(collectConversationSourceRecords(ctx));
  } catch (error) {
    log?.('warn', 'runner: settled assistant conversation source capture degraded: ' + (error as Error).message);
  }
}

export async function promoteExecutionLogSettlement(
  executionLogStore: Infrastructure['executionLogStore'],
  result: Pick<RunnerResult, 'runId' | 'finalReplySettlement'>,
  log?: LogFn,
): Promise<void> {
  const settlement = result.finalReplySettlement;
  if (!settlement || settlement.status !== 'settled') return;
  try {
    await executionLogStore.settleFinalReply(result.runId, settlement);
  } catch (error) {
    log?.('error', 'runner: failed to promote settled final reply in execution log: ' + (error as Error).message);
  }
}
