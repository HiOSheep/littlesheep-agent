import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeepSeekV4ExactContextTokenCounter,
  resolveDeepSeekTokenizerFamily,
  createLazyLocalExactContextTokenCounter,
  prepareLocalExactContextTokenCounter,
  verifyDeepSeekV4TokenizerAssets,
} from './deepseek-v4-counter.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DeepSeek V4 tokenizer assets', () => {
  it('reports missing and invalid immutable assets separately', async () => {
    const root = await temporaryRoot();
    const missing = await verifyDeepSeekV4TokenizerAssets(root);
    expect(missing.available).toBe(false);
    expect(missing.missing).toEqual(['tokenizer.json', 'tokenizer_config.json']);
    expect(missing.invalid).toEqual([]);

    const repositoryRoot = join(missing.modelRoot, 'deepseek-ai', 'DeepSeek-V4-Flash');
    await mkdir(repositoryRoot, { recursive: true });
    await Promise.all([
      writeFile(join(repositoryRoot, 'tokenizer.json'), '{}', 'utf8'),
      writeFile(join(repositoryRoot, 'tokenizer_config.json'), '{}', 'utf8'),
    ]);

    const invalid = await verifyDeepSeekV4TokenizerAssets(root);
    expect(invalid.available).toBe(false);
    expect(invalid.missing).toEqual([]);
    expect(invalid.invalid).toEqual(['tokenizer.json', 'tokenizer_config.json']);
  });

  it('fails a corrupt download closed, removes temporary files, and permits retry', async () => {
    const root = await temporaryRoot();
    let requestCount = 0;
    const fetchFn = (async () => {
      requestCount++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const options = {
      modelRef: 'deepseek/deepseek-v4-pro',
      modelRootDir: root,
      fetchFn,
      timeoutMs: 1_000,
    };

    await expect(prepareLocalExactContextTokenCounter(options)).rejects.toThrow(/size mismatch/);
    await expect(prepareLocalExactContextTokenCounter(options)).rejects.toThrow(/size mismatch/);
    expect(requestCount).toBe(2);
    expect((await readdir(root, { recursive: true })).some((path) => path.endsWith('.tmp'))).toBe(false);
  });

  it('does not touch the network for unsupported models', async () => {
    let requested = false;
    const counter = await prepareLocalExactContextTokenCounter({
      modelRef: 'openai/gpt-5.6',
      modelRootDir: await temporaryRoot(),
      fetchFn: (async () => {
        requested = true;
        throw new Error('unexpected request');
      }) as typeof fetch,
    });
    expect(counter).toBeUndefined();
    expect(requested).toBe(false);
  });

  it('prepares lazily, coalesces callers, backs off after failure, and disposes cleanly', async () => {
    const root = await temporaryRoot();
    let requestCount = 0;
    let releaseResponse!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const counter = createLazyLocalExactContextTokenCounter({
      modelRef: 'deepseek/deepseek-v4-pro',
      modelRootDir: root,
      retryBackoffMs: 60_000,
      fetchFn: (async () => {
        requestCount++;
        await responseReady;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as typeof fetch,
    });

    expect(counter).toBeDefined();
    expect(counter!.ready).toBe(false);
    expect(requestCount).toBe(0);
    expect(() => counter!.countRequest({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
    })).toThrow(/preparing/);

    const first = counter!.prepare();
    const second = counter!.prepare();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(requestCount).toBe(1));
    releaseResponse();
    await expect(first).rejects.toThrow(/size mismatch/);
    await expect(second).rejects.toThrow(/size mismatch/);

    expect(() => counter!.countRequest({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
    })).toThrow(/temporarily unavailable/);
    expect(requestCount).toBe(1);

    counter!.dispose();
    await expect(counter!.prepare()).rejects.toThrow(/disposed/);
  });

  it('does not create a lazy counter for unsupported models', async () => {
    const counter = createLazyLocalExactContextTokenCounter({
      modelRef: 'openai/gpt-5.6',
      modelRootDir: await temporaryRoot(),
      fetchFn: (() => { throw new Error('unexpected request'); }) as typeof fetch,
    });
    expect(counter).toBeUndefined();
  });

  it('counts calibrated V4.1 Flash tool protocol requests', () => {
    let tokenizerCalls = 0;
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode() {
        tokenizerCalls++;
        return { ids: Array.from({ length: 10 }, (_, index) => index) };
      },
    }, resolveDeepSeekTokenizerFamily('deepseek/deepseek-v4-flash'));

    const tools = [{
      type: 'function' as const,
      function: {
        name: 'probe',
        description: 'Probe once.',
        parameters: { type: 'object', properties: {} },
      },
    }];

    const highRequest = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Use the probe.' }],
      tools,
      tool_choice: 'auto',
      reasoning_effort: 'high' as const,
      thinking: { type: 'enabled' as const },
    };
    expect(counter.countRequest(highRequest)).toBe(10);
    expect(counter.countRequest(highRequest)).toBe(10);
    expect(counter.countRequest({
      ...highRequest,
      reasoning_effort: 'max',
    })).toBe(10);

    // Tool history without an active schema measured one token off, so it stays
    // explicitly uncovered rather than returning a near-but-wrong count.
    expect(() => counter.countRequest({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'Use the probe.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'probe', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      ],
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    })).toThrow(/tool history without an active tool schema/);
    expect(tokenizerCalls).toBe(2);
  });

  it('keeps Pro tool protocol requests failed closed pending model-specific calibration', () => {
    let tokenizerCalls = 0;
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode() {
        tokenizerCalls++;
        return { ids: [1] };
      },
    });
    expect(() => counter.countRequest({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Use the probe.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'probe',
          description: 'Probe once.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: 'auto',
      thinking: { type: 'disabled' },
    })).toThrow(/does not cover tool protocol requests/);
    expect(tokenizerCalls).toBe(0);
  });

  it('fails closed for uncalibrated thinking and tool-choice combinations', () => {
    let tokenizerCalls = 0;
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode() {
        tokenizerCalls++;
        return { ids: [1] };
      },
    }, resolveDeepSeekTokenizerFamily('deepseek/deepseek-v4-flash'));
    expect(() => counter.countRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled' },
    })).toThrow(/explicit reasoning_effort/);
    expect(() => counter.countRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
      thinking: { type: 'disabled' },
    })).toThrow(/thinking is disabled/);
    expect(() => counter.countRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        type: 'function',
        function: {
          name: 'probe',
          description: 'Probe once.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      thinking: { type: 'disabled' },
    })).toThrow(/tool_choice=auto/);
    expect(tokenizerCalls).toBe(0);
  });

  it('counts a forced-final-answer turn that keeps its tool schema', () => {
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode: (prompt: string) => ({ ids: Array.from({ length: prompt.length }, () => 1) }),
    }, resolveDeepSeekTokenizerFamily('deepseek/deepseek-v4-flash'));
    const base = {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user' as const, content: 'Use the probe.' }],
      tools: [{
        type: 'function' as const,
        function: {
          name: 'probe',
          description: 'Probe once.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      thinking: { type: 'disabled' as const },
    };

    // The forced turn keeps the same tool schema as every other turn in the run
    // (so its cacheable prefix is unchanged) and only flips tool_choice.
    expect(counter.countRequest({ ...base, tool_choice: 'none' }))
      .toBe(counter.countRequest({ ...base, tool_choice: 'auto' }));
    // Other non-auto values stay uncovered rather than silently miscounted.
    expect(() => counter.countRequest({ ...base, tool_choice: 'required' })).toThrow(/tool_choice=auto/);
  });

  it('fails exact counting closed when Provider thinking defaults are implicit', () => {
    let tokenizerCalls = 0;
    const counter = createDeepSeekV4ExactContextTokenCounter({
      encode() {
        tokenizerCalls++;
        return { ids: [1] };
      },
    }, resolveDeepSeekTokenizerFamily('deepseek/deepseek-v4-flash'));

    expect(() => counter.countRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })).toThrow(/explicit thinking mode/);
    expect(tokenizerCalls).toBe(0);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-tokenizer-'));
  temporaryRoots.push(root);
  return root;
}
