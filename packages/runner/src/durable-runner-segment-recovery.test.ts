import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
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
  it('continues the same Run from its persisted segment boundary without replaying settled effects', async () => {
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
    expect(child.signalCode).toBe('SIGKILL');

    const identity = marker.match(/LS_RUNNER_SEGMENT_CHECKPOINT:([^:\r\n]+):([^:\r\n]+):([^\r\n]+)/u);
    expect(identity).toBeTruthy();
    const [, sessionId, runId] = identity!;
    const workspace = join(rootDir, 'workspace');
    const initialFiles = readdirSync(workspace).filter((name) => name.endsWith('.txt')).sort();
    expect(initialFiles).toHaveLength(30);
    expect(initialFiles).toEqual(Array.from({ length: 30 }, (_, index) => `step-${String(index + 1).padStart(2, '0')}.txt`));

    process.env.LITTLESHEEP_DATA_DIR = rootDir;
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.maxModelCallsPerRun = 64;
    config.agents.defaults.maxToolCallsPerRun = 64;
    config.agents.defaults.maxToolLoopIterationsPerRun = 60;
    let additionalCalls = 0;
    const resumedRequestToolResultCounts: number[] = [];
    const chat = async (request: ChatRequest): Promise<ChatResponse> => {
      additionalCalls += 1;
      resumedRequestToolResultCounts.push(request.messages.filter((message) => message.role === 'tool').length);
      return nextFixtureResponse(request, workspace);
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

    const recovered = await restarted.recoverDurableRun!(asSessionId(sessionId!), runId!);
    expect(recovered.projection).toMatchObject({ status: 'completed', runId, finalReply: { state: 'settled' } });
    const resultFiles = readdirSync(workspace).filter((name) => name.endsWith('.txt')).sort();
    expect(resultFiles).toHaveLength(35);
    expect(resultFiles).toEqual(Array.from({ length: 35 }, (_, index) => `step-${String(index + 1).padStart(2, '0')}.txt`));
    for (let index = 1; index <= 35; index += 1) {
      expect(readFileSync(join(workspace, `step-${String(index).padStart(2, '0')}.txt`), 'utf8')).toBe(`completed:${index}\n`);
    }
    expect(additionalCalls).toBeGreaterThan(0);
    expect(resumedRequestToolResultCounts).toEqual([30, 31, 32, 33, 34, 35]);
    expect(recovered.projection.effects).toHaveLength(35);
    expect(new Set(recovered.projection.effects.map((effect) => effect.effectId)).size).toBe(35);
    expect(recovered.projection.effects.every((effect) => effect.status === 'succeeded')).toBe(true);
    const events = await restarted.infra.durableEventStore.read(sessionId!, runId!);
    expect(events.filter((event) => event.type === 'run_accepted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'user_input_appended')).toHaveLength(1);
    const requestIndexes = recovered.projection.modelRequests.map((request) => request.requestIndex).filter((index) => index !== undefined);
    expect(new Set(requestIndexes).size).toBe(requestIndexes.length);
    expect(Math.max(...requestIndexes)).toBeGreaterThan(30);
    const recoveredLease = await restarted.infra.durableRunLeaseStore.read(sessionId!, runId!);
    expect(recoveredLease).toMatchObject({ status: 'released', attempts: 2 });
  }, 300_000);
});

function nextFixtureResponse(request: ChatRequest, workspace: string): ChatResponse {
  const prompt = request.messages.map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n');
  const completed = request.messages.filter((message) => message.role === 'tool').length;
  if (completed === 0 && prompt.includes('Choose the next LittleSheep activity')) {
    return { content: '{"type":"problem","confidence":0.99,"reason":"segment crash fixture"}', toolCalls: [], finishReason: 'stop' };
  }
  if (completed < 35) {
    const step = completed + 1;
    return {
      content: '',
      toolCalls: [{
        id: `segment-recovery-${step}`,
        type: 'function',
        function: {
          name: 'write',
          arguments: JSON.stringify({
            file_path: join(workspace, `step-${String(step).padStart(2, '0')}.txt`),
            content: `completed:${step}\n`,
          }),
        },
      }],
      finishReason: 'tool_calls',
    };
  }
  return { content: 'All 35 recovery fixture operations completed.', toolCalls: [], finishReason: 'stop' };
}

function waitForChildMarker(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`child did not reach ${expected}: ${output}`)), 180_000);
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
