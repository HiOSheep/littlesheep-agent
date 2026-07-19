// @littlesheep/tools — builtin/glob.ts
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

const GlobInput = z.object({
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts").'),
  path: z.string().optional().describe('Directory to search (default: cwd).'),
  max_results: z.number().int().positive().optional().default(100),
});

/** Convert a glob pattern to a RegExp. Supports *, **, and ?. Exported for reuse by grep.ts. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '{{SS_SLASH}}')   // **/ → optional directory prefix
    .replace(/\*\*/g, '.*')               // bare ** → match anything
    .replace(/\*/g, '[^/\\\\]*')          // * → single segment wildcard
    .replace(/\?/g, '[^/\\\\]')            // ? → single char
    .replace(/{{SS_SLASH}}/g, '(.*\\/)?');
  return new RegExp('^' + escaped + '$');
}

export const globTool: AgentTool = {
  name: 'glob',
  description: 'Find files by glob pattern. Read-only.',
  inputSchema: GlobInput,
  execution: parallelFilePolicy('path', 'read', true),
  execute: withToolTiming(async (input, ctx) => {
    const { pattern, path: searchPath, max_results } = GlobInput.parse(input);
    const target = resolve(ctx.cwd, searchPath ?? '.');
    const authorization = await authorizeToolAccess('glob', { path: target }, ctx);
    if (!authorization.allowed) {
      return { ok: false, error: 'Approval denied: searching this path requires user approval.' };
    }
    if (!existsSync(target)) {
      return { ok: false, error: `Path not found: ${target}` };
    }
    const regex = globToRegex(pattern);
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath || target, e.name))
      .filter((full) => {
        const rel = relative(target, full);
        return regex.test(rel) || regex.test(rel.replace(/\\/g, '/'));
      })
      .slice(0, max_results);

    const output = files.length > 0 ? files.join('\n') : 'No files matched';
    return { output, meta: { count: files.length } };
  }),
};
