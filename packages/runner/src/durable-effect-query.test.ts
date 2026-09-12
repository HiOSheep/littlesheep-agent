import { describe, expect, it, vi } from 'vitest';
import type { AgentTool, DurableEffectProjection } from '@littlesheep/types';
import type { ToolRegistry } from '@littlesheep/tools';
import { createDurableEffectOutcomeQuery } from './durable-effect-query.js';

const identity = { sessionId: 'session-1', runId: 'run-1' };
const effect = {
  effectId: 'effect-1',
  toolName: 'write',
  status: 'in_progress',
  reconciliationKey: { path: 'D:/data/notes.md' },
} as unknown as DurableEffectProjection;

function registryWith(tool?: Partial<AgentTool>): ToolRegistry {
  return {
    get: (name: string) => (tool && name === 'write' ? { tool: tool as AgentTool } : undefined),
  } as unknown as ToolRegistry;
}

describe('durable effect outcome query', () => {
  it('prefers the host-owned query over tool self-reconciliation', async () => {
    const query = vi.fn(async () => ({ known: true as const, status: 'succeeded' as const }));
    const reconcile = vi.fn(async () => ({ known: true as const, status: 'failed' as const }));
    const outcome = await createDurableEffectOutcomeQuery({
      registry: registryWith({ reconcileEffect: reconcile }),
      query,
    })(effect, identity);

    expect(outcome).toEqual({ known: true, status: 'succeeded' });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('binds the caller identity into the host authorization callback', async () => {
    const authorizeRead = vi.fn(async () => false);
    const reconcile = vi.fn(async (_effect, ctx) => (
      (await ctx.authorizeRead?.('D:/data/notes.md'))
        ? { known: true as const, status: 'succeeded' as const }
        : { known: false as const, reason: 'reconciliation read was not authorized' }
    ));
    const outcome = await createDurableEffectOutcomeQuery({
      registry: registryWith({ reconcileEffect: reconcile }),
      authorizeRead,
    })(effect, identity);

    expect(outcome).toEqual({ known: false, reason: 'reconciliation read was not authorized' });
    expect(authorizeRead).toHaveBeenCalledWith('D:/data/notes.md', identity);
  });

  it('omits the authorization callback when the host did not provide one', async () => {
    const reconcile = vi.fn(async (_effect, ctx) => ({
      known: false as const,
      reason: ctx.authorizeRead ? 'callback-present' : 'no-host-authorization',
    }));
    const outcome = await createDurableEffectOutcomeQuery({
      registry: registryWith({ reconcileEffect: reconcile }),
    })(effect, identity);
    expect(outcome).toEqual({ known: false, reason: 'no-host-authorization' });
  });

  it('stays unknown for unregistered tools and for a throwing reconcile', async () => {
    expect(await createDurableEffectOutcomeQuery({ registry: registryWith() })(effect, identity))
      .toEqual({ known: false });
    const log = vi.fn();
    const outcome = await createDurableEffectOutcomeQuery({
      registry: registryWith({ reconcileEffect: async () => { throw new Error('probe failed'); } }),
      log,
    })(effect, identity);
    expect(outcome).toEqual({ known: false });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('reconciliation failed'), expect.objectContaining({
      effectId: 'effect-1',
      toolName: 'write',
    }));
  });
});