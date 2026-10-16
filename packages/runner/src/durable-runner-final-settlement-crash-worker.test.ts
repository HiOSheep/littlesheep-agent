import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { createRunner } from './runner.js';

const root = process.env.LS_S2B_FINAL_SETTLEMENT_ROOT;

describe('T04-E final settlement crash worker', () => {
  it.skipIf(!root)('holds the caller result after durable completion', async () => {
    process.env.LITTLESHEEP_DATA_DIR = root!;
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/final-settlement-crash',
      llm: finalReplyLlm(),
    });
    const runId = 's2b-t04e-final-settlement-crash';
    try {
      const session = await runner.sessionManager.create('test/final-settlement-crash');
      await writeFile(join(root!, 'final-settlement-identity.json'), JSON.stringify({
        sessionId: String(session.id),
        runId,
      }), 'utf8');
      await mkdir(root!, { recursive: true });
      await writeStdout(`LS_S2B_FINAL_SETTLEMENT_IDENTITY:${String(session.id)}:${runId}\n`);
      await waitForFile(join(root!, 'begin-final-run'));
      const result = await runner.run({
        sessionId: session.id,
        runId,
        text: 'Return the final settlement fixture reply.',
      });
      expect(result).toMatchObject({ status: 'ok', reply: 'durable final settlement fixture reply' });
      await writeStdout(`LS_S2B_FINAL_SETTLEMENT_RESULT_READY:${String(session.id)}:${runId}\n`);
      await new Promise<never>(() => undefined);
    } finally {
      await runner.shutdown();
    }
  }, 90_000);
});

function finalReplyLlm(): LlmClient {
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => ({
    content: 'durable final settlement fixture reply',
    toolCalls: [],
    finishReason: 'stop',
  });
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'delta', delta: response.content });
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: 'test/final-settlement-crash', usage: { promptTokens: 0 } }),
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`timed out waiting for final run gate: ${path}`);
}

async function writeStdout(value: string): Promise<void> {
  await new Promise<void>((resolveWrite) => process.stdout.write(value, () => resolveWrite()));
}
