import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { createRunner } from './runner.js';

const root = process.env.LS_S2B_PROVIDER_CRASH_ROOT;
const port = Number(process.env.LS_S2B_PROVIDER_CRASH_PORT);
const mode = process.env.LS_S2B_PROVIDER_CRASH_MODE;

describe('T04-C Provider crash worker', () => {
  it.skipIf(!root || !Number.isInteger(port) || port < 1)('waits for an HTTP Provider response after dispatch', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!;
    const runId = 's2b-t04c-provider-crash';
    const llm = httpFixtureLlm(port);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/provider-crash',
      llm,
    });
    try {
      const session = await runner.sessionManager.create('test/provider-crash');
      await writeFile(join(root!, 'provider-request-started.json'), JSON.stringify({
        sessionId: String(session.id),
        runId,
      }), 'utf8');
      await runner.run({
        sessionId: session.id,
        runId,
        text: 'Use one controlled local Provider request and wait for its result.',
      });
      expect.fail('the controlled HTTP Provider intentionally never responds');
    } finally {
      await runner.shutdown();
    }
  }, 90_000);

  it.skipIf(!root || !Number.isInteger(port) || port < 1)('holds a received HTTP response before returning it to Runtime', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!;
    const runId = 's2b-t04c-provider-crash';
    const llm = httpFixtureLlm(port);
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/provider-crash',
      llm,
    });
    try {
      const session = await runner.sessionManager.create('test/provider-crash');
      await writeFile(join(root!, 'provider-request-started.json'), JSON.stringify({
        sessionId: String(session.id),
        runId,
      }), 'utf8');
      await runner.run({
        sessionId: session.id,
        runId,
        text: 'Use one controlled local Provider request and wait for its result.',
      });
      expect.fail('the controlled HTTP Provider response is intentionally held before Runtime receipt');
    } finally {
      await runner.shutdown();
    }
  }, 90_000);
});

function httpFixtureLlm(port: number): LlmClient {
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    if (mode === 'not-sent') {
      await writeFile(join(root!, 'provider-request-not-sent.json'), JSON.stringify({ requestPrepared: true }), 'utf8');
      await new Promise<never>(() => undefined);
    }
    const response = await fetch(`http://127.0.0.1:${port}/provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: request.messages }),
    });
    const body = await response.text();
    const parsed = JSON.parse(body) as ChatResponse;
    if (mode === 'response-held') {
      await writeFile(join(root!, 'provider-response-observed.json'), body, 'utf8');
      await new Promise<never>(() => undefined);
    }
    return parsed;
  };
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}
