import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantTurnMessage, transcriptWithoutAnswer } from './assistant-turn'
import { AgentToolRow } from './agent-tool-row'
import { ReasoningRow, reasoningPreview } from './reasoning-row'
import type { AssistantTurnActivity, TranscriptEntry } from './types'

beforeEach(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function render(status: AssistantTurnActivity['status']) {
  return renderToStaticMarkup(createElement(AssistantTurnMessage, {
    now: 2000,
    onOpenFile: () => undefined,
    message: {
      role: 'assistant', text: '结果',
      activity: {
        status, instruction: '读取文件', startedAt: 1000, steps: [],
        transcript: [{ kind: 'tool', id: 'row', callId: 'call' }],
        tools: [{ callId: 'call', name: 'read', input: { path: 'fixture.txt' }, output: '真实内容', ok: true, endedAt: 1500 }],
      },
    },
  }))
}

describe('DSH execution presentation', () => {
  it.each(['running', 'failed', 'aborted', 'paused', 'waiting_user'] as const)('keeps %s process visible', (status) => {
    const html = render(status)
    expect(html).toMatch(/class="assistant-process-trigger"[^>]*aria-expanded="true"[^>]*disabled=""/u)
    expect(html).toContain('assistant-process-content')
    expect(html).toContain('真实内容')
  })

  it('folds a completed process without dropping its successful tool history', () => {
    const html = render('done')
    expect(html).toMatch(/class="assistant-process-trigger"[^>]*aria-expanded="false"/u)
    expect(html).toContain('真实内容')
    expect(html).toContain('data-call-id="call"')
  })

  it('removes only the last matching answer, retaining earlier model progress and tools', () => {
    const rows: TranscriptEntry[] = [
      { kind: 'text', id: 'progress', text: '结果' },
      { kind: 'tool', id: 'tool', callId: 'call' },
      { kind: 'text', id: 'answer', text: '结果\n' },
    ]
    expect(transcriptWithoutAnswer(rows, '结果')).toEqual(rows.slice(0, 2))
    expect(transcriptWithoutAnswer(rows, '不同的流式文本')).toBe(rows)
    expect(rows).toHaveLength(3)
  })

  it('keeps streaming reasoning folded with a readable preview', () => {
    const html = renderToStaticMarkup(createElement(ReasoningRow, { id: 'think', text: '**检查文件**\n读取实际结果', status: 'running' }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('agent-flow-title is-running')
    expect(html).toContain('检查文件')
  })

  it('advances a streaming reasoning preview to the latest completed paragraph', () => {
    expect(reasoningPreview('第一段\n说明\n\n**第二段**\n说明\n\n正在生成第三段', true)).toBe('第二段')
    expect(reasoningPreview('第一段\n说明\n\n第二段', false)).toBe('第一段')
  })

  it('shows an executable command as command text and keeps the actual output', () => {
    const html = renderToStaticMarkup(createElement(AgentToolRow, {
      now: 2000, tool: { callId: 'exec', name: 'exec', input: { command: 'node verify.js', timeout: 5000 }, output: 'passed 3 checks', ok: true },
    }))
    expect(html).toContain('命令')
    expect(html).toContain('<pre>node verify.js</pre>')
    expect(html).toContain('passed 3 checks')
    expect(html).not.toContain('&quot;command&quot;')
  })
})
