import { describe, it, expect } from 'vitest';
import {
  classifyByRules,
  extractExplicitToolInstructionNames,
  isMemoryRecallRequest,
  listRules,
} from './rules.js';

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

  it('keeps an exact-response calibration instruction on the response path', () => {
    expect(classifyByRules('Provider校准测试 20260730-1610：请只回复 LS-PROVIDER-OK-20260730-1610')).toMatchObject({
      activity: 'respond',
      type: 'chat',
      confidence: 0.98,
      reason: 'direct response constraint',
    });
  });

  it('recognizes an English reply-only constraint', () => {
    expect(classifyByRules('For calibration, reply only with LS-OK')).toMatchObject({
      activity: 'respond',
      type: 'chat',
      reason: 'direct response constraint',
    });
  });

  it('routes an explicit prior-turn memory question directly to a response', () => {
    const prompt = '你还记得上一轮保存的文件名称和验收代号吗？请分别回答，不要调用工具。';
    expect(isMemoryRecallRequest(prompt)).toBe(true);
    expect(classifyByRules(prompt)).toMatchObject({
      activity: 'respond',
      type: 'chat',
      confidence: 0.98,
      reason: 'memory recall question',
    });
  });

  it('recognizes a declarative request for values saved across earlier turns', () => {
    const prompt = '请分别回答最初保存的代号和颜色，以及后来约定的上限、开关状态和操作顺序。不要调用工具。';
    expect(isMemoryRecallRequest(prompt)).toBe(true);
    expect(classifyByRules(prompt)).toMatchObject({
      activity: 'respond',
      type: 'chat',
      confidence: 0.98,
      reason: 'memory recall question',
    });
  });

  it('does not mistake a current save or agreement request for historical recall', () => {
    expect(isMemoryRecallRequest('请保存当前代号和颜色，稍后我会追问。')).toBe(false);
    expect(isMemoryRecallRequest('请和我约定新的上限，并更新开关状态。')).toBe(false);
    expect(isMemoryRecallRequest('请回答当前页面显示的代号和颜色。')).toBe(false);
  });

  it('recognizes an explicit tool instruction without a model classifier call', () => {
    expect(classifyByRules('请使用 glob 工具读取当前文件夹')).toMatchObject({
      activity: 'execute',
      type: 'problem',
      confidence: 0.96,
      reason: 'explicit tool instruction',
    });
  });

  it('does not mistake a requested writing style for a tool invocation', () => {
    expect(classifyByRules('请用一句话介绍 glob 工具')).toBeNull();
  });

  it('extracts all explicitly requested tool labels for strict single-tool routing', () => {
    expect(extractExplicitToolInstructionNames('请使用 glob 工具读取当前文件夹')).toEqual(['glob']);
    expect(extractExplicitToolInstructionNames('Please use the Read tool, then call the glob tool.'))
      .toEqual(['read', 'glob']);
    expect(extractExplicitToolInstructionNames('请用一句话介绍 glob 工具')).toEqual([]);
  });

  it('recognizes ordered multi-tool instructions and excludes forbidden tools', () => {
    const text = '第一步只使用 write 工具创建文件；第二步只使用 read 工具核对。不要使用 exec 工具。';
    expect(classifyByRules(text)).toMatchObject({
      activity: 'execute',
      reason: 'explicit tool instruction',
    });
    expect(extractExplicitToolInstructionNames(text)).toEqual(['write', 'read']);
  });

  it('inherits an explicit verb across a coordinated tool list', () => {
    expect(extractExplicitToolInstructionNames('Please use the write tool and then the read tool.'))
      .toEqual(['write', 'read']);
    expect(extractExplicitToolInstructionNames('请使用 write 工具和 read 工具。'))
      .toEqual(['write', 'read']);
  });

  it('does not treat negated or descriptive tool mentions as explicit calls', () => {
    expect(extractExplicitToolInstructionNames('不要使用 exec 工具，只需要回答问题。')).toEqual([]);
    expect(extractExplicitToolInstructionNames('This guide explains how to use the read tool.')).toEqual([]);
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

  it('classifies a capability-status question as chat even when it contains an action word', () => {
    const result = classifyByRules('但是现在好像还没给你配置网络查询功能吧');
    expect(result).toMatchObject({
      activity: 'respond',
      type: 'chat',
      reason: 'capability or status question',
    });
  });

  it('keeps an explicit configuration request on the problem path', () => {
    expect(classifyByRules('现在帮我配置网络查询功能吧')).toMatchObject({
      activity: 'execute',
      type: 'problem',
    });
  });

  it('does not treat a current imperative as a status question', () => {
    expect(classifyByRules('现在更新这个文件吧')).toMatchObject({
      activity: 'execute',
      type: 'problem',
      reason: 'action verb',
    });
  });

  it('keeps a completed-state question on the response path', () => {
    expect(classifyByRules('现在配置好了吗？')).toMatchObject({
      activity: 'respond',
      type: 'chat',
      reason: 'capability or status question',
    });
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
    expect(rules.every((r) => r.pattern && r.activity && r.confidence > 0)).toBe(true);
  });
});
