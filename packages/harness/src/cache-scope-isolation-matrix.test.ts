import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest } from '@littlesheep/llm';
import {
  buildCacheObservation,
  buildCacheScopePartition,
  type CacheScopeInput,
} from './cache-observability.js';
import { CacheObservationStore } from './cache-observation-store.js';

const roots: string[] = [];

const SESSIONS = ['session-a', 'session-b'] as const;
const WORKSPACES = ['C:\\Work\\LittleSheep', 'D:\\Other\\Workspace'] as const;
const PERMISSIONS = ['full', 'research', 'restricted'] as const;

function scope(
  sessionId: string,
  workspaceScope: string,
  permissionPolicyId: typeof PERMISSIONS[number],
): CacheScopeInput {
  return {
    sessionId,
    workspaceScope,
    permissionPolicyId,
    key: 'cache-scope-matrix-key',
  };
}

function allScopes(): CacheScopeInput[] {
  return SESSIONS.flatMap((sessionId) => (
    WORKSPACES.flatMap((workspaceScope) => (
      PERMISSIONS.map((permissionPolicyId) => scope(sessionId, workspaceScope, permissionPolicyId))
    ))
  ));
}

function request(label: string): ChatRequest {
  return {
    model: 'test/model',
    messages: [
      { role: 'system', content: `stable policy ${label}\n<!-- LITTLESHEEP_CACHE_BOUNDARY -->\nrun=${label}` },
      { role: 'user', content: `secret user content ${label}` },
    ],
  };
}

function observation(scopeInput: CacheScopeInput, index: number) {
  const label = `${scopeInput.sessionId}-${scopeInput.workspaceScope}-${scopeInput.permissionPolicyId}`;
  return buildCacheObservation({
    request: request(label),
    provider: 'openai',
    model: 'test/model',
    requestKind: 'reply',
    requestIndex: index,
    modelRequestId: `request-${index}`,
    ...scopeInput,
  });
}

async function createStore() {
  const root = await mkdtemp(join(process.cwd(), 'cache-scope-matrix-'));
  roots.push(root);
  const store = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => 1_000 });
  await store.initialize();
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CACHE-06 scope isolation matrix', () => {
  it('partitions every session, workspace and permission combination without exposing raw scope', () => {
    const scopes = allScopes();
    const partitions = scopes.map((input) => buildCacheScopePartition(input));

    expect(scopes).toHaveLength(12);
    expect(new Set(partitions.map((partition) => partition.partitionDigest)).size).toBe(12);
    const serialized = JSON.stringify(partitions);
    for (const sessionId of SESSIONS) expect(serialized).not.toContain(sessionId);
    for (const workspaceScope of WORKSPACES) expect(serialized).not.toContain(workspaceScope);
    expect(serialized).not.toContain('cache-scope-matrix-key');
  });

  it('returns only the caller scope and never correlates concurrent cross-scope reads', async () => {
    const { store } = await createStore();
    const scopes = allScopes();
    const observations = scopes.map((input, index) => observation(input, index + 1));

    const stored = await Promise.all(observations.map((item, index) => store.put(item, scopes[index]!)));
    expect(stored.every((entry) => entry.stored)).toBe(true);

    for (let index = 0; index < scopes.length; index++) {
      const own = await store.lookup({
        ...scopes[index]!,
        entryFingerprint: observations[index]!.normalizedRequest.fingerprint!,
      });
      expect(own).toMatchObject({
        status: 'hit',
        observation: { modelRequestId: `request-${index + 1}` },
      });

      const victim = (index + 1) % scopes.length;
      const cross = await store.lookup({
        ...scopes[index]!,
        entryFingerprint: observations[victim]!.normalizedRequest.fingerprint!,
      });
      expect(cross.status).not.toBe('hit');
      expect(cross).toMatchObject({ status: 'miss', reason: 'not_found' });
    }

    expect(new Set(observations.map((item) => item.scope.partitionDigest)).size).toBe(12);
    expect(new Set(observations.map((item) => item.stablePrefix.fingerprint)).size).toBe(12);
  });

  it('preserves the full isolation matrix across a store restart', async () => {
    const { root, store } = await createStore();
    const scopes = allScopes();
    const observations = scopes.map((input, index) => observation(input, index + 1));
    await Promise.all(observations.map((item, index) => store.put(item, scopes[index]!)));

    const restarted = new CacheObservationStore({ rootDir: root, maxAgeMs: 60_000, now: () => 2_000 });
    await restarted.initialize();

    const own = await restarted.lookup({
      ...scopes[0]!,
      entryFingerprint: observations[0]!.normalizedRequest.fingerprint!,
    });
    expect(own).toMatchObject({ status: 'hit', observation: { modelRequestId: 'request-1' } });

    for (let index = 1; index < scopes.length; index++) {
      const cross = await restarted.lookup({
        ...scopes[index]!,
        entryFingerprint: observations[0]!.normalizedRequest.fingerprint!,
      });
      expect(cross.status).not.toBe('hit');
    }
  });

  it('rejects a tampered entry whose embedded observation belongs to another scope', async () => {
    const { root, store } = await createStore();
    const scopeA = scope('session-a', WORKSPACES[0], 'research');
    const scopeB = scope('session-b', WORKSPACES[1], 'restricted');
    const observationA = observation(scopeA, 1);
    const observationB = observation(scopeB, 2);
    await store.put(observationA, scopeA);
    await store.put(observationB, scopeB);

    const files = (await readdir(root)).filter((file) => file.endsWith('.json'));
    let target: string | undefined;
    for (const file of files) {
      const entry = JSON.parse(await readFile(join(root, file), 'utf8')) as {
        observation?: { modelRequestId?: string };
      };
      if (entry.observation?.modelRequestId === 'request-2') {
        target = file;
        break;
      }
    }
    expect(target).toBeDefined();
    const path = join(root, target!);
    const entry = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    entry.observation = observationA;
    await writeFile(path, JSON.stringify(entry));

    await expect(store.lookup({
      ...scopeB,
      entryFingerprint: observationB.normalizedRequest.fingerprint!,
    })).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'scope_scope_mismatch',
    });
  });

  it('never persists raw session, workspace or user content across the matrix', async () => {
    const { root, store } = await createStore();
    const scopes = allScopes();
    await Promise.all(scopes.map((input, index) => store.put(observation(input, index + 1), input)));

    for (const file of (await readdir(root)).filter((entry) => entry.endsWith('.json'))) {
      const persisted = await readFile(join(root, file), 'utf8');
      for (const sessionId of SESSIONS) expect(persisted).not.toContain(sessionId);
      for (const workspaceScope of WORKSPACES) expect(persisted).not.toContain(workspaceScope);
      expect(persisted).not.toContain('secret user content');
      expect(persisted).not.toContain('stable policy');
    }
  });
});
