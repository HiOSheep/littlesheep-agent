// Conversation rendering and execution-progress presentation.
import type { TaskBook,VerificationRecord } from '@littlesheep/types'
import { lastPathSegment } from '../workspace/path-utils'
import { WorkspaceArtifactRef } from '../workspace/types'
import { AssistantTurnActivity,ChatMessage,LiveStepEvent,LiveStepStatus,LiveToolEvent } from './types'


export function upsertLiveStep(
  steps: LiveStepEvent[],
  next: Partial<LiveStepEvent> & { stepId: string },
): LiveStepEvent[] {
  const existing = steps.find((step) => step.stepId === next.stepId)
  const merged: LiveStepEvent = {
    stepId: next.stepId,
    title: (next.title || existing?.title || '执行步骤').trim(),
    description: next.description ?? existing?.description,
    status: next.status ?? existing?.status ?? 'running',
    startedAt: next.startedAt ?? existing?.startedAt,
    endedAt: next.endedAt ?? existing?.endedAt,
    output: next.output ?? existing?.output,
    error: next.error ?? existing?.error,
    toolCount: next.toolCount ?? existing?.toolCount ?? 0,
    activeTools: Math.max(0, next.activeTools ?? existing?.activeTools ?? 0),
  }

  if (!existing) return [...steps, merged]
  return steps.map((step) => (step.stepId === next.stepId ? merged : step))
}


export function mergeTaskBookIntoLiveSteps(steps: LiveStepEvent[], taskBook: TaskBook): LiveStepEvent[] {
  const existing = new Map(steps.map((step) => [step.stepId, step]))
  return taskBook.steps.map((step, index) => {
    const stepId = step.id ?? `step-${index + 1}`
    const current = existing.get(stepId)
    return {
      stepId,
      title: step.title || current?.title || step.description || '执行步骤',
      description: step.description || current?.description,
      status: current?.status ?? coerceLiveStepStatus(step.status ?? 'pending'),
      startedAt: current?.startedAt,
      endedAt: current?.endedAt,
      output: current?.output,
      error: current?.error,
      toolCount: current?.toolCount ?? 0,
      activeTools: current?.activeTools ?? 0,
    }
  })
}


export function bumpLiveStepTools(steps: LiveStepEvent[], stepId: string, delta: 1 | -1): LiveStepEvent[] {
  if (!stepId) return steps
  const hasStep = steps.some((step) => step.stepId === stepId)
  if (!hasStep && delta > 0) {
    return [
      ...steps,
      {
        stepId,
        title: '执行步骤',
        status: 'running',
        startedAt: Date.now(),
        toolCount: 1,
        activeTools: 1,
      },
    ]
  }

  return steps.map((step) => {
    if (step.stepId !== stepId) return step
    if (delta > 0) {
      return {
        ...step,
        toolCount: step.toolCount + 1,
        activeTools: step.activeTools + 1,
      }
    }
    return {
      ...step,
      activeTools: Math.max(0, step.activeTools - 1),
    }
  })
}


export function upsertLiveTool(
  tools: LiveToolEvent[],
  next: Partial<LiveToolEvent> & { callId: string; name: string },
): LiveToolEvent[] {
  const existing = tools.find((tool) => tool.callId === next.callId)
  const merged: LiveToolEvent = {
    callId: next.callId,
    name: next.name || existing?.name || 'tool',
    stepId: next.stepId ?? existing?.stepId,
    startedAt: next.startedAt ?? existing?.startedAt,
    endedAt: next.endedAt ?? existing?.endedAt,
    input: next.input ?? existing?.input,
    ok: Object.prototype.hasOwnProperty.call(next, 'ok') ? next.ok : existing?.ok,
    output: next.output ?? existing?.output,
    error: next.error ?? existing?.error,
  }

  if (!existing) return [...tools, merged]
  return tools.map((tool) => (tool.callId === next.callId ? merged : tool))
}


export function updateLastAssistantActivity(
  setMessages: (updater: (messages: ChatMessage[]) => ChatMessage[]) => void,
  update: (activity: AssistantTurnActivity) => AssistantTurnActivity,
): void {
  setMessages((messages) => {
    const next = [...messages]
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index]
      if (message?.role !== 'assistant' || !message.activity) continue
      next[index] = { ...message, activity: update(message.activity) }
      break
    }
    return next
  })
}


export function assistantTurnStatusLabel(activity: AssistantTurnActivity, now: number): string {
  const duration = formatDurationMs(activity.durationMs ?? ((activity.endedAt ?? now) - activity.startedAt))
  if (activity.status === 'running') return `处理中 ${duration}`
  if (activity.status === 'failed') return `处理失败 ${duration}`
  if (activity.status === 'aborted') return `已停止 ${duration}`
  return `已处理 ${duration}`
}


