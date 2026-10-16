import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createRunner } from './runner.js';

type RunFixtureOptions = {
  runId: string;
  maxToolCalls: number;
  interruptAfter?: number;
};

let dataDir: string;
let runners: Array<{ shutdown: () => Promise<void> }> = [];

afterEach(async () => {
  for (const runner of runners) await runner.shutdown();
  runners = [];
  delete process.env.LITTLESHEEP_DATA_DIR;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

async function runFixture(options: RunFixtureOptions) {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-s2b-segments-'));
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  const workspace = join(dataDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.maxModelCallsPerRun = 64;
  config.agents.defaults.maxToolCallsPerRun = options.maxToolCalls;
  config.agents.defaults.maxToolLoopIterationsPerRun = 60;
  let completed = 0;
  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
    const prompt = request.messages.map((message) => (
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )).join('\n');
    if (prompt.includes('Choose the next LittleSheep activity')) {
      return textResponse('{"type":"problem","confidence":0.99,"reason":"deterministic segment test"}');
    }
    if (completed < 35) {
      return {
        content: '',
        toolCalls: [{
          id: `segment-progress-${completed + 1}`,
          type: 'function',
          function: { name: 'record_progress', arguments: JSON.stringify({ step: completed + 1 }) },
        }],
        finishReason: 'tool_calls',
      };
    }
    return textResponse('All fixture operations completed.');
  });
  const chatStream = vi.fn(async (
    request: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> => {
    const response = await chat(request);
    for (const delta of response.content.match(/.{1,3}/g) ?? []) onDelta({ type: 'delta', delta });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  });
  const llm: LlmClient = {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
  };
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const recordProgress: AgentTool = {
    name: 'record_progress',
    description: 'Record one deterministic fixture operation.',
    inputSchema: z.object({ step: z.number().int() }).strict(),
    execution: {
      concurrency: 'parallel',
      resources: (input) => [{ key: `s2b-step:${String((input as { step: number }).step)}`, mode: 'write' }],
    },
    async execute(input) {
      const step = Number((input as { step: number }).step);
      writeFileSync(join(workspace, `step-${String(step).padStart(2, '0')}.txt`), `completed:${step}\n`, 'utf8');
      completed += 1;
      if (options.interruptAfter === completed) {
        runner.activeRuns?.request(options.runId, 'interrupt', 'test interruption at segment boundary');
      }
      return { callId: '', ok: true, output: `completed step ${step}` };
    },
  };
  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/segments',
    llm,
    approve: async () => true,
    skillsDirs: [],
  });
  runners.push(runner);
  const result = await runner.run({
    runId: options.runId,
    text: 'Complete all 35 independently verifiable fixture operations.',
    cwd: workspace,
    additionalTools: [recordProgress],
  });
  const checkpoint = await runner.infra.runCheckpointStore?.latestForRun(result.runId);
  return {
    result,
    completed,
    files: readdirSync(workspace).filter((name) => name.endsWith('.txt')),
    modelCalls: chat.mock.calls.length,
    checkpoint,
  };
}

describe('Runner execution segments', () => {
  it('continues 35 operations across the 30-turn segment limit in one Run', async () => {
    const run = await runFixture({ runId: 's2b-t01-single-run', maxToolCalls: 64 });
    expect(run.result).toMatchObject({ status: 'ok', runId: 's2b-t01-single-run' });
    expect(run.completed).toBe(35);
    expect(run.files).toHaveLength(35);
    expect(run.result.toolInvocations?.filter((item) => item.toolName === 'record_progress')).toHaveLength(35);
    expect(run.modelCalls).toBeLessThanOrEqual(64);
    expect(run.checkpoint?.loopBudget).toMatchObject({
      executionSegmentIndex: 2,
      // The loop budget counts every reserved model/tool-loop turn, including
      // non-mutating turns around the 35 effectful calls.
      segmentIterationsUsed: 7,
      toolLoopIterationsUsed: 37,
      toolCallsUsed: 35,
      maxToolCalls: 64,
      maxToolLoopIterationsPerRun: 60,
    });
  });

  it('does not replenish the Run tool budget when a new segment starts', async () => {
    const run = await runFixture({ runId: 's2b-t02-single-run', maxToolCalls: 32 });
    expect(run.result.runId).toBe('s2b-t02-single-run');
    expect(run.completed).toBe(32);
    expect(run.files).toHaveLength(32);
    expect(run.checkpoint?.loopBudget).toMatchObject({
      executionSegmentIndex: 2,
      toolCallsUsed: 32,
      maxToolCalls: 32,
    });
  });

  it('honors an interruption at the segment boundary before another Provider call', async () => {
    const run = await runFixture({
      runId: 's2b-t05-interrupt-at-boundary',
      maxToolCalls: 64,
      interruptAfter: 30,
    });
    expect(run.result.status).toBe('aborted');
    expect(run.completed).toBe(30);
    expect(run.modelCalls).toBeLessThanOrEqual(32);
    expect(run.files).toHaveLength(30);
  });
});
