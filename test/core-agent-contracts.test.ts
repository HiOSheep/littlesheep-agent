import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import {
  MemoryRepository,
  MemoryTree,
  MemoryWriteService,
  TreeMemoryBranch,
  DEFAULT_BRANCH_SPECS,
  type MemoryWriteIntent,
} from '@littlesheep/memory-tree'
import { asSessionId, textMessage } from '@littlesheep/types'
import { createDefaultHarness } from '../packages/harness/src/default-harness.js'
import { createDecideStage } from '../packages/harness/src/stages/decide.js'
import {
  createMockLlm,
  createMockMemoryStore,
  createMockSessionManager,
  makeCtx,
  makeTool,
  textResponse,
  toolCallResponse,
} from '../packages/harness/src/tests/helpers.js'

const stageDeps = { model: 'test/model', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING }
const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHarness(llm: ReturnType<typeof createMockLlm>) {
  return createDefaultHarness({
    model: 'test/model',
    config: DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    llm,
    sessionManager: createMockSessionManager(),
    memoryStore: createMockMemoryStore(),
  })
}

describe('core agent behavior contracts', () => {
  it('keeps casual chat outside DECIDE and task-book execution', async () => {
    const llm = createMockLlm(textResponse('Hello.'))
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') })

    const result = await makeHarness(llm).run(ctx)

    expect(result.ok).toBe(true)
    // Casual chat still costs exactly one model request; it now runs in the same
    // main loop as tool work, so no planning request and no TaskBook appear.
    expect((result.meta?.trace as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'enter', 'classify', 'execute', 'verify', 'finalize',
    ])
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual(['execute_tool_loop'])
    expect(ctx.taskBook).toBeUndefined()
    expect(ctx.plan).toBeUndefined()
    expect(ctx.taskExecution).toBeUndefined()
  })

  it('code-compacts an overplanned simple read into one lightweight step', async () => {
    const read = makeTool('read', { ok: true, output: 'contents' })
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'read and explain one file',
        complexity: 'simple',
        goal: 'read and explain README.md',
        successCriteria: ['README.md is explained'],
        requiresTaskBook: true,
      },
      taskBook: {
        goal: 'read and explain README.md',
        complexity: 'simple',
        successCriteria: ['README.md is explained'],
        steps: [
          { id: 'step-1', description: 'invent a broad architecture review', tools: ['read'] },
          { id: 'step-2', description: 'inspect unrelated packages', tools: ['read'] },
          { id: 'step-3', description: 'write an extensive report' },
        ],
      },
    })))
    const ctx = makeCtx({
      tools: [read],
      inbound: textMessage('user', 'Read README.md and tell me what it says.'),
    })

    const result = await createDecideStage({ ...stageDeps, llm })(ctx)

    expect(result.next).toBe('execute')
    expect(ctx.needAssessment).toMatchObject({ complexity: 'simple', requiresTaskBook: false })
    expect(ctx.plan).toEqual([expect.objectContaining({
      id: 'step-1',
      description: 'read and explain README.md',
      tools: ['read'],
      acceptanceCriteria: ['README.md is explained'],
    })])
    expect(ctx.taskBook?.assessment.requiresTaskBook).toBe(false)
  })

  it('replaces a single over-scoped lightweight step with the calibrated goal', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'explain one setting', complexity: 'trivial', goal: 'explain the timeout setting',
        successCriteria: ['the timeout setting is explained'], requiresTaskBook: false,
      },
      taskBook: {
        steps: [{ id: 'step-1', description: 'audit and redesign the entire configuration system' }],
      },
    })))
    const ctx = makeCtx({ inbound: textMessage('user', 'What does this timeout setting do?') })

    await createDecideStage({ ...stageDeps, llm })(ctx)

    expect(ctx.plan).toEqual([expect.objectContaining({
      description: 'explain the timeout setting',
      acceptanceCriteria: ['the timeout setting is explained'],
    })])
    expect(ctx.taskBook).toMatchObject({
      assessment: { requiresTaskBook: false },
      steps: [expect.objectContaining({ description: 'explain the timeout setting' })],
    })
  })

  it('code-requires a task book for complex work even when the model opts out', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'migrate the storage subsystem',
        complexity: 'complex',
        goal: 'migrate storage without data loss',
        successCriteria: ['migration passes rollback and data-integrity checks'],
        requiresTaskBook: false,
      },
      taskBook: {
        steps: [
          { id: 'step-1', description: 'inspect the current storage contract' },
          { id: 'step-2', description: 'implement and verify the migration' },
        ],
      },
    })))
    const ctx = makeCtx({ inbound: textMessage('user', 'Migrate the storage subsystem safely.') })

    const result = await createDecideStage({ ...stageDeps, llm })(ctx)

    expect(result.next).toBe('execute')
    expect(ctx.needAssessment?.requiresTaskBook).toBe(true)
    expect(ctx.taskBook?.complexity).toBe('complex')
    expect(ctx.taskBook?.steps).toHaveLength(2)
  })

  it('routes an executable request with missing critical information to ASK_USER', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'delete a target',
        complexity: 'simple',
        goal: 'delete the requested target',
        successCriteria: ['the intended target is deleted'],
        missingInfo: ['target path'],
        needsClarification: true,
        requiresTaskBook: false,
      },
      clarification: {
        blockingReason: 'Deleting without a target is unsafe.',
        questions: [{ field: 'targetPath', prompt: 'Which path should be deleted?', required: true }],
      },
      taskBook: { steps: [] },
    })))
    const ctx = makeCtx({ inbound: textMessage('user', 'Delete it.') })

    const result = await createDecideStage({ ...stageDeps, llm })(ctx)

    expect(result.next).toBe('finalize')
    expect(ctx.clarificationRequest).toMatchObject({
      kind: 'missing_information',
      missingInfo: ['target path'],
      blockingReason: 'Deleting without a target is unsafe.',
    })
  })

  it('replans only the failed middle step and never reruns completed work', async () => {
    const read = makeTool('read', { ok: true, output: 'unused' })
    let toolExecutions = 0
    read.execute = async () => {
      toolExecutions += 1
      return toolExecutions === 1
        ? { callId: '', ok: false, error: 'ENOENT: file not found' }
        : { callId: '', ok: true, output: 'correct file contents' }
    }
    const assessment = {
      userNeed: 'prepare a verified summary', complexity: 'standard', goal: 'prepare the summary',
      successCriteria: ['summary is complete'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
    }
    const initial = {
      assessment,
      taskBook: {
        goal: assessment.goal, complexity: assessment.complexity, successCriteria: assessment.successCriteria,
        steps: [
          { id: 'step-1', description: 'prepare the outline' },
          { id: 'step-2', description: 'read the file', tools: ['read'] },
          { id: 'step-3', description: 'finish the summary' },
        ],
      },
    }
    const revised = {
      assessment,
      taskBook: {
        ...initial.taskBook,
        steps: [
          { id: 'step-1', description: 'replace completed work' },
          { id: 'step-2', description: 'read the corrected file', tools: ['read'] },
          { id: 'step-3', description: 'finish the summary' },
        ],
      },
    }
    const llm = createMockLlm([
      textResponse(JSON.stringify(initial)),
      textResponse('outline ready'),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { path: 'missing.md' } }]),
      textResponse('read failed'),
      textResponse(JSON.stringify({
        verdict: 'needs_replan', reason: 'the path is wrong', feedback: 'use the corrected path', failedStepIds: ['step-2'],
      })),
      textResponse(JSON.stringify(revised)),
      toolCallResponse([{ id: 'read-2', name: 'read', args: { path: 'correct.md' } }]),
      textResponse('correct contents'),
      textResponse('summary complete'),
      textResponse('final summary'),
      textResponse('{"verdict":"pass","reason":"complete"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ])
    const ctx = makeCtx({
      tools: [read],
      inbound: textMessage('user', 'prepare a verified summary from the file as a multi-step job.'),
    })
    // New requests no longer plan, so an already persisted plan is what keeps
    // this on the step executor: the replan invariant below is still the subject.
    ctx.taskBook = {
      assessment,
      goal: assessment.goal,
      complexity: assessment.complexity,
      successCriteria: [...assessment.successCriteria],
      steps: initial.taskBook.steps.map((step) => ({ ...step, status: 'pending' as const })),
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
    }

    const result = await makeHarness(llm).run(ctx)

    expect(result.ok).toBe(true)
    expect(toolExecutions).toBe(2)
    expect(ctx.taskExecution?.steps.map((step) => [step.stepId, step.attempt, step.status])).toEqual([
      ['step-1', 1, 'done'], ['step-2', 2, 'done'], ['step-3', 1, 'done'],
    ])
    expect(ctx.replanHistory?.[0]).toMatchObject({
      targetStepIds: ['step-2'], preservedStepIds: ['step-1'], revisedStepIds: ['step-2'],
    })
  })

})
