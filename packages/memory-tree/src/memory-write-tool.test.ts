import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryWriteTool,
  memoryWriteIntentId,
  memoryWriteSourceRefs,
  userAskedToRemember,
  type MemoryWriteSourceMessage,
} from './memory-write-tool.js';
import type { MemoryWriteIntent, MemoryWriteResult } from './types.js';

const userMessage = (id: string, text: string, runId = 'run-1'): MemoryWriteSourceMessage => ({
  id,
  role: 'user',
  text,
  runId,
})

const assistantMessage = (id: string, text: string, toolCallIds: string[] = [], runId = 'run-1'): MemoryWriteSourceMessage => ({
  id,
  role: 'assistant',
  text,
  runId,
  toolCallIds,
})

function harness(options: {
  messages: MemoryWriteSourceMessage[]
  decision?: MemoryWriteResult['decision']
  reason?: string
} = { messages: [] }) {
  const writes: MemoryWriteIntent[] = []
  const write = vi.fn(async (intent: MemoryWriteIntent): Promise<MemoryWriteResult> => {
    writes.push(intent)
    const decision = options.decision ?? 'created'
    return {
      intentId: intent.id!,
      decision,
      reason: options.reason ?? 'Indexed memory created.',
      ...(decision === 'created' ? { node: { id: 'atom-1' } as never } : {}),
    } as MemoryWriteResult
  })
  const tool = createMemoryWriteTool({
    write,
    readMessages: async () => options.messages,
    resolveEpistemic: ({ scope }) => ({
      domain: 'user',
      statementKind: 'preference',
      epistemicStatus: 'reported',
      authorityScope: { kind: 'user-self', scope: scope as never, topics: [] },
      assertedBy: { kind: 'user', id: 'user' },
      entityRefs: [],
      relationRefs: [],
    }),
  })
  // The tool only ever runs after the harness granted approval for this call.
  const ctx = { sessionId: 'session-1', runId: 'run-1', cwd: 'C:\\ws', approvalGranted: true } as never
  return { tool, write, writes, ctx }
}

const baseInput = {
  reasonKind: 'user-request' as const,
  summary: '回复偏好',
  content: '用户希望工程进度回复保持简洁。',
  retrievalKeys: ['回复', '简洁'],
  reason: '用户明确要求记住这条偏好。',
  sourceMessageIds: ['m1'],
}

