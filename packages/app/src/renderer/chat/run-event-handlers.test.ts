import { describe, expect, it } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import type { ToolStreamEvent } from '@littlesheep/types'
import { handleRunToolEvent } from './run-event-handlers'
import type { ChatMessage } from './types'

function harness() {
  let messages: ChatMessage[] = [{
    role: 'assistant',
    text: '',
    activity: { status: 'running', instruction: '任务', startedAt: 0, steps: [], tools: [] },
  }]
  const setMessages: Dispatch<SetStateAction<ChatMessage[]>> = (action) => {
    messages = typeof action === 'function' ? action(messages) : action
  }
  return {
    context: {
      appMountedRef: { current: true },
      liveToolStepRef: { current: new Map<string, string>() },
      setMessages,
    },
    activity: () => messages[messages.length - 1]!.activity!,
  }
}

function dispatch(context: ReturnType<typeof harness>['context'], event: Partial<ToolStreamEvent>): void {
  handleRunToolEvent(event as ToolStreamEvent, context)
}

describe('next-Harness transcript reduction', () => {
  it('projects the durable system prompt as the first transcript row', () => {
    const { context, activity } = harness()
    dispatch(context, { type: 'system_prompt', phaseId: 'system-prompt', summary: 'SYSTEM-PROMPT-BODY', visibility: 'progress' })
    dispatch(context, { type: 'model_reasoning', phaseId: 'reply:run', reasoningStatus: 'done', summary: '想好了。', visibility: 'progress' })
    const transcript = activity().transcript ?? []
    expect(transcript.map((entry) => entry.kind)).toEqual(['system', 'reasoning'])
    expect(transcript[0]).toMatchObject({ kind: 'system', text: 'SYSTEM-PROMPT-BODY' })
  })

  it('keeps thinking, prose, and tools in production order', () => {
    const { context, activity } = harness()

    dispatch(context, { type: 'model_reasoning', phaseId: 'step-1:turn-1', reasoningStatus: 'running', summary: '先看', visibility: 'progress' })
    dispatch(context, { type: 'model_reasoning', phaseId: 'step-1:turn-1', reasoningStatus: 'running', summary: '目录。', visibility: 'progress' })
    dispatch(context, { type: 'model_reasoning', phaseId: 'step-1:turn-1', reasoningStatus: 'done', summary: '先看目录。', visibility: 'progress' })
    dispatch(context, { type: 'model_text', phaseId: 'step-1:turn-1', summary: '我先列出目录。', visibility: 'progress' })
    dispatch(context, { type: 'tool_start', callId: 'call-1', name: 'glob', visibility: 'progress' })
    dispatch(context, { type: 'tool_end', callId: 'call-1', name: 'glob', ok: true, output: 'attachments/', visibility: 'progress' })
    dispatch(context, { type: 'model_reasoning', phaseId: 'step-1:turn-2', reasoningStatus: 'done', summary: '看到目录了。', visibility: 'progress' })

    const transcript = activity().transcript ?? []
    expect(transcript.map((entry) => entry.kind)).toEqual(['reasoning', 'text', 'tool', 'reasoning'])
    expect(transcript[0]).toMatchObject({ kind: 'reasoning', status: 'done', text: '先看目录。' })
    expect(transcript[2]).toMatchObject({ kind: 'tool', callId: 'call-1' })
    // The ordered transcript is additive: the flat tool list still feeds the
    // existing status, artifact, and completion reconciliation paths.
    expect(activity().tools).toHaveLength(1)
    expect(activity().tools[0]).toMatchObject({ callId: 'call-1', ok: true, output: 'attachments/' })
  })

  it('leaves the transcript absent when only legacy stage events arrive', () => {
    const { context, activity } = harness()
    dispatch(context, { type: 'reasoning', phaseId: 'execute', stage: 'execute', reasoningStatus: 'done', summary: '已完成计划内执行', visibility: 'silent' })
    dispatch(context, { type: 'step_start', stepId: 'step-1', title: 'One', visibility: 'progress' })
    expect(activity().transcript ?? []).toEqual([])
  })
})