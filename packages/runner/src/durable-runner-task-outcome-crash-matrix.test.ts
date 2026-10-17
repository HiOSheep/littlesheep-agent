import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import type { LlmClient } from '@littlesheep/llm';
import { asSessionId, unknownTaskOutcome } from '@littlesheep/types';
import { reduceDurableRunProjection } from '@littlesheep/harness';
import { createRunner, type AgentRunner } from './runner.js';

const roots: string[] = [];
const runners: AgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)));
  delete process.env.LITTLESHEEP_DATA_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('S2C-D Task Outcome settlement process crash matrix', () => {
  it('records file checks as facts about the checked version, not a later external version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2c-d-file-version-'));
    roots.push(root);
    const child = spawnWorker(root, 'run', 'external_change_before_outcome');
    const identity = parseIdentity(await waitForMarker(child, 'LS_S2C_D_IDENTITY:'));
    await writeFile(join(root, 'begin-run'), 'start', 'utf8');
    await waitForMarker(child, 'LS_S2C_D_WORKER_RETURNED:');
    await waitChildExit(child);
    expect(child.exitCode).toBe(0);
    expect(readFileSync(join(root, 'workspace', 'result.txt'), 'utf8')).toBe('goodbye');

    process.env.LITTLESHEEP_DATA_DIR = root;
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/s2c-d-file-version-read',
      llm: noCallLlm(),
      skillsDirs: [],
    });
    runners.push(runner);
    const replayed = await runner.replayTaskOutcome!(asSessionId(identity.sessionId), identity.runId);
    expect(replayed).toMatchObject({
      status: 'completed',
      requirements: [{ status: 'passed' }],
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: 'requirement_check',
          contentHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        }),
      ]),
    });
    expect((await runner.replay(identity.runId))?.taskOutcome).toEqual(replayed);
    unlinkSync(join(root, 'workspace', 'result.txt'));
    expect((await runner.replayTaskOutcome!(asSessionId(identity.sessionId), identity.runId))).toEqual(replayed);
  }, 120_000);

  it.each([
    ['before-outcome-construction', 'after_final_reply_proposed'],
    ['outcome-durable-before-execution-log', 'after_task_outcome_settled'],
    ['execution-log-durable-before-final-reply', 'after_execution_log_write'],
    ['final-reply-durable-before-run-completed', 'before_run_completed'],
    ['run-completed-before-caller-result', 'after_run_completed'],
  ] as const)('recovers conservatively across %s', async (_name, phase) => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2c-d-outcome-crash-'));
    roots.push(root);
    const child = spawnWorker(root, 'run', phase);
    let identity: RunIdentity | undefined;
    try {
      identity = await startRunAndWaitForCrash(child, root);
      child.kill('SIGKILL');
      await waitChildExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(child.signalCode).toBe('SIGKILL');
    await expireDeadProcessLease(root, identity!.runId);

    process.env.LITTLESHEEP_DATA_DIR = root;
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/s2c-d-outcome-crash-recovery',
      llm: noCallLlm(),
      skillsDirs: [],
    });
    runners.push(runner);
    const preRecoveryEvents = await runner.infra.durableEventStore.read(identity!.sessionId, identity!.runId);
    const preRecoveryOutcomeEvents = preRecoveryEvents.filter((event) => event.type === 'task_outcome_settled');
    const preRecoveryReplyEvents = preRecoveryEvents.filter((event) => event.type === 'final_reply_settled');
    const preRecoveryCompletionEvents = preRecoveryEvents.filter((event) => event.type === 'run_completed');
    const preRecoveryLog = await runner.infra.executionLogStore.read(identity!.runId);
    if (phase === 'after_final_reply_proposed') {
      expect(preRecoveryEvents.some((event) => event.type === 'final_reply_proposed')).toBe(true);
      expect(preRecoveryOutcomeEvents).toHaveLength(0);
    } else if (phase === 'after_task_outcome_settled') {
      expect(preRecoveryOutcomeEvents).toHaveLength(1);
      expect(preRecoveryLog).toBeNull();
    } else if (phase === 'after_execution_log_write') {
      expect(preRecoveryOutcomeEvents).toHaveLength(1);
      expect(preRecoveryLog?.taskOutcome?.status).toBe('completed');
      expect(preRecoveryReplyEvents).toHaveLength(0);
    } else if (phase === 'before_run_completed') {
      expect(preRecoveryReplyEvents).toHaveLength(1);
      expect(preRecoveryCompletionEvents).toHaveLength(0);
    } else {
      expect(preRecoveryCompletionEvents).toHaveLength(1);
    }
    const recovery = await runner.recoverDurableRun!(asSessionId(identity!.sessionId), identity!.runId);
    const events = await runner.infra.durableEventStore.read(identity!.sessionId, identity!.runId);
    const projection = reduceDurableRunProjection(events);
    const taskOutcomeEvents = events.filter((event) => event.type === 'task_outcome_settled');
    const replyEvents = events.filter((event) => event.type === 'final_reply_settled');
    const completionEvents = events.filter((event) => event.type === 'run_completed');

    expect(projection.runId).toBe(identity!.runId);
    expect(taskOutcomeEvents.length).toBeLessThanOrEqual(1);
    expect(replyEvents.length).toBeLessThanOrEqual(1);
    expect(completionEvents.length).toBeLessThanOrEqual(1);
    expect(recovery.projection.runId).toBe(identity!.runId);

    if (phase === 'after_final_reply_proposed') {
      expect(taskOutcomeEvents).toHaveLength(1);
      expect(taskOutcomeEvents[0]?.payload.outcome).toEqual(unknownTaskOutcome(identity!.runId));
      expect(replyEvents).toHaveLength(0);
      expect(completionEvents).toHaveLength(0);
      await expect(runner.replayTaskOutcome!(asSessionId(identity!.sessionId), identity!.runId))
        .resolves.toMatchObject({ status: 'unknown', requirements: [] });
    } else if (phase === 'after_task_outcome_settled') {
      expect(taskOutcomeEvents).toHaveLength(1);
      expect(taskOutcomeEvents[0]?.payload.outcome).toMatchObject({
        status: 'completed', requirements: [{ status: 'passed' }],
      });
      expect(replyEvents).toHaveLength(1);
      expect(completionEvents).toHaveLength(1);
      // The durable fact is intact, but the missing audit projection cannot prove its evidence.
      await expect(runner.replayTaskOutcome!(asSessionId(identity!.sessionId), identity!.runId))
        .resolves.toMatchObject({ status: 'unknown' });
    } else {
      const replayed = await runner.replayTaskOutcome!(asSessionId(identity!.sessionId), identity!.runId);
      expect(replayed).toMatchObject({
        runId: identity!.runId,
        status: 'completed',
        requirements: [{ status: 'passed' }],
      });
      expect(replyEvents).toHaveLength(1);
      expect(completionEvents).toHaveLength(1);
    }

    expect(readFileSync(join(root, 'workspace', 'result.txt'), 'utf8')).toBe('hello');
    const toolEffects = projection.effects.filter((effect) => (
      effect.toolName === 'write' || effect.toolName === 'runtime_check_file_content'
    ));
    expect(toolEffects.filter((effect) => effect.toolName === 'write')).toHaveLength(1);
    expect(toolEffects.filter((effect) => effect.toolName === 'runtime_check_file_content')).toHaveLength(1);
  }, 180_000);

  it('does not duplicate settlement when a real recovery process is killed after reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2c-d-recovery-crash-'));
    roots.push(root);
    const initial = spawnWorker(root, 'run', 'before_run_completed');
    let identity: RunIdentity | undefined;
    try {
      identity = await startRunAndWaitForCrash(initial, root);
      initial.kill('SIGKILL');
      await waitChildExit(initial);
    } finally {
      if (initial.exitCode === null && initial.signalCode === null) initial.kill('SIGKILL');
    }
    expect(initial.signalCode).toBe('SIGKILL');
    await expireDeadProcessLease(root, identity!.runId);

    const recoveryWorker = spawnWorker(root, 'recover', 'after_run_completed', identity!);
    try {
      const marker = await waitForMarker(recoveryWorker, 'LS_S2C_D_CRASH_READY:');
      expect(marker).toContain(`:${identity!.runId}:run_completed`);
      recoveryWorker.kill('SIGKILL');
      await waitChildExit(recoveryWorker);
    } finally {
      if (recoveryWorker.exitCode === null && recoveryWorker.signalCode === null) recoveryWorker.kill('SIGKILL');
    }
    expect(recoveryWorker.signalCode).toBe('SIGKILL');
    await expireDeadProcessLease(root, identity!.runId);

    process.env.LITTLESHEEP_DATA_DIR = root;
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/s2c-d-outcome-second-recovery',
      llm: noCallLlm(),
      skillsDirs: [],
    });
    runners.push(runner);
    const recovered = await runner.recoverDurableRun!(asSessionId(identity!.sessionId), identity!.runId);
    expect(recovered.projection).toMatchObject({
      status: 'completed',
      runId: identity!.runId,
      finalReply: { state: 'settled' },
    });
    const events = await runner.infra.durableEventStore.read(identity!.sessionId, identity!.runId);
    expect(events.filter((event) => event.type === 'task_outcome_settled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'final_reply_settled')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_completed')).toHaveLength(1);
    await expect(runner.replayTaskOutcome!(asSessionId(identity!.sessionId), identity!.runId))
      .resolves.toMatchObject({ status: 'completed', requirements: [{ status: 'passed' }] });
  }, 180_000);
});

