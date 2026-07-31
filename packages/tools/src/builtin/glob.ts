// @littlesheep/tools — builtin/glob.ts
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
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
  description: 'Find files and directories by glob pattern. Directories end with a path separator. Read-only.',
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
    const matches = entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => {
        const fullPath = join(entry.parentPath || target, entry.name);
        const relativePath = relative(target, fullPath).replace(/\\/g, '/');
        return { fullPath, relativePath, directory: entry.isDirectory() };
      })
      .filter((entry) => regex.test(entry.relativePath)
        || (entry.directory && regex.test(`${entry.relativePath}/`)))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
      .slice(0, max_results);

    const output = matches.length > 0
      ? matches.map((entry) => entry.directory ? `${entry.fullPath}${sep}` : entry.fullPath).join('\n')
      : 'No files or directories matched';
    return {
      output,
      meta: {
        count: matches.length,
        fileCount: matches.filter((entry) => !entry.directory).length,
        directoryCount: matches.filter((entry) => entry.directory).length,
      },
    };
  }),
};
