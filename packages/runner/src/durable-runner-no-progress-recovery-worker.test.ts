// Child fixture for T03-R: one repeated observation is already recorded at
// a safe segment boundary before this process is killed.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { createRunner } from './runner.js'

const root = process.env.LS_RUNNER_NO_PROGRESS_ROOT

describe('T03-R no-progress recovery worker', () => {
  it.skipIf(!root)('pauses at the durable no-progress boundary', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!
    const workspace = join(root!, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.maxModelCallsPerRun = 64
    config.agents.defaults.maxToolCallsPerRun = 64
    config.agents.defaults.maxToolLoopIterationsPerRun = 60
    const llm: LlmClient = {
      chat: async (request) => nextResponse(request, workspace),
      chatStream: async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
        const response = await nextResponse(request, workspace)
        onDelta({ type: 'done', finishReason: response.finishReason })
        return response
      },
      embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
    }
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/no-progress-recovery',
      llm,
      approve: async () => true,
      skillsDirs: [],
    })
    const store = runner.infra.durableEventStore
    const append = store.append.bind(store)
    store.append = async (event) => {
      const result = await append(event)
      if (event.type === 'checkpoint_written' && typeof event.payload.checkpointId === 'string') {
        const checkpoint = await runner.infra.runCheckpointStore!.read(event.payload.checkpointId)
        if (checkpoint?.loopBudget.executionSegmentIndex === 2
          && checkpoint.loopBudget.toolLoopIterationsUsed === 30
          && checkpoint.loopBudget.noProgressRounds === 1
          && checkpoint.safeSegmentBoundary?.kind === 'execution_segment') {
          process.stdout.write(`LS_NO_PROGRESS_CHECKPOINT:${checkpoint.sessionId}:${checkpoint.runId}:${checkpoint.id}\n`)
          await new Promise<never>(() => undefined)
        }
      }
      return result
    }
    await runner.run({
      runId: 's2b-t03r-no-progress-recovery',
      text: 'Perform the fixed fixture operations, then repeat the exact same read until the no-progress bound applies.',
      cwd: workspace,
    })
  }, 240_000)
})

function nextResponse(request: ChatRequest, workspace: string): ChatResponse {
  const prompt = request.messages.map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n')
  const completed = request.messages.filter((message) => message.role === 'tool').length
  if (completed === 0 && prompt.includes('Choose the next LittleSheep activity')) {
    return textResponse('{"type":"problem","confidence":0.99,"reason":"cross-process no-progress fixture"}')
  }
  if (completed < 28) {
    const step = completed + 1
    return toolResponse(`no-progress-write-${step}`, 'write', {
      file_path: join(workspace, `unique-${String(step).padStart(2, '0')}.txt`),
      content: `completed:${step}\n`,
    })
  }
  if (completed < 30) {
    return toolResponse(`no-progress-read-${completed}`, 'read', { file_path: join(workspace, 'unique-01.txt') })
  }
  return textResponse('Stopped after the durable no-progress limit; no more repeated operations are needed.')
}

function toolResponse(id: string, name: string, input: Record<string, unknown>): ChatResponse {
  return {
    content: '',
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
    finishReason: 'tool_calls',
  }
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' }
}
