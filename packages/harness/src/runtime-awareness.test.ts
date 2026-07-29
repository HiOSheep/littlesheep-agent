import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import { textMessage, type SessionRunSummary } from '@littlesheep/types';
import { buildRunRequestCandidates } from './context-candidates.js';
import { prepareModelRequest } from './model-observability.js';
import { makeCtx } from './tests/helpers.js';

function request(content = 'what is the status?'): ChatRequest {
  return {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'stable policy' },
      { role: 'user', content },
    ],
    max_tokens: 900,
  };
}

function previousRunSummary(): SessionRunSummary {
  return {
    version: 1,
    runId: 'previous-run',
    status: 'ok',
    startedAt: '2026-07-15T02:00:00.000Z',
    endedAt: '2026-07-15T02:00:02.500Z',
    durationMs: 2500,
    task: { status: 'done', completedSteps: 2, totalSteps: 2 },
    tools: {
      total: 1, succeeded: 1, failed: 0, totalDurationMs: 700,
      recent: [{ name: 'read', status: 'succeeded', durationMs: 700 }],
      truncated: false,
    },
  };
}

describe('runtime awareness', () => {
  it('injects exact time, progress, and tool timing below the cache boundary', () => {
    const ctx = makeCtx({
      inbound: textMessage('user', 'what is the status?'),
      taskBook: {
        assessment: {
          userNeed: 'finish two steps',
          complexity: 'standard',
          goal: 'finish two steps',
          successCriteria: ['both complete'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1.5,
        },
        goal: 'finish two steps',
        complexity: 'standard',
        successCriteria: ['both complete'],
        steps: [
          { id: 'step-1', title: 'First', description: 'first', status: 'done' },
          { id: 'step-2', title: 'Second', description: 'second', status: 'in_progress' },
        ],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'focused' },
      },
    });
    ctx.startedAt = '2026-07-15T03:03:00.000Z';
    ctx.timeZone = 'Asia/Hong_Kong';
    ctx.runtimeNow = () => new Date('2026-07-15T03:04:05.678Z');
    ctx.taskExecution = {
      goal: 'finish two steps',
      complexity: 'standard',
      status: 'running',
      startedAt: ctx.startedAt,
      steps: [
        {
          stepId: 'step-1', title: 'First', description: 'first', status: 'done',
          startedAt: '2026-07-15T03:03:00.000Z', endedAt: '2026-07-15T03:03:30.000Z',
          toolCallIds: ['call-1'], toolResults: [],
        },
        {
          stepId: 'step-2', title: 'Second', description: 'second', status: 'in_progress',
          startedAt: '2026-07-15T03:03:30.000Z', toolCallIds: [], toolResults: [],
        },
      ],
    };
    ctx.produced = [
      {
        id: 'tool-call-message', role: 'assistant', timestamp: '2026-07-15T03:03:10.000Z',
        content: [{ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', input: { path: 'x' } }] }],
      },
      {
        id: 'tool-result-message', role: 'tool', timestamp: '2026-07-15T03:03:11.250Z',
        content: [{ type: 'tool_result', result: { callId: 'call-1', ok: true, output: 'ok', durationMs: 1250, meta: { stepId: 'step-1' } } }],
      },
    ];

    const raw = request();
    const prepared = prepareModelRequest(
      ctx,
      'reply',
      raw,
      buildRunRequestCandidates(ctx, 'reply', raw.messages, { history: [] }),
    );
    const system = String(prepared.messages[0]?.content);

    expect(system.indexOf(CACHE_BOUNDARY_MARKER)).toBeGreaterThan(system.indexOf('stable policy'));
    expect(system).toContain('local_datetime: 2026-07-15 11:04:05 +08:00');
    expect(system).toContain('run_elapsed: 65678 ms (00:01:05.678)');
    expect(system).toContain('task_progress: 1/2 completed (50%)');
    expect(system).toContain('read:succeeded:1250 ms, step=step-1');
    expect(ctx.contextSnapshots?.[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runtime-awareness:1',
        kind: 'system_prompt',
        required: true,
        source: expect.objectContaining({ kind: 'runtime_event' }),
      }),
    ]));
  });

  it('refreshes the live second for every outbound request and includes the previous run', () => {
    const inbound = 'what is the status of the previous run?';
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });
    ctx.startedAt = '2026-07-15T03:00:00.000Z';
    ctx.timeZone = 'Asia/Hong_Kong';
    let now = new Date('2026-07-15T03:04:05.000Z');
    ctx.runtimeNow = () => now;
    ctx.previousRun = previousRunSummary();

    const first = prepareModelRequest(ctx, 'reply', request(inbound));
    now = new Date('2026-07-15T03:04:06.000Z');
    const second = prepareModelRequest(ctx, 'reply', request(inbound));

    expect(String(first.messages[0]?.content)).toContain('2026-07-15 11:04:05');
    expect(String(second.messages[0]?.content)).toContain('2026-07-15 11:04:06');
    expect(String(second.messages[0]?.content)).toContain('previous_run: id=previous-run');
    expect(String(second.messages[0]?.content)).toContain('read:succeeded:700 ms');
  });

  it('keeps previous-run execution details out of an ordinary direct reply', () => {
    const inbound = 'hello again';
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });
    ctx.previousRun = previousRunSummary();

    const prepared = prepareModelRequest(ctx, 'reply', request(inbound));
    const system = String(prepared.messages[0]?.content);

    expect(system).toContain('# Runtime Clock');
    expect(system).not.toContain('previous_run:');
    expect(system).not.toContain('recent_previous_tools:');
  });
});
