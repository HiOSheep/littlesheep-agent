import { describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '@littlesheep/session';
import type { ToolContext } from '@littlesheep/types';
import { createSessionStatusTool } from './session_status.js';

describe('session_status conversation ownership', () => {
  it('reads the trusted calling session and its actual run model while another session is selected', async () => {
    const loadMetadata = vi.fn(async () => ({ model: 'old/model', messageCount: 2 }));
    const tool = createSessionStatusTool({ sessionId: () => 'session-B', sessionManager: { loadMetadata } as unknown as SessionManager, model: context => context?.runId === 'run-A' ? 'provider/model-A' : 'provider/model-B' });
    const result = await tool.execute({}, { sessionId: 'session-A', runId: 'run-A' } as ToolContext);
    expect(loadMetadata).toHaveBeenCalledWith('session-A');
    expect(result.output).toContain('Session: session-A');
    expect(result.output).toContain('Model: provider/model-A');
  });
});
