import { describe, expect, it } from 'vitest';
import { parseExplicitFileContentRequirement } from './task-outcome-request.js';

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
});
