import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveActivityLabel, TurnLiveStatus } from './turn-live-status'
import { AssistantTurnMessage } from './assistant-turn'
import type { AssistantTurnActivity } from './types'

afterEach(() => vi.unstubAllGlobals())
const activity = (extra: Partial<AssistantTurnActivity> = {}): AssistantTurnActivity => ({
  status: 'running', instruction: '检查文件', startedAt: 100, steps: [], tools: [], ...extra,
})

describe('bounded execution presentation', () => {
  it('prefers an actual running tool over older completed tools', () => {
    const label = liveActivityLabel(activity({ tools: [
      { callId: 'old', name: 'read', input: { path: 'old.txt' }, startedAt: 1, endedAt: 2, ok: true },
      { callId: 'live', name: 'read', input: { path: 'current.txt' }, startedAt: 3 },
    ] }))
    expect(label).toContain('current.txt')
    expect(label).not.toContain('old.txt')
  })
  it('keeps recorded failures and actual model progress visible when the process is folded', () => {
    vi.stubGlobal('React', React)
    const next = activity({ tools: [{ callId: 'bad', name: 'exec', ok: false, error: 'exit 1' }],
      transcript: [{ kind: 'text', id: 'progress', text: '正在检查第二个文件。' }] })
    const html = renderToStaticMarkup(createElement(TurnLiveStatus, { activity: next }))
    expect(html).toContain('1 次调用失败')
    expect(html).toContain('正在检查第二个文件。')
    expect(renderToStaticMarkup(createElement(TurnLiveStatus, { activity: next, responseText: '正在检查第二个文件。' })))
      .not.toContain('turn-live-update')
  })
  it('starts a running process folded and keeps a failed turn expanded with its own retry', () => {
    vi.stubGlobal('React', React)
    const render = (status: AssistantTurnActivity['status']) => renderToStaticMarkup(createElement(AssistantTurnMessage, {
      message: { role: 'assistant', text: '', activity: activity({ status }) }, now: 300,
      onOpenFile: () => undefined, onRetryTurn: () => undefined,
    }))
    expect(render('running')).toMatch(/assistant-process-trigger[^>]*aria-expanded="false"/u)
    expect(render('running')).toContain('turn-live-current')
    expect(render('failed')).toMatch(/assistant-process-trigger[^>]*aria-expanded="true"/u)
    expect(render('failed')).toContain('assistant-turn-retry')
    expect(renderToStaticMarkup(createElement(TurnLiveStatus, { activity: activity({ status: 'done' }) }))).toBe('')
  })
})
