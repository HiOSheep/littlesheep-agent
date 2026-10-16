import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm'
import { asSessionId } from '@littlesheep/types'
import { createRunner, type AgentRunner } from './runner.js'

const roots: string[] = []
const runners: AgentRunner[] = []

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)))
  delete process.env.LITTLESHEEP_DATA_DIR
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('cross-process no-progress continuity', () => {
  it('keeps the accumulated no-progress bound after a real process kill at a safe segment boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2b-no-progress-restart-'))
    roots.push(root)
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      resolve('packages/runner/src/durable-runner-no-progress-recovery-worker.test.ts'),
      '--pool=threads',
      '--maxWorkers=1',
      '--minWorkers=1',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, LS_RUNNER_NO_PROGRESS_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const marker = await waitForMarker(child)
    child.kill('SIGKILL')
    await Promise.race([once(child, 'exit'), delay(5_000)])
    expect(child.signalCode).toBe('SIGKILL')
    const identity = marker.match(/LS_NO_PROGRESS_CHECKPOINT:([^:\r\n]+):([^:\r\n]+):([^\r\n]+)/u)
    expect(identity).toBeTruthy()
    const [, sessionId, runId, checkpointId] = identity!

    process.env.LITTLESHEEP_DATA_DIR = root
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.maxModelCallsPerRun = 64
    config.agents.defaults.maxToolCallsPerRun = 64
    config.agents.defaults.maxToolLoopIterationsPerRun = 60
    const resumedPrompts: string[] = []
    const chat = async (request: ChatRequest): Promise<ChatResponse> => {
      const prompt = request.messages.map((message) => (
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      )).join('\n')
      resumedPrompts.push(prompt)
      const completed = request.messages.filter((message) => message.role === 'tool').length
      return completed <= 31
        ? readAgain(join(root, 'workspace', 'unique-01.txt'), completed)
        : textResponse('The durable no-progress bound was retained after restart.')
    }
    const llm: LlmClient = {
      chat,
      chatStream: async (request, onDelta) => {
        const response = await chat(request)
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
    runners.push(runner)
    const checkpoint = await runner.infra.runCheckpointStore!.read(checkpointId!)
    expect(checkpoint?.loopBudget.noProgressRounds).toBe(1)
    const lease = await runner.infra.durableRunLeaseStore.read(sessionId!, runId!)
    await delay(Math.max(0, Date.parse(lease?.leaseUntil ?? '') - Date.now() + 25))

    const recovery = await runner.recoverDurableRun!(asSessionId(sessionId!), runId!)
    expect(recovery.projection.status).toBe('completed')
    expect(resumedPrompts.length).toBeGreaterThanOrEqual(2)
    expect(resumedPrompts[1]).toContain('last rounds added no new evidence')
    expect(readdirSync(join(root, 'workspace')).filter((name) => name.endsWith('.txt'))).toHaveLength(28)
    expect(existsSync(join(root, 'workspace', 'unique-01.txt'))).toBe(true)
    const finalCheckpoint = await runner.infra.runCheckpointStore!.latestForRun(runId!)
    expect(finalCheckpoint?.loopBudget.noProgressRounds).toBeGreaterThanOrEqual(2)
  }, 240_000)
})

function readAgain(path: string, completed: number): ChatResponse {
  return {
    content: '',
    toolCalls: [{
      id: `after-recovery-read-${completed}`,
      type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ file_path: path }) },
    }],
    finishReason: 'tool_calls',
  }
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' }
}

async function waitForMarker(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveMarker, reject) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error(`no-progress worker did not reach its boundary: ${output}`)), 180_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      child.removeAllListeners('exit')
      if (error) reject(error)
      else resolveMarker(output)
    }
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (output.includes('LS_NO_PROGRESS_CHECKPOINT:')) finish()
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('exit', (code) => finish(new Error(`no-progress worker exited with ${String(code)}: ${output}`)))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)))
}
