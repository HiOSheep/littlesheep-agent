// The Runtime environment brief (CE-13).
//
// The model has to know what the run is actually routed to — which provider and
// model are answering, which directory its relative paths resolve under, which
// shell its commands run in, and what the permission and network limits are —
// without probing the environment or asking the user. It has to be told once per
// effective state, not once per request, and the fact it was told must survive a
// restart through the same transcript replay everything else uses.
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import type { Message, ResolvedRunConfig, RunContext } from '@littlesheep/types';
import { describeExecutionShell } from '@littlesheep/tools';
import { makeCtx } from './tests/helpers.js';
import { buildRunRequestCandidates } from './context-candidates.js';
import { prepareModelRequest } from './model-observability.js';
import {
  RUNTIME_CONTEXT_TAIL_ID,
  currentRuntimeContextFields,
  lastRuntimeContextNotice,
  recordRuntimeContextNotice,
  renderRuntimeContextNotice,
} from './runtime-context-notice.js';
import { RunTailLedger } from './run-tail-ledger.js';

function resolvedConfig(overrides: Partial<ResolvedRunConfig> = {}): ResolvedRunConfig {
  return {
    version: 1,
    runId: 'run-1',
    resolvedAt: '2026-09-23T00:00:00.000Z',
    origin: 'app',
    behaviorModeId: 'general',
    permissionPolicyId: 'research',
    workflowStrategyId: 'bounded-loop',
    contextStrategyId: 'legacy-stage-assembly-v1',
    memoryStrategyId: 'index-first-v1',
    toolSelectionStrategyId: 'registered-tools-v1',
    outputContractId: 'user-reply-v1',
    provider: 'provider-a',
    model: 'model-a',
    reasoning: 'auto',
    parameters: {},
    availableToolNames: ['read', 'glob'],
    approvalRequiredToolNames: [],
    networkPolicy: { enabled: true, mode: 'search', providerId: 'tavily' },
    userOverrides: {},
    projectOverrides: {},
    ...overrides,
  } as ResolvedRunConfig;
}

function runContext(options: {
  cwd?: string;
  config?: ResolvedRunConfig;
  modelHistory?: Message[];
} = {}): RunContext {
  const ctx = makeCtx({ inbound: textMessage('user', 'keep going') });
  ctx.cwd = options.cwd ?? 'D:\\work\\project';
  ctx.resolvedRunConfig = options.config ?? resolvedConfig();
  ctx.modelHistory = options.modelHistory ?? [];
  return ctx;
}

/** A runtime-tail record as the session transcript stores it. */
function tailRecord(text: string, id = RUNTIME_CONTEXT_TAIL_ID): Message {
  return {
    id: `tail-${id}-${text.length}`,
    role: 'system',
    content: [{ type: 'text', text }],
    timestamp: '2026-09-23T00:00:00.000Z',
    runtimeTail: true,
    runtimeTailId: id,
  };
}

