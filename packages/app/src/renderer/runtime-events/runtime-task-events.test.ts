import { describe, expect, it } from 'vitest'
import type { RuntimeEventIngressOutcome } from '@littlesheep/types'
import type { RuntimePatch, RuntimeState } from '../../shared/runtime-api-contracts'
import {
  describeRuntimeSettingBatch,
  describeRuntimeTaskEventOutcome,
  runtimeSettingEventEntries,
  runtimeTaskEventNeedsNewIdentity,
  runtimeTaskEventWasQueued,
} from './runtime-task-events'


describe('renderer runtime task event helpers', () => {
  it('only clears user input after an accepted or duplicate event', () => {
    expect(runtimeTaskEventWasQueued(outcome('accepted'))).toBe(true)
    expect(runtimeTaskEventWasQueued(outcome('duplicate'))).toBe(true)
    expect(runtimeTaskEventWasQueued(outcome('expired'))).toBe(false)
    expect(runtimeTaskEventWasQueued(rejected('capacity'))).toBe(false)
  })

  it('rotates identities after terminal or conflicting outcomes but retains retry identity on capacity', () => {
    expect(runtimeTaskEventNeedsNewIdentity(outcome('accepted'))).toBe(true)
    expect(runtimeTaskEventNeedsNewIdentity(outcome('duplicate'))).toBe(true)
    expect(runtimeTaskEventNeedsNewIdentity(outcome('expired'))).toBe(true)
    expect(runtimeTaskEventNeedsNewIdentity(rejected('conflict'))).toBe(true)
    expect(runtimeTaskEventNeedsNewIdentity(rejected('capacity'))).toBe(false)
  })

  it('maps ingress outcomes to concise explainable notices', () => {
    expect(describeRuntimeTaskEventOutcome('message', outcome('accepted'), 10)).toMatchObject({
      tone: 'success',
      text: '已加入当前任务，将在安全边界处理',
      createdAt: 10,
    })
    expect(describeRuntimeTaskEventOutcome('message', rejected('conflict'), 11)).toMatchObject({
      tone: 'warning',
      text: '这条补充与已有更新冲突，未加入当前任务',
    })
    expect(describeRuntimeTaskEventOutcome('file', rejected('run-not-active'), 12).text)
      .toContain('当前任务已经结束')
  })

  it('emits only confirmed runtime patch values in stable key order', () => {
    const patch: RuntimePatch = {
      reasoning: 'high',
      model: 'deepseek/deepseek-chat',
      closePolicy: 'always-background',
    }
    const state = runtimeState()
    expect(runtimeSettingEventEntries(patch, state)).toEqual([
      { key: 'model', value: state.model },
      { key: 'reasoning', value: state.reasoning },
    ])
  })

  it('summarizes partial setting delivery without claiming every change was queued', () => {
    expect(describeRuntimeSettingBatch([
      outcome('accepted'),
      rejected('capacity'),
    ], [], 20)).toMatchObject({
      tone: 'warning',
      text: '设置已保存，1/2 项变化已加入当前任务',
    })
  })
})


function outcome(kind: 'accepted' | 'duplicate' | 'expired'): RuntimeEventIngressOutcome {
  return {
    kind,
    event: {
      version: 1,
      id: `event-${kind}`,
      runId: 'run-1',
      sessionId: 'session-1' as never,
      sequence: 1,
      type: 'user_message',
      source: 'app',
      status: kind === 'expired' ? 'expired' : 'queued',
      receivedAt: '2026-07-29T00:00:00.000Z',
      payload: { text: 'update' },
    },
  }
}


function rejected(reason: Extract<RuntimeEventIngressOutcome, { kind: 'rejected' }>['reason']): RuntimeEventIngressOutcome {
  return { kind: 'rejected', reason, message: `rejected: ${reason}` }
}


function runtimeState(): RuntimeState {
  return {
    model: 'deepseek/deepseek-chat',
    reasoning: 'high',
    profile: 'general',
    contextCompressionThresholdRatio: 0.8,
    durableHarnessMode: 'shadow',
    durableHarnessSessionOverrides: {},
    closePolicy: 'background-while-active',
    workspace: 'D:/workspace',
    workplace: 'D:/data/workplace',
    providers: [],
    web: {
      enabled: false,
      status: 'disabled',
      providerConfigured: false,
      readMode: 'public_anonymous',
      dnsResolver: 'system',
      strictReadApproval: false,
      allowDomains: [],
      blockDomains: [],
      cacheEnabled: true,
      cacheTtlSeconds: 300,
      cacheMaxBytes: 64 * 1024 * 1024,
      browserFallback: 'approval_required',
      sensitiveQueryPolicy: 'approve',
      egress: ['query_to_search_provider', 'url_to_target_site', 'evidence_to_current_llm_provider'],
    },
  }
}
