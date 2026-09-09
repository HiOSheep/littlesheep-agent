import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest } from '@littlesheep/llm';
import type { DurableModelRequestProjection } from '@littlesheep/types';
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

function modelRequest(
  overrides: Partial<DurableModelRequestProjection> = {},
): DurableModelRequestProjection {
  return {
    requestId: 'request-1',
    status: 'received',
    startedEventId: 'event-started-1',
    startedAt: '2026-09-09T00:00:00.000Z',
    respondedAt: '2026-09-09T00:00:00.100Z',
    settledAt: '2026-09-09T00:00:00.100Z',
    ...overrides,
  };
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

  it('reports only the authorized scope and never mixes another scope', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();
    const scopeA = scope({ sessionId: 'session-a' });
    const scopeB = scope({ sessionId: 'session-b' });
    await store.put(observation({ sessionId: 'session-a', modelRequestId: 'request-a' }), scopeA);
    await store.put(observation({ sessionId: 'session-b', modelRequestId: 'request-b' }), scopeB);

    const reportA = await store.report(scopeA);
    expect(reportA).toMatchObject({
      status: 'available',
      report: {
        requestCount: 1,
        providerPrompt: { statusCounts: { unavailable: 1 } },
      },
    });
    expect(JSON.stringify(reportA)).not.toContain('request-b');

    const reportB = await store.report(scopeB);
    expect(reportB).toMatchObject({
      status: 'available',
      report: {
        requestCount: 1,
        providerPrompt: { statusCounts: { unavailable: 1 } },
      },
    });
    expect(JSON.stringify(reportB)).not.toContain('request-a');
  });

  it('fails closed when the report scope cannot be authorized', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();

    await expect(store.report(scope({ key: null }))).resolves.toEqual({
      status: 'unavailable',
      reason: 'scope_key_unavailable',
    });
  });

  it('degrades the report gate when an entry cannot be parsed', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();
    await store.put(observation(), scope());
    await writeFile(join(root, 'corrupt.json'), '{', 'utf8');

    const result = await store.report(scope());
    expect(result).toMatchObject({
      status: 'available',
      report: { requestCount: 1, unreadableEntryCount: 1 },
    });
    if (result.status !== 'available') throw new Error('report unexpectedly unavailable');
    expect(result.report.releaseGate.reasons).toContain('cache_entries_unreadable');
  });

  it('reports only observations inside the requested time window', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => now });
    await store.initialize();
    await store.put(observation({
      request: {
        ...request,
        messages: [
          { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=old' },
          { role: 'user', content: 'old user content' },
        ],
      },
      modelRequestId: 'request-old',
    }), scope());
    now = 2_000;
    await store.put(observation({
      request: {
        ...request,
        messages: [
          { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=new' },
          { role: 'user', content: 'new user content' },
        ],
      },
      requestIndex: 2,
      modelRequestId: 'request-new',
    }), scope());

    const window = await store.report({ ...scope(), since: 1_500, until: 2_500 });
    expect(window).toMatchObject({
      status: 'available',
      report: { requestCount: 1, partitions: [{ requestCount: 1 }] },
    });
    expect(JSON.stringify(window)).not.toContain('request-old');

    const empty = await store.report({ ...scope(), since: 0, until: 500 });
    expect(empty).toMatchObject({ status: 'available', report: { requestCount: 0 } });

    await expect(store.report({ ...scope(), since: 500, until: 100 })).resolves.toEqual({
      status: 'unavailable',
      reason: 'report_window_invalid',
    });
  });

  it('summarizes latency only from durable requests matching authorized observations', async () => {
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root });
    await store.initialize();
    await store.put(observation({ modelRequestId: 'request-1' }), scope());
    await store.put(observation({
      request: {
        ...request,
        messages: [
          { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=two' },
          { role: 'user', content: 'second secret user content' },
        ],
      },
      requestIndex: 2,
      modelRequestId: 'request-2',
    }), scope());

    const result = await store.report({
      ...scope(),
      modelRequests: [
        modelRequest({
          requestId: 'request-1',
          startedAt: '2026-09-09T00:00:00.000Z',
          settledAt: '2026-09-09T00:00:00.100Z',
        }),
        modelRequest({
          requestId: 'request-2',
          startedAt: '2026-09-09T00:00:00.000Z',
          settledAt: '2026-09-09T00:00:00.300Z',
        }),
        modelRequest({
          requestId: 'request-other-scope',
          startedAt: '2026-09-09T00:00:00.000Z',
          settledAt: '2026-09-09T00:00:00.900Z',
        }),
      ],
    });

    expect(result).toMatchObject({
      status: 'available',
      report: {
        requestCount: 2,
        latency: {
          requestCount: 2,
          completedCount: 2,
          receivedCount: 2,
          p50Ms: 100,
          p95Ms: 300,
          maxMs: 300,
        },
      },
    });
    if (result.status !== 'available') throw new Error('report unexpectedly unavailable');
    expect(result.report.releaseGate.reasons).not.toContain('latency_unavailable');
  });

  it('returns only the latest authorized observation for a scope', async () => {
    let now = 1_000;
    const root = await mkdtemp(join(process.cwd(), 'cache-observation-store-'));
    roots.push(root);
    const store = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => now });
    await store.initialize();
    await store.put(observation({
      request: {
        ...request,
        messages: [
          { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=old' },
          { role: 'user', content: 'old user content' },
        ],
      },
      modelRequestId: 'request-old',
    }), scope());
    now = 2_000;
    await store.put(observation({
      request: {
        ...request,
        messages: [
          { role: 'system', content: 'Stable policy\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=new' },
          { role: 'user', content: 'new user content' },
        ],
      },
      requestIndex: 2,
      modelRequestId: 'request-new',
    }), scope());

    await expect(store.latest(scope())).resolves.toMatchObject({ modelRequestId: 'request-new' });
    await expect(store.latest(scope({ sessionId: 'session-b' }))).resolves.toBeUndefined();
    await expect(store.latest(scope({ key: null }))).resolves.toBeUndefined();
    now = 70_000;
    await expect(store.latest(scope())).resolves.toBeUndefined();
  });
});
