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
});
