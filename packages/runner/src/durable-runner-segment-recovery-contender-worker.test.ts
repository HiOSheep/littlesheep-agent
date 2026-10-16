import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { asSessionId } from '@littlesheep/types';
import { createRunner } from './runner.js';

const root = process.env.LS_RUNNER_SEGMENT_RECOVERY_ROOT;
const workerId = process.env.LS_RUNNER_SEGMENT_RECOVERY_CONTENDER;
const sessionId = process.env.LS_RUNNER_SEGMENT_RECOVERY_SESSION;
const runId = process.env.LS_RUNNER_SEGMENT_RECOVERY_RUN;

describe('same-Run recovery contender process', () => {
  it.skipIf(!root || !workerId || !sessionId || !runId)('starts Harness only after both processes are ready to contend', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!;
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.maxModelCallsPerRun = 64;
    config.agents.defaults.maxToolCallsPerRun = 64;
    config.agents.defaults.maxToolLoopIterationsPerRun = 60;
    const workspace = join(root!, 'workspace');
    let providerCalls = 0;
    const toolResultCounts: number[] = [];
    const llm = contenderLlm(workspace, () => {
      providerCalls += 1;
    }, toolResultCounts);
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/segment-recovery',
      llm,
      approve: async () => true,
      skillsDirs: [],
    });
    const barrier = join(root!, 'recovery-contender-barrier');
    await mkdir(barrier, { recursive: true });
    await writeFile(join(barrier, `${workerId}.ready`), process.pid.toString(), 'utf8');
    try {
      await waitForBothContenders(barrier);
      let status: 'completed' | 'ownership_conflict' | 'failed' = 'failed';
      let error: string | undefined;
      try {
        const recovery = await runner.recoverDurableRun!(asSessionId(sessionId!), runId!);
        status = recovery.projection.status === 'completed' ? 'completed' : 'failed';
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (/owned by another process|still owned until/iu.test(error)) status = 'ownership_conflict';
        else throw caught;
      }
      await writeFile(join(root!, `recovery-${workerId}.json`), JSON.stringify({
        status,
        providerCalls,
        toolResultCounts,
        ...(error ? { error } : {}),
      }), 'utf8');
      expect(['completed', 'ownership_conflict']).toContain(status);
    } finally {
      await runner.shutdown();
    }
  }, 240_000);
});

function contenderLlm(workspace: string, onCall: () => void, toolResultCounts: number[]): LlmClient {
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    onCall();
    toolResultCounts.push(request.messages.filter((message) => message.role === 'tool').length);
    return fixtureResponse(request, workspace);
  };
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}

function fixtureResponse(request: ChatRequest, workspace: string): ChatResponse {
  const prompt = request.messages.map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n');
  const completed = request.messages.filter((message) => message.role === 'tool').length;
  if (completed === 0 && prompt.includes('Choose the next LittleSheep activity')) {
    return { content: '{"type":"problem","confidence":0.99,"reason":"segment recovery fixture"}', toolCalls: [], finishReason: 'stop' };
  }
  if (completed < 35) {
    const step = completed + 1;
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
  return { content: 'All 35 recovery fixture operations completed.', toolCalls: [], finishReason: 'stop' };
}

async function waitForBothContenders(barrier: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (existsSync(join(barrier, 'alpha.ready')) && existsSync(join(barrier, 'beta.ready'))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error('both recovery contenders did not reach the synchronized start barrier');
}
