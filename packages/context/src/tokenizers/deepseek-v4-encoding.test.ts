import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@littlesheep/llm';
import { createDeepSeekV4ExactContextTokenCounter } from './deepseek-v4-counter.js';
import {
  encodeDeepSeekV4Messages,
  encodeDeepSeekV4Request,
  type DeepSeekV4Message,
} from './deepseek-v4-encoding.js';

describe('DeepSeek V4.1 prompt framing', () => {
  it('wraps the system message and renders the numeric reasoning budget', () => {
    const prompt = encodeDeepSeekV4Messages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
    ], { thinkingMode: 'thinking', reasoningEffort: 'high', framing: 'v4.1' });

    expect(prompt).toBe(
      '<｜begin▁of▁sentence｜><｜System｜>'
      + 'Reasoning Effort: 75 (range 1-100, the higher the value, the more thorough the reasoning)\n\n'
      + 'You are a helpful assistant.<｜User｜>What is 2+2?<｜Assistant｜><think>',
    );
  });

  it('maps the published reasoning-effort aliases onto their budgets', () => {
    const prefixFor = (effort: 'high' | 'max') => encodeDeepSeekV4Messages(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      { thinkingMode: 'thinking', reasoningEffort: effort, framing: 'v4.1' },
    ).split('\n\n')[0]!;

    expect(prefixFor('high')).toBe('<｜begin▁of▁sentence｜><｜System｜>Reasoning Effort: 75 (range 1-100, the higher the value, the more thorough the reasoning)');
    expect(prefixFor('max')).toContain('Reasoning Effort: 100 (range 1-100');
  });

  it('omits the effort prefix when thinking is off and uses the space-prefixed DSML tags', () => {
    const request: ChatRequest = {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Call the probe.' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: '',
          tool_calls: [{
            id: 'call-001',
            type: 'function',
            function: { name: 'probe', arguments: '{"value":"alpha-42"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-001', content: '{"accepted":true}' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'probe',
          description: 'probe',
          parameters: { type: 'object', properties: { value: { type: 'string' } } },
        },
      }],
      tool_choice: 'auto',
      thinking: { type: 'disabled' },
    };

    const prompt = encodeDeepSeekV4Request(request, 'v4.1');
    expect(prompt.startsWith('<｜begin▁of▁sentence｜><｜System｜>You are a helpful assistant.')).toBe(true);
    expect(prompt).not.toContain('Reasoning Effort:');
    expect(prompt).toContain('<｜DSML｜ calls>');
    expect(prompt).toContain('<｜DSML｜ invoke name="probe">');
    expect(prompt).toContain('<｜DSML｜ parameter name="value" string="true">alpha-42</｜DSML｜ parameter>');
    expect(prompt).toContain('writing a "<｜DSML｜ calls>" block');
  });

  it('renders a mid-conversation system message with the System token and assistant header', () => {
    const prompt = encodeDeepSeekV4Messages([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok', wo_eos: true },
      { role: 'system', content: 'runtime note' },
    ], { thinkingMode: 'chat', framing: 'v4.1' });

    expect(prompt).toContain('<｜System｜>runtime note<｜Assistant｜></think>');
  });

  it('keeps the V4 framing as the default', () => {
    const prompt = encodeDeepSeekV4Messages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
    ], { thinkingMode: 'chat' });

    expect(prompt).toBe('<｜begin▁of▁sentence｜>You are a helpful assistant.<｜User｜>hi<｜Assistant｜></think>');
  });
});

