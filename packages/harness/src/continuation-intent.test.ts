import { describe, expect, it } from 'vitest';
import {
  isExecutionContinuationRequest,
  isExplicitContinuationRequest,
} from './continuation-intent.js';

describe('continuation intent', () => {
  it('keeps a continuation followed by another instruction inside the continuity gate', () => {
    expect(isExecutionContinuationRequest('继续上一轮，请使用 glob 工具读取当前工作区')).toBe(true);
    expect(isExplicitContinuationRequest('Continue the previous task, then use the glob tool.')).toBe(true);
  });

  it('does not treat an ordinary explicit tool instruction as continuation', () => {
    expect(isExplicitContinuationRequest('请使用 glob 工具读取当前工作区')).toBe(false);
  });

  it('does not read the characters in 出现在哪 as a standalone 现在 reference', () => {
    expect(isExplicitContinuationRequest(
      '请在当前工作区搜索文本 LS_ACCEPTANCE_NEEDLE_42 出现在哪个文件和第几行，只告诉我匹配结果，不要修改任何文件。',
    )).toBe(false);
    expect(isExecutionContinuationRequest('现在任务进度如何？')).toBe(true);
  });

  it('recognizes natural historical-value recall without requiring a question form', () => {
    expect(isExplicitContinuationRequest(
      '请分别回答最初保存的代号和颜色，以及后来约定的上限、开关状态和操作顺序。',
    )).toBe(true);
  });

  it('keeps current-turn save and agreement requests outside the continuity gate', () => {
    expect(isExplicitContinuationRequest('请保存当前代号和颜色，稍后我会追问。')).toBe(false);
    expect(isExplicitContinuationRequest('请和我约定新的上限，并更新开关状态。')).toBe(false);
  });
});
