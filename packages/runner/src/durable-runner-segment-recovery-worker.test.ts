// Child-process fixture for the T04-A safe segment-boundary restart contract.
// The parent terminates this process after the checkpoint is atomically saved,
// before the next segment can issue its first Provider request.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { AgentTool } from '@littlesheep/types';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { createRunner } from './runner.js';

const root = process.env.LS_RUNNER_SEGMENT_RECOVERY_ROOT;

if (root) {
  process.env.LITTLESHEEP_DATA_DIR = root;
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.maxModelCallsPerRun = 64;
  config.agents.defaults.maxToolCallsPerRun = 64;
  config.agents.defaults.maxToolLoopIterationsPerRun = 60;

  let completed = 0;
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const prompt = request.messages.map((message) => (
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )).join('\n');
    if (prompt.includes('Choose the next LittleSheep activity')) {
      return textResponse('{"type":"problem","confidence":0.99,"reason":"segment crash fixture"}');
    }
    if (completed < 35) {
      return {
        content: '',
        toolCalls: [{
          id: `segment-recovery-${completed + 1}`,
          type: 'function',
          function: { name: 'record_progress', arguments: JSON.stringify({ step: completed + 1 }) },
        }],
        finishReason: 'tool_calls',
      };
    }
    return textResponse('All recovery fixture operations completed.');
  };
  const llm: LlmClient = {
    chat,
    chatStream: async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const response = await chat(request);
      for (const delta of response.content.match(/.{1,3}/g) ?? []) onDelta({ type: 'delta', delta });
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const recordProgress: AgentTool = {
    name: 'record_progress',
    description: 'Record one deterministic fixture operation.',
    inputSchema: z.object({ step: z.number().int() }).strict(),
    async execute(input) {
      const step = Number((input as { step: number }).step);
      writeFileSync(join(workspace, `step-${String(step).padStart(2, '0')}.txt`), `completed:${step}\n`, 'utf8');
      completed += 1;
      return { callId: '', ok: true, output: `completed step ${step}` };
    },
  };

  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/segment-recovery',
    llm,
    approve: async () => true,
    skillsDirs: [],
  });
  const store = runner.infra.runCheckpointStore!;
  const write = store.write.bind(store);
  store.write = async (checkpoint) => {
    const outcome = await write(checkpoint);
    if (checkpoint.loopBudget.executionSegmentIndex === 2
      && checkpoint.loopBudget.toolLoopIterationsUsed === 30
      && checkpoint.reason === 'execution-segment-started') {
      process.stdout.write(`LS_RUNNER_SEGMENT_CHECKPOINT:${checkpoint.sessionId}:${checkpoint.runId}:${checkpoint.id}\n`);
      await new Promise<never>(() => undefined);
    }
    return outcome;
  };
  await runner.run({
    runId: 's2b-t04a-process-restart',
    text: 'Complete all 35 independently verifiable fixture operations.',
    cwd: workspace,
    additionalTools: [recordProgress],
  });
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}
