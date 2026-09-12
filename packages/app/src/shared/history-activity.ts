import type { ExecutionLog, ToolCallRecord } from '@littlesheep/runner'
import type { Message, RunUsage, TaskBook, ToolInvocationRecord, VerificationRecord, WebEvidenceProjection } from '@littlesheep/types'
import { aggregateRunUsage } from './run-usage'

export type HistoryActivityStatus = 'running' | 'done' | 'failed' | 'aborted' | 'paused' | 'waiting_user'
export type HistoryStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'unknown'
export type ActivityVisibility = 'silent' | 'progress'

export interface HistoryActivity {
  status: HistoryActivityStatus
  /** Runtime-owned disclosure policy for non-message run activity. */
  visibility?: ActivityVisibility
  instruction: string
  /** Runtime failure/abort state; this is not an assistant-authored reply. */
  error?: string
  runtimeStatus?: ExecutionLog['runtimeStatus']
  runCheckpointId?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  taskBook?: TaskBook
  verificationHistory?: VerificationRecord[]
  verificationRunning?: boolean
  steps: Array<{
    stepId: string
    title: string
    description?: string
    status: HistoryStepStatus
    startedAt?: number
    endedAt?: number
    output?: string
    error?: string
    toolCount: number
    activeTools: number
  }>
  tools: Array<{
    callId: string
    name: string
    stepId?: string
    startedAt?: number
    endedAt?: number
    input?: unknown
    ok?: boolean
    output?: string
    error?: string
  }>
  contextProjections?: Array<{
    kind: 'context_injection' | 'cross_session_recall' | 'context_compaction'
    label: string
    detail: string
  }>
  transcript?: Array<
    | { kind: 'reasoning'; id: string; text: string; status: 'running' | 'done' }
    | { kind: 'text'; id: string; text: string }
    | { kind: 'system'; id: string; text: string }
    | { kind: 'tool'; id: string; callId: string }
  >
}

export interface HistoryMessageRecord {
  /** Durable source message id; stable across paging and app restarts. */
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  durationMs?: number
  usage?: RunUsage
  modelRef?: string
  activityCollapsed?: boolean
  activity?: HistoryActivity
  webEvidence?: WebEvidenceProjection
}

function finiteTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function stringifyHistoryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function historyStepStatus(status: string, waiting: boolean): HistoryStepStatus {
  if (status === 'done' || status === 'failed' || status === 'skipped') return status
  if (status === 'blocked') return 'failed'
  if (status === 'pending') return 'pending'
  return waiting ? 'pending' : 'unknown'
}

function historySteps(log: ExecutionLog): HistoryActivity['steps'] {
  const waiting = log.runtimeStatus?.status === 'waiting_user' || log.runtimeControl?.state === 'paused'
  const results = new Map((log.taskExecution?.steps ?? []).map((step) => [step.stepId, step]))
  const planned = log.taskBook?.steps ?? []
  if (planned.length === 0) {
    return (log.taskExecution?.steps ?? []).map((step) => ({
      stepId: step.stepId,
      title: step.title || step.description || '执行步骤',
      description: step.description,
      status: historyStepStatus(step.status, waiting),
      startedAt: finiteTimestamp(step.startedAt),
      endedAt: finiteTimestamp(step.endedAt),
      output: step.output,
      error: step.error,
      toolCount: step.toolCallIds?.length ?? 0,
      activeTools: 0,
    }))
  }
  return planned.map((step, index) => {
    const stepId = step.id ?? `step-${index + 1}`
    const result = results.get(stepId)
    return {
      stepId,
      title: result?.title || step.title || step.description || '执行步骤',
      description: result?.description ?? step.description,
      status: historyStepStatus(result?.status ?? step.status ?? 'pending', waiting),
      startedAt: finiteTimestamp(result?.startedAt),
      endedAt: finiteTimestamp(result?.endedAt),
      output: result?.output,
      error: result?.error,
      toolCount: result?.toolCallIds?.length ?? 0,
      activeTools: 0,
    }
  })
}

function historyTool(tool: ToolCallRecord, log: ExecutionLog, index: number): HistoryActivity['tools'][number] {
  const durationMs = tool.result.durationMs
  const logStartedAt = finiteTimestamp(log.startedAt)
  const startedAt = logStartedAt === undefined ? undefined : logStartedAt + index * 12
  return {
    callId: tool.call.id,
    name: tool.call.name,
    stepId: typeof tool.result.meta?.stepId === 'string' ? tool.result.meta.stepId : undefined,
    startedAt,
    endedAt: typeof durationMs === 'number' && startedAt !== undefined
      ? startedAt + durationMs
      : undefined,
    input: tool.call.input,
    ok: tool.result.ok,
    output: stringifyHistoryValue(tool.result.output),
    error: tool.result.error,
  }
}

