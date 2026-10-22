import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskEvidenceReference, TaskEvidenceStatus, TaskOutcome } from '@littlesheep/types'
import { unknownTaskOutcome } from '@littlesheep/types'
import type { AssistantTurnActivity } from './types'
import { TaskOutcomeCard } from './task-outcome-card'

const digest = 'a'.repeat(64)

beforeEach(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

function outcome(status: 'passed' | 'failed' | 'unverified' | 'blocked' = 'passed'): TaskOutcome {
  const requirementStatus = status === 'passed' ? 'passed' : status
  const checkStatus: TaskEvidenceStatus = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'partial'
  const evidence: TaskEvidenceReference[] = status === 'blocked' ? [] : [
    { version: 1 as const, id: 'file-state-1', kind: 'file_state' as const, status: 'informational' as const,
      sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt', contentHash: digest,
      checkedAt: '2026-10-17T12:00:00.000Z' },
    { version: 1 as const, id: 'effect-1', kind: 'settled_effect' as const, status: 'pass' as const,
      sourceRef: 'effect-1', resourceRef: 'workspace:result.txt', effectRef: 'effect-1' },
    { version: 1 as const, id: 'tool-result-1', kind: 'tool_result' as const, status: 'informational' as const,
      sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt' },
    { version: 1 as const, id: 'check-1', kind: 'requirement_check' as const, status: checkStatus,
      sourceRef: 'tool:check-1', resourceRef: 'workspace:result.txt', contentHash: digest,
      checkedAt: '2026-10-17T12:00:00.000Z' },
  ]
  const evidenceRefs = evidence.map((item) => item.id)
  return {
    version: 1,
    runId: 'run-1',
    execution: { status: status === 'blocked' ? 'blocked' : 'completed' },
    requirementInventory: 'complete',
    requirements: [{ id: 'req-1', sourceMessageId: 'user-message-1', origin: 'user_explicit',
      status: requirementStatus, evidenceRefs, ...(status === 'failed' ? { reasonCode: 'file_content_mismatch' } : {}) }],
    evidence,
    artifacts: status === 'blocked' ? [] : [{ resourceRef: 'workspace:result.txt', action: 'created',
      effectRef: 'effect-1', evidenceRefs, verification: requirementStatus }],
    status: status === 'passed' ? 'completed' : status === 'blocked' ? 'blocked' : 'partially_completed',
    remaining: status === 'passed' ? [] : [{ requirementId: 'req-1', reasonCode: status === 'failed' ? 'file_content_mismatch'
      : status === 'blocked' ? 'unknown_effect' : 'no_independent_check', evidenceRefs }],
  }
}

function activity(overrides: Partial<AssistantTurnActivity> = {}): AssistantTurnActivity {
  return { status: 'done', instruction: 'Create result.txt, content must be hello', startedAt: 1, steps: [], tools: [], ...overrides }
}

function render(next: Partial<AssistantTurnActivity>): string {
  return renderToStaticMarkup(createElement(TaskOutcomeCard, { activity: activity(next), onOpenFile: () => undefined }))
}

describe('Task Outcome card', () => {
  it('shows a failed content check without turning a successful write into task success', () => {
    const html = render({ taskOutcome: outcome('failed') })
    expect(html).toContain('检查未通过')
    expect(html).toContain('文件内容与要求不一致')
    expect(html).toContain('本次创建')
    expect(html).toContain('检查时文件版本 aaaaaaaaaaaa')
    expect(html).toContain('文件之后可能变化')
    expect(html).toContain('检查时间 2026-10-17T12:00:00.000Z')
    expect(html).not.toContain('已按明确的验收条件通过')
    expect(html).not.toContain(digest)
  })

  it('shows independently checked success and links only the safe workspace-relative resource', () => {
    const html = render({ taskOutcome: outcome('passed') })
    expect(html).toContain('已验证通过')
    expect(html).toContain('已按明确的验收条件通过')
    expect(html).toContain('检查时文件版本 aaaaaaaaaaaa')
    expect(html).toContain('后续变化未自动复核')
    expect(html).toContain('>result.txt</button>')
  })

  it('keeps unverified and blocked requirements distinct from passed checks', () => {
    const unverified = render({ taskOutcome: outcome('unverified') })
    expect(unverified).toContain('尚未验证')
    expect(unverified).toContain('没有独立内容检查')

    const blocked = render({ taskOutcome: outcome('blocked') })
    expect(blocked).toContain('检查受阻')
    expect(blocked).toContain('副作用结果不确定，需要核实')
    expect(blocked).not.toContain('已验证通过')
  })

  it('shows the DELIV-02 unknown shape as an explicit unverified acceptance, never as a pass', () => {
    const taskOutcome = unknownTaskOutcome('run-deliv-02')
    taskOutcome.execution = { status: 'completed' }
    taskOutcome.remaining = [{ reasonCode: 'requirements_unknown', evidenceRefs: [] }]
    const html = render({ taskOutcome, tools: [{ callId: 'write-1', name: 'write', ok: true }] })

    expect(html).toContain('未验收')
    expect(html).toContain('role="status"')
    expect(html).toContain('data-acceptance="unverified"')
    expect(html).toContain('is-unverified')
    expect(html).toContain('task-outcome-badge unverified')
    expect(html).toContain('模型最终回复')
    expect(html).toContain('不构成验收通过')
    expect(html).toContain('验证范围仅限')
    expect(html).toContain('执行：执行已结束')
    expect(html).toContain('验收清单无法确认')
    expect(html).toContain('无法确认完整的要求清单')
    expect(html).not.toContain('已验证通过')
    expect(html).not.toContain('已按明确的验收条件通过')
  })

  it('renders a confirmed failed requirement as a danger-level fact', () => {
    const html = render({ taskOutcome: outcome('failed') })
    expect(html).toContain('task-outcome-badge danger')
    expect(html).toContain('data-acceptance="failed"')
    expect(html).not.toContain('已按明确的验收条件通过')
  })

  it('shows passed and failed requirements together without marking the task fully complete', () => {
    const partial = outcome('passed')
    partial.artifacts[0]!.resourceRef = 'workspace:a.txt'
    const failedEvidence: TaskEvidenceReference[] = [
      { version: 1, id: 'file-state-b', kind: 'file_state', status: 'informational', sourceRef: 'tool:check-b',
        resourceRef: 'workspace:b.txt', contentHash: 'b'.repeat(64) },
      { version: 1, id: 'effect-b', kind: 'settled_effect', status: 'pass', sourceRef: 'effect-b',
        resourceRef: 'workspace:b.txt', effectRef: 'effect-b' },
      { version: 1, id: 'tool-result-b', kind: 'tool_result', status: 'informational', sourceRef: 'tool:check-b',
        resourceRef: 'workspace:b.txt' },
      { version: 1, id: 'check-b', kind: 'requirement_check', status: 'fail', sourceRef: 'tool:check-b',
        resourceRef: 'workspace:b.txt', contentHash: 'b'.repeat(64) },
    ]
    partial.requirements[0]!.status = 'passed'
    partial.requirements[0]!.id = 'req-a'
    partial.requirements[1] = { id: 'req-b', sourceMessageId: 'user-message-1', origin: 'user_explicit',
      status: 'failed', evidenceRefs: failedEvidence.map((item) => item.id), reasonCode: 'file_content_mismatch' }
    partial.evidence.push(...failedEvidence)
    partial.artifacts.push({ resourceRef: 'workspace:b.txt', action: 'created', effectRef: 'effect-b',
      evidenceRefs: failedEvidence.map((item) => item.id), verification: 'failed' })
    partial.status = 'partially_completed'
    partial.remaining = [{ requirementId: 'req-b', reasonCode: 'file_content_mismatch', evidenceRefs: failedEvidence.map((item) => item.id) }]
    const html = render({ taskOutcome: partial })
    expect(html).toContain('部分要求已通过，仍有未满足项')
    expect(html).toContain('已验证通过')
    expect(html).toContain('检查未通过')
    expect(html).toContain('>a.txt</button>')
    expect(html).toContain('>b.txt</button>')
    expect(html).not.toContain('已按明确的验收条件通过')
  })

  it('shows a missing record for legacy file writes and stays silent for ordinary chat', () => {
    const missing = render({ tools: [{ callId: 'write-1', name: 'write', ok: true }] })
    expect(missing).toContain('缺少验收记录')
    expect(missing).toContain('文件写入操作成功不代表')
    expect(missing).toContain('不构成验收通过')
    expect(missing).toContain('role="status"')
    expect(render({ taskOutcome: undefined })).toBe('')
  })

  it('does not render unsafe resource paths or expose untrusted output details', () => {
    const badPath = outcome('passed')
    badPath.artifacts[0]!.resourceRef = 'workspace:../../private/key.txt'
    const html = render({ taskOutcome: badPath })
    expect(html).toContain('受限资源')
    expect(html).not.toContain('private/key.txt')
    expect(html).not.toContain('secret-content')
  })

  it('does not render a success card before the run reaches a terminal state', () => {
    const html = render({ status: 'running', taskOutcome: outcome('passed') })
    expect(html).toBe('')
  })
})
