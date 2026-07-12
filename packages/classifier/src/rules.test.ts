import { describe, it, expect } from 'vitest';
import { classifyByRules, listRules } from './rules.js';

describe('classifyByRules', () => {
  it('classifies greetings as chat', () => {
    const result = classifyByRules('你好');
    expect(result?.type).toBe('chat');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result?.source).toBe('rules');
  });

  it('classifies "hello" as chat', () => {
    expect(classifyByRules('hello there')?.type).toBe('chat');
  });

  it('classifies "hi" as chat', () => {
    expect(classifyByRules('hi')?.type).toBe('chat');
  });

  it('classifies action verbs as problem', () => {
    const result = classifyByRules('帮我写一个函数');
    expect(result?.type).toBe('problem');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies "修复" as problem', () => {
    expect(classifyByRules('修复这个 bug')?.type).toBe('problem');
  });

  it('classifies "debug" as problem', () => {
    expect(classifyByRules('debug this issue')?.type).toBe('problem');
  });

  it('classifies code blocks as problem', () => {
    const text = 'Here is the code:\n```js\nconsole.log("x")\n```';
    expect(classifyByRules(text)?.type).toBe('problem');
  });

  it('classifies file paths as problem', () => {
    expect(classifyByRules('读一下 /tmp/file.txt')?.type).toBe('problem');
  });

  it('classifies Windows file paths as problem', () => {
    expect(classifyByRules('C:\\Users\\test\\file.txt')?.type).toBe('problem');
  });

  it('classifies error keywords as problem', () => {
    expect(classifyByRules('there is an error in the log')?.type).toBe('problem');
  });

  it('classifies pure questions as chat (default to chat, not unclear)', () => {
    const result = classifyByRules('为什么天空是蓝色的？');
    expect(result?.type).toBe('chat');
  });

  it('classifies English pure questions as chat', () => {
    const result = classifyByRules('what is this?');
    expect(result?.type).toBe('chat');
  });

  it('returns null for unmatched text', () => {
    expect(classifyByRules('the weather is nice today')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(classifyByRules('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(classifyByRules('   ')).toBeNull();
  });

  it('first matching rule wins (action verb before error keyword)', () => {
    // "修复" matches action verb first (rule order matters)
    const result = classifyByRules('修复 error');
    expect(result?.reason).toBe('action verb');
  });

  it('listRules returns all rules', () => {
    const rules = listRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.pattern && r.type && r.confidence > 0)).toBe(true);
  });
});
