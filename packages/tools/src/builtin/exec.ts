// @littlesheep/tools — builtin/exec.ts
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
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

const MAX_CAPTURED_STREAM_CHARS = 64 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;
const FORCE_SETTLE_DELAY_MS = 1_000;

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
        if (authorization.approvedByPolicy || ctx.approvalGranted === true) {
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

      return await new Promise((resolve) => {
        const proc = spawn(shell, shellArgs, {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });

        const stdout = new BoundedTextCapture(MAX_CAPTURED_STREAM_CHARS);
        const stderr = new BoundedTextCapture(MAX_CAPTURED_STREAM_CHARS);
        let settled = false;
        let terminationReason: 'timed_out' | 'aborted' | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let forceSettleTimer: NodeJS.Timeout | undefined;
        const timeoutTimer = setTimeout(() => {
          requestTermination('timed_out');
        }, timeout_ms);

        const cleanup = () => {
          clearTimeout(timeoutTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          if (forceSettleTimer) clearTimeout(forceSettleTimer);
          ctx.signal?.removeEventListener('abort', onAbort);
          proc.stdout?.removeListener('data', onStdout);
          proc.stderr?.removeListener('data', onStderr);
          proc.removeListener('error', onError);
          proc.removeListener('close', onClose);
        };
        const settle = (result: Parameters<typeof resolve>[0]) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const capturedResult = (
          code: number | null | undefined,
          signal: NodeJS.Signals | null | undefined,
          processClosed: boolean,
          spawnError?: Error,
        ) => {
          const stdoutText = stdout.finish();
          const stderrText = stderr.finish();
          const combined = stdoutText + (stderrText ? `\n[stderr]\n${stderrText}` : '');
          const sanitizedOutput = sanitizeOutput(combined, DEFAULT_SANITIZE);
          const succeeded = !terminationReason && !spawnError && code === 0;
          return {
            ok: succeeded,
            output: sanitizedOutput.output,
            error: terminationReason === 'timed_out'
              ? `command timed out after ${timeout_ms}ms`
              : terminationReason === 'aborted'
                ? 'command aborted'
                : spawnError?.message
                  ?? (code !== 0 ? `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}` : undefined),
            sanitized: sanitizedOutput.sanitized || stdout.truncated || stderr.truncated,
            meta: {
              ...streamMeta(stdout, stderr, code, terminationReason, processClosed),
              ...(signal ? { signal } : {}),
              outputTruncated: sanitizedOutput.truncated || stdout.truncated || stderr.truncated,
            },
          };
        };
        const requestTermination = (reason: 'timed_out' | 'aborted') => {
          if (settled || terminationReason) return;
          terminationReason = reason;
          terminateProcessTree(proc, false);
          forceKillTimer = setTimeout(() => {
            terminateProcessTree(proc, true);
            forceSettleTimer = setTimeout(() => {
              proc.stdout?.destroy();
              proc.stderr?.destroy();
              proc.unref();
              settle(capturedResult(proc.exitCode, proc.signalCode, false));
            }, FORCE_SETTLE_DELAY_MS);
            forceSettleTimer.unref?.();
          }, FORCE_KILL_DELAY_MS);
          forceKillTimer.unref?.();
        };
        const onAbort = () => requestTermination('aborted');
        const onStdout = (chunk: Buffer) => stdout.append(chunk);
        const onStderr = (chunk: Buffer) => stderr.append(chunk);
        const onError = (error: Error) => {
          settle(capturedResult(proc.exitCode, proc.signalCode, false, error));
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
          settle(capturedResult(code, signal, true));
        };

        proc.stdout?.on('data', onStdout);
        proc.stderr?.on('data', onStderr);
        proc.once('error', onError);
        proc.once('close', onClose);
        if (ctx.signal?.aborted) onAbort();
        else ctx.signal?.addEventListener('abort', onAbort, { once: true });
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

class BoundedTextCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = '';
  private tail = '';
  private ended = false;
  totalChars = 0;

  constructor(maxChars: number) {
    this.headLimit = Math.max(1, Math.floor(maxChars * 0.75));
    this.tailLimit = Math.max(1, maxChars - this.headLimit);
  }

  get retainedChars(): number {
    return this.head.length + this.tail.length;
  }

  get truncated(): boolean {
    return this.totalChars > this.retainedChars;
  }

  append(chunk: Buffer): void {
    if (this.ended) return;
    this.appendText(this.decoder.write(chunk));
  }

  finish(): string {
    if (!this.ended) {
      this.ended = true;
      this.appendText(this.decoder.end());
    }
    if (!this.truncated) return this.head + this.tail;
    const omitted = this.totalChars - this.retainedChars;
    return `${this.head}\n\n... [stream capture truncated: ${omitted} chars omitted] ...\n\n${this.tail}`;
  }

  private appendText(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, text.length);
      this.head += text.slice(0, take);
      text = text.slice(take);
    }
    if (text) this.tail = (this.tail + text).slice(-this.tailLimit);
  }
}

function streamMeta(
  stdout: BoundedTextCapture,
  stderr: BoundedTextCapture,
  exitCode: number | null | undefined,
  terminationReason: 'timed_out' | 'aborted' | undefined,
  processClosed: boolean,
): Record<string, unknown> {
  return {
    exitCode: exitCode ?? null,
    stdoutLen: stdout.totalChars,
    stderrLen: stderr.totalChars,
    stdoutRetainedChars: stdout.retainedChars,
    stderrRetainedChars: stderr.retainedChars,
    captureTruncated: stdout.truncated || stderr.truncated,
    timedOut: terminationReason === 'timed_out',
    aborted: terminationReason === 'aborted',
    processClosed,
  };
}

function terminateProcessTree(
  proc: ReturnType<typeof spawn>,
  force: boolean,
): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => proc.kill(force ? 'SIGKILL' : 'SIGTERM'));
      killer.unref();
    } catch {
      proc.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    return;
  }
  try {
    process.kill(-proc.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    proc.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}