export function formatMaybeDuration(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (!startedAt) return ''
  return formatDurationMs((endedAt ?? now) - startedAt)
}


export function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms))
  if (safeMs < 60_000) {
    const seconds = safeMs / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(1).replace(/\.0$/, '')}s`
  }
  const totalSeconds = Math.max(1, Math.floor(safeMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}


export function taskStepToLiveStep(step: {
  stepId: string
  title?: string
  description: string
  status: string
  startedAt?: string
  endedAt?: string
  output?: string
  error?: string
  toolCallIds?: string[]
}): LiveStepEvent {
  return {
    stepId: step.stepId,
    title: step.title || step.description || '执行步骤',
    description: step.description,
    status: coerceLiveStepStatus(step.status),
    startedAt: step.startedAt ? Date.parse(step.startedAt) : undefined,
    endedAt: step.endedAt ? Date.parse(step.endedAt) : undefined,
    output: step.output,
    error: step.error,
    toolCount: step.toolCallIds?.length ?? 0,
    activeTools: 0,
  }
}


export function coerceLiveStepStatus(status: string): LiveStepStatus {
  if (status === 'pending') return 'pending'
  if (status === 'done' || status === 'failed' || status === 'skipped') return status
  if (status === 'blocked') return 'failed'
  return 'running'
}


export function liveStepStatusLabel(status: LiveStepStatus): string {
  if (status === 'pending') return '待执行'
  if (status === 'done') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'skipped') return '跳过'
  return '执行中'
}


export function verificationVerdictLabel(verdict: VerificationRecord['verdict']): string {
  if (verdict === 'pass') return '验证通过'
  if (verdict === 'needs_replan') return '需要调整'
  return '验证失败'
}


export function verificationSummary(records: VerificationRecord[] | undefined): string {
  const last = records?.at(-1)
  if (!last) return '等待验证'
  return verificationVerdictLabel(last.verdict)
}


export function buildTraceData(result: {
  trace?: { name: string; ok: boolean }[]
  durationMs?: number
  messages?: { role: string; content: unknown[] }[]
}) {
  const msgs = result.messages ?? []
  const toolCalls: { name: string; input: unknown; output?: unknown; error?: string; ok: boolean }[] = []
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    const tcBlock = (m.content as Array<
      { type?: string; calls?: Array<{ id: string; name: string; input: unknown }> }
    >).find((c) => c.type === 'tool_calls')
    if (!tcBlock?.calls) continue
    for (const tc of tcBlock.calls) {
      const trBlock = msgs
        .filter((rm) => rm.role === 'tool')
        .flatMap((rm) => rm.content as Array<
          { type?: string; result?: { callId: string; ok: boolean; output?: unknown; error?: string } }
        >)
        .find((c) => c.type === 'tool_result' && c.result?.callId === tc.id)
      toolCalls.push({
        name: tc.name,
        input: tc.input,
        output: trBlock?.result?.output,
        error: trBlock?.result?.error,
        ok: trBlock?.result?.ok ?? true,
      })
    }
  }
  return { trace: result.trace, durationMs: result.durationMs, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}


export function buildArtifactsFromToolCalls(
  toolCalls?: { name: string; input: unknown; ok: boolean }[],
): WorkspaceArtifactRef[] | undefined {
  if (!toolCalls?.length) return undefined
  const byPath = new Map<string, WorkspaceArtifactRef>()
  for (const tool of toolCalls) {
    if (!tool.ok) continue
    const path = toolFilePath(tool.input)
    if (!path) continue
    const action = tool.name === 'write' || tool.name === 'write_file' ? 'created' : tool.name === 'edit' || tool.name === 'edit_file' ? 'modified' : null
    if (!action) continue
    byPath.set(path, {
      path,
      name: lastPathSegment(path),
      action,
      toolName: tool.name,
    })
  }
  return byPath.size > 0 ? Array.from(byPath.values()) : undefined
}


export function buildArtifactsFromLiveTools(tools?: LiveToolEvent[]): WorkspaceArtifactRef[] | undefined {
  if (!tools?.length) return undefined
  return buildArtifactsFromToolCalls(tools
    .filter((tool) => tool.ok === true)
    .map((tool) => ({
      name: tool.name,
      input: tool.input,
      ok: true,
    })))
}


export function toolFilePath(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const value = record.file_path ?? record.path ?? record.filePath
  return typeof value === 'string' ? value.trim() : ''
}
