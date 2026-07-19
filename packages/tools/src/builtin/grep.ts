// @littlesheep/tools — builtin/grep.ts
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { globToRegex } from './glob.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

const GrepInput = z.object({
  pattern: z.string().describe('Regex pattern to search for.'),
  path: z.string().optional().describe('Directory or file to search (default: cwd).'),
  glob: z.string().optional().describe('File glob filter (e.g. "*.ts").'),
  max_results: z.number().int().positive().optional().default(50),
});

export const grepTool: AgentTool = {
  name: 'grep',
  description: 'Search file contents using ripgrep (falls back to naive search). Read-only.',
  inputSchema: GrepInput,
  execution: parallelFilePolicy('path', 'read', true),
  execute: withToolTiming(async (input, ctx) => {
    const { pattern, path: searchPath, glob: _glob, max_results } = GrepInput.parse(input);
    const target = resolve(ctx.cwd, searchPath ?? '.');
    const authorization = await authorizeToolAccess('grep', { path: target }, ctx);
    if (!authorization.allowed) {
      return { ok: false, error: 'Approval denied: searching this path requires user approval.' };
    }

    // Try ripgrep first
    const hits = await new Promise<string[]>((resolve) => {
      const args = ['-n', '--max-count', String(max_results), pattern];
      if (_glob) args.unshift('--glob', _glob);
      args.push(target);
      const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (d) => (out += d.toString()));
      proc.on('error', () => resolve([]));
      proc.on('exit', () => resolve(out.split('\n').filter((l) => l.trim().length > 0)));
    });

    if (hits.length > 0) {
      const limited = hits.slice(0, max_results).join('\n');
      return { output: limited };
    }

    // Fallback: naive search
    if (!existsSync(target)) {
      return { ok: false, error: `Path not found: ${target}` };
    }
    const results: string[] = [];
    const s = await stat(target);
    if (s.isFile()) {
      const content = await readFile(target, 'utf8');
      const lines = content.split('\n');
      const regex = new RegExp(pattern, 'i');
      for (let i = 0; i < lines.length && results.length < max_results; i++) {
        if (regex.test(lines[i]!)) results.push(`${target}:${i + 1}:${lines[i]}`);
      }
    } else {
      const entries = await readdir(target, { recursive: true });
      const regex = new RegExp(pattern, 'i');
      for (const entry of entries) {
        if (results.length >= max_results) break;
        if (_glob) {
          const globRegex = globToRegex(_glob);
          if (!globRegex.test(entry) && !globRegex.test(entry.replace(/\\/g, '/'))) continue;
        }
        const full = join(target, entry);
        try {
          const content = await readFile(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < max_results; i++) {
            if (regex.test(lines[i]!)) results.push(`${relative(ctx.cwd, full)}:${i + 1}:${lines[i]}`);
          }
        } catch {
          // skip unreadable files
        }
      }
    }

    return { output: results.join('\n') || 'No matches' };
  }),
};
