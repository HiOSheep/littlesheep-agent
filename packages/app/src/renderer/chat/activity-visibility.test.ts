import { describe, expect, it } from 'vitest'
import {
  activityAttentionLine,
  activityVerificationLine,
  classifyCallFailures,
  compactTranscriptEntries,
} from './activity-visibility'
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
  })

  it('has nothing to attend to for a clean finished turn', () => {
    // The one case where the line must stay silent: a normal state gets exactly one primary
    // display location, so an empty attention row must not be invented for it.
    expect(activityAttentionLine(activity({ status: 'done' }))).toBeNull()
    expect(activityAttentionLine(activity({
      status: 'done',
      tools: [tool({ callId: 'call-ok', ok: true, stepId: 'step-1' })],
      steps: [{ stepId: 'step-1', title: '读取', status: 'done', toolCount: 1, activeTools: 0 }],
    }))).toBeNull()
  })

  it('keeps unverified verification and unfinished steps visible', () => {
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

    expect(line).toContain('1 个步骤未完成')
    expect(line).toContain('验证：未验证')
    // A passing verification is not an attention fact.
    expect(line).not.toContain('验证通过')
  })

  it('treats a step whose outcome nobody knows as unfinished, not as done', () => {
    // A settled run marks a step `unknown` when its call never reported a result
    // (`run-result-reducer.ts`). Folding that away would present a missing outcome as finished.
    const line = activityAttentionLine(activity({
      status: 'failed',
      steps: [{ stepId: 's1', title: '写入', status: 'unknown', toolCount: 1, activeTools: 0 }],
    }))

    expect(line).toContain('1 个步骤未完成')
    expect(line).toContain('本轮未完成')
  })
})

describe('recorded call failures keep their resolution state', () => {
  it('marks a failure unresolved when nothing in its step recovered it', () => {
    const failures = classifyCallFailures([
      tool({ callId: 'call-a', stepId: 'step-1', ok: false, error: 'exec exited 3' }),
      tool({ callId: 'call-b', stepId: 'step-1', ok: false, error: 'validation failed' }),
    ])

    expect(failures.map((failure) => failure.tool.callId)).toEqual(['call-a', 'call-b'])
    expect(failures.every((failure) => !failure.recovered)).toBe(true)
  })

  it('marks a failure recovered when a later call in the same step succeeded', () => {
    // Runtime's own rule: a non-succeeded invocation is superseded when a later invocation in
    // the same step succeeded (`runtimeExecutionEvidenceGap`).
    const failures = classifyCallFailures([
      tool({ callId: 'call-a', stepId: 'step-1', ok: false, error: 'exec exited 3' }),
      tool({ callId: 'call-b', stepId: 'step-1', ok: true }),
    ])

    expect(failures).toHaveLength(1)
    expect(failures[0]?.recovered).toBe(true)
  })

  it('never marks a failure recovered from a success in another step', () => {
    const failures = classifyCallFailures([
      tool({ callId: 'call-a', stepId: 'step-1', ok: false }),
      tool({ callId: 'call-b', stepId: 'step-2', ok: true }),
    ])

    expect(failures.map((failure) => failure.recovered)).toEqual([false])
  })

  it('never marks a standalone failure recovered, because there is no step to supersede in', () => {
    const failures = classifyCallFailures([
      tool({ callId: 'call-a', ok: false }),
      tool({ callId: 'call-b', ok: true }),
    ])

    expect(failures.map((failure) => failure.recovered)).toEqual([false])
  })

  it('separates an unresolved failure from a recovered one on the line', () => {
    const unresolved = activityAttentionLine(activity({
      status: 'done',
      tools: [
        tool({ callId: 'call-a', stepId: 'step-1', ok: false, error: 'exec exited 3' }),
        tool({ callId: 'call-b', stepId: 'step-2', ok: true }),
      ],
      verificationHistory: [
        { attempt: 1, verdict: 'unverified', reason: 'recorded failure', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
      ],
    }))
    const recovered = activityAttentionLine(activity({
      status: 'done',
      tools: [
        tool({ callId: 'call-a', stepId: 'step-1', ok: false, error: 'exec exited 3' }),
        tool({ callId: 'call-b', stepId: 'step-1', ok: true }),
      ],
      verificationHistory: [
        { attempt: 1, verdict: 'unverified', reason: 'recorded failure', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
      ],
    }))

    expect(unresolved).toContain('1 次调用失败')
    expect(unresolved).not.toContain('恢复')
    // A recovered failure stays readable as history, and the run is not left reading as broken.
    expect(recovered).toContain('1 次失败已由后续调用恢复')
    expect(recovered).toContain('本轮无未解决失败')
    expect(recovered).not.toContain('1 次调用失败')
    // Neither reading may drop the verdict.
    expect(recovered).toContain('验证：未验证')
  })
})

describe('the verification line', () => {
  it('gives the same verification fact to both display modes', () => {
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

  it('never renders a verdict that did not pass as a pass', () => {
    for (const verdict of ['unverified', 'needs_replan', 'fail'] as const) {
      const line = activityVerificationLine(activity({
        status: 'done',
        verificationHistory: [
          { attempt: 1, verdict, reason: 'reason', verifiedAt: '2026-09-23T00:00:00.000Z', source: 'structural' },
        ],
      } as Partial<AssistantTurnActivity>))

      expect(line).not.toBeNull()
      expect(line).not.toContain('验证通过')
    }
  })
})
