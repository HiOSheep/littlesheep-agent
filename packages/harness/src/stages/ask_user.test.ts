// @littlesheep/harness - stages/ask_user.test.ts
import { describe, expect, it } from 'vitest';
import { createAskUserStage } from './ask_user.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';
import { textMessage } from '@littlesheep/types';

describe('askUserStage', () => {
  it('renders and preserves a structured clarification request', async () => {
    const llm = createMockLlm(textResponse('请选择目标文件：README.md 还是 package.json？'));
    const stage = createAskUserStage();
    const ctx = makeCtx({
      inbound: textMessage('user', '修改那个文件'),
      clarificationRequest: {
        id: 'run-1:clarification',
        kind: 'missing_information',
        sourceStage: 'decide',
        createdAt: '2026-07-10T00:00:00.000Z',
        originalRequest: '修改那个文件',
        blockingReason: '没有目标路径',
        questions: [{
          id: 'question-1',
          field: 'targetPath',
          prompt: '请选择目标文件。',
          required: true,
          options: ['README.md', 'package.json'],
        }],
      },
    });

    const result = await stage(ctx);

    expect(result.next).toBe('finalize');
    expect(result.meta?.clarificationRequestId).toBe('run-1:clarification');
    expect(ctx.reply).toBe('没有目标路径\n\n请选择目标文件。（可选：README.md、package.json）');
    expect(ctx.clarificationRequest?.prompt).toBe(ctx.reply);
    expect(ctx.lastError).toBeUndefined();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('converts a recovery escalation into a first-class request', async () => {
    const llm = createMockLlm(textResponse('执行失败了，你希望我重试还是停止？'));
    const stage = createAskUserStage();
    const ctx = makeCtx({
      inbound: textMessage('user', '继续执行'),
      lastError: { stage: 'execute', message: 'permission denied' },
    });

    const result = await stage(ctx);

    expect(result.meta?.escalated).toBe(true);
    expect(ctx.clarificationRequest?.kind).toBe('recovery_decision');
    expect(ctx.clarificationRequest?.sourceStage).toBe('execute');
    expect(llm.chat).not.toHaveBeenCalled();
  });
});