/** Union of log tool calls and durable invocations, keyed by call id. */
function historyTools(log: ExecutionLog, endedAt: number | undefined): HistoryActivity['tools'] {
  const rows = new Map<string, HistoryActivity['tools'][number]>()
  for (const [index, tool] of log.toolCalls.entries()) {
    rows.set(tool.call.id, historyTool(tool, log, index))
  }
  for (const record of log.toolInvocations ?? []) {
    rows.set(record.callId, applyInvocationStatus(rows.get(record.callId), record, endedAt))
  }
  return [...rows.values()]
}

export function hasExecutionActivity(log: ExecutionLog): boolean {
  return Boolean(log.durableHarnessMode === 'next' || log.taskBook?.steps?.length || log.taskExecution?.steps?.length || log.toolCalls.length || log.toolInvocations?.length || log.verificationHistory?.length)
}

/**
 * Overlay the durable status of one tool invocation onto a display row.
 * Display text (input/output) always stays with the live stream or execution
 * log: a ToolInvocationRecord deliberately carries only bounded summaries
 * such as `output present (N characters)`, which must never replace the
 * actual output the user already saw.
 */
export function applyInvocationStatus(
  previous: HistoryActivity['tools'][number] | undefined,
  record: ToolInvocationRecord,
  endedAt: number | undefined,
): HistoryActivity['tools'][number] {
  const ok = record.status === 'succeeded' ? true : record.status === 'running' || record.status === 'proposed' ? undefined : false
  return {
    ...previous,
    callId: record.callId,
    name: previous?.name ?? record.toolName,
    stepId: previous?.stepId ?? record.stepId,
    input: previous?.input,
    output: previous?.output,
    error: record.error ?? previous?.error ?? (ok === undefined ? '未收到工具最终结果。' : undefined),
    ok,
    startedAt: previous?.startedAt ?? finiteTimestamp(record.startedAt),
    endedAt: finiteTimestamp(record.endedAt) ?? previous?.endedAt ?? endedAt,
  };
}

/** One terminal-state mapping for both live results and history reloads. */
export function runActivityOutcome(run: Pick<ExecutionLog, 'status' | 'runtimeControl' | 'runtimeStatus' | 'error' | 'runCheckpointId'>): Pick<HistoryActivity, 'status' | 'error' | 'runtimeStatus' | 'runCheckpointId'> {
  const waiting = run.runtimeStatus?.status === 'waiting_user'
  const paused = !waiting && run.runtimeControl?.state === 'paused'
  return {
    status: waiting ? 'waiting_user' : paused ? 'paused' : run.status === 'ok' ? 'done' : run.status === 'aborted' ? 'aborted' : 'failed',
    error: waiting
      ? run.error || `需要用户决定后才能继续。${run.runtimeStatus?.reason ? ` ${run.runtimeStatus.reason}` : ''}`
      : paused ? '任务已暂停，现场已保存。' : run.error,
    runtimeStatus: run.runtimeStatus,
    runCheckpointId: run.runCheckpointId,
  }
}

export function executionLogToHistoryActivity(log: ExecutionLog): HistoryActivity {
  const startedAt = finiteTimestamp(log.startedAt) ?? 0
  const endedAt = finiteTimestamp(log.endedAt)
  return {
    ...runActivityOutcome(log),
    visibility: hasExecutionActivity(log) ? 'progress' : 'silent',
    instruction: log.inboundText,
    startedAt,
    endedAt,
    durationMs: log.durationMs,
    taskBook: log.taskBook,
    verificationHistory: log.verificationHistory,
    steps: historySteps(log),
    tools: historyTools(log, endedAt),
    contextProjections: projectHistoryContext(log),
    transcript: log.systemPromptProjection
      ? [{ kind: 'system', id: 'system-prompt', text: log.systemPromptProjection }]
      : undefined,
  }
}

