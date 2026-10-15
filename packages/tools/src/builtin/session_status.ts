// @littlesheep/tools — builtin/session_status.ts
import { z } from 'zod';
import type { AgentTool, ToolContext } from '@littlesheep/types';
import type { SessionManager } from '@littlesheep/session';
import { withToolTiming } from '../wrapper.js';

const StatusInput = z.object({
  action: z.enum(['get', 'set']).default('get'),
  model: z.string().optional().describe('Set session model override.'),
});

export function createSessionStatusTool(opts: {
  sessionId: () => string;
  sessionManager: SessionManager;
  model: (context?: ToolContext) => string;
}): AgentTool {
  return {
    name: 'session_status',
    description: 'Get current session status (timestamp, model, message count) or set model override.',
    inputSchema: StatusInput,
    execute: withToolTiming(async (input, context) => {
      const { action, model } = StatusInput.parse(input);
      const sid = context.sessionId || opts.sessionId();
      const meta = await opts.sessionManager.loadMetadata(sid as any);
      if (action === 'set' && model) {
        await opts.sessionManager.updateMetadata(sid as any, { model });
        return { output: `Session model set to ${model}` };
      }
      const lines = [
        `Session: ${sid}`,
        `Model: ${opts.model(context) || meta?.model}`,
        `Messages: ${meta?.messageCount ?? 0}`,
        `Created: ${meta?.createdAt ?? 'unknown'}`,
        `Updated: ${meta?.updatedAt ?? 'unknown'}`,
        `Now: ${new Date().toISOString()}`,
      ];
      return { output: lines.join('\n') };
    }),
  };
}
