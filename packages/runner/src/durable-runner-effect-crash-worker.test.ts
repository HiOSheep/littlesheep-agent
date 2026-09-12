// Full Runner child-process fixture. The effect is durably admitted, performs
// one real file mutation, then blocks until the parent kills the OS process.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool, ToolResult } from '@littlesheep/types';
import { createRunner } from './runner.js';

const crashRoot = process.env.LS_DURABLE_RUNNER_EFFECT_CRASH_ROOT;

it('holds a real effect open until its parent kills the Runner process', async () => {
  if (!crashRoot) {
    expect(crashRoot).toBeUndefined();
    return;
  }
  process.env.LITTLESHEEP_DATA_DIR = crashRoot;
  const workspace = join(crashRoot, 'effect-workspace');
  await mkdir(workspace, { recursive: true });
  const responses: ChatResponse[] = [
    textResponse('{"type":"problem","confidence":0.99,"reason":"execute crash probe"}'),
    textResponse('{"plan":[{"description":"execute crash probe","tools":["crash_effect"]}]}'),
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'crash-effect-call',
        type: 'function',
        function: { name: 'crash_effect', arguments: '{}' },
      }],
    },
  ];
  const runner = await createRunner({
    config: DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    model: 'test/model',
    llm: queueLlm(responses),
    durableHarnessMode: 'next',
  });
  const session = await runner.sessionManager.create('test/model');
  const tool: AgentTool = {
    name: 'crash_effect',
    description: 'Apply one observable mutation and remain in flight.',
    inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
    execution: {
      concurrency: 'exclusive',
      resources: () => [{ key: 'workspace:runner-crash-effect', mode: 'write' }],
    },
    async execute(_input, context): Promise<ToolResult> {
      await writeFile(join(workspace, 'effect-applied.txt'), `${context.sessionId}:${context.runId}\n`, 'utf8');
      process.stdout.write(`LS_DURABLE_RUNNER_EFFECT_STARTED:${context.sessionId}\n`);
      await new Promise<never>(() => undefined);
      return { callId: 'crash-effect-call', ok: false, error: 'killed before completion' };
    },
  };
  await runner.run({
    sessionId: session.id,
    runId: 'run-effect-process-killed',
    text: 'execute the crash effect',
    cwd: workspace,
    additionalTools: [tool],
  });
}, 90_000);

function queueLlm(responses: ChatResponse[]): LlmClient {
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => (
    responses.shift() ?? textResponse('unexpected request after effect start')
  );
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: 'test/model', usage: { promptTokens: 0 } }),
  };
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}
