import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunner } from './runner.js';
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { asSessionId } from '@littlesheep/types';

function taskLlm(writeContent: string, includeCheck = true, afterCheckContent?: string, workspace?: string): LlmClient {
  const responses: ChatResponse[] = [
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'task-outcome-write',
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: writeContent }) },
      }],
    },
    ...(includeCheck ? [{
      content: '',
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'task-outcome-check',
        type: 'function' as const,
        function: { name: 'runtime_check_file_content', arguments: '{}' },
      }],
    }] : []),
    ...(afterCheckContent !== undefined ? [{
      content: '',
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'task-outcome-read-before-rewrite',
        type: 'function' as const,
        function: { name: 'read', arguments: JSON.stringify({ file_path: join(workspace ?? '', 'result.txt') }) },
      }],
    }, {
      content: '',
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'task-outcome-write-after-check',
        type: 'function' as const,
        function: { name: 'write', arguments: JSON.stringify({ file_path: 'result.txt', content: afterCheckContent }) },
      }],
    }] : []),
    { content: '已执行文件检查。', toolCalls: [], finishReason: 'stop' },
  ];
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => responses.shift()
    ?? { content: '完成。', toolCalls: [], finishReason: 'stop' };
  const chatStream = async (
    request: ChatRequest,
    onDelta: (chunk: StreamChunk) => void,
  ): Promise<ChatResponse> => {
    const response = await chat(request);
    for (const delta of response.content.match(/.{1,3}/g) ?? []) onDelta({ type: 'delta', delta });
    onDelta({ type: 'done', finishReason: response.finishReason });
    return response;
  };
  return { chat, chatStream, embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }) };
}

let dataDir = '';
const runners: Array<{ shutdown(): Promise<void> }> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-task-outcome-runner-'));
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  runners.length = 0;
});

afterEach(async () => {
  for (const runner of runners) await runner.shutdown().catch(() => undefined);
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Task Outcome through Runner, Harness, and Tools', () => {
  async function runFileTask(actualContent: string, includeCheck = true, afterCheckContent?: string) {
    const workspace = join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/task-outcome',
      llm: taskLlm(actualContent, includeCheck, afterCheckContent, workspace),
      skillsDirs: [],
    });
    runners.push(runner);
    const result = await runner.run({
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
    return { runner, result, workspace };
  }

  it('records a real failed file-content check after a successful write effect', async () => {
    const { runner, result, workspace } = await runFileTask('goodbye');
    expect(result.status).toBe('ok');
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('goodbye');
    expect(result.taskOutcome).toMatchObject({
      execution: { status: 'completed' },
      requirementInventory: 'complete',
      status: 'partially_completed',
      requirements: [{ status: 'failed', reasonCode: 'file_content_mismatch' }],
      artifacts: [{ resourceRef: 'workspace:result.txt', verification: 'failed', effectRef: expect.stringMatching(/^effect:/u) }],
    });
    expect(result.toolInvocations?.find((invocation) => invocation.toolName === 'runtime_check_file_content')?.toolSource)
      .toBe('run-scoped');
    const receipt = result.taskOutcome!.evidence.find((evidence) => evidence.kind === 'file_state');
    expect(receipt?.contentHash).toBe(createHash('sha256').update('goodbye').digest('hex'));
    expect(result.taskOutcome!.evidence.some((evidence) => evidence.kind === 'settled_effect')).toBe(true);
    const replayed = await runner.replay(result.runId);
    expect(replayed?.taskOutcome).toEqual(result.taskOutcome);
    const projection = await runner.infra.durableEventStore.read(String(result.sessionId), result.runId);
    expect(projection.filter((event) => event.type === 'task_outcome_settled')).toHaveLength(1);
    expect(projection.findIndex((event) => event.type === 'task_outcome_settled'))
      .toBeLessThan(projection.findIndex((event) => event.type === 'final_reply_settled'));
    await expect(runner.replayTaskOutcome!(asSessionId(result.sessionId), result.runId)).resolves.toEqual(result.taskOutcome);
  });

  it('marks the requirement passed only after the checker reads matching file bytes', async () => {
    const { result, workspace } = await runFileTask('hello');
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('hello');
    expect(result.taskOutcome).toMatchObject({
      status: 'completed',
      requirements: [{ status: 'passed' }],
      artifacts: [{ verification: 'passed' }],
    });
  });

  it('keeps a successful write unverified when no independent check ran', async () => {
    const { result, workspace } = await runFileTask('hello', false);
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('hello');
    expect(result.status).toBe('ok');
    expect(result.taskOutcome).toMatchObject({
      status: 'partially_completed',
      requirements: [{ status: 'unverified', reasonCode: 'no_independent_check' }],
    });
    expect(result.taskOutcome!.evidence).toEqual([]);
  });

  it('invalidates a check when a later successful write changes the same file', async () => {
    const { result, workspace } = await runFileTask('hello', true, 'goodbye');
    const writes = result.toolInvocations?.filter((invocation) => invocation.toolName === 'write') ?? [];
    expect(writes.map((invocation) => invocation.status)).toEqual(['succeeded', 'succeeded']);
    expect(readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('goodbye');
    expect(result.taskOutcome).toMatchObject({
      status: 'partially_completed',
      requirements: [{ status: 'unverified', reasonCode: 'no_independent_check' }],
    });
    expect(result.taskOutcome!.evidence).toEqual([]);
  });
});
