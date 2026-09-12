import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableEffectLeaseStore', () => {
  it('fences owners, permits expiry takeover, and rejects the stale token', async () => {
    const rootDir = await newRoot();
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const first = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000, now });
    const second = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000, now });
    const identity = { sessionId: 'session-a', runId: 'run-a', effectId: 'tool:write:sensitive-input-hash' };
    const acquired = await first.acquire(identity);
    expect(acquired.kind).toBe('acquired');
    expect(await second.acquire(identity)).toMatchObject({ kind: 'conflict' });

    nowMs += 1_001;
    const reclaimed = await second.acquire(identity);
    expect(reclaimed).toMatchObject({ kind: 'reclaimed', lease: { attempts: 2 } });
    await expect(first.release(identity, acquired.lease.ownerToken!)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(second.release(identity, reclaimed.lease.ownerToken!)).resolves.toMatchObject({ status: 'released' });
  });

  it('stores only a derived effect key, never the raw run or effect identity', async () => {
    const rootDir = await newRoot();
    const store = new DurableEffectLeaseStore({ rootDir, leaseMs: 1_000 });
    await store.acquire({
      sessionId: 'session-visible',
      runId: 'run-secret-value',
      effectId: 'tool:exec:secret-resource-value',
    });
    const files = (await readdir(rootDir)).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(rootDir, files[0]!), 'utf8');
    expect(raw).not.toContain('run-secret-value');
    expect(raw).not.toContain('secret-resource-value');
    expect(raw).toContain('effect-');
  });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-durable-effect-lease-'));
  roots.push(root);
  return root;
}
