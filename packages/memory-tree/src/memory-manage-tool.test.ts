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
  ...overrides,
})

function harness(options: {
  messages?: MemoryManageSourceMessage[]
  target?: MemoryManageTarget | undefined
  visible?: boolean
  invalidateFails?: string
} = {}) {
  const invalidate = vi.fn(async () => {
    if (options.invalidateFails) throw new Error(options.invalidateFails)
  })
  const recordRevocation = vi.fn()
  const tool = createMemoryManageTool({
    inspect: async () => ('target' in options ? options.target : target()),
    invalidate,
    isVisibleToRun: async () => options.visible ?? true,
    readMessages: async () => options.messages ?? [userMessage('m1', '忘掉我之前说的端口偏好。')],
    recordRevocation,
  })
  const ctx = { sessionId: 'session-1', runId: 'run-1', cwd: 'C:\\ws', approvalGranted: true } as never
  return { tool, invalidate, recordRevocation, ctx }
}

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

describe('memory correction boundary', () => {
  it('refuses to correct a memory and says the old one still stands', async () => {
    const { tool, invalidate, ctx } = harness({ messages: [userMessage('m1', '刚才记错了：端口是 6432。')] })
    const result = await tool.execute({
      ...baseInput,
      action: 'correct',
      replacement: { summary: '端口', content: '端口是 6432。', retrievalKeys: ['端口'] },
    }, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_manage_unsupported')
    expect(result.error).toContain('not implemented yet')
    expect(result.error).toContain('old memory still stands')
    expect(invalidate).not.toHaveBeenCalled()
  })
})
