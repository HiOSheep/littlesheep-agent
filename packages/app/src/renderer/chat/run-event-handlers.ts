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
import type { ChatMessage, LiveStepStatus } from './types'

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
      taskBook,
      steps: mergeTaskBookIntoLiveSteps(activity.steps, taskBook),
    }))
    return
  }
  if (evt.type === 'step_start' && evt.stepId) {
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
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
    updateLastAssistantActivity(context.setMessages, (activity) => ({ ...activity, verificationRunning: true }))
    return
  }
  if (evt.type === 'verification' && evt.verification) {
    updateLastAssistantActivity(context.setMessages, (activity) => ({
      ...activity,
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
