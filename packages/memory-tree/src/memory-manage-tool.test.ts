import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryManageTool,
  userAskedToForget,
  type MemoryManageSourceMessage,
  type MemoryManageTarget,
} from './memory-manage-tool.js';

const userMessage = (id: string, text: string): MemoryManageSourceMessage => ({ id, role: 'user', text })

const target = (overrides: Partial<MemoryManageTarget> = {}): MemoryManageTarget => ({
  atomId: 'atom-1',
  revision: 3,
  branch: 'long-term',
  scope: 'global',
  status: 'active',
  entityRefs: ['memory-entity:port'],
  parentNodeId: 'long-term:root',
  ...overrides,
})

function harness(options: {
  messages?: MemoryManageSourceMessage[]
  target?: MemoryManageTarget | undefined
  visible?: boolean
  invalidateFails?: string
  replacementDecision?: string
  relateFails?: string
  supersedeFails?: string
  withCorrectionPorts?: boolean
} = {}) {
  const invalidate = vi.fn(async () => {
    if (options.invalidateFails) throw new Error(options.invalidateFails)
  })
  const writeReplacement = vi.fn(async () => ({
    atomId: 'atom-2',
    revision: 1,
    decision: options.replacementDecision ?? 'created',
  }))
  const relateReplacement = vi.fn(async () => {
    if (options.relateFails) throw new Error(options.relateFails)
    return 'relation:replaces-1'
  })
  const supersede = vi.fn(async () => {
    if (options.supersedeFails) throw new Error(options.supersedeFails)
  })
  const recordRevocation = vi.fn()
  const tool = createMemoryManageTool({
    inspect: async () => ('target' in options ? options.target : target()),
    invalidate,
    isVisibleToRun: async () => options.visible ?? true,
    readMessages: async () => options.messages ?? [userMessage('m1', '忘掉我之前说的端口偏好。')],
    recordRevocation,
    ...(options.withCorrectionPorts === false ? {} : { writeReplacement, relateReplacement, supersede }),
  })
  const ctx = { sessionId: 'session-1', runId: 'run-1', cwd: 'C:\\ws', approvalGranted: true } as never
  return { tool, invalidate, writeReplacement, relateReplacement, supersede, recordRevocation, ctx }
}

/** The tool falls back to this run's own messages, so the message needs its run id. */
const runUserMessage = (id: string, text: string, runId = 'run-1'): MemoryManageSourceMessage => ({
  id, role: 'user', text, runId,
})
const baseInput = {
  action: 'forget' as const,
  atomId: 'atom-1',
  expectedRevision: 3,
  reason: '用户要求忘记这条偏好。',
  sourceMessageIds: ['m1'],
}

describe('memory manage authorization', () => {
  it('forgets the atom the user named, and records the revocation', async () => {
    const { tool, invalidate, recordRevocation, ctx } = harness()
    const result = await tool.execute(baseInput, ctx)

    expect(result.ok).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ atomId: 'atom-1', expectedRevision: 3, reason: baseInput.reason })
    expect(recordRevocation).toHaveBeenCalledWith({ atomId: 'atom-1', revision: 3, action: 'invalidate' })
    expect(result.meta?.memoryManageOutcome).toBe('committed')
    expect(result.output).toContain('Memory forgotten')
  })

  it('refuses a change the user never asked for', async () => {
    const { tool, invalidate, ctx } = harness({ messages: [userMessage('m1', '这个构建为什么失败？')] })
    const result = await tool.execute(baseInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_not_authorized')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('recognises the way a user asks for a memory to go away', () => {
    expect(userAskedToForget('忘掉我之前说的端口偏好')).toBe(true)
    expect(userAskedToForget('刚才记错了，是 6432')).toBe(true)
    expect(userAskedToForget('please forget my earlier preference')).toBe(true)
    expect(userAskedToForget('端口是多少？')).toBe(false)
  })
})

