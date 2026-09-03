import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest } from '@littlesheep/llm';
import { buildCacheObservation } from './cache-observability.js';
import { CacheObservationStore } from './cache-observation-store.js';

const roots: string[] = [];
const request: ChatRequest = {
  model: 'test/model',
  messages: [
    { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=one' },
    { role: 'user', content: 'secret user content' },
  ],
};

function scope(overrides: Partial<{
  sessionId: string;
  workspaceScope: string;
  permissionPolicyId: 'full' | 'research' | 'restricted' | undefined;
  key: string | null;
}> = {}) {
  return {
    sessionId: 'session-a',
    workspaceScope: 'C:\\Work\\LittleSheep',
    permissionPolicyId: 'research' as const,
    key: 'persistent-cache-key',
    ...overrides,
  };
}

function observation(overrides: Partial<Parameters<typeof buildCacheObservation>[0]> = {}) {
  return buildCacheObservation({
    request,
    provider: 'openai',
    model: request.model,
    requestKind: 'reply',
    requestIndex: 1,
    modelRequestId: 'request-1',
    ...scope(),
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CacheObservationStore', () => {
  it('survives a restart and returns only the exact authorized scope entry', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const first = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => 1_000 });
    await first.initialize();
    const current = observation();
    await expect(first.put(current, scope())).resolves.toEqual({ stored: true });

    const restarted = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => 2_000 });
    await restarted.initialize();
    await expect(restarted.lookup({
      ...scope(),
      entryFingerprint: current.normalizedRequest.fingerprint!,
    })).resolves.toMatchObject({ status: 'hit', observation: { modelRequestId: 'request-1' } });
    await expect(restarted.lookup({
      ...scope({ sessionId: 'session-b' }),
      entryFingerprint: current.normalizedRequest.fingerprint!,
    })).resolves.toMatchObject({ status: 'miss', reason: 'not_found' });
    await expect(restarted.lookup({
      ...scope({ permissionPolicyId: 'restricted' }),
      entryFingerprint: current.normalizedRequest.fingerprint!,
    })).resolves.toMatchObject({ status: 'miss', reason: 'not_found' });
  });

  it('rejects unavailable scope and ephemeral identities before any cache write', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();
    const current = observation();
    await expect(store.put(current, scope({ key: null }))).resolves.toEqual({
      stored: false,
      reason: 'scope_key_unavailable',
    });
    await expect(store.put(current, scope({ permissionPolicyId: undefined }))).resolves.toEqual({
      stored: false,
      reason: 'scope_scope_unavailable',
    });
    expect((await readdir(root)).filter((file) => file.endsWith('.json'))).toEqual([]);
  });

  it('never persists prompt text and expires entries conservatively', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root, maxAgeMs: 100, now: () => now });
    await store.initialize();
    const current = observation();
    await expect(store.put(current, scope())).resolves.toEqual({ stored: true });
    const file = (await readdir(root)).find((entry) => entry.endsWith('.json'))!;
    const persisted = await readFile(join(root, file), 'utf8');
    expect(persisted).not.toContain('secret user content');
    expect(persisted).not.toContain('Stable policy');
    now = 1_101;
    await expect(store.lookup({
      ...scope(),
      entryFingerprint: current.normalizedRequest.fingerprint!,
    })).resolves.toEqual({ status: 'miss', reason: 'expired' });
  });

  it('serializes concurrent writes without producing partial JSON', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();
    const entries = await Promise.all(Array.from({ length: 24 }, (_, index) => {
      const current = observation({
        sessionId: `session-${index + 1}`,
        requestIndex: index + 1,
        modelRequestId: `request-${index + 1}`,
      });
      return store.put(current, scope({ sessionId: `session-${index + 1}` }));
    }));
    expect(entries.every((entry) => entry.stored)).toBe(true);
    for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.json'))) {
      await expect(readFile(join(root, file), 'utf8')).resolves.toMatch(/^\{/u);
    }
  });
});
