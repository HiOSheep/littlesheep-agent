// @littlesheep/harness — stages/classify.test.ts
// Activity routing is deterministic: rules decide the conversational routes,
// retrieval intent decides the ones that need sources, and everything else goes
// to the single main loop. No path may spend a model request.
import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import { createClassifyStage } from './classify.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

describe('classifyStage', () => {
  it('sends a self-contained single-goal action directly to the lean work loop', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const ctx = makeCtx({ inbound: textMessage('user', '再做一个小游戏吧') });
    ctx.streamModelTranscript = false;

    await expect(createClassifyStage()(ctx))
      .resolves.toMatchObject({ next: 'execute', ok: true });
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      source: 'rules',
      reasonCode: 'action_request',
      workPolicy: { version: 1, executionMode: 'bounded_loop', reasonCode: 'bounded_single_goal' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('sends an unmatched request to the main loop without a routing model call', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const ctx = makeCtx({ inbound: textMessage('user', 'xyzzy') });

    await expect(createClassifyStage()(ctx)).resolves.toMatchObject({ next: 'execute', ok: true });
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      source: 'rules',
      reasonCode: 'deterministic_default_execute',
      workPolicy: { version: 1, executionMode: 'bounded_loop', reasonCode: 'bounded_default' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('keeps history and injected memory while routing without a model call', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const ctx = makeCtx({
      inbound: textMessage('user', '再做一个小游戏吧'),
      history: [textMessage('assistant', '上一个游戏已经完成。')],
      initialMemoryContext: '用户希望小游戏使用单文件 HTML。',
    });
    ctx.streamModelTranscript = false;

    await expect(createClassifyStage()(ctx)).resolves.toMatchObject({ next: 'execute', ok: true });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(ctx.initialMemoryContext).toContain('单文件 HTML');
  });

  it('keeps a complex action request in the single main loop', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const ctx = makeCtx({ inbound: textMessage('user', '重构整个项目架构并迁移所有文件') });
    ctx.streamModelTranscript = true;

    await expect(createClassifyStage()(ctx)).resolves.toMatchObject({ next: 'execute', ok: true });
    expect(ctx.classification?.workPolicy).toMatchObject({
      executionMode: 'bounded_loop',
      reasonCode: 'complex_scope',
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('bypasses the generic rules for a structurally bound checkpoint answer', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const stage = createClassifyStage();
    const ctx = makeCtx({
      inbound: textMessage('user', 'Permission is available; retry.', {
        clarificationResponse: {
          requestId: 'request-1',
          answer: 'Permission is available; retry.',
          answeredAt: '2026-08-14T00:00:00.000Z',
        },
      }),
      clarificationResponse: {
        requestId: 'request-1',
        answer: 'Permission is available; retry.',
        answeredAt: '2026-08-14T00:00:00.000Z',
      },
    });
    ctx.resumedFromCheckpointId = 'checkpoint-1';

    await expect(stage(ctx)).resolves.toMatchObject({
      next: 'execute',
      ok: true,
      meta: { continuationGuard: true, checkpointId: 'checkpoint-1', requestId: 'request-1' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('keeps a fresh Web request in the single main loop with a retrieval reason code', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const stage = createClassifyStage({ rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', '查一下今天的公开新闻') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'execute', ok: true });
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      retrievalIntent: 'web_search',
      workPolicy: { executionMode: 'bounded_loop', reasonCode: 'retrieval_required' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('keeps a capability question on the Runtime-fact reply route', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const stage = createClassifyStage({ rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', 'LS 支持网络搜索吗？') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'reply', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'respond', retrievalIntent: 'capability_question' });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('routes a requested capability probe deterministically and emits probe evidence', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const events: import('@littlesheep/types').ToolStreamEvent[] = [];
    const durableEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const stage = createClassifyStage();
    const ctx = makeCtx({
      inbound: textMessage('user', '你查询过了吗？'),
      appendDurableEvent: async (event) => {
        durableEvents.push({ type: event.type, payload: event.payload });
      },
    });
    ctx.onToolEvent = (event) => events.push(event);
    ctx.capabilitySnapshot = {
      version: 1,
      epoch: 'epoch-1',
      generatedAt: '2026-09-02T00:00:00.000Z',
      permissionPolicyId: 'research',
      workspace: 'available',
      tools: [],
      network: { enabled: false, status: 'disabled' },
    };
    await expect(stage(ctx)).resolves.toMatchObject({ next: 'reply', ok: true });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(ctx.classification).toMatchObject({
      activity: 'respond',
      retrievalIntent: 'capability_probe',
    });
    expect(ctx.capabilityProbe).toMatchObject({ status: 'observed', capabilityEpoch: 'epoch-1' });
    expect(ctx.capabilityPermissionEvent).toMatchObject({ action: 'capability_probe', decision: 'allow' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'capability_probe', visibility: 'silent' });
    expect(durableEvents.map((event) => event.type)).toEqual([
      'capability_snapshot_read',
      'capability_probe_settled',
      'route_decided',
    ]);
    expect(durableEvents[0]?.payload).toMatchObject({
      snapshot: { capabilityEpoch: 'epoch-1', network: { enabled: false, status: 'disabled' } },
    });
    expect(durableEvents[1]?.payload).toMatchObject({
      probeId: expect.any(String), capabilityEpoch: 'epoch-1', evidence: 'runtime_snapshot',
    });
  });

  it('keeps the supplied capability-question conversation on Runtime facts only', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const durableTypes: string[] = [];
    const snapshot = {
      version: 1 as const,
      epoch: 'epoch-stable',
      generatedAt: '2026-09-02T00:00:00.000Z',
      permissionPolicyId: 'research' as const,
      workspace: 'available' as const,
      tools: [],
      network: { enabled: false, status: 'disabled' as const },
    };
    const messages = [
      ['你能调用网络了吗？', 'capability_question'],
      ['现在呢', 'capability_question'],
      ['现在呢', 'capability_question'],
      ['你查询过了吗？', 'capability_probe'],
      ['基于事实，因此你需要查询', 'capability_probe'],
      ['权限给你了啊', 'capability_probe'],
    ] as const;
    for (const [message, retrievalIntent] of messages) {
      const ctx = makeCtx({
        inbound: textMessage('user', message),
        appendDurableEvent: async (event) => { durableTypes.push(event.type); },
      });
      ctx.capabilitySnapshot = snapshot;
      await expect(createClassifyStage()(ctx)).resolves.toMatchObject({
        next: 'reply', ok: true,
      });
      expect(ctx.classification).toMatchObject({ activity: 'respond', retrievalIntent });
    }
    expect(llm.chat).not.toHaveBeenCalled();
    expect(durableTypes).toEqual([
      'capability_snapshot_read', 'route_decided',
      'capability_snapshot_read', 'route_decided',
      'capability_snapshot_read', 'route_decided',
      'capability_snapshot_read', 'capability_probe_settled', 'route_decided',
      'capability_snapshot_read', 'capability_probe_settled', 'route_decided',
      'capability_snapshot_read', 'capability_probe_settled', 'route_decided',
    ]);
  });

  it.each([
    ['搜索我的项目文件里有哪些 web_search 调用', 'local_workspace'],
    ['你还记得我上次的决定吗？', 'local_memory'],
  ])('keeps %s in the single main loop with a local retrieval route', async (message, retrievalIntent) => {
    const llm = createMockLlm(textResponse('should not be called'));
    const stage = createClassifyStage({ rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', message) });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'execute', ok: true });
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      retrievalIntent,
      workPolicy: { executionMode: 'bounded_loop' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  // One execution system: the second executor is deleted, so DECIDE is no longer
  // a registered stage. Routing there would fail at dispatch with "no stage
  // registered for 'decide'", so no classification may produce that route.
  it.each([
    ['user', '再做一个小游戏吧'],
    ['user', 'xyzzy'],
    ['user', '重构整个项目架构并迁移所有文件'],
    ['user', '查一下今天的公开新闻'],
    ['user', '你还记得我上次的决定吗？'],
  ])('never routes %s to the deleted DECIDE stage', async (role, message) => {
    const stage = createClassifyStage({ rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage(role as 'user', message) });

    const result = await stage(ctx);
    expect(result.next).not.toBe('decide');
    expect(['execute', 'reply', 'exit']).toContain(result.next);
  });
});

/**
 * The route cannot be forced from a test context: classify derives the policy by
 * calling selectWorkPolicy, which rebuilds it from ctx, and that function returns
 * 'bounded_loop' on every path. So the invariant is asserted at the source level
 * instead -- a behavioural test here would pass against the old ternary too and
 * would therefore guard nothing.
 */
describe('single-execution-system routing invariant', () => {
  it('derives the execute route without consulting the work-policy mode', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('./classify.ts', import.meta.url), 'utf8'));
    // The deleted ternary read `workPolicy.executionMode` to choose between
    // 'execute' and the no-longer-registered 'decide'. No route may depend on it.
    expect(source).not.toMatch(/next\s*=\s*routed\.workPolicy\.executionMode/u);
    expect(source).not.toMatch(/next\s*=\s*[^\n]*\?\s*'execute'\s*:\s*'decide'/u);
  });

  it('names no stage that the driver does not register', async () => {
    const fs = await import('node:fs/promises');
    const [source, harness] = await Promise.all([
      fs.readFile(new URL('./classify.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../default-harness.ts', import.meta.url), 'utf8'),
    ]);
    const targets = [...source.matchAll(/next\s*[:=]\s*(?:[^\n]*?\?\s*)?'([a-z_]+)'/gu)]
      .map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const stage of new Set(targets)) {
      if (stage === 'exit') continue;
      // 'decide' is intentionally absent: it survives only as a legacy checkpoint
      // name and is mapped to the main loop by resolveCheckpointResumeStage.
      expect(harness).toContain(`stages.set('${stage}'`);
    }
  });
});
