import { describe, expect, it } from 'vitest';
import { textMessage, type Classification } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import {
  isSupportedPersistedWorkPolicy,
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

  // The persisted boundary is the only place a retired execution mode is still accepted, and accepting it
  // is not the same as running it: the gate hands back the persisted shape, and nothing in the live path
  // reads `executionMode` to pick a mode any more (the second executor is gone).
  it('accepts a retired execution mode at the persisted boundary so old checkpoints still open', () => {
    expect(isSupportedPersistedWorkPolicy({
      version: 1,
      route: 'execute',
      sourceMessageId: 'message-1',
      executionMode: 'task_book',
      reasonCode: 'complex_scope',
    })).toBe(true);
    expect(isSupportedPersistedWorkPolicy({
      version: 1,
      route: 'execute',
      sourceMessageId: 'message-1',
      executionMode: 'bounded_loop',
      reasonCode: 'bounded_default',
    })).toBe(true);
  });

  it('rejects malformed or unknown policy shapes at the persisted boundary', () => {
    expect(isSupportedPersistedWorkPolicy({
      version: 1,
      route: 'execute',
      sourceMessageId: 'message-1',
      reasonCode: 'bounded_single_goal',
    })).toBe(false);
    expect(isSupportedPersistedWorkPolicy({
      version: 1,
      route: 'respond',
      sourceMessageId: 'message-1',
      executionMode: 'bounded_loop',
      reasonCode: 'greeting',
    })).toBe(false);
    expect(isSupportedPersistedWorkPolicy({
      version: 1,
      route: 'execute',
      sourceMessageId: 'message-1',
      executionMode: 'second_executor',
      reasonCode: 'complex_scope',
    })).toBe(false);
    expect(isSupportedPersistedWorkPolicy({ version: 2, route: 'execute', sourceMessageId: 'm', reasonCode: 'x' }))
      .toBe(false);
  });
});
