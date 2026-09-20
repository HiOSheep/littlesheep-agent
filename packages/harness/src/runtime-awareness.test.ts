// Locks the lean Runtime-facts contract: only Runtime-owned facts that can
// change an answer travel with a request (capability state plus task state and
// progress). The exact clock, elapsed time and repeated tool/run statistics are
// deliberately absent, so the prompt tail does not change on every request.
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

/** The Runtime facts now travel in one trailing message. */
function runtimeBlock(prepared: ChatRequest): string {
  return String(prepared.messages.at(-1)?.content ?? '');
}

const REPLAYED_CLOCK = '2026-07-15T03:04:05.678Z';

describe('runtime facts', () => {
  it('injects task state and capability facts below the cache boundary', () => {
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
    const system = runtimeBlock(prepared);

    // The Runtime facts must stay out of the system prompt so the Provider's
    // prefix cache can cover the system prompt and the whole conversation.
    expect(system.startsWith(CACHE_BOUNDARY_MARKER)).toBe(true);
    expect(String(prepared.messages[0]?.content)).toBe('stable policy');
    expect(system).toContain('task_state: running');
    expect(system).toContain('task_progress: 1/2 completed (50%)');
    // Clock, elapsed time and tool statistics are not judgement inputs and are
    // no longer re-sent on every call.
    expect(system).not.toContain('elapsed');
    expect(system).not.toContain('2026-07-15 11:04:05');
    expect(system).not.toContain('read:succeeded');
    expect(system).not.toContain('current_run_tools');
    expect(ctx.contextSnapshots?.[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runtime-awareness:1',
        kind: 'runtime_event',
        required: true,
        source: expect.objectContaining({ kind: 'runtime_event' }),
      }),
    ]));
  });

  it('sends byte-identical Runtime facts for repeated requests of one run', () => {
    const inbound = 'what is the status?';
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });
    ctx.startedAt = '2026-07-15T03:00:00.000Z';
    ctx.timeZone = 'Asia/Hong_Kong';
    const first = prepareModelRequest(ctx, 'reply', request(inbound));
    const second = prepareModelRequest(ctx, 'reply', request(inbound));

    // A per-request clock used to make this tail unique on every call, which is
    // exactly the uncached content the cache work has to remove.
    expect(runtimeBlock(first)).toBe(runtimeBlock(second));
  });

  it('includes observed capability-probe evidence separately from the capability snapshot', () => {
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
    const system = runtimeBlock(prepared);

    expect(system).toContain('capability_epoch: epoch-probe');
    expect(system).toContain('capability_probe=observed');
    expect(system).toContain('capability_permission_decision: allow');
    expect(system).not.toContain('previous_run');
  });

  it('keeps the per-call Runtime block small and free of execution history', () => {
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

    const block = runtimeBlock(prepareModelRequest(ctx, 'reply', request('status?')));

    // Every call re-sends this block uncached. Measured at 439 characters
    // (~110 tokens) with 12 tools plus a capability snapshot; the old block
    // carried the clock, elapsed time and execution history on top of that and
    // was measured at 705 characters for a reply. Keep it bounded.
    expect(block.length).toBeLessThan(500);
    expect(block).not.toContain('previous_run');
    expect(block).not.toContain('current_run_tools');
  });

  it('uses the compact Runtime facts for a self-contained autonomous read decision', () => {
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
        source: 'llm', reason: 'workspace inspection requires evidence',
      },
    });

    const prepared = prepareModelRequest(ctx, 'decide', request(inbound));
    const system = runtimeBlock(prepared);

    expect(system).toContain('capability_snapshot=unavailable');
    expect(system).not.toContain('- capability_epoch:');
    expect(system).not.toContain('task_progress:');
  });

  it.each([
    '请只回复 LS-PROVIDER-OK',
    '解释一下 HTTP status code 和 result type 的区别',
    'Continue the unfinished task.',
  ])('keeps the compact facts for an ordinary reply: %s', (inbound) => {
    const ctx = makeCtx({ inbound: textMessage('user', inbound) });

    const system = runtimeBlock(prepareModelRequest(ctx, 'reply', request(inbound)));

    expect(system).toContain('# Runtime Facts');
    expect(system).not.toContain('previous_run');
    expect(system).not.toContain('recent_previous_tools');
  });
});