interface RunIdentity {
  sessionId: string;
  runId: string;
}

function spawnWorker(root: string, mode: 'run' | 'recover', phase: string, identity?: RunIdentity): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    resolve('packages/runner/src/durable-runner-task-outcome-crash-worker.test.ts'),
    '--pool=threads',
    '--maxWorkers=1',
    '--minWorkers=1',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      LS_S2C_D_ROOT: root,
      LS_S2C_D_MODE: mode,
      LS_S2C_D_PHASE: phase,
      ...(identity ? { LS_S2C_D_SESSION: identity.sessionId, LS_S2C_D_RUN: identity.runId } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const childOutputStates = new WeakMap<ChildProcess, { output: string; listeners: Set<() => void> }>();

function waitForMarker(child: ChildProcess, prefix: string): Promise<string> {
  const state = getChildOutputState(child);
  if (state.output.includes(prefix)) return Promise.resolve(state.output);
  return new Promise((resolveMarker, rejectMarker) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.listeners.delete(check);
      child.removeListener('exit', onExit);
      error ? rejectMarker(error) : resolveMarker(state.output);
    };
    const check = () => {
      if (state.output.includes(prefix)) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`child exited before marker with ${String(code ?? signal)}: ${state.output}`));
    };
    const timer = setTimeout(
      () => finish(new Error(`child did not reach ${prefix}: ${state.output}`)),
      90_000,
    );
    state.listeners.add(check);
    child.once('exit', onExit);
    check();
  });
}

