import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableHarnessKernel } from '@littlesheep/harness';
import type { SessionManager } from '@littlesheep/session';
import { asSessionId, type DurableRunProjection, type DurableRunRecoveryResult } from '@littlesheep/types';
import { DurableEffectLeaseStore } from './durable-effect-lease-store.js';
import { DurableRunLeaseStore } from './durable-run-lease-store.js';
import { createDurableRunRecovery } from './durable-run-recovery.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createDurableRunRecovery', () => {
  it('releases recovery ownership even when the kernel fails closed', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-recovery-'));
    roots.push(rootDir);
    const leaseStore = new DurableRunLeaseStore({ rootDir });
    const effectLeaseStore = new DurableEffectLeaseStore({ rootDir: join(rootDir, 'effects') });
    const recover = createDurableRunRecovery({
      kernel: {
        replay: vi.fn().mockResolvedValue(projection()),
        recoverRun: vi.fn().mockRejectedValue(new Error('corrupt event log')),
      } as unknown as DurableHarnessKernel,
      leaseStore,
      effectLeaseStore,
      sessionManager: {} as SessionManager,
    });

    await expect(recover(asSessionId('session-a'), 'run-a')).rejects.toThrow('corrupt event log');
    await expect(leaseStore.read('session-a', 'run-a')).resolves.toMatchObject({
      status: 'released',
      attempts: 1,
    });
  });

  it('refuses recovery while any pending effect still has an active owner', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-recovery-'));
    roots.push(rootDir);
    const leaseStore = new DurableRunLeaseStore({ rootDir: join(rootDir, 'runs'), leaseMs: 1_000 });
    const effectLeaseStore = new DurableEffectLeaseStore({ rootDir: join(rootDir, 'effects'), leaseMs: 1_000 });
    const identity = { sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' };
    await effectLeaseStore.acquire(identity);
    const kernel = {
      replay: vi.fn().mockResolvedValue(projection(['effect-a'])),
      recoverRun: vi.fn(),
    } as unknown as DurableHarnessKernel;
    const recover = createDurableRunRecovery({ kernel, leaseStore, effectLeaseStore, sessionManager: {} as SessionManager });

    await expect(recover(asSessionId('session-a'), 'run-a')).rejects.toThrow('durable effect is still owned');
    expect(kernel.recoverRun).not.toHaveBeenCalled();
    await expect(leaseStore.read('session-a', 'run-a')).resolves.toMatchObject({ status: 'released' });
  });

  it('reclaims every expired pending effect before recovery and releases both ownership levels', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-recovery-'));
    roots.push(rootDir);
    let nowMs = Date.parse('2026-09-10T00:00:00.000Z');
    const now = () => new Date(nowMs);
    const leaseStore = new DurableRunLeaseStore({ rootDir: join(rootDir, 'runs'), leaseMs: 1_000, now });
    const effectLeaseStore = new DurableEffectLeaseStore({ rootDir: join(rootDir, 'effects'), leaseMs: 1_000, now });
    const identity = { sessionId: 'session-a', runId: 'run-a', effectId: 'effect-a' };
    await effectLeaseStore.acquire(identity);
    nowMs += 1_001;
    const recovered = { projection: projection(), actions: [] } as unknown as DurableRunRecoveryResult;
    const kernel = {
      replay: vi.fn().mockResolvedValue(projection(['effect-a'])),
      recoverRun: vi.fn().mockResolvedValue(recovered),
    } as unknown as DurableHarnessKernel;
    const recover = createDurableRunRecovery({ kernel, leaseStore, effectLeaseStore, sessionManager: {} as SessionManager });

    await expect(recover(asSessionId('session-a'), 'run-a')).resolves.toBe(recovered);
    await expect(effectLeaseStore.read(identity)).resolves.toMatchObject({ status: 'released', attempts: 2 });
    await expect(leaseStore.read('session-a', 'run-a')).resolves.toMatchObject({ status: 'released' });
  });

  it('forwards the external effect outcome query into the kernel recovery options', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'ls-durable-run-recovery-query-'));
    roots.push(rootDir);
    const leaseStore = new DurableRunLeaseStore({ rootDir: join(rootDir, 'runs'), leaseMs: 1_000 });
    const effectLeaseStore = new DurableEffectLeaseStore({ rootDir: join(rootDir, 'effects'), leaseMs: 1_000 });
    const queryEffectOutcome = vi.fn(async () => ({ known: false as const }));
    const kernel = {
      replay: vi.fn().mockResolvedValue(projection(['effect-a'])),
      recoverRun: vi.fn().mockImplementation(async (_sessionId: string, _runId: string, options: { queryEffectOutcome?: (effect: { effectId: string }) => unknown }) => {
        await options.queryEffectOutcome?.({ effectId: 'effect-a' });
        return { projection: projection(), actions: [] } as unknown as DurableRunRecoveryResult;
      }),
    } as unknown as DurableHarnessKernel;
    const recover = createDurableRunRecovery({ kernel, leaseStore, effectLeaseStore, queryEffectOutcome, sessionManager: {} as SessionManager });

    await expect(recover(asSessionId('session-a'), 'run-a')).resolves.toBeDefined();
    expect(queryEffectOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: 'effect-a' }),
      { sessionId: 'session-a', runId: 'run-a' },
    );
  });
});

function projection(pendingEffectIds: string[] = []): DurableRunProjection {
  return { pendingEffectIds } as unknown as DurableRunProjection;
}
