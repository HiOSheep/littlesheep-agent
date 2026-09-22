// @littlesheep/tools — builtin/read.ts
import { z } from 'zod';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { sanitizeOutput, DEFAULT_SANITIZE, isBinary, binaryPreview } from '../sanitize.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';
import { hashFileBytes, observationSnapshot } from '../file-observation.js';

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
    // Read through one handle so the bytes, the size and the mtime all describe
    // the same file version. A read that fails simply produces no observation.
    let buffer: Buffer;
    let sizeBytes: number;
    let mtimeMs: number;
    try {
      const handle = await open(targetPath, 'r');
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          return { ok: false, error: `Not a regular file: ${targetPath}` };
        }
        sizeBytes = stats.size;
        mtimeMs = stats.mtimeMs;
        buffer = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, error: `File not found: ${targetPath}` };
      }
      throw error;
    }
    // Binary files: return hex preview directly (offset/limit don't apply).
    // A preview is not "having read the file", so it registers no observation.
    if (isBinary(buffer)) {
      const preview = binaryPreview(buffer);
      ctx.log?.('info', `read binary ${targetPath} (${buffer.length} bytes)`);
      return { output: preview, sanitized: true };
    }
    const text = buffer.toString('utf8');
    let lines = text.split('\n');
    if (offset) {
      lines = lines.slice(offset - 1);
    }
    if (limit) {
      lines = lines.slice(0, limit);
    }
    const visibleLines = lines.join('\n');
    const { output, sanitized, truncated } = sanitizeOutput(visibleLines, DEFAULT_SANITIZE);
    // Only an unmodified delivery counts as an observation: truncation or
    // redaction means the model did not see this file's content as it is, so a
    // later overwrite must be refused rather than checked against a guess.
    if (!sanitized && !truncated && lines.length > 0) {
      const start = offset ?? 1;
      const coverage = offset === undefined && limit === undefined ? 'full' : 'partial';
      ctx.observation?.recordRead({
        absPath: targetPath,
        snapshot: observationSnapshot({
          version: hashFileBytes(buffer),
          sizeBytes,
          mtimeMs,
          coverage,
          ...(coverage === 'partial' ? { visibleLineRange: { start, end: start + lines.length - 1 } } : {}),
          runId: ctx.runId,
        }),
      });
    }
    ctx.log?.('info', `read ${targetPath} (${visibleLines.length} chars)`);
    return { output, sanitized };
  }),
};