function projectHistoryContext(log: ExecutionLog): HistoryActivity['contextProjections'] {
  const snapshot = log.contextSnapshots?.at(-1)
  if (!snapshot) return undefined
  const included = snapshot.items.filter((item) => item.disposition === 'included')
  const memory = included.filter((item) => item.source.kind === 'memory'
    || item.kind === 'memory_index' || item.kind === 'memory_fragment' || item.kind === 'project_knowledge')
  const recalled = included.filter((item) => item.kind === 'summary_memory'
    || (item.source.kind === 'memory' && (item.scope === 'session' || item.scope === 'global')))
  const rows: NonNullable<HistoryActivity['contextProjections']> = []
  if (memory.length) rows.push({ kind: 'context_injection', label: '上下文注入', detail: `${memory.length} 个记忆项 · ${memory.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0)} tokens` })
  if (recalled.length) rows.push({ kind: 'cross_session_recall', label: '跨会话召回', detail: `${recalled.length} 个历史项` })
  if (included.some((item) => item.kind === 'summary_memory')) rows.push({ kind: 'context_compaction', label: '上下文已压缩', detail: '使用可追溯会话摘要' })
  return rows.length ? rows : undefined
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function isConversationalMessage(message: Message): message is Message & { role: 'user' | 'assistant' } {
  return message.role === 'user' || message.role === 'assistant'
}

function activityOwnerIndexes(messages: Message[]): Map<string, number> {
  const owners = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.runId) {
      owners.set(message.runId, index)
    }
  })
  return owners
}

/**
 * Rebuild renderer history from durable session messages and execution logs.
 * One run's process is attached only to its final textual assistant message,
 * never to intermediate assistant tool-call records from the same run.
 */
export function buildHistoryMessages(
  messages: Message[],
  logsByRunId: ReadonlyMap<string, ExecutionLog>,
): HistoryMessageRecord[] {
  // Runtime recovery may finish after a crash that persisted only the user
  // input. Give that status a stable UI row without inventing Agent text or
  // writing a synthetic message into the authoritative transcript.
  const missingAssistantRuns = new Set([...logsByRunId.values()]
    .filter((log) => log.runtimeStatus && !messages.some((message) => message.runId === log.runId && message.role === 'assistant'))
    .map((log) => log.runId))
  const projectedMessages = messages.flatMap((message): Message[] => {
    if (message.role !== 'user' || !message.runId || !missingAssistantRuns.delete(message.runId)) return [message]
    return [message, { ...message, id: `${message.runId}:runtime-status`, role: 'assistant', stage: 'finalize', content: [] }]
  })
  const owners = activityOwnerIndexes(projectedMessages)
  return projectedMessages
    .map((message, index): HistoryMessageRecord | null => {
      if (!isConversationalMessage(message)) return null
      const runId = String(message.runId ?? '')
      const log = runId ? logsByRunId.get(runId) : undefined
      const ownsRun = message.role === 'assistant' && owners.get(runId) === index
      const ownsActivity = ownsRun && !!log && (hasExecutionActivity(log) || !!log.runtimeStatus)
      const textFromMessage = messageText(message)
      const durableSettlement = ownsRun
        && (message.stage === 'finalize' || message.finalReplySettlement !== undefined)
        && log?.finalReplySettlement?.status === 'settled'
        && (!message.finalReplySettlement
          || message.finalReplySettlement.settlementId === log.finalReplySettlement.settlementId)
        ? log.finalReplySettlement
        : undefined
      const unconfirmedFinalProposal = message.role === 'assistant'
        && message.stage === 'finalize'
        && (message.finalReplySettlement !== undefined || log?.durableHarnessMode === 'next' || !!log?.runtimeStatus)
        && durableSettlement === undefined
      const text = unconfirmedFinalProposal
        ? ''
        : durableSettlement
          ? durableSettlement.reply
        : message.role === 'assistant' && ownsRun && (message.stage === 'finalize' || !message.stage) && !textFromMessage.trim() && log
        ? log.reply
        : textFromMessage
      const activity = ownsActivity && log ? executionLogToHistoryActivity(log) : undefined
      if (!text.trim() && !activity) return null
      return {
        id: message.id,
        role: message.role,
        text,
        timestamp: message.timestamp,
        durationMs: activity ? log?.durationMs : undefined,
        usage: ownsRun ? aggregateRunUsage(log?.contextSnapshots, log?.usage) : undefined,
        modelRef: ownsRun && log ? log.model : undefined,
        activity,
        ...(ownsRun && log?.webEvidence ? { webEvidence: log.webEvidence } : {}),
        activityCollapsed: activity ? true : undefined,
      }
    })
    .filter((message): message is HistoryMessageRecord => message !== null)
}
