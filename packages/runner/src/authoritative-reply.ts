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
const MAX_FAILURE_MESSAGE_LENGTH = 512

/**
 * Results that already passed the next-mode publication boundary. The Local App
 * API must not repeat that durable replay when Runner already prepared them.
 */
const preparedAuthoritativeResults = new WeakSet<object>()

export function markAuthoritativePrepared<T extends object>(result: T): T {
  preparedAuthoritativeResults.add(result)
  return result
}

export function isAuthoritativePrepared(result: unknown): boolean {
  return typeof result === 'object' && result !== null && preparedAuthoritativeResults.has(result)
}

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
    runtimeFailureDetail(result),
  )
}

/**
 * Apply the same publication boundary to a diagnostic execution-log replay.
 * The log remains useful for bounded audit fields, but its reply/messages are
 * never allowed to outrank the durable final-reply projection in next mode.
 */
export async function prepareAuthoritativeExecutionLog(
  runner: Pick<AgentRunner, 'durableHarnessModeForRun' | 'replayDurableFinalReply'>,
  log: ExecutionLog,
): Promise<AuthoritativeExecutionLog> {
  let mode = log.durableHarnessMode
  try {
    mode ??= await runner.durableHarnessModeForRun?.(log.sessionId, log.runId)
  } catch {
    return runtimeExecutionLogResult(log, 'failed', 'durable_run_mode_unavailable')
  }
  // Settlement metadata predates the explicit mode field. Such records must
  // still be verified; truly legacy records keep their historical behavior.
  mode ??= log.finalReplySettlement ? 'next' : 'shadow'
  if (mode !== 'next') return log
  log = { ...log, durableHarnessMode: 'next' }

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
      runtimeStatus: undefined,
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
    runtimeFailureDetail(log),
  )
}

export type AuthoritativeExecutionLog = ExecutionLog & {
  runtimeStatus?: RuntimeFinalStatus
}

function runtimeStatusResult(
  result: RunnerResult,
  status: RuntimeFinalStatus['status'],
  reason?: string,
  detail?: string,
): RunnerResult {
  const runtimeStatus = buildRuntimeStatus(status, reason)
  return {
    ...result,
    status: status === 'interrupted' ? 'aborted' : 'error',
    reply: '',
    replyProvenance: undefined,
    finalReplySettlement: undefined,
    runtimeStatus,
    error: detail ? boundedFailureMessage(detail) : runtimeStatusMessage(runtimeStatus),
    messages: hideUnsettledFinalizeMessages(result.messages),
    webEvidence: undefined,
  }
}

function runtimeExecutionLogResult(
  log: ExecutionLog,
  status: RuntimeFinalStatus['status'],
  reason?: string,
  detail?: string,
): AuthoritativeExecutionLog {
  const runtimeStatus = buildRuntimeStatus(status, reason)
  return {
    ...log,
    status: status === 'interrupted' ? 'aborted' : 'error',
    reply: '',
    replyProvenance: undefined,
    finalReplySettlement: undefined,
    runtimeStatus,
    error: detail ? boundedFailureMessage(detail) : runtimeStatusMessage(runtimeStatus),
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

/**
 * The durable projection can prove that nothing was settled, but it does not
 * say why. The Runtime-owned failure text (never model prose) is the only
 * actionable explanation the user has, so a fail-closed result keeps it
 * instead of replacing it with an internal code.
 */
function runtimeFailureDetail(source: { error?: string; runtimeStatus?: RuntimeFinalStatus }): string | undefined {
  const detail = source.error?.replace(/\s+/gu, ' ').trim()
  if (detail) return detail
  return source.runtimeStatus?.reason
}

function boundedFailureMessage(detail: string): string {
  return detail.slice(0, MAX_FAILURE_MESSAGE_LENGTH)
}
