// Session isolation and the shared commit mutex for file observations.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionId } from '@littlesheep/types';
import { hashFileBytes, observationSnapshot } from '@littlesheep/tools';
import { SessionFileObservationRegistry } from './session-file-observations.js';

const tmpRoot = await mkdtemp(join(tmpdir(), 'ls-session-observations-'));
const file = join(tmpRoot, 'file.txt');
await writeFile(file, 'hello\n', 'utf8');

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function snapshot() {
  return observationSnapshot({
    version: hashFileBytes('hello\n'),
    sizeBytes: 6,
    mtimeMs: 1,
    coverage: 'full',
    runId: 'run-1',
  });
}

describe('SessionFileObservationRegistry', () => {
  it('keeps one session from borrowing another session\'s observation', () => {
    const registry = new SessionFileObservationRegistry();
    const first = registry.forSession('session-a' as SessionId);
    const second = registry.forSession('session-b' as SessionId);

    first.recordRead({ absPath: file, snapshot: snapshot() });

    expect(first.lookup(file).ok).toBe(true);
    expect(second.lookup(file).ok).toBe(false);
    registry.dispose();
  });

  it('returns the same table for repeated lookups of one session', () => {
    const registry = new SessionFileObservationRegistry();
    const first = registry.forSession('session-a' as SessionId);
    first.recordRead({ absPath: file, snapshot: snapshot() });

    const again = registry.forSession('session-a' as SessionId);
    expect(again.lookup(file).ok).toBe(true);
    registry.dispose();
  });

  it('drops the least recently used session table when bounded', () => {
    let clock = 0;
    const registry = new SessionFileObservationRegistry({ maxSessions: 1, now: () => (clock += 1) });
    const first = registry.forSession('session-a' as SessionId);
    first.recordRead({ absPath: file, snapshot: snapshot() });

    const second = registry.forSession('session-b' as SessionId);

    // The registry forgot session-a, so the next run of that session starts
    // from nothing and has to read the file again. A port already handed to a
    // live run keeps its own bounded table (eviction bounds memory, it does not
    // yank the basis out from under a run in flight).
    expect(second.lookup(file).ok).toBe(false);
    expect(registry.forSession('session-a' as SessionId).lookup(file).ok).toBe(false);
    registry.dispose();
  });

  it('forgets every table on dispose', () => {
    const registry = new SessionFileObservationRegistry();
    const port = registry.forSession('session-a' as SessionId);
    port.recordRead({ absPath: file, snapshot: snapshot() });
    registry.dispose();
    expect(registry.forSession('session-a' as SessionId).lookup(file).ok).toBe(false);
  });

  it('serializes the same path across two sessions of one host', async () => {
    const registry = new SessionFileObservationRegistry();
    const order: string[] = [];
    const first = registry.forSession('session-a' as SessionId);
    const second = registry.forSession('session-b' as SessionId);

    const slow = first.withPathLock(file, async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first:end');
    });
    const next = second.withPathLock(file, async () => {
      order.push('second');
    });

    await Promise.all([slow, next]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    registry.dispose();
  });
});
