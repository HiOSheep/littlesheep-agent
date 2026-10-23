import { describe, expect, it } from 'vitest'
import { TOOL_STREAM_EVENT_NAME_LIST, isToolStreamEventName } from './run-stream-events.js'

describe('run stream tool events', () => {
  it('recognizes every ToolStreamEvent name and rejects unknown stream events', () => {
    expect(TOOL_STREAM_EVENT_NAME_LIST).toContain('tool_start')
    expect(TOOL_STREAM_EVENT_NAME_LIST).toContain('tool_end')
    expect(TOOL_STREAM_EVENT_NAME_LIST).toContain('model_text')
    expect(isToolStreamEventName('verification_start')).toBe(true)
    expect(isToolStreamEventName('capability_probe')).toBe(true)
    expect(isToolStreamEventName('result')).toBe(false)
    expect(isToolStreamEventName('approval_request')).toBe(false)
    expect(isToolStreamEventName('toString')).toBe(false)
  })
})
