import type { ExecutionLog, ToolCallRecord } from '@littlesheep/runner'
import type { Message, TaskBook, VerificationRecord } from '@littlesheep/types'

export type HistoryActivityStatus = 'running' | 'done' | 'failed' | 'aborted'
export type HistoryStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface HistoryActivity {
  status: HistoryActivityStatus
  instruction: string
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
}

export interface HistoryMessageRecord {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  durationMs?: number
  activityCollapsed?: boolean
  activity?: HistoryActivity
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

function historyStepStatus(status: string): HistoryStepStatus {
  if (status === 'done' || status === 'failed' || status === 'skipped') return status
  if (status === 'blocked') return 'failed'
  if (status === 'pending') return 'pending'
  return 'running'
}

function historySteps(log: ExecutionLog): HistoryActivity['steps'] {
  const results = new Map((log.taskExecution?.steps ?? []).map((step) => [step.stepId, step]))
  const planned = log.taskBook?.steps ?? []
  if (planned.length === 0) {
    return (log.taskExecution?.steps ?? []).map((step) => ({
      stepId: step.stepId,
      title: step.title || step.description || '执行步骤',
      description: step.description,
      status: historyStepStatus(step.status),
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
      status: historyStepStatus(result?.status ?? step.status ?? 'pending'),
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

export function hasExecutionActivity(log: ExecutionLog): boolean {
  return Boolean(log.taskBook?.steps?.length || log.taskExecution?.steps?.length || log.toolCalls.length || log.verificationHistory?.length)
}

export function executionLogToHistoryActivity(log: ExecutionLog): HistoryActivity {
  const startedAt = finiteTimestamp(log.startedAt) ?? 0
  const endedAt = finiteTimestamp(log.endedAt)
  return {
    status: log.status === 'ok' ? 'done' : log.status === 'aborted' ? 'aborted' : 'failed',
    instruction: log.inboundText,
    startedAt,
    endedAt,
    durationMs: log.durationMs,
    taskBook: log.taskBook,
    verificationHistory: log.verificationHistory,
    steps: historySteps(log),
    tools: log.toolCalls.map((tool, index) => historyTool(tool, log, index)),
  }
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
  const owners = activityOwnerIndexes(messages)
  return messages
    .map((message, index): HistoryMessageRecord | null => {
      if (!isConversationalMessage(message)) return null
      const runId = String(message.runId ?? '')
      const log = runId ? logsByRunId.get(runId) : undefined
      const ownsRun = message.role === 'assistant' && owners.get(runId) === index
      const ownsActivity = ownsRun && !!log && hasExecutionActivity(log)
      const textFromMessage = messageText(message)
      const text = message.role === 'assistant' && ownsRun && !textFromMessage.trim() && log
        ? (log.reply || (log.error ? `Error: ${log.error}` : ''))
        : textFromMessage
      const activity = ownsActivity && log ? executionLogToHistoryActivity(log) : undefined
      if (!text.trim() && !activity) return null
      return {
        role: message.role,
        text,
        timestamp: message.timestamp,
        durationMs: activity ? log?.durationMs : undefined,
        activity,
        activityCollapsed: activity ? true : undefined,
      }
    })
    .filter((message): message is HistoryMessageRecord => message !== null)
}
