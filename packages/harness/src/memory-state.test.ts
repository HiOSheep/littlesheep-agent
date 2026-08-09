import { describe, expect, it } from 'vitest';
import { makeCtx } from './tests/helpers.js';
import { writeMemoryState } from './memory-state.js';

describe('memory state boundary', () => {
  it('commits a validated bootstrap batch', () => {
    const ctx = makeCtx();

    writeMemoryState(ctx, 'runner-init', {
      sessionSummary: { id: 'summary-1', summary: 'older context', createdAt: '2026-08-10T00:00:00.000Z' },
      memoryRootIndex: 'root-1',
      initialMemoryContext: 'selected memory',
    });

    expect(ctx.sessionSummary?.id).toBe('summary-1');
    expect(ctx.memoryRootIndex).toBe('root-1');
    expect(ctx.initialMemoryContext).toBe('selected memory');
  });

  it('rejects an invalid stage without partially applying the batch', () => {
    const ctx = makeCtx();
    ctx.memoryRootIndex = 'old-root';
    ctx.initialMemoryContext = 'old-context';

    expect(() => writeMemoryState(ctx, 'decide', {
      memoryRootIndex: 'new-root',
      initialMemoryContext: 'new-context',
    })).toThrow(/cannot be written|not allowed/i);

    expect(ctx.memoryRootIndex).toBe('old-root');
    expect(ctx.initialMemoryContext).toBe('old-context');
  });

  it('rejects unknown fields before mutation', () => {
    const ctx = makeCtx();

    expect(() => writeMemoryState(ctx, 'runner-init', {
      memoryRootIndex: 'root-1',
      // @ts-expect-error runtime guard for an unregistered field
      unknownMemoryField: 'invalid',
    })).toThrow(/unknown memory state field/i);

    expect(ctx.memoryRootIndex).toBeUndefined();
  });
});
