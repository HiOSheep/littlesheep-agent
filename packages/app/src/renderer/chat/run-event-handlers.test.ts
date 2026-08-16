import { describe, expect, it } from 'vitest'
import { handleRunToolEvent } from './run-event-handlers'
import type { ChatMessage } from './types'

describe('run reasoning event handling', () => {
  it('updates one stable phase row from running to done', () => {
    let messages: ChatMessage[] = [{
      role: 'assistant',
      text: '',
      activity: {
        status: 'running',
        instruction: '检查项目',
        startedAt: 100,
        reasoning: [],
        steps: [],
        tools: [],
      },
    }]
    const context = {
      appMountedRef: { current: true },
      liveToolStepRef: { current: new Map<string, string>() },
      setMessages: (update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
        messages = typeof update === 'function' ? update(messages) : update
      },
    }

    handleRunToolEvent({
      type: 'reasoning',
      phaseId: 'decide:2',
      stage: 'decide',
      reasoningStatus: 'running',
      summary: '正在校准目标、范围和验收标准',
    }, context)
    handleRunToolEvent({
      type: 'reasoning',
      phaseId: 'decide:2',
      stage: 'decide',
      reasoningStatus: 'done',
      summary: '已形成执行路径和验收标准',
      durationMs: 24,
    }, context)

    expect(messages[0]?.activity?.reasoning).toEqual([
      expect.objectContaining({
        phaseId: 'decide:2',
        stage: 'decide',
        status: 'done',
        summary: '已形成执行路径和验收标准',
        durationMs: 24,
      }),
    ])
  })
})
