// @littlesheep/tools — builtin/edit.ts
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import { withToolTiming } from '../wrapper.js';

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
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, old_string, new_string } = EditInput.parse(input);
    if (!existsSync(file_path)) {
      return { ok: false, error: `File not found: ${file_path}` };
    }
    const approved = await ctx.approve?.('edit', { file_path }) ?? false;
    if (!approved) {
      return { ok: false, error: 'Approval denied' };
    }
    const content = await readFile(file_path, 'utf8');
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return { ok: false, error: 'old_string not found in file' };
    }
    if (occurrences > 1) {
      return { ok: false, error: `old_string is not unique (${occurrences} matches)` };
    }
    const updated = content.replace(old_string, new_string);
    await writeFile(file_path, updated, 'utf8');
    ctx.log?.('info', `edited ${file_path}`);
    return { output: `Edited ${file_path}: replaced ${old_string.length} chars` };
  }),
};
