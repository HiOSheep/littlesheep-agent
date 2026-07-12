// @littlesheep/tools — builtin/read.ts
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import { sanitizeOutput, DEFAULT_SANITIZE, isBinary, binaryPreview } from '../sanitize.js';
import { withToolTiming } from '../wrapper.js';

const ReadInput = z.object({
  file_path: z.string().describe('Absolute path to the file to read.'),
  offset: z.number().int().positive().optional().describe('Line number to start from (1-based).'),
  limit: z.number().int().positive().optional().describe('Max lines to read.'),
});

export const readTool: AgentTool = {
  name: 'read',
  description: 'Read a file from the filesystem. Returns text content (binary gets hex preview).',
  inputSchema: ReadInput,
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, offset, limit } = ReadInput.parse(input);
    if (!existsSync(file_path)) {
      return { ok: false, error: `File not found: ${file_path}` };
    }
    const buffer = await readFile(file_path);
    // Binary files: return hex preview directly (offset/limit don't apply)
    if (isBinary(buffer)) {
      const preview = binaryPreview(buffer);
      ctx.log?.('info', `read binary ${file_path} (${buffer.length} bytes)`);
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
    ctx.log?.('info', `read ${file_path} (${text.length} chars)`);
    return { output, sanitized };
  }),
};
