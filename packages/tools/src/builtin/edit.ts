// @littlesheep/tools — builtin/edit.ts
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { CORE_SOURCE_READ_ONLY_ERROR, findProtectedWriteRoot, resolveToolPath } from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

const EditInput = z.object({
  file_path: z.string(),
  old_string: z.string().describe('Exact text to find (must be unique).'),
  new_string: z.string().describe('Replacement text.'),
});

export const editTool: AgentTool = {
  name: 'edit',
  description: 'Edit a file by replacing an exact string. Requires approval.',
  inputSchema: EditInput,
  requiresApproval: true,
  execution: parallelFilePolicy('file_path', 'write'),
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, old_string, new_string } = EditInput.parse(input);
    const targetPath = resolveToolPath(file_path, ctx.cwd);
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx);
    if (protectedRoot) {
      return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: ${targetPath}` };
    }
    const authorization = await authorizeToolAccess('edit', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    if (!existsSync(targetPath)) {
      return { ok: false, error: `File not found: ${targetPath}` };
    }
    await ctx.versioning?.beforeFileMutation(targetPath);
    const content = await readFile(targetPath, 'utf8');
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: 'old_string not found in file' };
    }
    if (occurrences > 1) {
      return { ok: false, error: `old_string is not unique (${occurrences} matches)` };
    }
    const updated = content.replace(old_string, new_string);
    await writeFile(targetPath, updated, 'utf8');
    ctx.log?.('info', `edited ${targetPath}`);
    return { output: `Edited ${targetPath}: replaced ${old_string.length} chars` };
  }),
};
