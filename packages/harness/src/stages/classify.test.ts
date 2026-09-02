import { describe, expect, it } from 'vitest';
import { textMessage } from '@littlesheep/types';
import { createClassifyStage } from './classify.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

describe('classifyStage', () => {
  it('bypasses the generic classifier for a structurally bound checkpoint answer', async () => {
    const llm = createMockLlm(textResponse('{"activity":"clarify"}'));
    const stage = createClassifyStage({ llm, model: 'test/model' });
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
      next: 'decide',
      ok: true,
      meta: { continuationGuard: true, checkpointId: 'checkpoint-1', requestId: 'request-1' },
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('corrects a classifier respond result to execute for a fresh Web request', async () => {
    const llm = createMockLlm(textResponse('{"activity":"respond","confidence":0.9,"reason":"chat"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', '查一下今天的公开新闻') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'decide', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'execute', retrievalIntent: 'web_search' });
  });

  it('corrects a classifier execute result to respond for a capability question', async () => {
    const llm = createMockLlm(textResponse('{"activity":"execute","confidence":0.9,"reason":"search"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', 'LS 支持网络搜索吗？') });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'reply', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'respond', retrievalIntent: 'capability_question' });
  });

  it('routes a requested capability probe deterministically and emits probe evidence', async () => {
    const llm = createMockLlm(textResponse('should not be called'));
    const events: import('@littlesheep/types').ToolStreamEvent[] = [];
    const durableEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const stage = createClassifyStage({ llm, model: 'test/model' });
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
      await expect(createClassifyStage({ llm, model: 'test/model' })(ctx)).resolves.toMatchObject({
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
  ])('keeps %s on a local retrieval route', async (message, retrievalIntent) => {
    const llm = createMockLlm(textResponse('{"activity":"execute","confidence":0.9,"reason":"local"}'));
    const stage = createClassifyStage({ llm, model: 'test/model', rulesConfidenceThreshold: 2 });
    const ctx = makeCtx({ inbound: textMessage('user', message) });

    await expect(stage(ctx)).resolves.toMatchObject({ next: 'decide', ok: true });
    expect(ctx.classification).toMatchObject({ activity: 'execute', retrievalIntent });
  });
});
