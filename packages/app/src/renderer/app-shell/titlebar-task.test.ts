import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useTitlebarTask } from './titlebar-task'
import type { ChatMessage } from '../chat/types'

function TaskProbe({ messages }: { messages: ChatMessage[] }) {
  const task = useTitlebarTask({ sessions: [], currentSession: undefined, messages, activityNow: 5 })
  return createElement('span', { 'data-has-session': String(task.hasSession) }, task.activity?.status)
}
describe('first-request task presence', () => {
  it('shows real activity before the durable session id arrives and hides an empty draft', () => {
    const activity = { status: 'running' as const, instruction: 'test', startedAt: 1, steps: [], tools: [] }
    const live = renderToStaticMarkup(createElement(TaskProbe, { messages: [{ role: 'assistant', text: '', activity }] }))
    expect(live).toContain('data-has-session="true"')
    expect(live).toContain('running')
    expect(renderToStaticMarkup(createElement(TaskProbe, { messages: [] }))).toContain('data-has-session="false"')
  })
})
