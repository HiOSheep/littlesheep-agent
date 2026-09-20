// Locks the Runtime-facts contract: per-run capability facts are stable, so they
// travel inside the cacheable prefix; only facts that can change mid-run (task
// state, probe results, permission decisions) stay below the cache boundary. The
// exact clock, elapsed time and repeated tool/run statistics stay absent.
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import { textMessage } from '@littlesheep/types';
import { buildRunRequestCandidates } from './context-candidates.js';
import { prepareModelRequest } from './model-observability.js';
import { makeCtx, makeTool } from './tests/helpers.js';

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

/** Stable capability facts: message right after the main system prompt. */
function stableFacts(prepared: ChatRequest): string {
  return String(prepared.messages[1]?.content ?? '');
}

/** Volatile Runtime state: the trailing message when one exists. */
function volatileState(prepared: ChatRequest): string {
  const last = prepared.messages.at(-1);
  return last?.role === 'system' ? String(last.content ?? '') : '';
}

const REPLAYED_CLOCK = '2026-07-15T03:04:05.678Z';

describe('runtime facts', () => {
  it('keeps capability facts inside the cacheable prefix and task state below the boundary', () => {
    const ctx = makeCtx({
      inbound: textMessage('user', '继续执行'),
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
    ctx.runtimeNow = () => new Date(REPLAYED_CLOCK);
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
    const stable = stableFacts(prepared);
    const volatile = volatileState(prepared);

    // Stable facts sit between the system prompt and the conversation, so the
    // Provider can reuse them from its prefix cache.
    expect(String(prepared.messages[0]?.content)).toBe('stable policy');
    expect(stable).toContain('# Runtime Facts');
    expect(stable).toContain('capability_snapshot: unavailable');
    expect(stable).not.toContain(CACHE_BOUNDARY_MARKER);
    // Volatile state stays below the boundary at the tail.
    expect(volatile.startsWith(CACHE_BOUNDARY_MARKER)).toBe(true);
    expect(volatile).toContain('task=running');
    expect(volatile).toContain('task_progress=1/2 (50%)');
    // Clock, elapsed time and tool statistics are not judgement inputs and are
    // no longer sent at all.
    expect(volatile).not.toContain('elapsed');
    expect(volatile).not.toContain('2026-07-15 11:04:05');
    expect(volatile).not.toContain('read:succeeded');
    expect(volatile).not.toContain('current_run_tools');
    expect(ctx.contextSnapshots?.[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runtime-awareness:1:stable',
        kind: 'runtime_event',
        required: true,
        source: expect.objectContaining({ kind: 'runtime_event' }),
      }),
    ]));
  });

  it('sends byte-identical capability facts for repeated requests of one run', () => {
    const inbound = 'what is the status?';
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });
    ctx.startedAt = '2026-07-15T03:00:00.000Z';
    ctx.timeZone = 'Asia/Hong_Kong';
    const first = prepareModelRequest(ctx, 'reply', request(inbound));
    const second = prepareModelRequest(ctx, 'reply', request(inbound));

    // A per-request clock used to make the Runtime block unique on every call;
    // the facts that remain are stable for the whole run.
    expect(stableFacts(first)).toBe(stableFacts(second));
  });

  it('adds no trailing Runtime state when the run has no task book', () => {
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });

    const prepared = prepareModelRequest(ctx, 'reply', request('hello'));

    expect(stableFacts(prepared)).toContain('# Runtime Facts');
    expect(volatileState(prepared)).toBe('');
  });

  it('keeps observed probe evidence and permission decisions below the cache boundary', () => {
    const ctx = makeCtx({ inbound: textMessage('user', '你查询过了吗？') });
    ctx.capabilitySnapshot = {
      version: 1,
      epoch: 'epoch-probe',
      generatedAt: '2026-07-15T03:04:05.000Z',
      permissionPolicyId: 'research',
      workspace: 'available',
      tools: [],
      network: { enabled: true, status: 'ready', providerId: 'tavily' },
    };
    ctx.capabilityProbe = {
      version: 1,
      probeId: 'probe-1',
      kind: 'capability_snapshot',
      status: 'observed',
      capabilityEpoch: 'epoch-probe',
      evidence: 'runtime_snapshot',
    };
    ctx.capabilityPermissionEvent = {
      version: 1,
      eventId: 'permission-1',
      action: 'capability_probe',
      decision: 'allow',
      permissionPolicyId: 'research',
      capabilityEpoch: 'epoch-probe',
      source: 'runtime',
    };

    const capabilityRequest = { ...request(), max_tokens: 500 };
    const prepared = prepareModelRequest(ctx, 'capability_reply', capabilityRequest, buildRunRequestCandidates(ctx, 'reply', capabilityRequest.messages, { history: [] }));

    expect(stableFacts(prepared)).toContain('capability_epoch: epoch-probe');
    expect(stableFacts(prepared)).not.toContain('capability_probe');
    const volatile = volatileState(prepared);
    expect(volatile).toContain('capability_probe=observed');
    expect(volatile).toContain('capability_permission_decision: allow');
    expect(volatile).not.toContain('previous_run');
  });

  it('keeps the per-call trailing Runtime state free of execution history', () => {
    const tools = Array.from({ length: 12 }, (_, index) => makeTool(`tool_${index}`, { ok: true, output: '' }));
    const ctx = makeCtx({ inbound: textMessage('user', 'status?'), tools });
    ctx.capabilitySnapshot = {
      version: 1,
      epoch: 'epoch-size',
      generatedAt: '2026-07-15T03:04:05.000Z',
      permissionPolicyId: 'research',
      workspace: 'available',
      tools: tools.map((tool) => ({ name: tool.name, status: 'available' })),
      network: { enabled: true, status: 'ready', providerId: 'tavily' },
    };

    const prepared = prepareModelRequest(ctx, 'reply', request('status?'));
    const stable = stableFacts(prepared);

    // The stable block is cached after the first request of a prefix, so it can
    // carry the tool list; execution history no longer appears at all.
    // 384 characters (~96 tokens) with 12 tools, now inside the cacheable
    // prefix instead of being re-sent uncached on every request.
    expect(stable.length).toBeLessThan(450);
    expect(stable).toContain('tools=tool_0=available');
    expect(volatileState(prepared)).toBe('');
    expect(stable).not.toContain('previous_run');
    expect(stable).not.toContain('current_run_tools');
  });

  it('uses the compact facts for a self-contained autonomous read decision', () => {
    const inbound = '请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。';
    const tools = [
      makeTool('glob', { ok: true, output: [] }),
      makeTool('grep', { ok: true, output: [] }),
      makeTool('read', { ok: true, output: '' }),
    ];
    const ctx = makeCtx({
      inbound: textMessage('user', inbound),
      tools,
      classification: {
        activity: 'execute', type: 'problem', confidence: 0.95,
        source: 'rules', reason: 'workspace inspection requires evidence',
      },
    });

    const prepared = prepareModelRequest(ctx, 'decide', request(inbound));

    expect(stableFacts(prepared)).toContain('capability_snapshot=unavailable');
    expect(stableFacts(prepared)).not.toContain('- capability_epoch:');
    expect(stableFacts(prepared)).not.toContain('task_progress');
  });

  it.each([
    '请只回复 LS-PROVIDER-OK',
    '解释一下 HTTP status code 和 result type 的区别',
    'Continue the unfinished task.',
  ])('keeps the compact facts for an ordinary reply: %s', (inbound) => {
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });

    const prepared = prepareModelRequest(ctx, 'reply', request(inbound));
    const stable = stableFacts(prepared);

    expect(stable).toContain('# Runtime Facts');
    expect(stable).not.toContain('previous_run');
    expect(stable).not.toContain('recent_previous_tools');
  });
});
