// @littlesheep/tools — builtin/read.ts
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { sanitizeOutput, DEFAULT_SANITIZE, isBinary, binaryPreview } from '../sanitize.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

const ReadInput = z.object({
  file_path: z.string().describe('Absolute path to the file to read.'),
  offset: z.number().int().positive().optional().describe('Line number to start from (1-based).'),
  limit: z.number().int().positive().optional().describe('Max lines to read.'),
});

export const readTool: AgentTool = {
  name: 'read',
  description: 'Read a file from the filesystem. Returns text content (binary gets hex preview).',
  inputSchema: ReadInput,
  execution: parallelFilePolicy('file_path', 'read'),
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, offset, limit } = ReadInput.parse(input);
    const targetPath = resolve(ctx.cwd, file_path);
    const authorization = await authorizeToolAccess('read', { file_path: targetPath }, ctx);
    if (!authorization.allowed) {
      return { ok: false, error: 'Approval denied: reading this path requires user approval.' };
    }
    if (!existsSync(targetPath)) {
      return { ok: false, error: `File not found: ${targetPath}` };
    }
    const buffer = await readFile(targetPath);
    // Binary files: return hex preview directly (offset/limit don't apply)
    if (isBinary(buffer)) {
      const preview = binaryPreview(buffer);
      ctx.log?.('info', `read binary ${targetPath} (${buffer.length} bytes)`);
      return { output: preview, sanitized: true };
    }
    let text = buffer.toString('utf8');
    let lines = text.split('\n');
    if (offset) {
      lines = lines.slice(offset - 1);
    }
    if (limit) {
      lines = lines.slice(0, limit);
    }
    text = lines.join('\n');
    const { output, sanitized } = sanitizeOutput(text, DEFAULT_SANITIZE);
    ctx.log?.('info', `read ${targetPath} (${text.length} chars)`);
    return { output, sanitized };
  }),
};
