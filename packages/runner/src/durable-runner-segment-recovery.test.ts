import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import type { ChatResponse, LlmClient } from '@littlesheep/llm';
import { reduceDurableRunProjection } from '@littlesheep/harness';
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
    const initialStepFiles = readdirSync(workspace).filter((name) => /^step-\d+\.txt$/u.test(name)).sort();
    expect(initialStepFiles).toHaveLength(29);
    expect(initialStepFiles).toEqual(Array.from({ length: 29 }, (_, index) => `step-${String(index + 1).padStart(2, '0')}.txt`));
    expect(readFileSync(join(workspace, 'result.out'), 'utf8')).toBe('hello');

    process.env.LITTLESHEEP_DATA_DIR = rootDir;
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.maxModelCallsPerRun = 64;
    config.agents.defaults.maxToolCallsPerRun = 64;
    config.agents.defaults.maxToolLoopIterationsPerRun = 60;
    const restarted = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/segment-recovery',
      llm: noCallLlm(),
      approve: async () => true,
      skillsDirs: [],
    });
    runners.push(restarted);
    const priorLease = await restarted.infra.durableRunLeaseStore.read(sessionId!, runId!);
    await delay(Math.max(0, Date.parse(priorLease?.leaseUntil ?? '') - Date.now() + 25));

    const contenders = [spawnRecoveryContender(rootDir, 'alpha', sessionId!, runId!)];
    try {
      await waitForFile(join(rootDir, 'recovery-contender-barrier', 'alpha.ready'));
      contenders.push(spawnRecoveryContender(rootDir, 'beta', sessionId!, runId!));
      await waitForFile(join(rootDir, 'recovery-contender-barrier', 'beta.ready'));
      await Promise.all(contenders.map(waitForContenderExit));
    } finally {
      for (const contender of contenders) {
        if (contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL');
      }
    }
    const results = ['alpha', 'beta'].map((workerId) => JSON.parse(
      readFileSync(join(rootDir, `recovery-${workerId}.json`), 'utf8'),
    ) as RecoveryContenderResult);
    const resumedResults = results.filter((result) => result.providerCalls > 0);
    expect(resumedResults).toHaveLength(1);
    expect(results.every((result) => result.status === 'completed' || result.status === 'ownership_conflict')).toBe(true);
    expect(resumedResults[0]?.toolResultCounts).toEqual([30, 31, 32, 33, 34, 35, 36]);
    const recoveredProjection = reduceDurableRunProjection(
      await restarted.infra.durableEventStore.read(sessionId!, runId!),
    );
    expect(recoveredProjection).toMatchObject({ status: 'completed', runId, finalReply: { state: 'settled' } });
    const resultFiles = readdirSync(workspace).filter((name) => name.endsWith('.txt')).sort();
    expect(resultFiles).toHaveLength(34);
    expect(resultFiles).toEqual(Array.from({ length: 34 }, (_, index) => `step-${String(index + 1).padStart(2, '0')}.txt`));
    for (let index = 1; index <= 34; index += 1) {
      expect(readFileSync(join(workspace, `step-${String(index).padStart(2, '0')}.txt`), 'utf8')).toBe(`completed:${index}\n`);
    }
    expect(recoveredProjection.effects).toHaveLength(36);
    expect(new Set(recoveredProjection.effects.map((effect) => effect.effectId)).size).toBe(36);
    expect(recoveredProjection.effects.filter((effect) => effect.toolName === 'write')).toHaveLength(35);
    expect(recoveredProjection.effects.filter((effect) => effect.toolName === 'runtime_check_file_content')).toHaveLength(1);
    expect(recoveredProjection.effects.every((effect) => effect.status === 'succeeded')).toBe(true);
    expect(readFileSync(join(workspace, 'result.out'), 'utf8')).toBe('hello');
    const taskOutcome = await restarted.replayTaskOutcome!(asSessionId(sessionId!), runId!);
    expect(taskOutcome).toMatchObject({
      runId,
      status: 'completed',
      requirementInventory: 'complete',
      requirements: [{ sourceMessageId: expect.any(String), status: 'passed' }],
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: 'file_state', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ kind: 'requirement_check', status: 'pass' }),
        expect.objectContaining({ kind: 'settled_effect', status: 'pass' }),
      ]),
    });
    const events = await restarted.infra.durableEventStore.read(sessionId!, runId!);
    expect(events.filter((event) => event.type === 'run_accepted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'user_input_appended')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task_outcome_settled')).toHaveLength(1);
    expect((await restarted.replay(runId!))?.taskOutcome).toEqual(taskOutcome);
    const requestIndexes = recoveredProjection.modelRequests.map((request) => request.requestIndex).filter((index) => index !== undefined);
    expect(new Set(requestIndexes).size).toBe(requestIndexes.length);
    expect(Math.max(...requestIndexes)).toBeGreaterThan(30);
    const recoveredLease = await restarted.infra.durableRunLeaseStore.read(sessionId!, runId!);
    expect(recoveredLease?.status).toBe('released');
    expect([2, 3]).toContain(recoveredLease?.attempts);
  }, 300_000);
});

interface RecoveryContenderResult {
  status: 'completed' | 'ownership_conflict' | 'failed';
  providerCalls: number;
  toolResultCounts: number[];
  error?: string;
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

function spawnRecoveryContender(rootDir: string, workerId: string, sessionId: string, runId: string): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    resolve('packages/runner/src/durable-runner-segment-recovery-contender-worker.test.ts'),
    '--pool=threads',
    '--maxWorkers=1',
    '--minWorkers=1',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      LS_RUNNER_SEGMENT_RECOVERY_ROOT: rootDir,
      LS_RUNNER_SEGMENT_RECOVERY_CONTENDER: workerId,
      LS_RUNNER_SEGMENT_RECOVERY_SESSION: sessionId,
      LS_RUNNER_SEGMENT_RECOVERY_RUN: runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForContenderExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`recovery contender timed out: ${output}`)), 240_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('exit');
      error ? rejectExit(error) : resolveExit();
    };
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => code === 0
      ? finish()
      : finish(new Error(`recovery contender exited with code ${String(code)}: ${output}`)));
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(20);
  }
  throw new Error(`recovery contender did not reach readiness: ${path}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}

function noCallLlm(): LlmClient {
  const response: ChatResponse = { content: 'must not execute from recovery inspection', toolCalls: [], finishReason: 'stop' };
  return {
    chat: async () => response,
    chatStream: async (_request, onDelta) => {
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}
