import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
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

describe('same-Run segment recovery after process restart', () => {
  it.fails('continues the same Run from its persisted segment boundary without replaying settled effects', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-s2b-segment-restart-'));
    roots.push(rootDir);
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      resolve('packages/runner/src/durable-runner-segment-recovery-worker.test.ts'),
      '--pool=threads',
      '--maxWorkers=1',
      '--minWorkers=1',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, LS_RUNNER_SEGMENT_RECOVERY_ROOT: rootDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let marker = '';
    try {
      marker = await waitForChildMarker(child, 'LS_RUNNER_SEGMENT_CHECKPOINT:');
    } finally {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }

    const identity = marker.match(/LS_RUNNER_SEGMENT_CHECKPOINT:([^:\r\n]+):([^:\r\n]+):([^\r\n]+)/u);
    expect(identity).toBeTruthy();
    const [, sessionId, runId] = identity!;
    const workspace = join(rootDir, 'workspace');
    expect(readdirSync(workspace).filter((name) => name.endsWith('.txt'))).toHaveLength(30);

    process.env.LITTLESHEEP_DATA_DIR = rootDir;
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.maxModelCallsPerRun = 64;
    config.agents.defaults.maxToolCallsPerRun = 64;
    config.agents.defaults.maxToolLoopIterationsPerRun = 60;
    let additionalCalls = 0;
    const chat = async (_request: ChatRequest): Promise<ChatResponse> => {
      additionalCalls += 1;
      return { content: 'This must be the recovered Run final response.', toolCalls: [], finishReason: 'stop' };
    };
    const llm: LlmClient = {
      chat,
      chatStream: async (request, onDelta) => {
        const response = await chat(request);
        onDelta({ type: 'done', finishReason: response.finishReason });
        return response;
      },
      embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
    };
    const restarted = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/segment-recovery',
      llm,
      approve: async () => true,
      skillsDirs: [],
    });
    runners.push(restarted);
    const priorLease = await restarted.infra.durableRunLeaseStore.read(sessionId!, runId!);
    await delay(Math.max(0, Date.parse(priorLease?.leaseUntil ?? '') - Date.now() + 25));

    // The real Runner recovery entry must resume the existing logical Run.
    // This assertion is intentionally expected to fail until same-Run recovery
    // exists; current recovery only reconciles durable facts and then stops.
    const recovered = await restarted.recoverDurableRun!(asSessionId(sessionId!), runId!);
    expect.soft(recovered.projection).toMatchObject({ status: 'completed', runId });
    expect.soft(readdirSync(workspace).filter((name) => name.endsWith('.txt'))).toHaveLength(35);
    expect(existsSync(join(workspace, 'step-01.txt'))).toBe(true);
    expect.soft(additionalCalls).toBeGreaterThan(0);
  }, 120_000);
});

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
    child.once('exit', (code) => finish(new Error(`child exited before checkpoint with code ${String(code)}: ${output}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}
