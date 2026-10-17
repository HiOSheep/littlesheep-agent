import { describe, expect, it } from 'vitest';
import { parseExplicitFileContentRequirement, parseExplicitFileContentRequirements } from './task-outcome-request.js';

describe('parseExplicitFileContentRequirement', () => {
  it('accepts one exact user requirement and assigns a stable source-linked id', () => {
    const input = { runId: 'run-1', sourceMessageId: 'message-1', text: '创建 result.txt，内容必须为 hello。' };
    const parsed = parseExplicitFileContentRequirement(input);
    expect(parsed).toMatchObject({
      runId: 'run-1',
      sourceMessageId: 'message-1',
      origin: 'user_explicit',
      filePath: 'result.txt',
      expectedContent: 'hello',
    });
    expect(parseExplicitFileContentRequirement(input)?.requirementId).toBe(parsed?.requirementId);
  });

  it('does not include a trailing English sentence period in the requested file content', () => {
    expect(parseExplicitFileContentRequirement({
      runId: 'run-1', sourceMessageId: 'message-english',
      text: 'Create result.txt, content must be hello.',
    })).toMatchObject({ filePath: 'result.txt', expectedContent: 'hello' });
  });

  it('does not extract criteria from extra prose or unsafe paths', () => {
    expect(parseExplicitFileContentRequirement({
      runId: 'r', sourceMessageId: 'm', text: '请创建 result.txt，内容必须为 hello。然后再解释一下。',
    })).toBeUndefined();
    expect(parseExplicitFileContentRequirement({
      runId: 'r', sourceMessageId: 'm', text: '创建 ../secret.txt，内容必须为 hello。',
    })).toBeUndefined();
  });

  it('recognizes a complete two-item root text-file list with stable per-file requirements', () => {
    const input = {
      runId: 'run-multi',
      sourceMessageId: 'message-multi',
      text: '- 创建 a.txt，内容必须为 hello。\n- 创建 b.txt，内容必须为 world。',
    };
    const parsed = parseExplicitFileContentRequirements(input);
    expect(parsed).toHaveLength(2);
    expect(parsed).toMatchObject([
      { sourceMessageId: input.sourceMessageId, filePath: 'a.txt', expectedContent: 'hello', origin: 'user_explicit' },
      { sourceMessageId: input.sourceMessageId, filePath: 'b.txt', expectedContent: 'world', origin: 'user_explicit' },
    ]);
    expect(new Set(parsed?.map((item) => item.requirementId)).size).toBe(2);
    expect(parseExplicitFileContentRequirements(input)?.map((item) => item.requirementId))
      .toEqual(parsed?.map((item) => item.requirementId));
  });

  it('keeps the inventory unknown for partial, duplicate, unsupported, or extra-prose lists', () => {
    const input = {
      runId: 'run-multi', sourceMessageId: 'message-multi',
      text: '创建 a.txt，内容必须为 hello。\n创建 b.txt，内容必须为 world。',
    };
    expect(parseExplicitFileContentRequirements({ ...input, text: `${input.text}\n并解释实现方式。` })).toBeUndefined();
    expect(parseExplicitFileContentRequirements({ ...input, text: `${input.text}\n创建 c.txt，内容必须为 third。\n创建 d.txt，内容必须为 fourth。` })).toBeUndefined();
    expect(parseExplicitFileContentRequirements({ ...input, text: '创建 a.md，内容必须为 hello。\n创建 b.txt，内容必须为 world。' })).toBeUndefined();
    expect(parseExplicitFileContentRequirements({ ...input, text: '创建 a.txt，内容必须为 hello。\n创建 a.txt，内容必须为 world。' })).toBeUndefined();
  });
});
