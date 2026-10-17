import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { asSessionId } from '@littlesheep/types';
import { createRunner } from './runner.js';

const root = process.env.LS_S2C_D_ROOT;

describe('S2C-D Task Outcome crash worker', () => {
  it.skipIf(!root)('pauses after the selected durable boundary', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!;
    const mode = process.env.LS_S2C_D_MODE;
    const phase = process.env.LS_S2C_D_PHASE;
    const workspace = join(root!, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/s2c-d-outcome-crash',
      llm: fileTaskLlm(),
      skillsDirs: [],
    });
    const runId = process.env.LS_S2C_D_RUN ?? 's2c-d-task-outcome-crash';
    const eventStore = runner.infra.durableEventStore;
    const append = eventStore.append.bind(eventStore);
    let taskOutcomeDurable = false;
    eventStore.append = async (event) => {
      if (mode === 'run' && phase === 'external_change_before_outcome'
        && event.type === 'task_outcome_settled') {
        writeFileSync(join(workspace, 'result.txt'), 'goodbye', 'utf8');
      }
      if (mode === 'recover' && phase === 'after_run_completed' && event.type === 'run_completed') {
        const result = await append(event);
        await pause(`${event.sessionId}:${event.runId}:${event.type}`);
        return result;
      }
      if (mode === 'run' && phase === 'before_run_completed' && event.type === 'run_completed') {
        await pause(`${event.sessionId}:${event.runId}:${event.type}:before`);
        return append(event);
      }
      const result = await append(event);
      if (mode === 'run' && event.type === 'task_outcome_settled') taskOutcomeDurable = true;
      if (mode === 'run' && phase === 'after_final_reply_proposed' && event.type === 'final_reply_proposed') {
        await pause(`${event.sessionId}:${event.runId}:${event.type}`);
      }
      if (mode === 'run' && phase === 'after_task_outcome_settled' && event.type === 'task_outcome_settled') {
        await pause(`${event.sessionId}:${event.runId}:${event.type}`);
      }
      if (mode === 'run' && phase === 'after_run_completed' && event.type === 'run_completed') {
        await pause(`${event.sessionId}:${event.runId}:${event.type}`);
      }
      return result;
    };

    if (mode === 'run' && phase === 'after_execution_log_write') {
      const store = runner.infra.executionLogStore;
      const write = store.write.bind(store);
      store.write = async (input) => {
        const result = await write(input);
        if (input.runId === runId && taskOutcomeDurable) {
          await pause(`${input.sessionId}:${input.runId}:execution_log_written`);
        }
        return result;
      };
    }

    try {
      if (mode === 'run') {
        const session = await runner.sessionManager.create('test/s2c-d-outcome-crash');
        writeFileSync(join(root!, 'identity.json'), JSON.stringify({ sessionId: String(session.id), runId }), 'utf8');
        process.stdout.write(`LS_S2C_D_IDENTITY:${String(session.id)}:${runId}\n`);
        await waitForFile(join(root!, 'begin-run'));
        await runner.run({
          sessionId: session.id,
          runId,
          text: '创建 result.txt，内容必须为 hello。',
          cwd: workspace,
          origin: 'test',
          approve: async () => true,
          permissionPreset: 'workspace-write',
          permissionPolicyV2: {
            version: 2,
            preset: 'workspace-write',
            approvalPolicy: 'prompt',
            workspaceRoot: workspace,
            protectedRoots: [],
            constraints: { workspaceFileWrites: 'available', shellIsolation: 'unavailable' },
            fullAccessConfirmed: false,
          },
        });
      } else if (mode === 'recover') {
        const sessionId = process.env.LS_S2C_D_SESSION;
        if (!sessionId) throw new Error('recovery worker missing session identity');
        await runner.recoverDurableRun!(asSessionId(sessionId), runId);
      } else {
        throw new Error(`unknown worker mode: ${String(mode)}`);
      }
      process.stdout.write(`LS_S2C_D_WORKER_RETURNED:${runId}\n`);
    } finally {
      await runner.shutdown();
    }
  }, 120_000);
});

function pause(suffix: string): Promise<never> {
  process.stdout.write(`LS_S2C_D_CRASH_READY:${suffix}\n`);
  return new Promise<never>(() => undefined);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fileTaskLlm(): LlmClient {
  const responses: ChatResponse[] = [
    {
      content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 's2c-d-write', type: 'function', function: {
        name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: 'hello' }),
      } }],
    },
    {
      content: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 's2c-d-check', type: 'function', function: {
        name: 'runtime_check_file_content', arguments: '{}',
      } }],
    },
    { content: '文件已按请求检查。', toolCalls: [], finishReason: 'stop' },
  ];
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => responses.shift()
    ?? { content: 'fixture response exhausted', toolCalls: [], finishReason: 'stop' };
  return {
    chat,
    chatStream: async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const response = await chat(request);
      if (response.content) onDelta({ type: 'delta', delta: response.content });
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}
