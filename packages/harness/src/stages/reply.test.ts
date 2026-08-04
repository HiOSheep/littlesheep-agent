// @littlesheep/harness - stages/reply.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { textMessage } from '@littlesheep/types';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';
import { createReplyStage } from './reply.js';

describe('replyStage', () => {
  it('includes the active Soul when composing the user-visible reply', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('带有人格风格的回复');
    });
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const ctx = makeCtx({
      inbound: textMessage('user', '你好'),
      bootstrap: { 'SOUL.md': 'SOUL_SENTINEL_REPLY_VOICE' },
    });

    const result = await stage(ctx);

    expect(result.next).toBe('finalize');
    expect(ctx.reply).toBe('带有人格风格的回复');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(systemPrompts[0]).toContain('SOUL_SENTINEL_REPLY_VOICE');
    expect(ctx.replyProvenance).toMatchObject({ source: 'llm', purpose: 'reply', rewriteCount: 0 });
  });

  it('preserves a referenced topic anchor and later correction in the DeepSeek request', async () => {
    const requests: import('@littlesheep/llm').ChatRequest[] = [];
    const llm = createMockLlm((request) => {
      requests.push(request);
      return textResponse('我会把它当作高机动高单发的支援型 TD 来玩。');
    });
    const stage = createReplyStage({
      llm,
      model: 'deepseek/deepseek-v4-flash',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const history = [
      textMessage('user', '介绍一下DBV-152这辆车吧'),
      textMessage('assistant', 'DBV-152 是一辆 X 级坦克歼击车，主炮口径为 152 mm。'),
      textMessage('user', '你这信息有错误啊'),
      textMessage('assistant', '请告诉我具体是哪一项。'),
      textMessage('user', '单发是800啊'),
      textMessage('assistant', '明白了，已更正：单发伤害是 800。'),
    ];
    const ctx = makeCtx({
      inbound: textMessage('user', '假如你拥有了152，会怎么做呢？'),
      history,
    });
    // Reproduce the old failure condition: the strict byte upper bound is
    // above the reply stage's 16k soft target while remaining far below the
    // verified one-million-token model window.
    ctx.memoryRootIndex = `# Memory Tree Root Index\n${'indexed-memory-entry\n'.repeat(900)}`;

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    const sentText = requests[0]?.messages.map((message) => typeof message.content === 'string'
      ? message.content
      : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')) ?? [];
    expect(sentText).toEqual(expect.arrayContaining([
      '介绍一下DBV-152这辆车吧',
      '单发是800啊',
      '假如你拥有了152，会怎么做呢？',
    ]));
    expect(ctx.contextSnapshots?.[0]?.safetyEstimate?.estimatedPromptTokens).toBeLessThan(8_000);
    const systemPrompt = String(requests[0]?.messages[0]?.content);
    expect(systemPrompt).toContain('# Memory Tree Root Index');
    expect(systemPrompt).toContain('root index truncated');
    expect(systemPrompt).not.toContain('root index -> branch index -> node/query expansion');
    expect(ctx.contextSnapshots?.[0]?.items
      .filter((item) => item.kind === 'recent_message')
      .every((item) => item.disposition === 'included')).toBe(true);
  });

  it('repairs one discontinuous continuation before reserving or publishing it', async () => {
    const llm = createMockLlm([
      textResponse('我无法回忆上一轮保存的内容。'),
      textResponse('代号：continuity-anchor-6824；颜色：琥珀色'),
    ]);
    const stage = createReplyStage({
      llm,
      model: 'deepseek/deepseek-v4-flash',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const ctx = makeCtx({
      history: [
        textMessage('user', '请记住代号 continuity-anchor-6824 和颜色琥珀色。'),
        textMessage('assistant', '记录完成。'),
      ],
      inbound: textMessage(
        'user',
        '继续上一轮。请输出上一轮让我保存的代号和颜色，格式为“代号：...；颜色：...”。',
      ),
    });
    ctx.reserveUserFacingReply = vi.fn(async () => true);

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.reply).toBe('代号：continuity-anchor-6824；颜色：琥珀色');
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(String(llm.chat.mock.calls[1]?.[0].messages[0]?.content))
      .toContain('Continuity correction contract');
    expect(ctx.reserveUserFacingReply).toHaveBeenCalledTimes(1);
    expect(ctx.reserveUserFacingReply).toHaveBeenCalledWith(
      '代号：continuity-anchor-6824；颜色：琥珀色',
    );
    expect(ctx.replyProvenance).toMatchObject({
      source: 'llm',
      purpose: 'reply',
      modelRequestIndex: 2,
    });
  });

  it('fails closed when one continuity correction still contradicts visible history', async () => {
    const llm = createMockLlm([
      textResponse('我无法回忆上一轮保存的内容。'),
      textResponse('代号和颜色都没有记录。'),
    ]);
    const stage = createReplyStage({
      llm,
      model: 'deepseek/deepseek-v4-flash',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const ctx = makeCtx({
      history: [
        textMessage('user', '请记住代号 continuity-anchor-6824 和颜色琥珀色。'),
        textMessage('assistant', '记录完成。'),
      ],
      inbound: textMessage(
        'user',
        '继续上一轮。请输出上一轮让我保存的代号和颜色，格式为“代号：...；颜色：...”。',
      ),
    });
    ctx.reserveUserFacingReply = vi.fn(async () => true);

    const result = await stage(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('still omitted or contradicted');
    expect(ctx.reply).toBeUndefined();
    expect(ctx.reserveUserFacingReply).not.toHaveBeenCalled();
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('streams provider deltas and replaces provisional text with the canonical reply', async () => {
    const llm = createMockLlm(textResponse('Hello '));
    llm.chatStream.mockImplementationOnce(async (_request, onChunk) => {
      onChunk({ type: 'delta', delta: 'Hel' });
      onChunk({ type: 'delta', delta: 'lo ' });
      return textResponse('Hello!');
    });
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const deltas: string[] = [];
    const replacements: string[] = [];
    const ctx = makeCtx({ inbound: textMessage('user', 'Say hello') });
    ctx.onAssistantDelta = (delta) => deltas.push(delta);
    ctx.onAssistantReplace = (text) => replacements.push(text);

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(deltas).toEqual(['Hel', 'lo ']);
    expect(replacements).toEqual(['Hello!']);
    expect(ctx.reply).toBe('Hello!');
  });

  it('resets provisional text when the streaming provider retries', async () => {
    const llm = createMockLlm(textResponse('new answer'));
    llm.chatStream.mockImplementationOnce(async (_request, onChunk) => {
      onChunk({ type: 'delta', delta: 'old answer' });
      onChunk({ type: 'reset' });
      onChunk({ type: 'delta', delta: 'new answer' });
      return textResponse('new answer');
    });
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const deltas: string[] = [];
    const replacements: string[] = [];
    const ctx = makeCtx({ inbound: textMessage('user', 'Retry safely') });
    ctx.onAssistantDelta = (delta) => deltas.push(delta);
    ctx.onAssistantReplace = (text) => replacements.push(text);

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(deltas).toEqual(['old answer', 'new answer']);
    expect(replacements).toEqual(['']);
    expect(ctx.reply).toBe('new answer');
  });

  it('buffers streaming output and publishes only the distinct rewritten reply', async () => {
    const llm = createMockLlm([
      textResponse('还是同一句回复。'),
      textResponse('这次换一种自然的说法。'),
    ]);
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const deltas: string[] = [];
    const ctx = makeCtx({
      inbound: textMessage('user', '再说一次'),
      history: [textMessage('assistant', '还是同一句回复。')],
    });
    ctx.onAssistantDelta = (delta) => deltas.push(delta);
    ctx.onAssistantReplace = (text) => deltas.push(text);

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.reply).toBe('这次换一种自然的说法。');
    expect(deltas).toEqual(['这次换一种自然的说法。']);
    expect(ctx.replyProvenance?.rewriteCount).toBe(1);
  });

  it('returns a runtime error instead of publishing a repeated fallback', async () => {
    const llm = createMockLlm(textResponse('固定回复'));
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const deltas: string[] = [];
    const ctx = makeCtx({
      history: [textMessage('assistant', '固定回复')],
      inbound: textMessage('user', '继续'),
    });
    ctx.onAssistantDelta = (delta) => deltas.push(delta);

    const result = await stage(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/repeated a previously published reply/);
    expect(ctx.reply).toBeUndefined();
    expect(deltas).toEqual([]);
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it('rewrites a duplicate found only in the durable session registry', async () => {
    const llm = createMockLlm([
      textResponse('Archived exact reply'),
      textResponse('Fresh model-authored wording'),
    ]);
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const ctx = makeCtx({
      history: [],
      inbound: textMessage('user', 'Repeat the old question'),
    });
    ctx.reserveUserFacingReply = vi.fn(async (reply: string) => reply !== 'Archived exact reply');

    const result = await stage(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.reply).toBe('Fresh model-authored wording');
    expect(ctx.replyProvenance?.rewriteCount).toBe(1);
    expect(ctx.reserveUserFacingReply).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the durable reply registry cannot reserve text', async () => {
    const llm = createMockLlm(textResponse('Response generated by the Provider API'));
    const stage = createReplyStage({
      llm,
      model: 'test',
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
    });
    const deltas: string[] = [];
    const ctx = makeCtx({ inbound: textMessage('user', 'Hello') });
    ctx.reserveUserFacingReply = vi.fn(async () => {
      throw new Error('registry unavailable');
    });
    ctx.onAssistantDelta = (delta) => deltas.push(delta);

    const result = await stage(ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('registry unavailable');
    expect(ctx.reply).toBeUndefined();
    expect(deltas).toEqual([]);
  });
});
