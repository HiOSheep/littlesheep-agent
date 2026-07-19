// @littlesheep/tools — builtin/exec.ts
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess, describeToolAccess } from '@littlesheep/safety';
import { checkApproval, interactiveApprove, type ApprovalConfig, DEFAULT_APPROVAL } from '../approval.js';
import {
  CORE_SOURCE_READ_ONLY_ERROR,
  commandReferencesProtectedRoot,
  findProtectedWriteRoot,
  isReadOnlyCoreCommand,
} from '../path-protection.js';
import { sanitizeOutput, DEFAULT_SANITIZE } from '../sanitize.js';
import { withToolTiming } from '../wrapper.js';

const ExecInput = z.object({
  command: z.string().describe('Shell command to execute.'),
  cwd: z.string().optional().describe('Working directory.'),
  timeout_ms: z.number().int().positive().optional().default(120000).describe('Timeout in ms.'),
});

export interface ExecToolOptions {
  approvalConfig?: ApprovalConfig;
  /** Whether to prompt interactively for escalated approvals. */
  interactive?: boolean;
}

export function createExecTool(opts: ExecToolOptions = {}): AgentTool {
  const approvalConfig = opts.approvalConfig ?? DEFAULT_APPROVAL;
  return {
    name: 'exec',
    description: 'Execute a shell command. Whitelisted commands auto-approve; others require approval.',
    inputSchema: ExecInput,
    requiresApproval: true,
    execution: { concurrency: 'exclusive' },
    execute: withToolTiming(async (input, ctx) => {
      const { command, cwd, timeout_ms } = ExecInput.parse(input);
      const workDir = resolve(ctx.cwd, cwd ?? '.');
      const protectedRoot = findProtectedWriteRoot(workDir, ctx)
        ?? commandReferencesProtectedRoot(command, ctx.protectedWriteRoots);
      if (protectedRoot && !isReadOnlyCoreCommand(command)) {
        return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: command execution denied` };
      }

      const authorization = await authorizeToolAccess('exec', { command, cwd: workDir }, ctx);
      if (!authorization.allowed) return { ok: false, error: 'Approval denied: this command requires user approval.' };

      // Approval gate
      const approval = checkApproval(command, approvalConfig);
      if (approval.decision === 'denied') {
        return { ok: false, error: `Approval denied: ${approval.reason}` };
      }
      if (approval.decision === 'escalate') {
        const descriptor = describeToolAccess('exec', { command, cwd: workDir }, ctx);
        const policyAlreadyApproved = authorization.approvedByPolicy
          || (ctx.permissionMode === 'full' && descriptor.boundary === 'inside');
        if (policyAlreadyApproved) {
          // The boundary policy already authorized this invocation. Keep the
          // blacklist check above, but do not ask for the same command twice.
        } else if (opts.interactive) {
          const ok = await interactiveApprove(command);
          if (!ok) {
            return { ok: false, error: 'User denied command' };
          }
        } else {
          const ok = await ctx.approve?.('exec', { command }) ?? false;
          if (!ok) {
            return { ok: false, error: 'Approval denied' };
          }
        }
      }

      if (!isLikelyReadOnlyCommand(command)) {
        await ctx.versioning?.beforeWorkspaceMutation(workDir);
      }
      ctx.log?.('info', `exec: ${command} (cwd: ${workDir})`);

      // Use PowerShell on Windows (per TOOLS.md convention), sh on Unix
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const shellArgs: string[] = process.platform === 'win32'
        ? ['-NoProfile', '-Command', command]
        : ['-c', command];

      // Return a Promise that resolves from the spawn exit/error callback.
      // withToolTiming awaits this Promise, so the callback's resolve value
      // is correctly covered by the wrapper's timing + error handling.
      return await new Promise((resolve) => {
        const proc = spawn(shell, shellArgs, {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: ctx.signal,
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          setTimeout(() => proc.kill('SIGKILL'), 5000);
        }, timeout_ms);

        proc.stdout?.on('data', (d) => (stdout += d.toString()));
        proc.stderr?.on('data', (d) => (stderr += d.toString()));

        proc.on('error', (err) => {
          clearTimeout(timer);
          // Resolve (don't throw) so the Promise settles exactly once — the
          // 'exit' handler below may also fire on some platforms. withToolTiming
          // still wraps this in ok:false + durationMs either way.
          resolve({ ok: false, error: err.message });
        });

        proc.on('exit', (code) => {
          clearTimeout(timer);
          const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
          const { output, sanitized } = sanitizeOutput(combined, DEFAULT_SANITIZE);
          resolve({
            ok: code === 0,
            output,
            error: code !== 0 ? `exit code ${code}` : undefined,
            sanitized,
            meta: { exitCode: code, stdoutLen: stdout.length, stderrLen: stderr.length },
          });
        });
      });
    }),
  };
}

/** Default exec tool instance (interactive mode). */
export const execTool = createExecTool({ interactive: true });

function isLikelyReadOnlyCommand(command: string): boolean {
  const value = command.trim();
  if (!value || /[;>&]|\|\||\$\(|`/u.test(value)) return false;
  return /^(?:pwd|dir|ls|Get-ChildItem|Get-Content|Select-String|rg)(?:\s|$)/iu.test(value)
    || /^git\s+(?:status|log|diff|show)(?:\s|$)/iu.test(value)
    || /^(?:node|npm|pnpm)\s+--version(?:\s|$)/iu.test(value)
    || /^echo(?:\s|$)/iu.test(value);
}
