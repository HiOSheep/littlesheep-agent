import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

const roots: string[] = [];
const identity = { sessionId: 'session-killed', runId: 'run-killed', effectId: 'effect-killed' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable effect lease process recovery', () => {
  it('reclaims effect ownership after a renewing OS process is killed', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-effect-lease-kill-'));
    roots.push(rootDir);
    const child = spawn(process.execPath, [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      resolve('packages/runner/src/durable-effect-lease-crash-worker.test.ts'),
      '--pool=threads',
      '--maxWorkers=1',
      '--minWorkers=1',
    ], {
      cwd: resolve('.'),
      env: { ...process.env, LS_DURABLE_EFFECT_LEASE_CRASH_ROOT: rootDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForChildMarker(child, 'LS_DURABLE_EFFECT_LEASE_RENEWED');
    } finally {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
    }

    const store = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000 });
    const inherited = await store.read(identity);
    expect(inherited).toMatchObject({ status: 'active', attempts: 1 });
    await expect(store.acquire(identity)).resolves.toMatchObject({ kind: 'conflict' });
    await delay(Math.max(0, Date.parse(inherited?.leaseUntil ?? '') - Date.now() + 25));

    const reclaimed = await store.acquire(identity);
    expect(reclaimed).toMatchObject({ kind: 'reclaimed', lease: { status: 'active', attempts: 2 } });
    expect(reclaimed.lease.ownerToken).not.toBe(inherited?.ownerToken);
    await store.release(identity, reclaimed.lease.ownerToken!);
  }, 30_000);
});

function waitForChildMarker(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolveMarker, rejectMarker) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`child did not reach ${marker}: ${output}`)), 20_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('exit');
      error ? rejectMarker(error) : resolveMarker();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(marker)) finish();
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('exit', (code) => finish(new Error(`child exited before renewal with code ${String(code)}: ${output}`)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
