import { describe, expect, it } from 'vitest'
import { activityAttentionLine, activityVerificationLine, compactTranscriptEntries } from './activity-visibility'
import type { AssistantTurnActivity, LiveToolEvent, TranscriptEntry } from './types'

function tool(overrides: Partial<LiveToolEvent> = {}): LiveToolEvent {
  return {
    callId: 'call-1',
    name: 'exec',
    status: 'done',
    ...overrides,
  } as LiveToolEvent
}

function activity(overrides: Partial<AssistantTurnActivity> = {}): AssistantTurnActivity {
  return {
    status: 'done',
    instruction: '整理缓存验收',
    startedAt: 0,
    steps: [],
    tools: [],
    ...overrides,
  } as AssistantTurnActivity
}

describe('compact mode keeps attention facts', () => {
  it('keeps a tool row whose call did not succeed', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'reasoning', id: 'r1', text: '思考', status: 'done' },
      { kind: 'tool', id: 't1', callId: 'call-ok' },
      { kind: 'tool', id: 't2', callId: 'call-denied' },
      { kind: 'text', id: 'x1', text: '普通正文' },
    ]
    const tools = [
      tool({ callId: 'call-ok', ok: true }),
      // A permission denial reaches the renderer as ok === false plus a reason.
      tool({ callId: 'call-denied', ok: false, error: 'permission denied by policy' }),
    ]

    expect(compactTranscriptEntries(entries, tools).map((entry) => entry.id)).toEqual(['t2'])
  })

  it('keeps failed or aborted preparation and failed reasoning rows', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'preparing', id: 'p1', name: 'exec', receivedCharacters: 10, status: 'running' },
      { kind: 'preparing', id: 'p2', name: 'exec', receivedCharacters: 10, status: 'failed' },
      { kind: 'reasoning', id: 'r1', text: '思考', status: 'failed' },
      { kind: 'reasoning', id: 'r2', text: '思考', status: 'done' },
    ]

    expect(compactTranscriptEntries(entries, []).map((entry) => entry.id)).toEqual(['p2', 'r1'])
  })

  it('states the activity-level facts that no row carries', () => {
    expect(activityAttentionLine(activity({ status: 'failed' }))).toContain('本轮未完成')
    expect(activityAttentionLine(activity({ status: 'aborted' }))).toContain('本轮已停止')
    expect(activityAttentionLine(activity({ status: 'waiting_user' }))).toContain('等待你决定后继续')
    expect(activityAttentionLine(activity({ status: 'paused' }))).toContain('本轮已暂停')
    expect(activityAttentionLine(activity({ status: 'done' }))).toBeNull()
  })

  it('keeps unverified verification and failed steps visible', () => {
    const line = activityAttentionLine(activity({
      status: 'done',
      steps: [
        { stepId: 's1', title: '写入', status: 'failed', toolCount: 1, activeTools: 0 },
        { stepId: 's2', title: '读取', status: 'done', toolCount: 1, activeTools: 0 },
      ],
      verificationHistory: [
        { attempt: 1, verdict: 'unverified', reason: 'no evidence', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
        { attempt: 1, verdict: 'pass', reason: 'ok', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
      ],
    } as Partial<AssistantTurnActivity>))

    expect(line).toContain('1 个步骤失败')
    expect(line).toContain('验证：未验证')
    // A passing verification is not an attention fact.
    expect(line).not.toContain('验证通过')
  })

  it('gives the same verification fact to normal mode, which has no attention line', () => {
    const unverified = activity({
      status: 'done',
      verificationHistory: [
        { attempt: 1, verdict: 'unverified', reason: 'no evidence', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
      ],
    } as Partial<AssistantTurnActivity>)

    expect(activityVerificationLine(unverified)).toBe('验证：未验证')
    expect(activityVerificationLine(activity({
      status: 'done',
      verificationHistory: [
        { attempt: 1, verdict: 'pass', reason: 'ok', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
      ],
    } as Partial<AssistantTurnActivity>))).toBeNull()
    expect(activityVerificationLine(activity({ status: 'done' } as Partial<AssistantTurnActivity>))).toBeNull()
  })
})
