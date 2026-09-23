// CE-01: Main → Runner → prompt → tool cwd resolve to one workspace.
//
// The defect was never a single wrong string: the prompt was rendered from
// `agents.defaults.workspace` while the tool context was built from the run's
// own `cwd`, so a session bound to a project (or to any directory other than the
// saved default) was told to work in one place and executed in another. This
// asserts the whole chain at the Runner boundary, which is where the two used to
// diverge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import type { AgentTool } from '@littlesheep/types'
import { createRunner } from './runner.js'

type Responder = ChatResponse | ((req: ChatRequest) => ChatResponse)

function makeMockLlm(responder: Responder): LlmClient {
  const chat = vi.fn(async (req: ChatRequest): Promise<ChatResponse> => (
    typeof responder === 'function' ? responder(req) : responder
  ))
  const chatStream = vi.fn(async (
    req: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> => {
    const res = await chat(req)
    onDelta({ type: 'done', finishReason: res.finishReason })
    return res
  })
  return { chat, chatStream, embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })) }
}

const createdRunners: Array<{ shutdown: () => Promise<void> }> = []
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-workspace-fact-'))
  process.env.LITTLESHEEP_DATA_DIR = dataDir
  createdRunners.length = 0
})

afterEach(async () => {
  for (const runner of createdRunners) {
    try { await runner.shutdown() } catch { /* best-effort */ }
  }
  delete process.env.LITTLESHEEP_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

function systemText(request: ChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content ?? ''))
    .join('\n')
}

describe('the run workspace fact', () => {
  it('uses the requested directory in the prompt, the tool context and the environment brief', async () => {
    const configuredDefault = resolve(dataDir, 'configured-default')
    const requested = resolve(dataDir, 'requested workspace')
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = configuredDefault

    const requests: ChatRequest[] = []
    let turn = 0
    const llm = makeMockLlm((request) => {
      requests.push(request)
      turn += 1
      if (turn === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'probe-1', type: 'function', function: { name: 'probe', arguments: '{"path":"."}' } }],
        }
      }
      return { content: 'probed the workspace', toolCalls: [], finishReason: 'stop' }
    })
    const observedCwd: string[] = []
    const probe: AgentTool = {
      name: 'probe',
      description: 'record the working directory this run executes in',
      inputSchema: { parse: (value: unknown) => value },
      execution: { concurrency: 'parallel', resources: () => [{ key: 'workspace:.', mode: 'read' }] },
      execute: async (_input, ctx) => {
        observedCwd.push(ctx.cwd)
        return { callId: '', ok: true, output: 'probed' }
      },
    }

    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm,
      bootstrapDir: dataDir,
      skillsDirs: [],
    })
    createdRunners.push(runner)

    const result = await runner.run({
      text: 'make a small game here',
      cwd: requested,
      additionalTools: [probe],
      permissionPolicyId: 'full',
    })

    expect(observedCwd).toEqual([requested])
    const prompt = systemText(requests[0]!)
    expect(prompt).toContain(`Working directory: \`${requested}\``)
    expect(prompt).not.toContain(configuredDefault)
    const brief = requests[0]?.messages
      .map((message) => String(message.content ?? ''))
      .find((content) => content.includes('[Runtime context; effective for this request]'))
    expect(brief).toContain(`- workspace: ${requested}`)
    expect(result.runId).toBeTruthy()
  })

  it('keeps the configured default when the request does not name a directory', async () => {
    const configuredDefault = resolve(dataDir, 'configured-default')
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = configuredDefault
    const requests: ChatRequest[] = []
    const llm = makeMockLlm((request) => {
      requests.push(request)
      return { content: 'hello', toolCalls: [], finishReason: 'stop' }
    })
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm,
      bootstrapDir: dataDir,
      skillsDirs: [],
    })
    createdRunners.push(runner)

    await runner.run({ text: 'hello' })

    expect(systemText(requests[0]!)).toContain(`Working directory: \`${configuredDefault}\``)
  })
})