describe('runtime context brief', () => {
  it('states the effective provider, model, workspace, shell, access and tool count', () => {
    const ctx = runContext();

    const notice = renderRuntimeContextNotice(ctx);

    expect(notice).toBeDefined();
    expect(notice).toContain('[Runtime context; effective for this request]');
    expect(notice).toContain('- model: provider-a/model-a');
    expect(notice).toContain('- workspace: D:\\work\\project');
    expect(notice).toContain(`- shell: ${describeExecutionShell().binary}`);
    expect(notice).toContain('- access: permission=research; network=enabled');
    expect(notice).toContain('- tools: 2');
    // Bounded: one header plus the five field lines, and nothing that changes
    // per request (no clock, no counters, no request id).
    expect(notice!.split('\n')).toHaveLength(6);
  });

  it('reads the provider and model from the resolved run config, not the session default', () => {
    const ctx = runContext({ config: resolvedConfig({ provider: 'provider-b', model: 'model-b' }) });

    expect(currentRuntimeContextFields(ctx).model).toBe('provider-b/model-b');
    expect(renderRuntimeContextNotice(ctx)).toContain('- model: provider-b/model-b');
  });

  it('announces a changed model once and names the changed field', () => {
    const previous = renderRuntimeContextNotice(runContext())!;
    const switched = runContext({
      config: resolvedConfig({ provider: 'provider-b', model: 'model-b' }),
      modelHistory: [tailRecord(previous)],
    });

    const notice = renderRuntimeContextNotice(switched);

    expect(notice).toContain('Changed: model.');
    expect(notice).toContain('- model: provider-b/model-b');
    // The unchanged fields still travel, so the brief is self-contained.
    expect(notice).toContain('- workspace: D:\\work\\project');
  });

  it('says nothing when the effective environment has not moved', () => {
    const previous = renderRuntimeContextNotice(runContext())!;
    const unchanged = runContext({ modelHistory: [tailRecord(previous)] });

    expect(renderRuntimeContextNotice(unchanged)).toBeUndefined();
  });

  it('marks a workspace switch and points relative paths at the new directory', () => {
    const previous = renderRuntimeContextNotice(runContext())!;
    const moved = runContext({
      cwd: 'D:\\work\\project with spaces',
      modelHistory: [tailRecord(previous)],
    });

    const notice = renderRuntimeContextNotice(moved);

    expect(notice).toContain('Changed: workspace.');
    expect(notice).toContain('Relative paths now resolve under the current workspace.');
    // The new path is rendered in full: a truncated path would be a wrong path.
    expect(notice).toContain('- workspace: D:\\work\\project with spaces');
  });

  it('reports permission, network and tool-availability changes', () => {
    const previous = renderRuntimeContextNotice(runContext())!;
    const restricted = runContext({
      config: resolvedConfig({
        permissionPolicyId: 'restricted',
        networkPolicy: { enabled: false, mode: 'disabled' },
        availableToolNames: ['read'],
      }),
      modelHistory: [tailRecord(previous)],
    });

    const notice = renderRuntimeContextNotice(restricted);

    expect(notice).toContain('Changed: access, tools.');
    expect(notice).toContain('- access: permission=restricted; network=disabled');
    expect(notice).toContain('- tools: 1');
  });

  it('keeps the latest effective state readable after a restart', () => {
    const first = renderRuntimeContextNotice(runContext())!;
    const switched = runContext({
      config: resolvedConfig({ provider: 'provider-b', model: 'model-b' }),
      modelHistory: [tailRecord(first)],
    });
    const second = renderRuntimeContextNotice(switched)!;

    // A restart replays both records; the newest one is the current state, and
    // the older one stays as the history it is.
    const restarted = runContext({
      config: resolvedConfig({ provider: 'provider-b', model: 'model-b' }),
      modelHistory: [tailRecord(first), tailRecord(second)],
    });

    expect(lastRuntimeContextNotice(restarted)).toMatchObject({ model: 'provider-b/model-b' });
    expect(renderRuntimeContextNotice(restarted)).toBeUndefined();
  });

  it('does not repeat a brief this run already recorded', () => {
    const ctx = runContext();
    const notice = renderRuntimeContextNotice(ctx)!;
    recordRuntimeContextNotice(ctx, notice);

    // A later request in the same run (a capability reply or an ask_user turn)
    // reads the run's own transcript and stays silent.
    expect(renderRuntimeContextNotice(ctx)).toBeUndefined();
    // Recording is idempotent.
    recordRuntimeContextNotice(ctx, notice);
    expect(ctx.produced.filter((message) => message.runtimeTailId === RUNTIME_CONTEXT_TAIL_ID))
      .toHaveLength(1);
  });

  it('appends exactly one tail entry and nothing on the second round', () => {
    const ctx = runContext();
    const ledger = new RunTailLedger();

    const first = ledger.update(ctx);
    const second = ledger.update(ctx);

    expect(first.entries.filter((entry) => entry.id === RUNTIME_CONTEXT_TAIL_ID)).toHaveLength(1);
    expect(second.entries.filter((entry) => entry.id === RUNTIME_CONTEXT_TAIL_ID)).toHaveLength(0);
  });

  it('reaches a capability reply from the same Runtime facts the main loop uses', () => {
    const ctx = runContext({ config: resolvedConfig({ provider: 'provider-b', model: 'model-b' }) });
    const raw: ChatRequest = {
      model: 'provider-b/model-b',
      messages: [
        { role: 'system', content: 'stable policy' },
        { role: 'user', content: '你现在用哪个模型？' },
      ],
      max_tokens: 500,
    };

    const prepared = prepareModelRequest(
      ctx,
      'capability_reply',
      raw,
      buildRunRequestCandidates(ctx, 'reply', raw.messages, { history: [] }),
    );

    const brief = prepared.messages
      .map((message) => String(message.content ?? ''))
      .find((content) => content.includes('[Runtime context; effective for this request]'));
    expect(brief).toContain('- model: provider-b/model-b');
    expect(brief).toContain('- workspace: D:\\work\\project');
  });
});
