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
})
