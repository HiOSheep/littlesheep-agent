// @littlesheep/tools — builtin/write.ts
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { withToolTiming } from '../wrapper.js';

const WriteInput = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Content to write.'),
});

export const writeTool: AgentTool = {
  name: 'write',
  description: 'Write content to a file (overwrites if exists). Requires approval.',
  inputSchema: WriteInput,
  requiresApproval: true,
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, content } = WriteInput.parse(input);
    const approved = await ctx.approve?.('write', { file_path }) ?? false;
    if (!approved) {
      return { ok: false, error: 'Approval denied' };
    }
    await mkdir(dirname(file_path), { recursive: true });
    await writeFile(file_path, content, 'utf8');
    ctx.log?.('info', `wrote ${file_path} (${content.length} chars)`);
    return { output: `Wrote ${content.length} chars to ${file_path}` };
  }),
};
