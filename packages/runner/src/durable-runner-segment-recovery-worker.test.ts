// Child-process fixture for the T04-A safe segment-boundary restart contract.
// The parent terminates this process after the checkpoint is atomically saved,
// before the next segment can issue its first Provider request.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
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

  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    return nextFixtureResponse(request, workspace);
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
  const runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/segment-recovery',
    llm,
    approve: async () => true,
    skillsDirs: [],
  });
  const eventStore = runner.infra.durableEventStore;
  const appendEvent = eventStore.append.bind(eventStore);
  eventStore.append = async (event) => {
    const outcome = await appendEvent(event);
    if (event.type === 'checkpoint_written' && typeof event.payload.checkpointId === 'string') {
      const checkpoint = await runner.infra.runCheckpointStore!.read(event.payload.checkpointId);
      if (checkpoint?.loopBudget.executionSegmentIndex === 2
        && checkpoint.loopBudget.toolLoopIterationsUsed === 30
        && checkpoint.reason === 'execution-segment-started'
        && checkpoint.safeSegmentBoundary?.kind === 'execution_segment') {
        process.stdout.write(`LS_RUNNER_SEGMENT_CHECKPOINT:${checkpoint.sessionId}:${checkpoint.runId}:${checkpoint.id}\n`);
        await new Promise<never>(() => undefined);
      }
    }
    return outcome;
  };
  await runner.run({
    runId: 's2b-t04a-process-restart',
    text: '创建 result.out，内容必须为 hello。',
    cwd: workspace,
  });
}

function nextFixtureResponse(request: ChatRequest, workspace: string): ChatResponse {
  const prompt = request.messages.map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n');
  const completed = request.messages.filter((message) => message.role === 'tool').length;
  if (completed === 0 && prompt.includes('Choose the next LittleSheep activity')) {
    return textResponse('{"type":"problem","confidence":0.99,"reason":"segment crash fixture"}');
  }
  if (completed === 0) {
    return {
      content: '',
      toolCalls: [{
        id: 'segment-recovery-create-outcome-target',
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.out', content: 'hello' }) },
      }],
      finishReason: 'tool_calls',
    };
  }
  if (completed <= 34) {
    const step = completed;
    return {
      content: '',
      toolCalls: [{
        id: `segment-recovery-${step}`,
        type: 'function',
        function: {
          name: 'write',
          arguments: JSON.stringify({
            file_path: join(workspace, `step-${String(step).padStart(2, '0')}.txt`),
            content: `completed:${step}\n`,
          }),
        },
      }],
      finishReason: 'tool_calls',
    };
  }
  if (completed === 35) {
    return {
      content: '',
      toolCalls: [{
        id: 'segment-recovery-outcome-check',
        type: 'function',
        function: { name: 'runtime_check_file_content', arguments: '{}' },
      }],
      finishReason: 'tool_calls',
    };
  }
  return textResponse('All 35 recovery fixture operations completed.');
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}
