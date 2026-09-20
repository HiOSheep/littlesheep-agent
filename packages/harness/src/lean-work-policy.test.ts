import { describe, expect, it } from 'vitest';
import { textMessage, type Classification } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import {
  canUseLeanWorkLoop,
  isSupportedWorkPolicy,
  resolveExecutionWorkPolicy,
  selectWorkPolicy,
} from './lean-work-policy.js';

function action(reason = 'diagnostic prose'): Classification {
  return {
    activity: 'execute',
    type: 'problem',
    confidence: 0.8,
    source: 'rules',
    reasonCode: 'action_request',
    reason,
  };
}

describe('work policy', () => {
  it.each([true, false])('does not let transcript subscription select execution policy (%s)', (stream) => {
    const ctx = makeCtx({ inbound: textMessage('user', '帮我写一个函数'), classification: action() });
    ctx.streamModelTranscript = stream;
    expect(selectWorkPolicy(ctx, ctx.classification!)).toMatchObject({
      version: 1,
      route: 'execute',
      executionMode: 'bounded_loop',
      reasonCode: 'bounded_single_goal',
    });
  });

  it('does not branch on human-readable classifier prose', () => {
    const ctx = makeCtx({ inbound: textMessage('user', '帮我写一个函数') });
    expect(selectWorkPolicy(ctx, action('action verb')).executionMode).toBe('bounded_loop');
    expect(selectWorkPolicy(ctx, action('执行一个明确任务')).executionMode).toBe('bounded_loop');
  });

  it.each([
    ['请使用 write 工具写入一个文件', 'explicit_tool_instruction'],
    ['请使用 glob 工具列出当前工作区顶层条目', 'explicit_tool_instruction'],
    ['write a small file', 'action_request'],
    ['create a single-page game', 'action_request'],
  ] as const)('admits one clear bounded action without DECIDE: %s', (text, reasonCode) => {
    const ctx = makeCtx({ inbound: textMessage('user', text) });
    const classification: Classification = {
      activity: 'execute',
      type: 'problem',
      confidence: reasonCode === 'explicit_tool_instruction' ? 0.96 : 0.8,
      source: 'rules',
      reasonCode,
      reason: 'stable display prose',
    };
    expect(selectWorkPolicy(ctx, classification)).toMatchObject({
      executionMode: 'bounded_loop',
      reasonCode: 'bounded_single_goal',
    });
  });

  it.each([
    ['重构整个项目架构并迁移所有文件', 'complex_scope'],
    [`帮我写一个函数${'x'.repeat(2_100)}`, 'large_request'],
    ['搜索今天的公开新闻', 'retrieval_required'],
  ] as const)('keeps %s in the single main loop with an explanatory reason code', (text, reasonCode) => {
    const ctx = makeCtx({ inbound: textMessage('user', text) });
    expect(selectWorkPolicy(ctx, action())).toMatchObject({ executionMode: 'bounded_loop', reasonCode });
  });

  it('requires a supported persisted policy but has an explicit legacy checkpoint interpretation', () => {
    const legacy = makeCtx({ inbound: textMessage('user', '帮我写一个函数'), classification: action() });
    legacy.resumedFromCheckpointId = 'checkpoint-legacy';
    expect(resolveExecutionWorkPolicy(legacy)).toMatchObject({
      executionMode: 'bounded_loop',
      reasonCode: 'legacy_checkpoint',
    });

    const invalid = makeCtx({ inbound: textMessage('user', '帮我写一个函数'), classification: action() });
    invalid.classification!.workPolicy = { version: 2 } as never;
    expect(() => canUseLeanWorkLoop(invalid)).toThrow(/unsupported work policy/);
  });

  it('rejects malformed policy shapes at the persisted boundary', () => {
    expect(isSupportedWorkPolicy({
      version: 1,
      route: 'execute',
      sourceMessageId: 'message-1',
      reasonCode: 'bounded_single_goal',
    })).toBe(false);
    expect(isSupportedWorkPolicy({
      version: 1,
      route: 'respond',
      sourceMessageId: 'message-1',
      executionMode: 'bounded_loop',
      reasonCode: 'greeting',
    })).toBe(false);
  });
});
