// @littlesheep/tools — builtin/write.ts
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { CORE_SOURCE_READ_ONLY_ERROR, findProtectedWriteRoot, resolveToolPath } from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

const WriteInput = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Content to write.'),
});

export const writeTool: AgentTool = {
  name: 'write',
  description: 'Write content to a file (overwrites if exists). Requires approval.',
  inputSchema: WriteInput,
  requiresApproval: true,
  execution: parallelFilePolicy('file_path', 'write'),
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, content } = WriteInput.parse(input);
    const targetPath = resolveToolPath(file_path, ctx.cwd);
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx);
    if (protectedRoot) {
      return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: ${targetPath}` };
    }
    const authorization = await authorizeToolAccess('write', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    await ctx.versioning?.beforeFileMutation(targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    ctx.log?.('info', `wrote ${targetPath} (${content.length} chars)`);
    return { output: `Wrote ${content.length} chars to ${targetPath}` };
  }),
};