function getChildOutputState(child: ChildProcess): { output: string; listeners: Set<() => void> } {
  const existing = childOutputStates.get(child);
  if (existing) return existing;
  const state = { output: '', listeners: new Set<() => void>() };
  childOutputStates.set(child, state);
  const append = (chunk: Buffer) => {
    state.output += chunk.toString('utf8');
    for (const listener of state.listeners) listener();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return state;
}

function parseIdentity(output: string): RunIdentity {
  const match = output.match(/LS_S2C_D_IDENTITY:([^:\r\n]+):([^:\r\n]+)/u);
  if (!match) throw new Error(`invalid crash worker identity marker: ${output}`);
  return { sessionId: match[1]!, runId: match[2]! };
}

async function startRunAndWaitForCrash(child: ChildProcess, root: string): Promise<RunIdentity> {
  const identity = parseIdentity(await waitForMarker(child, 'LS_S2C_D_IDENTITY:'));
  await writeFile(join(root, 'begin-run'), 'start', 'utf8');
  const crash = await waitForMarker(child, 'LS_S2C_D_CRASH_READY:');
  expect(crash).toContain(`:${identity.runId}:`);
  return identity;
}

async function waitChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

async function expireDeadProcessLease(root: string, runId: string): Promise<void> {
  const directory = join(root, 'durable-run-leases');
  const entries = readdirSync(directory).filter((name) => name.endsWith('.json'));
  const matching = entries.find((name) => {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { runId?: string };
      return value.runId === runId;
    } catch {
      return false;
    }
  });
  if (!matching) throw new Error(`could not find persisted lease for ${runId}`);
  const path = join(directory, matching);
  const lease = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...lease, leaseUntil: new Date(0).toISOString() }, null, 2), 'utf8');
}

function noCallLlm(): LlmClient {
  return {
    chat: async () => { throw new Error('recovery must not start another model request'); },
    chatStream: async () => { throw new Error('recovery must not start another model request'); },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}
