import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { asSessionId } from '@littlesheep/types';
import { createRunner, type AgentRunner } from './runner.js';

const roots: string[] = [];
const runners: AgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown().catch(() => undefined)));
  delete process.env.LITTLESHEEP_DATA_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('T04-C Provider request recovery', () => {
  it('fails closed when a request was not sent but the durable record cannot prove that fact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2b-provider-unsent-crash-'));
    roots.push(root);
    let requests = 0;
    const server = createServer(() => { requests += 1; });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('controlled HTTP server did not bind TCP');
      const child = spawnProviderCrashWorker(root, address.port, 'not-sent');
      try {
        await Promise.race([
          waitForFile(join(root, 'provider-request-not-sent.json')),
          waitForChildFailure(child),
        ]);
      } finally {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit'), delay(5_000)]);
      }
      expect(child.signalCode).toBe('SIGKILL');
      expect(requests).toBe(0);
      const startedAt = JSON.parse(await readFile(join(root, 'provider-request-started.json'), 'utf8')) as {
        sessionId: string;
        runId: string;
      };

      process.env.LITTLESHEEP_DATA_DIR = root;
      const runner = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/provider-crash',
        llm: noCallLlm(),
      });
      runners.push(runner);
      const lease = await runner.infra.durableRunLeaseStore.read(startedAt.sessionId, startedAt.runId);
      await delay(Math.max(0, Date.parse(lease?.leaseUntil ?? '') - Date.now() + 25));

      const recovery = await runner.recoverDurableRun!(asSessionId(startedAt.sessionId), startedAt.runId);
      expect(recovery.projection).toMatchObject({ status: 'waiting_user', finalReply: { state: 'runtime_status' } });
      expect(recovery.projection.modelRequests).toMatchObject([{
        status: 'missing',
        providerReachStatus: 'unknown',
        usageStatus: 'unknown',
      }]);
      expect(requests).toBe(0);
    } finally {
      await close(server);
    }
  }, 120_000);

  it('keeps an HTTP request with no response unknown and never resends it after SIGKILL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2b-provider-crash-'));
    roots.push(root);
    let requests = 0;
    const firstRequest = deferred();
    const server = createServer((request) => {
      requests += 1;
      request.resume();
      request.once('end', () => firstRequest.resolve());
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('controlled HTTP server did not bind TCP');
      const runId = 's2b-t04c-provider-crash';
      const child = spawnProviderCrashWorker(root, address.port);
      try {
        await Promise.race([firstRequest.promise, waitForChildFailure(child)]);
      } finally {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit'), delay(5_000)]);
      }
      expect(child.signalCode).toBe('SIGKILL');
      expect(requests).toBe(1);
      const startedAtPath = join(root, 'provider-request-started.json');
      const startedAt = JSON.parse(await readFile(startedAtPath, 'utf8')) as { sessionId: string; runId: string };
      expect(startedAt.runId).toBe(runId);
      const sessionId = startedAt.sessionId;

      process.env.LITTLESHEEP_DATA_DIR = root;
      const runner = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/provider-crash',
        llm: noCallLlm(),
      });
      runners.push(runner);
      const lease = await runner.infra.durableRunLeaseStore.read(sessionId, runId);
      await delay(Math.max(0, Date.parse(lease?.leaseUntil ?? '') - Date.now() + 25));

      const recovery = await runner.recoverDurableRun!(asSessionId(sessionId), runId);
      expect(recovery.projection).toMatchObject({ status: 'waiting_user', finalReply: { state: 'runtime_status' } });
      expect(recovery.projection.pendingModelRequestIds).toEqual([]);
      expect(recovery.projection.modelRequests).toHaveLength(1);
      expect(recovery.projection.modelRequests[0]).toMatchObject({
        status: 'missing',
        providerReachStatus: 'unknown',
        usageStatus: 'unknown',
      });
      expect(recovery.actions).toContainEqual(expect.objectContaining({
        kind: 'model_marked_missing',
        reason: 'model_response_missing',
      }));
      expect(requests).toBe(1);
      const events = await runner.infra.durableEventStore.read(sessionId, runId);
      expect(events.filter((event) => event.type === 'model_request_started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'model_request_settled')).toHaveLength(1);
      expect(events.some((event) => event.type === 'provider_usage_recorded')).toBe(false);
    } finally {
      await close(server);
    }
  }, 120_000);

  it('keeps a received but unpersisted HTTP response unknown and never sends another request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-s2b-provider-response-crash-'));
    roots.push(root);
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          content: 'response reached the client but was not handed to Runtime',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
        }));
      });
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('controlled HTTP server did not bind TCP');
      const child = spawnProviderCrashWorker(root, address.port, 'response-held');
      try {
        await Promise.race([
          waitForFile(join(root, 'provider-response-observed.json')),
          waitForChildFailure(child),
        ]);
      } finally {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit'), delay(5_000)]);
      }
      expect(child.signalCode).toBe('SIGKILL');
      expect(requests).toBe(1);
      const observedResponse = JSON.parse(await readFile(join(root, 'provider-response-observed.json'), 'utf8')) as {
        content: string;
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      };
      expect(observedResponse).toMatchObject({
        content: 'response reached the client but was not handed to Runtime',
        usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 },
      });
      const startedAt = JSON.parse(await readFile(join(root, 'provider-request-started.json'), 'utf8')) as {
        sessionId: string;
        runId: string;
      };

      process.env.LITTLESHEEP_DATA_DIR = root;
      const runner = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/provider-crash',
        llm: noCallLlm(),
      });
      runners.push(runner);
      const lease = await runner.infra.durableRunLeaseStore.read(startedAt.sessionId, startedAt.runId);
      await delay(Math.max(0, Date.parse(lease?.leaseUntil ?? '') - Date.now() + 25));

      const recovery = await runner.recoverDurableRun!(asSessionId(startedAt.sessionId), startedAt.runId);
      expect(recovery.projection).toMatchObject({ status: 'waiting_user', finalReply: { state: 'runtime_status' } });
      expect(recovery.projection.modelRequests).toHaveLength(1);
      expect(recovery.projection.modelRequests[0]).toMatchObject({
        status: 'missing',
        providerReachStatus: 'unknown',
        usageStatus: 'unknown',
      });
      expect(requests).toBe(1);
    } finally {
      await close(server);
    }
  }, 120_000);
});

function spawnProviderCrashWorker(root: string, port: number, mode = 'no-response'): ChildProcess {
  return spawn(process.execPath, [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    resolve('packages/runner/src/durable-runner-provider-request-crash-worker.test.ts'),
    '--pool=threads',
    '--maxWorkers=1',
    '--minWorkers=1',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      LS_S2B_PROVIDER_CRASH_ROOT: root,
      LS_S2B_PROVIDER_CRASH_PORT: String(port),
      LS_S2B_PROVIDER_CRASH_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForChildFailure(child: ChildProcess): Promise<never> {
  return new Promise((_resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => reject(new Error(`Provider child exited before HTTP request (${String(code)}): ${output}`)));
  });
}

function noCallLlm() {
  return {
    chat: async () => ({ content: 'must not resend an unknown Provider request', toolCalls: [], finishReason: 'stop' as const }),
    chatStream: async (_request: unknown, onDelta: (chunk: { type: 'done'; finishReason: 'stop' }) => void) => {
      const response = { content: 'must not resend an unknown Provider request', toolCalls: [], finishReason: 'stop' as const };
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    },
    embed: async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } }),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, 'utf8');
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for controlled Provider response marker: ${path}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, ms)));
}
