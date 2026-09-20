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
import { createEvolveStage } from '../packages/harness/src/stages/evolve.js'
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
    expect((result.meta?.trace as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'enter', 'classify', 'reply', 'finalize',
    ])
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

  it('rejects low-value long-term learning but keeps indexed project memory retrievable on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-core-eval-memory-'))
    tempDirs.push(dir)
    const repository = new MemoryRepository({ dataDir: dir })
    await repository.initialize()
    const tree = new MemoryTree({ totalRunTokenBudget: 1_200, perBranchTokenBudget: 500 })
    for (const spec of DEFAULT_BRANCH_SPECS) {
      tree.register(new TreeMemoryBranch({ repository, ...spec }))
    }
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidate(branch) })
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [
        {
          intent: 'write',
          branch: 'long-term', parentNodeId: 'long-term:root', scope: 'global',
          summary: 'Temporary thought', content: 'This is only this run temporary run state.',
          retrievalKeys: ['temporary'], importance: 0.2, confidence: 0.3,
          reason: 'The model proposed it even though it is not durable.',
        },
        {
          intent: 'write',
          branch: 'project', parentNodeId: 'project:root', scope: 'workspace',
          summary: 'Workspace package manager', content: 'Use pnpm in this repository.',
          retrievalKeys: ['pnpm', 'package manager'], importance: 0.8, confidence: 0.95,
          reason: 'Verified from the repository packageManager field.',
        },
      ],
      createSkill: null,
    })))
    const ctx = makeCtx({
      inbound: textMessage('user', 'Inspect the project package manager.'),
      reply: 'This project uses pnpm.',
      toolContext: { cwd: 'D:/project' },
    })
    ctx.cwd = 'D:/project'
    ctx.taskExecution = {
      goal: 'Inspect the project package manager.', complexity: 'simple', status: 'done',
      startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:00:01.000Z',
      steps: [{
        stepId: 'step-1', description: 'Inspect packageManager', status: 'done',
        startedAt: '2026-07-15T00:00:00.000Z', endedAt: '2026-07-15T00:00:01.000Z',
        toolCallIds: [], toolResults: [],
      }],
    }
    ctx.verificationHistory = [{
      attempt: 1, verdict: 'pass', reason: 'packageManager was inspected.',
      verifiedAt: '2026-07-15T00:00:02.000Z', source: 'model',
    }]

    await createEvolveStage({ llm, model: 'test/model', memoryWriter: writer })(ctx)

    expect(await repository.listNodes('long-term')).toHaveLength(0)
    expect(await repository.listNodes('project', 'D:/project')).toHaveLength(1)
    expect((await repository.snapshot()).writeAudit.map((record) => record.decision)).toEqual(['created'])
    expect(ctx.memoryIntentDecisions?.map((record) => record.decision)).toEqual(['rejected', 'committed'])

    tree.beginRun({
      runId: 'recall-run', sessionId: asSessionId('session-1'), query: 'Which package manager?',
      recentHistory: [], workspace: 'D:/project',
    })
    const root = tree.rootIndex()
    const tokensBeforeRejectedExpansion = tree.getLedger('recall-run')!.tokensUsed
    await expect(tree.expand('recall-run', { branchId: 'project', query: 'pnpm', limit: 3 }))
      .rejects.toThrow('branch_index')
    expect(tree.getLedger('recall-run')!.tokensUsed).toBe(tokensBeforeRejectedExpansion)
    expect(tree.getLedger('recall-run')!.records.at(-1)).toMatchObject({
      action: 'expand', status: 'error', sourceCount: 0, tokensUsed: 0,
    })
    const projectIndex = await tree.branchIndex('recall-run', 'project')
    const recalled = await tree.expand('recall-run', { branchId: 'project', query: 'pnpm', limit: 3 })

    expect(root).toContain('Only this lightweight root index is preloaded')
    expect(root).not.toContain('Use pnpm in this repository.')
    expect(projectIndex.entries[0]?.title).toBe('Workspace package manager')
    expect(recalled.fragments[0]?.content).toContain('Use pnpm in this repository.')
    expect(tree.finishRun('recall-run')?.records.map((record) => record.action)).toEqual([
      'root_index', 'expand', 'branch_index', 'expand',
    ])
  })
})
