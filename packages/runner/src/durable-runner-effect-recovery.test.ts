import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { asSessionId } from '@littlesheep/types';
import { createRunner, type AgentRunner } from './runner.js';

const roots: string[] = [];
const runners: AgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)));
  delete process.env.LITTLESHEEP_DATA_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('full Runner effect process recovery', () => {
  it('marks a killed real effect unknown only after reclaiming both expired leases', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-runner-effect-kill-'));
    roots.push(rootDir);
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      resolve('packages/runner/src/durable-runner-effect-crash-worker.test.ts'),
      '--pool=threads',
      '--maxWorkers=1',
      '--minWorkers=1',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, LS_DURABLE_RUNNER_EFFECT_CRASH_ROOT: rootDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let marker = '';
    try {
      marker = await waitForChildMarker(child, 'LS_DURABLE_RUNNER_EFFECT_STARTED:');
    } finally {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }
    const sessionId = marker.match(/LS_DURABLE_RUNNER_EFFECT_STARTED:([^\r\n]+)/u)?.[1]?.trim();
    expect(sessionId).toBeTruthy();
    const effectFile = join(rootDir, 'effect-workspace', 'effect-applied.txt');
    expect(existsSync(effectFile)).toBe(true);
    expect((await readFile(effectFile, 'utf8')).trim()).toBe(`${sessionId}:run-effect-process-killed`);

    process.env.LITTLESHEEP_DATA_DIR = rootDir;
    const llm = noCallLlm();
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      durableHarnessMode: 'next',
    });
    runners.push(runner);
    const events = await runner.infra.durableEventStore.read(sessionId!, 'run-effect-process-killed');
    const intent = events.find((event) => event.type === 'effect_intent_created');
    expect(intent).toBeTruthy();
    expect(events.some((event) => event.type === 'effect_settled')).toBe(false);
    const effectId = String(intent!.payload.effectId);
    const identity = { sessionId: sessionId!, runId: 'run-effect-process-killed', effectId };
    const [runLease, effectLease] = await Promise.all([
      runner.infra.durableRunLeaseStore.read(sessionId!, identity.runId),
      runner.infra.durableEffectLeaseStore.read(identity),
    ]);
    expect(runLease).toMatchObject({ status: 'active', attempts: 1 });
    expect(effectLease).toMatchObject({ status: 'active', attempts: 1 });
    await delay(Math.max(
      Date.parse(runLease?.leaseUntil ?? ''),
      Date.parse(effectLease?.leaseUntil ?? ''),
    ) - Date.now() + 50);

    const recovery = await runner.recoverDurableRun!(asSessionId(sessionId!), identity.runId);
    expect(recovery.actions).toContainEqual(expect.objectContaining({
      kind: 'effect_marked_unknown',
      effectId,
      reason: 'effect_settlement_unknown',
    }));
    expect(recovery.projection).toMatchObject({
      status: 'waiting_user',
      pendingEffectIds: [],
      unknownEffectIds: [effectId],
    });
    await expect(runner.infra.durableRunLeaseStore.read(sessionId!, identity.runId))
      .resolves.toMatchObject({ status: 'released', attempts: 2 });
    await expect(runner.infra.durableEffectLeaseStore.read(identity))
      .resolves.toMatchObject({ status: 'released', attempts: 2 });
    expect(llm.chat).not.toHaveBeenCalled();
    expect((await readFile(effectFile, 'utf8')).trim()).toBe(`${sessionId}:run-effect-process-killed`);
    await expect(runner.replayDurableFinalReply!(asSessionId(sessionId!), identity.runId))
      .resolves.toMatchObject({ kind: 'runtime_status', status: 'waiting_user' });

    const repeated = await runner.recoverDurableRun!(asSessionId(sessionId!), identity.runId);
    expect(repeated.actions).toEqual([]);
    expect(llm.chat).not.toHaveBeenCalled();
  }, 90_000);
});

function noCallLlm(): LlmClient & { chat: ReturnType<typeof vi.fn> } {
  const response: ChatResponse = { content: 'must not execute during recovery', toolCalls: [], finishReason: 'stop' };
  const chat = vi.fn(async (_request: ChatRequest) => response);
  return {
    chat,
    chatStream: async (request, onDelta) => {
      const result = await chat(request);
      onDelta({ type: 'done', finishReason: result.finishReason });
      return result;
    },
    embed: async () => ({ embeddings: [], model: 'test/model', usage: { promptTokens: 0 } }),
  };
}

function waitForChildMarker(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`child did not reach ${expected}: ${output}`)), 30_000);
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
    child.once('exit', (code) => finish(new Error(`child exited before effect start with code ${String(code)}: ${output}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}
