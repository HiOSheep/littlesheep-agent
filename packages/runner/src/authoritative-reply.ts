import type {
  DurableFinalReplyReplay,
  FinalReplySettlement,
  Message,
  RuntimeFinalStatus,
} from '@littlesheep/types'
import { asSessionId } from '@littlesheep/types'
import type { AgentRunner, RunnerResult } from './runner.js'
import type { ExecutionLog } from './execution-log.js'

const MAX_RUNTIME_REASON_LENGTH = 160

/**
 * Resolve the only result that may be published by a caller outside Runner.
 * Legacy and shadow runners retain their existing result contract. The next
 * Harness instead makes the durable final-reply projection authoritative:
 * proposals, execution-log replies and stream reconstruction are never
 * published when replay cannot prove a settled reply.
 */
export async function prepareAuthoritativeRunnerResult(
  runner: AgentRunner,
  result: RunnerResult,
): Promise<RunnerResult> {
  if ((result.durableHarnessMode ?? runner.durableHarnessMode) !== 'next') return result

  const replay = runner.replayDurableFinalReply
  if (!replay) {
    return runtimeStatusResult(result, 'failed', 'durable_final_reply_replay_unavailable')
  }

  let durable: DurableFinalReplyReplay
  try {
    durable = await replay(result.sessionId, result.runId)
  } catch {
    return runtimeStatusResult(result, 'failed', 'durable_final_reply_replay_failed')
  }

  if (durable.kind === 'settled') {
    const settlement: FinalReplySettlement = {
      version: 1,
      settlementId: durable.settlementId,
      reply: durable.reply,
      replyFingerprint: durable.replyFingerprint,
      modelRequestId: durable.modelRequestId,
      status: 'settled',
    }
    return {
      ...result,
      status: 'ok',
      reply: durable.reply,
      replyProvenance: result.replyProvenance?.modelRequestId === durable.modelRequestId
        ? result.replyProvenance
        : undefined,
      finalReplySettlement: settlement,
      runtimeStatus: undefined,
      error: undefined,
      messages: settleFinalizeMessages(result.messages, settlement),
    }
  }

  if (durable.kind === 'runtime_status') {
    return runtimeStatusResult(result, durable.status, durable.reason)
  }

  return runtimeStatusResult(
    result,
    durable.status === 'interrupted' ? 'interrupted' : 'failed',
    `durable_final_reply_${durable.reason}`,
  )
}

/**
 * Apply the same publication boundary to a diagnostic execution-log replay.
 * The log remains useful for bounded audit fields, but its reply/messages are
 * never allowed to outrank the durable final-reply projection in next mode.
 */
export async function prepareAuthoritativeExecutionLog(
  runner: Pick<AgentRunner, 'durableHarnessMode' | 'durableHarnessModeForSession' | 'replayDurableFinalReply'>,
  log: ExecutionLog,
): Promise<AuthoritativeExecutionLog> {
  const mode = runner.durableHarnessModeForSession?.(log.sessionId) ?? runner.durableHarnessMode
  if (mode !== 'next') return log

  const replay = runner.replayDurableFinalReply
  if (!replay) {
    return runtimeExecutionLogResult(log, 'failed', 'durable_final_reply_replay_unavailable')
  }

  let durable: DurableFinalReplyReplay
  try {
    durable = await replay(asSessionId(log.sessionId), log.runId)
  } catch {
    return runtimeExecutionLogResult(log, 'failed', 'durable_final_reply_replay_failed')
  }

  if (durable.kind === 'settled') {
    const settlement: FinalReplySettlement = {
      version: 1,
      settlementId: durable.settlementId,
      reply: durable.reply,
      replyFingerprint: durable.replyFingerprint,
      modelRequestId: durable.modelRequestId,
      status: 'settled',
    }
    return {
      ...log,
      status: 'ok',
      reply: durable.reply,
      replyProvenance: log.replyProvenance?.modelRequestId === durable.modelRequestId
        ? log.replyProvenance
        : undefined,
      finalReplySettlement: settlement,
      error: undefined,
    }
  }

  if (durable.kind === 'runtime_status') {
    return runtimeExecutionLogResult(log, durable.status, durable.reason)
  }

  return runtimeExecutionLogResult(
    log,
    durable.status === 'interrupted' ? 'interrupted' : 'failed',
    `durable_final_reply_${durable.reason}`,
  )
}

export type AuthoritativeExecutionLog = ExecutionLog & {
  runtimeStatus?: RuntimeFinalStatus
}

function runtimeStatusResult(
  result: RunnerResult,
  status: RuntimeFinalStatus['status'],
  reason?: string,
): RunnerResult {
  const runtimeStatus = buildRuntimeStatus(status, reason)
  return {
    ...result,
    status: status === 'interrupted' ? 'aborted' : 'error',
    reply: '',
    replyProvenance: undefined,
    finalReplySettlement: undefined,
    runtimeStatus,
    error: runtimeStatusMessage(runtimeStatus),
    messages: hideUnsettledFinalizeMessages(result.messages),
    webEvidence: undefined,
  }
}

function runtimeExecutionLogResult(
  log: ExecutionLog,
  status: RuntimeFinalStatus['status'],
  reason?: string,
): AuthoritativeExecutionLog {
  const runtimeStatus = buildRuntimeStatus(status, reason)
  return {
    ...log,
    status: status === 'interrupted' ? 'aborted' : 'error',
    reply: '',
    replyProvenance: undefined,
    finalReplySettlement: undefined,
    runtimeStatus,
    error: runtimeStatusMessage(runtimeStatus),
    webEvidence: undefined,
  }
}

function buildRuntimeStatus(
  status: RuntimeFinalStatus['status'],
  reason?: string,
): RuntimeFinalStatus {
  const boundedReason = boundedRuntimeReason(reason)
  return {
    version: 1,
    status,
    ...(boundedReason ? { reason: boundedReason } : {}),
  }
}

function hideUnsettledFinalizeMessages(messages: Message[]): Message[] {
  // FINALIZE messages contain the model proposal before the durable event is
  // settled. Callers may still use earlier tool evidence, but must not expose
  // an unconfirmed assistant proposal through the result payload.
  return messages.filter((message) => !(message.role === 'assistant' && message.stage === 'finalize'))
}

function settleFinalizeMessages(messages: Message[], settlement: FinalReplySettlement): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || message.stage !== 'finalize') return message
    return { ...message, finalReplySettlement: settlement }
  })
}

function boundedRuntimeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  const normalized = reason.replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, MAX_RUNTIME_REASON_LENGTH) : undefined
}

function runtimeStatusMessage(status: RuntimeFinalStatus): string {
  const base = status.status === 'waiting_user'
    ? 'Runtime is waiting for user action; no final reply was published.'
    : status.status === 'interrupted'
      ? 'Runtime interrupted before publishing a final reply.'
      : 'Runtime failed before publishing a final reply.'
  return status.reason ? `${base} Reason: ${status.reason}` : base
}