describe('DeepSeek V4 official prompt encoding', () => {
  it('matches the official thinking-without-tools vector exactly', () => {
    const messages: DeepSeekV4Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        reasoning_content: 'The user said hello, I should greet back.',
        content: 'Hi there! How can I help you?',
      },
      { role: 'user', content: 'What is the capital of France?' },
      {
        role: 'assistant',
        reasoning_content: 'The user asks about the capital of France. It is Paris.',
        content: 'The capital of France is Paris.',
      },
    ];

    expect(encodeDeepSeekV4Messages(messages, { thinkingMode: 'thinking' })).toBe(
      '<｜begin▁of▁sentence｜>You are a helpful assistant.'
      + '<｜User｜>Hello<｜Assistant｜></think>Hi there! How can I help you?<｜end▁of▁sentence｜>'
      + '<｜User｜>What is the capital of France?<｜Assistant｜><think>'
      + 'The user asks about the capital of France. It is Paris.</think>'
      + 'The capital of France is Paris.<｜end▁of▁sentence｜>',
    );
  });

  it('encodes top-level tools, tool calls, and tool results with official DSML framing', () => {
    const request: ChatRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: "What's the weather in Beijing?" },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'I should use the weather tool.',
          tool_calls: [{
            id: 'call-001',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"Beijing","days":2}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call-001',
          content: '{"temperature":22}',
        },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
              days: { type: 'integer' },
            },
            required: ['location'],
          },
        },
      }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    };

    const prompt = encodeDeepSeekV4Request(request);

    expect(prompt).toMatch(/^<｜begin▁of▁sentence｜>Reasoning Effort: Absolute maximum with no shortcuts permitted\./u);
    expect(prompt).toContain(
      '{"name": "get_weather", "description": "Get weather", "parameters": '
      + '{"type": "object", "properties": {"location": {"type": "string"}, '
      + '"days": {"type": "integer"}}, "required": ["location"]}}',
    );
    expect(prompt).toContain(
      '<｜Assistant｜><think>I should use the weather tool.</think>\n\n'
      + '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="get_weather">\n'
      + '<｜DSML｜parameter name="location" string="true">Beijing</｜DSML｜parameter>\n'
      + '<｜DSML｜parameter name="days" string="false">2</｜DSML｜parameter>\n'
      + '</｜DSML｜invoke>\n</｜DSML｜tool_calls><｜end▁of▁sentence｜>',
    );
    expect(prompt.endsWith(
      '<｜User｜><tool_result>{"temperature":22}</tool_result><｜Assistant｜><think>',
    )).toBe(true);
  });

  it('maps hosted Flash and Pro effort framing independently', () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      reasoning_effort: 'high' as const,
      thinking: { type: 'enabled' as const },
    };
    expect(encodeDeepSeekV4Request({
      ...request,
      model: 'deepseek-v4-flash',
    })).toMatch(/^<｜begin▁of▁sentence｜>Reasoning Effort: Absolute maximum with no shortcuts permitted\./u);
    expect(encodeDeepSeekV4Request({
      ...request,
      model: 'deepseek-v4-pro',
    })).toMatch(/^<｜begin▁of▁sentence｜>/u);
    expect(encodeDeepSeekV4Request({
      ...request,
      model: 'deepseek-v4-pro',
      reasoning_effort: 'max',
    })).toMatch(/^<｜begin▁of▁sentence｜>Reasoning Effort: Absolute maximum with no shortcuts permitted\./u);
  });

  it('counts the token ids returned by the local tokenizer over the fully encoded prompt', () => {
    let encodedPrompt = '';
    let addSpecialTokens: boolean | undefined;
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode(text, options) {
        encodedPrompt = text;
        addSpecialTokens = options?.add_special_tokens;
        return { ids: [101, 202, 303, 404] };
      },
    });
    const request: ChatRequest = {
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: '你好' },
      ],
      thinking: { type: 'disabled' },
    };

    expect(counter.supports('deepseek', 'deepseek-v4-pro')).toBe(true);
    expect(counter.countRequest(request)).toBe(4);
    expect(encodedPrompt).toBe(
      '<｜begin▁of▁sentence｜>system<｜User｜>你好<｜Assistant｜></think>',
    );
    expect(addSpecialTokens).toBe(false);
  });

  it('fails closed for request shapes not covered by the official text encoder', () => {
    expect(() => encodeDeepSeekV4Request({
      model: 'deepseek-v4-flash',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
      }],
    })).toThrow(/image content/);

    expect(() => encodeDeepSeekV4Request({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: 'required',
    })).toThrow(/tool_choice=required/);
  });
});