describe('memory manage citations', () => {
  it('authorizes a forget from this run\'s own message when nothing is cited', async () => {
    const { tool, invalidate, ctx } = harness({
      messages: [runUserMessage('m1', '忘掉之前那条端口偏好。')],
    })
    const { sourceMessageIds, ...withoutCitations } = baseInput
    void sourceMessageIds
    const result = await tool.execute(withoutCitations, ctx)

    expect(result.ok).toBe(true)
    expect(invalidate).toHaveBeenCalledWith({ atomId: 'atom-1', expectedRevision: 3, reason: baseInput.reason })
  })

  it('still refuses when no message of this run asks for the change', async () => {
    const { tool, invalidate, ctx } = harness({
      messages: [runUserMessage('m1', '端口是多少？')],
    })
    const { sourceMessageIds, ...withoutCitations } = baseInput
    void sourceMessageIds
    const result = await tool.execute(withoutCitations, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_not_authorized')
    expect(invalidate).not.toHaveBeenCalled()
  })
})
describe('memory manage target verification', () => {
  it('refuses an unknown target', async () => {
    const { tool, invalidate, ctx } = harness({ target: undefined })
    const result = await tool.execute(baseInput, ctx)
    expect(result.meta?.errorKind).toBe('memory_manage_target_missing')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refuses a target the run cannot see', async () => {
    const { tool, invalidate, ctx } = harness({ visible: false })
    const result = await tool.execute(baseInput, ctx)
    expect(result.meta?.errorKind).toBe('memory_manage_target_not_visible')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refuses a stale revision and names both numbers', async () => {
    const { tool, invalidate, ctx } = harness({ target: target({ revision: 5 }) })
    const result = await tool.execute(baseInput, ctx)
    expect(result.meta?.errorKind).toBe('memory_manage_stale_revision')
    expect(result.error).toContain('revision 5')
    expect(result.error).toContain('named 3')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('treats an already-forgotten atom as done rather than as an error', async () => {
    const { tool, invalidate, recordRevocation, ctx } = harness({
      target: target({ status: 'invalidated', invalidatedAt: '2026-09-27T00:00:00.000Z' }),
    })
    const result = await tool.execute(baseInput, ctx)
    expect(result.ok).toBe(true)
    expect(result.meta?.memoryManageOutcome).toBe('already-inactive')
    expect(invalidate).not.toHaveBeenCalled()
    expect(recordRevocation).not.toHaveBeenCalled()
  })

  it('refuses a structural branch root', async () => {
    const { tool, invalidate, ctx } = harness({ target: target({ isBranchRoot: true }) })
    const result = await tool.execute({ ...baseInput, atomId: 'long-term:root' }, ctx)
    expect(result.meta?.errorKind).toBe('memory_manage_target_invalid')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('reports a failed invalidation instead of claiming the memory is gone', async () => {
    const { tool, recordRevocation, ctx } = harness({ invalidateFails: 'registry locked' })
    const result = await tool.execute(baseInput, ctx)
    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_failed')
    expect(result.error).toContain('unchanged')
    expect(recordRevocation).not.toHaveBeenCalled()
  })
})

describe('memory correction', () => {
  const correctionInput = {
    ...baseInput,
    action: 'correct' as const,
    reason: '用户说刚才记错了，端口是 6432。',
    replacement: { summary: '本地端口', content: '本地端口是 6432。', retrievalKeys: ['端口'] },
  }
  const messages = [userMessage('m1', '刚才记错了：端口是 6432。')]

  it('writes the replacement, relates it, and only then supersedes the earlier memory', async () => {
    const { tool, writeReplacement, relateReplacement, supersede, recordRevocation, ctx } = harness({ messages })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(true)
    expect(writeReplacement).toHaveBeenCalledWith(expect.objectContaining({
      supersededAtomId: 'atom-1',
      content: '本地端口是 6432。',
      branch: 'long-term',
      scope: 'global',
      parentNodeId: 'long-term:root',
      sourceRefs: ['conversation-source:run-1:user-message:m1'],
    }))
    expect(relateReplacement).toHaveBeenCalledWith(expect.objectContaining({
      supersededAtomId: 'atom-1',
      replacementAtomId: 'atom-2',
    }))
    expect(supersede).toHaveBeenCalledWith(expect.objectContaining({
      atomId: 'atom-1',
      expectedRevision: 3,
      replacementAtomId: 'atom-2',
      replacementExpectedRevision: 1,
      relationId: 'relation:replaces-1',
    }))
    // Order matters: the replacement and its relation exist before the old atom stops being current.
    expect(writeReplacement.mock.invocationCallOrder[0]!).toBeLessThan(relateReplacement.mock.invocationCallOrder[0]!)
    expect(relateReplacement.mock.invocationCallOrder[0]!).toBeLessThan(supersede.mock.invocationCallOrder[0]!)
    expect(recordRevocation).toHaveBeenCalledWith({
      atomId: 'atom-1', revision: 3, action: 'supersede', replacementAtomId: 'atom-2',
    })
    expect(result.meta?.memoryManageOutcome).toBe('committed')
    expect(result.output).toContain('Memory corrected')
  })

  it('says the earlier memory still stands when the replacement cannot be related', async () => {
    const { tool, supersede, recordRevocation, ctx } = harness({ messages, relateFails: 'relation store locked' })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_partial')
    expect(result.error).toContain('atom-2')
    expect(result.error).toContain('still stands')
    expect(supersede).not.toHaveBeenCalled()
    // The revocation is still recorded: a summary written before this must not present the old fact as
    // settled while the correction is half-applied.
    expect(recordRevocation).toHaveBeenCalledTimes(1)
  })

  it('reports a half-applied correction as retryable instead of claiming success', async () => {
    const { tool, recordRevocation, ctx } = harness({ messages, supersedeFails: 'revision moved' })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_partial')
    expect(result.error).toContain('relation:replaces-1')
    expect(result.error).toContain('retry this call with the same atom and revision')
    expect(recordRevocation).toHaveBeenCalledTimes(1)
  })

  it('does not supersede anything when the replacement write was refused', async () => {
    const { tool, relateReplacement, supersede, ctx } = harness({ messages, replacementDecision: 'rejected' })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('still stands')
    expect(relateReplacement).not.toHaveBeenCalled()
    expect(supersede).not.toHaveBeenCalled()
  })

  it('refuses a correction the user never asked for', async () => {
    const { tool, writeReplacement, ctx } = harness({ messages: [userMessage('m1', '端口是多少？')] })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_not_authorized')
    expect(writeReplacement).not.toHaveBeenCalled()
  })

  it('states the capability boundary when the runtime has no correction ports', async () => {
    const { tool, invalidate, ctx } = harness({ messages, withCorrectionPorts: false })
    const result = await tool.execute(correctionInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_unsupported')
    expect(result.error).toContain('does not support correcting')
    expect(invalidate).not.toHaveBeenCalled()
  })
})
