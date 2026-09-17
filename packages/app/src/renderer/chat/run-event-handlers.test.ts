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
  it('HA-04-01 applies append/replace once and ignores duplicate sequence numbers', () => {
    const { context, activity } = harness()
    const ref = (sequence: number, operation: 'append' | 'replace' | 'reset') => ({
      version: 1 as const,
      runId: 'run-1',
      requestId: 'request-1',
      transportAttempt: 1,
      sequence,
      operation,
    })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: '先看', streamRef: ref(1, 'append') })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: '目录', streamRef: ref(2, 'append') })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: '重复', streamRef: ref(2, 'append') })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'done', summary: '先看目录', streamRef: ref(3, 'replace') })

    expect(activity().transcript).toEqual([expect.objectContaining({ kind: 'reasoning', text: '先看目录', status: 'done' })])
  })

  it('marks a stream incomplete when an event sequence has a gap', () => {
    const { context, activity } = harness()
    const streamRef = (sequence: number) => ({
      version: 1 as const,
      runId: 'run-gap',
      requestId: 'request-gap',
      transportAttempt: 1,
      sequence,
      operation: 'append' as const,
    })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: 'a', streamRef: streamRef(1) })
    dispatch(context, { type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: 'c', streamRef: streamRef(3) })

    expect(Object.values(activity().transcriptIncompleteStreams ?? {})).toContain(true)
  })

  it('HA-04-02 replaces tool preparation snapshots and keeps them out of tool counts', () => {
    const { context, activity } = harness()
    for (const [sequence, receivedCharacters] of [[1, 10], [2, 20], [3, 30]] as const) {
      dispatch(context, {
        type: 'tool_preparing', phaseId: 'turn:tool:0', name: 'exec',
        receivedCharacters, generationStatus: sequence === 3 ? 'done' : 'running',
        streamRef: { version: 1, runId: 'run', requestId: 'req', transportAttempt: 1, sequence, operation: 'replace' },
      })
    }
    expect(activity().transcript).toEqual([expect.objectContaining({
      kind: 'preparing', name: 'exec', receivedCharacters: 30, status: 'done',
    })])
    expect(activity().tools).toHaveLength(0)
  })

  it('HA-04-04 retires an old attempt so late frames cannot revive it', () => {
    const { context, activity } = harness()
    dispatch(context, {
      type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: 'old',
      streamRef: { version: 1, runId: 'run', requestId: 'req', transportAttempt: 1, sequence: 1, operation: 'append' },
    })
    dispatch(context, {
      type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: '',
      streamRef: { version: 1, runId: 'run', requestId: 'req', transportAttempt: 2, sequence: 1, operation: 'reset' },
    })
    dispatch(context, {
      type: 'model_reasoning', phaseId: 'turn', reasoningStatus: 'running', summary: 'late',
      streamRef: { version: 1, runId: 'run', requestId: 'req', transportAttempt: 1, sequence: 2, operation: 'append' },
    })
    expect(activity().transcript ?? []).toEqual([])
  })

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
    dispatch(context, { type: 'reasoning', phaseId: 'execute', stage: 'execute', reasoningStatus: 'running', summary: '正在按 stage 执行', visibility: 'progress' })
    dispatch(context, { type: 'step_start', stepId: 'step-1', title: 'One', visibility: 'progress' })
    expect(activity().transcript ?? []).toEqual([])
    expect(activity().reasoning ?? []).toEqual([])
  })

  it('HA-04-10 projects observable model work without a Harness stage', () => {
    const { context, activity } = harness()
    dispatch(context, {
      type: 'model_activity', phaseId: 'model-request:req-1', requestId: 'req-1',
      activityKind: 'model_request', activityStatus: 'running', summary: '模型正在生成回复',
    })
    expect(activity().reasoning).toEqual([expect.objectContaining({
      phaseId: 'model-request:req-1', source: 'model', activityKind: 'model_request',
      status: 'running', summary: '模型正在生成回复',
    })])
    expect(activity().reasoning?.[0]?.stage).toBeUndefined()
  })
})
