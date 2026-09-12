// 将流式运行事件归并为对话区可持久化形状的实时活动。
// 这里只负责 Renderer 状态归并，传输和 run 生命周期仍由 run-actions.ts 负责。
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { ToolStreamEvent } from '@littlesheep/types'
import {
  bumpLiveStepTools,
  mergeTaskBookIntoLiveSteps,
  updateLastAssistantActivity,
  upsertLiveReasoning,
  upsertLiveStep,
  upsertLiveTool,
} from './activity-model'
import type { ChatMessage, LiveStepStatus, TranscriptEntry } from './types'

export interface RunEventHandlerContext {
  appMountedRef: MutableRefObject<boolean>
  liveToolStepRef: MutableRefObject<Map<string, string>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
}

export function handleRunToolEvent(
  evt: ToolStreamEvent,
  context: RunEventHandlerContext,
): void {
  if (!context.appMountedRef.current) return

  // Capability facts/probes are Runtime projections, never conversation text.
  if (evt.type === 'capability_snapshot' || evt.type === 'capability_probe') return

  if (evt.type === 'system_prompt' && evt.summary) {
    const entry: TranscriptEntry = {
      kind: 'system',
      id: 'system-prompt',
      text: evt.summary,
    }
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, 'progress'),
      transcript: upsertTranscriptEntry(activity.transcript ?? [], entry),
    }))
    return
  }

  if (evt.type === 'model_reasoning' && evt.phaseId) {
    const phaseId = evt.phaseId
    const delta = evt.summary ?? ''
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, 'progress'),
      transcript: upsertTranscriptReasoning(activity.transcript ?? [], phaseId, delta, evt.reasoningStatus, evt.reasoningStatus === 'done' ? evt.summary : undefined),
    }))
    return
  }
  if (evt.type === 'model_text' && evt.phaseId && evt.summary) {
    const entry: TranscriptEntry = {
      kind: 'text',
      id: `${evt.phaseId}:text`,
      text: evt.summary,
    }
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, 'progress'),
      transcript: upsertTranscriptEntry(activity.transcript ?? [], entry),
    }))
    return
  }

  if (
    evt.type === 'reasoning'
    && evt.phaseId
    && evt.stage
    && evt.summary
    && evt.reasoningStatus
  ) {
    const eventTime = Date.now()
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      reasoning: upsertLiveReasoning(activity.reasoning ?? [], {
        phaseId: evt.phaseId!,
        stage: evt.stage!,
        summary: evt.summary!,
        status: evt.reasoningStatus!,
        startedAt: evt.reasoningStatus === 'running' ? eventTime : undefined,
        endedAt: evt.reasoningStatus === 'running' ? undefined : eventTime,
        durationMs: evt.durationMs,
      }),
    }))
    return
  }

  if (evt.type === 'task_book' && evt.taskBook) {
    const taskBook = evt.taskBook
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      taskBook,
      steps: mergeTaskBookIntoLiveSteps(activity.steps, taskBook),
    }))
    return
  }
  if (evt.type === 'step_start' && evt.stepId) {
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      steps: upsertLiveStep(activity.steps, {
        stepId: evt.stepId ?? '',
        title: evt.title || evt.description || '执行步骤',
        description: evt.description,
        status: 'running',
        startedAt: Date.now(),
      }),
    }))
    return
  }
  if (evt.type === 'verification_start') {
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      verificationRunning: true,
    }))
    return
  }
  if (evt.type === 'verification' && evt.verification) {
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      verificationRunning: false,
      verificationHistory: [...(activity.verificationHistory ?? []), evt.verification!],
    }))
    return
  }
  if (evt.type === 'step_done' || evt.type === 'step_failed' || evt.type === 'step_skipped') {
    if (!evt.stepId) return
    const status: LiveStepStatus = evt.type === 'step_done'
      ? 'done'
      : evt.type === 'step_failed' ? 'failed' : 'skipped'
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      steps: upsertLiveStep(activity.steps, {
        stepId: evt.stepId ?? '',
        title: evt.title || evt.description || '执行步骤',
        description: evt.description,
        status,
        output: evt.output,
        error: evt.error,
        activeTools: 0,
        endedAt: Date.now(),
      }),
    }))
    return
  }
  if (evt.type === 'tool_start' && evt.callId && evt.name) {
    if (evt.stepId) context.liveToolStepRef.current.set(evt.callId, evt.stepId)
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      transcript: appendTranscriptTool(activity.transcript ?? [], evt.callId!),
      tools: upsertLiveTool(activity.tools, {
        callId: evt.callId ?? '',
        name: evt.name ?? '',
        stepId: evt.stepId,
        startedAt: Date.now(),
        input: evt.input,
        ok: undefined,
        error: undefined,
      }),
      steps: evt.stepId ? bumpLiveStepTools(activity.steps, evt.stepId, 1) : activity.steps,
    }))
    return
  }
  if (evt.type === 'tool_end' && evt.callId) {
    const stepId = evt.stepId ?? context.liveToolStepRef.current.get(evt.callId)
    context.liveToolStepRef.current.delete(evt.callId)
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
      ...mergeVisibility(activity.visibility, evt.visibility),
      tools: upsertLiveTool(activity.tools, {
        callId: evt.callId ?? '',
        name: evt.name ?? '',
        stepId,
        ok: evt.ok,
        output: evt.output,
        error: evt.error,
        endedAt: Date.now(),
      }),
      steps: stepId ? bumpLiveStepTools(activity.steps, stepId, -1) : activity.steps,
    }))
  }
}

function mergeVisibility(
  current: 'silent' | 'progress' | undefined,
  next: 'silent' | 'progress' | undefined,
): { visibility?: 'silent' | 'progress' } {
  if (current === 'progress' || next === 'progress') return { visibility: 'progress' }
  if (next) return { visibility: next }
  return {}
}

/** Cap the transcript so a long run cannot grow renderer state without bound. */
const MAX_TRANSCRIPT_ENTRIES = 400
const MAX_TRANSCRIPT_TEXT = 8_000

function upsertTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  const next = index >= 0
    ? entries.map((candidate, position) => (position === index ? entry : candidate))
    : [...entries, entry]
  return next.length > MAX_TRANSCRIPT_ENTRIES ? next.slice(-MAX_TRANSCRIPT_ENTRIES) : next
}

/** Thinking arrives as deltas; each phase owns exactly one accumulating row. */
function upsertTranscriptReasoning(
  entries: TranscriptEntry[],
  phaseId: string,
  delta: string,
  status: 'running' | 'done' | 'failed' | undefined,
  finalText?: string,
): TranscriptEntry[] {
  const id = `${phaseId}:reasoning`
  const existing = entries.find((entry) => entry.id === id)
  const previous = existing?.kind === 'reasoning' ? existing.text : ''
  const text = (finalText ?? previous + delta).slice(0, MAX_TRANSCRIPT_TEXT)
  return upsertTranscriptEntry(entries, {
    kind: 'reasoning',
    id,
    text,
    status: status === 'running' ? 'running' : 'done',
  })
}

function appendTranscriptTool(entries: TranscriptEntry[], callId: string): TranscriptEntry[] {
  const id = `tool:${callId}`
  if (entries.some((entry) => entry.id === id)) return entries
  return upsertTranscriptEntry(entries, { kind: 'tool', id, callId })
}
