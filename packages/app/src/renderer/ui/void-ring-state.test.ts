import { describe, expect, it } from 'vitest'
import { voidRingStateForActivity } from './void-ring-state'
import type { HistoryActivity } from '../../shared/history-activity'

const running: HistoryActivity = { status: 'running', instruction: 'test', startedAt: 1, steps: [], tools: [] }
describe('Void Ring activity presentation', () => {
  it('stops for failures and decisions, rather than pretending work continues', () => {
    for (const status of ['failed', 'aborted', 'paused', 'waiting_user'] as const) {
      expect(voidRingStateForActivity({ ...running, status })).toBe('static')
    }
    expect(voidRingStateForActivity(null)).toBe('idle')
    expect(voidRingStateForActivity({ ...running, status: 'done' })).toBe('idle')
  })
  it('uses live reasoning only and gives running tools precedence', () => {
    const transcript = [{ kind: 'reasoning', id: 'r', text: 'reason', status: 'running' }] as const
    expect(voidRingStateForActivity({ ...running, transcript: [...transcript] })).toBe('thinking')
    expect(voidRingStateForActivity({ ...running, transcript: [{ ...transcript[0], status: 'done' }] })).toBe('loading')
    expect(voidRingStateForActivity({ ...running, transcript: [...transcript], tools: [{callId:'t',name:'read',startedAt:2}] })).toBe('loading')
    expect(voidRingStateForActivity({ ...running, transcript: [...transcript], tools: [{callId:'t',name:'read',startedAt:2,endedAt:3}] })).toBe('thinking')
  })
})
