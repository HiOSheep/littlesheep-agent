import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { asSessionId } from '@littlesheep/types';
import { createRunner, type AgentRunner } from './runner.js';

const roots: string[] = [];
const runners: AgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)));
  delete process.env.LITTLESHEEP_DATA_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('T04-E final settlement process recovery', () => {
  it('replays one committed final reply after SIGKILL before the caller receives the result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2b-final-settlement-crash-'));
    roots.push(root);
    const child = spawnFinalSettlementWorker(root);
    let marker: string;
    try {
      const identityOutput = await waitForChildMarker(child, 'LS_S2B_FINAL_SETTLEMENT_IDENTITY:');
      const identity = identityOutput.match(/LS_S2B_FINAL_SETTLEMENT_IDENTITY:([^:\r\n]+):([^\r\n]+)/u);
      expect(identity).toBeTruthy();
      const [, sessionId, runId] = identity!;
      await writeFile(join(root, 'begin-final-run'), 'go', 'utf8');
      marker = await waitForChildMarker(child, 'LS_S2B_FINAL_SETTLEMENT_RESULT_READY:');
      expect(marker).toContain(`LS_S2B_FINAL_SETTLEMENT_RESULT_READY:${sessionId}:${runId}`);
    } finally {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }
    expect(child.signalCode).toBe('SIGKILL');

    const startedAt = JSON.parse(await readFile(join(root, 'final-settlement-identity.json'), 'utf8')) as {
      sessionId: string;
      runId: string;
    };
    process.env.LITTLESHEEP_DATA_DIR = root;
    const llm = noCallLlm();
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/final-settlement-crash',
      llm,
    });
    runners.push(runner);

    const recovery = await runner.recoverDurableRun!(asSessionId(startedAt.sessionId), startedAt.runId);
    expect(recovery.projection).toMatchObject({
      status: 'completed',
      finalReply: { state: 'settled', reply: 'durable final settlement fixture reply' },
    });
    await expect(runner.replayDurableFinalReply!(asSessionId(startedAt.sessionId), startedAt.runId))
      .resolves.toMatchObject({ kind: 'settled', reply: 'durable final settlement fixture reply' });
    expect(llm.chat).not.toHaveBeenCalled();
    const events = await runner.infra.durableEventStore.read(startedAt.sessionId, startedAt.runId);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(1);
  }, 120_000);
});

function spawnFinalSettlementWorker(root: string): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    resolve('packages/runner/src/durable-runner-final-settlement-crash-worker.test.ts'),
    '--pool=threads',
    '--maxWorkers=1',
    '--minWorkers=1',
  ], {
    cwd: resolve('.'),
    env: { ...process.env, LS_S2B_FINAL_SETTLEMENT_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function noCallLlm(): LlmClient & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
    content: 'must not be called by final settlement recovery',
    toolCalls: [],
    finishReason: 'stop',
  }));
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const response = await chat(request);
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: 'test/final-settlement-crash', usage: { promptTokens: 0 } }),
  };
}

function waitForChildMarker(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`child did not reach ${expected}: ${output}`)), 60_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('exit');
      error ? rejectMarker(error) : resolveMarker(output);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(expected)) finish();
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => finish(new Error(`child exited before ${expected} with code ${String(code)}: ${output}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}