describe('memory write authorization', () => {
  it('accepts a write the user really asked for', async () => {
    const { tool, writes, ctx } = harness({
      messages: [userMessage('m1', '记住：我偏好简洁的工程进度回复。')],
    })
    const result = await tool.execute(baseInput, ctx)

    expect(result.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      branch: 'long-term',
      scope: 'global',
      sourceStage: 'tool',
      sourceRefs: ['conversation-source:run-1:user-message:m1'],
      reason: '用户明确要求记住这条偏好。',
    })
    expect(result.meta?.memoryWriteDecision).toBe('created')
    expect(result.output).toContain('Memory created')
  })

  it('refuses a "user-request" the user never made', async () => {
    const { tool, write, ctx } = harness({ messages: [userMessage('m1', '帮我看看这个构建为什么失败。')] })
    const result = await tool.execute(baseInput, ctx)

    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_write_not_authorized')
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses when no cited source is a user message at all', async () => {
    const { tool, write, ctx } = harness({ messages: [assistantMessage('m1', '记住这个词：简洁')] })
    const result = await tool.execute({ ...baseInput, sourceMessageIds: ['m1'] }, ctx)

    expect(result.meta?.errorKind).toBe('memory_write_not_authorized')
    expect(result.error).toContain('from the user')
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts a necessary write with a substantive reason, and refuses a thin one', async () => {
    const messages = [userMessage('m1', '这个项目的部署窗口是每周五下午。')]
    const strong = harness({ messages })
    const accepted = await strong.tool.execute({
      ...baseInput,
      reasonKind: 'necessary',
      reason: '项目约定：后续所有发布计划都要避开这个窗口，不记住会重复排期冲突。',
    }, strong.ctx)
    expect(accepted.ok).toBe(true)

    const weak = harness({ messages })
    const refused = await weak.tool.execute({ ...baseInput, reasonKind: 'necessary', reason: '有用' }, weak.ctx)
    expect(refused.meta?.errorKind).toBe('memory_write_reason_thin')
    expect(weak.write).not.toHaveBeenCalled()
  })

  it('refuses sources that are not in this session', async () => {
    const { tool, write, ctx } = harness({ messages: [userMessage('m1', '记住：端口是 5432。')] })
    const result = await tool.execute({ ...baseInput, sourceMessageIds: ['m1', 'm-99'] }, ctx)

    expect(result.meta?.errorKind).toBe('memory_write_source_missing')
    expect(result.error).toContain('m-99')
    expect(write).not.toHaveBeenCalled()
  })

  it('does not claim success when the repository refused or queued the write', async () => {
    const refused = harness({
      messages: [userMessage('m1', '记住：端口是 6432。')],
      decision: 'rejected',
      reason: 'A similar memory was found (0.92) but they are different facts: different values (6432).',
    })
    const refusedResult = await refused.tool.execute(baseInput, refused.ctx)
    expect(refusedResult.ok).toBe(false)
    expect(refusedResult.meta?.errorKind).toBe('memory_write_rejected')
    expect(refusedResult.output).toContain('different facts')

    const queued = harness({ messages: [userMessage('m1', '记住：端口是 6432。')], decision: 'queued' })
    const queuedResult = await queued.tool.execute(baseInput, queued.ctx)
    expect(queuedResult.ok).toBe(false)
    expect(queuedResult.meta?.errorKind).toBe('memory_write_queued')
  })

  it('bounds how much one run may commit', async () => {
    const { tool, write, ctx } = harness({ messages: [userMessage('m1', '记住：端口是 5432。')] })
    for (let index = 0; index < 4; index += 1) {
      const result = await tool.execute({ ...baseInput, content: `${baseInput.content}${index}` }, ctx)
      expect(result.ok).toBe(true)
    }
    const over = await tool.execute({ ...baseInput, content: `${baseInput.content}over` }, ctx)
    expect(over.meta?.errorKind).toBe('memory_write_budget_exhausted')
    expect(write).toHaveBeenCalledTimes(4)
  })

  it('keeps project scope available and refuses it for other branches', async () => {
    const { tool, write, ctx } = harness({ messages: [userMessage('m1', '记住：这个项目用 pnpm。')] })
    const wrong = await tool.execute({ ...baseInput, branch: 'long-term', scope: 'project' }, ctx)
    expect(wrong.meta?.errorKind).toBe('memory_write_scope_invalid')
    const right = await tool.execute({ ...baseInput, branch: 'project', scope: 'project' }, ctx)
    expect(right.ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('memory write identity', () => {
  it('gives a retry the same intent id and a different content a different one', () => {
    const base = {
      sessionId: 'session-1',
      branch: 'long-term',
      scope: 'global',
      content: '用户希望回复简洁。',
      sourceRefs: ['conversation-source:run-1:user-message:m1'],
    }
    expect(memoryWriteIntentId(base)).toBe(memoryWriteIntentId({ ...base }))
    // Whitespace and case are normalized, so a re-sent instruction is the same operation.
    expect(memoryWriteIntentId(base)).toBe(memoryWriteIntentId({ ...base, content: ' 用户希望回复简洁。 ' }))
    expect(memoryWriteIntentId(base)).not.toBe(memoryWriteIntentId({ ...base, content: '用户希望回复详细。' }))
    expect(memoryWriteIntentId(base)).not.toBe(memoryWriteIntentId({
      ...base,
      sourceRefs: ['conversation-source:run-1:user-message:m2'],
    }))
    expect(memoryWriteIntentId(base)).not.toBe(memoryWriteIntentId({ ...base, sessionId: 'session-2' }))
  })

  it('reads the immutable refs a message can contribute', () => {
    expect(memoryWriteSourceRefs(userMessage('m1', '记住'))).toEqual(['conversation-source:run-1:user-message:m1'])
    expect(memoryWriteSourceRefs(assistantMessage('m2', 'done', ['call-1']))).toEqual([
      'conversation-source:run-1:assistant-reply',
      'conversation-source:run-1:tool-result:call-1',
    ])
  })

  it('recognises the memory instructions a user writes', () => {
    expect(userAskedToRemember('记住：端口是 5432')).toBe(true)
    expect(userAskedToRemember('Please remember that I prefer concise replies')).toBe(true)
    expect(userAskedToRemember('别忘记把测试跑一遍')).toBe(true)
    expect(userAskedToRemember('这个构建为什么失败？')).toBe(false)
  })
})

describe('memory write evidence and approval', () => {
  it('refuses a write that cites a truncated source, and ignores truncation it did not cite', async () => {
    const messages: MemoryWriteSourceMessage[] = [
      { ...userMessage('m1', '记住：端口是 5432。'), truncated: true },
      userMessage('m2', '记住：部署窗口是周五。'),
    ]
    const truncatedCite = harness({ messages })
    const refused = await truncatedCite.tool.execute({ ...baseInput, sourceMessageIds: ['m1'] }, truncatedCite.ctx)
    expect(refused.ok).toBe(false)
    expect(refused.meta?.errorKind).toBe('memory_write_source_incomplete')
    expect(refused.error).toContain('m1')
    expect(truncatedCite.write).not.toHaveBeenCalled()

    // The same session, citing only the whole message, is written.
    const cleanCite = harness({ messages })
    const accepted = await cleanCite.tool.execute({ ...baseInput, sourceMessageIds: ['m2'] }, cleanCite.ctx)
    expect(accepted.ok).toBe(true)
    expect(cleanCite.write).toHaveBeenCalledTimes(1)
  })

  it('refuses to write without the approval grant for this call', async () => {
    const { tool, write } = harness({ messages: [userMessage('m1', '记住：端口是 5432。')] })
    const unapproved = { sessionId: 'session-1', runId: 'run-1', cwd: 'C:\\ws', permissionMode: 'restricted' } as never
    const result = await tool.execute(baseInput, unapproved)
    expect(result.ok).toBe(false)
    expect(result.meta?.errorKind).toBe('memory_write_not_approved')
    expect(write).not.toHaveBeenCalled()

    // The full mode is never asked for a grant, so a write there is not refused for lacking one.
    const fullMode = { sessionId: 'session-1', runId: 'run-1', cwd: 'C:\\ws', permissionMode: 'full' } as never
    const allowed = await tool.execute(baseInput, fullMode)
    expect(allowed.ok).toBe(true)
  })
})