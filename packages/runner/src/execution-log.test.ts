// @littlesheep/runner — execution-log.test.ts
// Verifies ExecutionLogStore: write/read round-trip, error resilience,
// tool-call pairing, and list() behavior.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExecutionLogStore } from './execution-log.js';
import type { Message } from '@littlesheep/types';

let dir: string;
let store: ExecutionLogStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ls-exec-'));
  store = new ExecutionLogStore({ rootDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ExecutionLogStore', () => {
  it('write → read 往返一致', async () => {
    const input = {
      runId: 'run-1',
      sessionId: 's1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'ok' as const,
      model: 'test',
      inboundText: 'hello',
      reply: 'hi',
      trace: [{ name: 'enter' as const, startedAt: '', endedAt: '', ok: true }],
      messages: [],
      durationMs: 5000,
    };
    await store.write(input);
    const log = await store.read('run-1');
    expect(log).not.toBeNull();
    expect(log!.runId).toBe('run-1');
    expect(log!.sessionId).toBe('s1');
    expect(log!.reply).toBe('hi');
    expect(log!.inboundText).toBe('hello');
    expect(log!.status).toBe('ok');
    expect(log!.durationMs).toBe(5000);
    expect(log!.toolCalls).toEqual([]);
  });

  it('read 不存在的 runId → null', async () => {
    const log = await store.read('nonexistent');
    expect(log).toBeNull();
  });

  it('read 损坏文件 → null（不抛异常）', async () => {
    writeFileSync(join(dir, 'bad.json'), '{not valid json');
    const log = await store.read('bad');
    expect(log).toBeNull();
  });

  it('extractToolCallPairs 正确配对 call+result', async () => {
    const callId = randomUUID();
    const messages: Message[] = [
      {
        id: randomUUID(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_calls', calls: [{ id: callId, name: 'read', input: { path: '/x' } }] },
        ],
      },
      {
        id: randomUUID(),
        role: 'tool',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_result', result: { callId, ok: true, output: 'data' } },
        ],
      },
    ];
    await store.write({
      runId: 'run-2',
      sessionId: 's1',
      startedAt: '',
      endedAt: '',
      status: 'ok',
      model: 't',
      inboundText: '',
      reply: '',
      trace: [],
      messages,
      durationMs: 0,
    });
    const log = await store.read('run-2');
    expect(log!.toolCalls).toHaveLength(1);
    expect(log!.toolCalls[0]!.call.name).toBe('read');
    expect(log!.toolCalls[0]!.call.input).toEqual({ path: '/x' });
    expect(log!.toolCalls[0]!.result.ok).toBe(true);
    expect(log!.toolCalls[0]!.result.output).toBe('data');
  });

  it('未配对的 call（无 result）被忽略', async () => {
    const messages: Message[] = [
      {
        id: randomUUID(),
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: [
          { type: 'tool_calls', calls: [{ id: 'orphan', name: 'read', input: {} }] },
        ],
      },
    ];
    await store.write({
      runId: 'run-3',
      sessionId: 's1',
      startedAt: '',
      endedAt: '',
      status: 'ok',
      model: 't',
      inboundText: '',
      reply: '',
      trace: [],
      messages,
      durationMs: 0,
    });
    const log = await store.read('run-3');
    expect(log!.toolCalls).toEqual([]);
  });

  it('list 返回所有 runId', async () => {
    await store.write({
      runId: 'a', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: '', trace: [], messages: [], durationMs: 0,
    });
    await store.write({
      runId: 'b', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: '', trace: [], messages: [], durationMs: 0,
    });
    const ids = await store.list();
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('list 空目录 → []', async () => {
    const emptyStore = new ExecutionLogStore({ rootDir: join(dir, 'noexist') });
    const ids = await emptyStore.list();
    expect(ids).toEqual([]);
  });

  it('persists clarification request and response metadata', async () => {
    const clarificationRequest = {
      id: 'run-4:clarification',
      kind: 'missing_information' as const,
      sourceStage: 'decide' as const,
      createdAt: '2026-07-10T00:00:00.000Z',
      originalRequest: 'edit it',
      blockingReason: 'target missing',
      questions: [{ id: 'question-1', field: 'path', prompt: 'Which file?', required: true }],
    };
    const clarificationResponse = {
      requestId: 'prior:clarification',
      answer: 'README.md',
      answeredAt: '2026-07-10T00:01:00.000Z',
    };
    await store.write({
      runId: 'run-4', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: 'Which file?', trace: [], messages: [], durationMs: 0,
      clarificationRequest,
      clarificationResponse,
    });

    const log = await store.read('run-4');
    expect(log?.clarificationRequest).toEqual(clarificationRequest);
    expect(log?.clarificationResponse).toEqual(clarificationResponse);
  });

  it('persists partial replan history inside task execution evidence', async () => {
    await store.write({
      runId: 'run-replan', sessionId: 's', startedAt: '', endedAt: '', status: 'ok',
      model: '', inboundText: '', reply: 'done', trace: [], messages: [], durationMs: 0,
      taskExecution: {
        goal: 'finish the task',
        complexity: 'standard',
        status: 'done',
        startedAt: '2026-07-10T00:00:00.000Z',
        steps: [{
          stepId: 'step-1', description: 'finish it', status: 'done', attempt: 2,
          startedAt: '2026-07-10T00:00:02.000Z', output: 'done', toolCallIds: [], toolResults: [],
        }],
        replanHistory: [{
          attempt: 1,
          requestedAt: '2026-07-10T00:00:01.000Z',
          targetStepIds: ['step-1'],
          reason: 'first attempt incomplete',
          feedback: 'retry with evidence',
          preservedStepIds: [],
          revisedStepIds: ['step-1'],
          decidedAt: '2026-07-10T00:00:01.500Z',
          resumedAt: '2026-07-10T00:00:02.000Z',
        }],
      },
    });

    const log = await store.read('run-replan');
    expect(log?.taskExecution?.steps[0]?.attempt).toBe(2);
    expect(log?.taskExecution?.replanHistory?.[0]?.targetStepIds).toEqual(['step-1']);
  });

  it('persists the task contract and every verification outcome', async () => {
    const taskBook = {
      assessment: {
        userNeed: 'inspect the project', complexity: 'standard' as const, goal: 'inspect the project',
        successCriteria: ['inspection is verified'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
      },
      goal: 'inspect the project', complexity: 'standard' as const,
      successCriteria: ['inspection is verified'],
      steps: [{ id: 'step-1', description: 'inspect files', status: 'done' as const }],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'stay focused' },
      stageResults: [],
    };
    const verificationHistory = [{
      attempt: 1, verdict: 'pass' as const, reason: 'evidence satisfies the contract',
      verifiedAt: '2026-07-11T01:00:03.000Z', source: 'model' as const,
    }];
    await store.write({
      runId: 'run-contract', sessionId: 's', startedAt: '2026-07-11T01:00:00.000Z',
      endedAt: '2026-07-11T01:00:04.000Z', status: 'ok', model: 'test/model',
      inboundText: 'inspect it', reply: 'inspection complete', trace: [], messages: [], durationMs: 4_000,
      taskBook,
      verificationHistory,
    });

    const log = await store.read('run-contract');
    expect(log?.taskBook).toMatchObject({ goal: 'inspect the project', successCriteria: ['inspection is verified'] });
    expect(log?.taskBook?.stageResults).toBeUndefined();
    expect(log?.verificationHistory).toEqual(verificationHistory);
  });
});
