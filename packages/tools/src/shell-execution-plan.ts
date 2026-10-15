// Trusted host execution facts. These checks detect changes; they do not isolate a Shell.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ShellExecutionDescription, ToolContext } from '@littlesheep/types';

const environmentKey = randomBytes(32);
export interface ShellInput { command: string; cwd?: string; timeout_ms?: number }
export interface ShellExecutionPlan {
  description: Readonly<ShellExecutionDescription>;
  env: Readonly<NodeJS.ProcessEnv>;
  requested: Readonly<ShellInput>;
  directories: readonly string[];
  directoryIdentity: string;
}

export function shellInput(value: unknown): ShellInput {
  const input = value as Partial<ShellInput> | null;
  if (!input || typeof input.command !== 'string' || !input.command.length
    || (input.cwd !== undefined && typeof input.cwd !== 'string')
    || (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms <= 0))) {
    throw new Error('invalid Shell execution input');
  }
  return Object.freeze({ command: input.command, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    timeout_ms: input.timeout_ms ?? 120_000 });
}

export function fingerprint(value: unknown): string {
  // An ordered array is used by callers; JSON preserves strings without normalization.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function environmentFingerprint(env: NodeJS.ProcessEnv): string {
  return createHmac('sha256', environmentKey)
    .update(JSON.stringify(Object.keys(env).filter((key) => env[key] !== undefined).sort().map((key) => [key, env[key]])))
    .digest('hex');
}

function directoryIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error('directory identity unavailable');
  return JSON.stringify([realpathSync(path), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

function executableIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.ino === 0n) throw new Error('Shell executable identity unavailable');
  return fingerprint([path, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs),
    createHash('sha256').update(readFileSync(path)).digest('hex')]);
}

function ancestors(path: string): string[] {
  const paths = [path];
  while (dirname(paths[paths.length - 1]!) !== paths[paths.length - 1]) paths.push(dirname(paths[paths.length - 1]!));
  return paths;
}

export function prepareShellPlan(
  value: unknown, ctx: ToolContext,
  identity: { invocationId: string; workspaceRoot: string; workspaceId: string; permission: string; timeoutMs: number },
): ShellExecutionPlan {
  const input = shellInput(value);
  const cwd = resolve(ctx.cwd, input.cwd ?? '.');
  const workspace = resolve(identity.workspaceRoot);
  const shellPath = realpathSync(process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/sh');
  const args = Object.freeze(process.platform === 'win32' ? ['-NoProfile', '-Command'] : ['-c']);
  const env = Object.freeze({ ...process.env });
  const facts = {
    version: 1 as const, invocationId: identity.invocationId, action: 'exec' as const, command: input.command,
    shell: Object.freeze({ path: shellPath, args, identity: executableIdentity(shellPath) }),
    cwd: Object.freeze({ path: cwd, identity: directoryIdentity(cwd) }),
    workspace: Object.freeze({ id: identity.workspaceId, path: workspace, identity: directoryIdentity(workspace) }),
    sessionId: String(ctx.sessionId), runId: ctx.runId, permission: identity.permission,
    environment: environmentFingerprint(env), timeoutMs: Math.min(input.timeout_ms!, identity.timeoutMs),
    source: 'agent' as const, user: userInfo().username,
  };
  const directories = Object.freeze([...new Set([...ancestors(cwd), ...ancestors(workspace), ...ancestors(dirname(shellPath))])]);
  return Object.freeze({ description: Object.freeze({ ...facts, digest: fingerprint(['ls-shell-v1', facts]) }),
    env, requested: input, directories, directoryIdentity: fingerprint(directories.map(directoryIdentity)) });
}

export function validateShellPlan(plan: ShellExecutionPlan, value: unknown, ctx: ToolContext): void {
  const input = shellInput(value);
  const facts = plan.description;
  if (input.command !== plan.requested.command || input.cwd !== plan.requested.cwd
    || input.timeout_ms !== plan.requested.timeout_ms || String(ctx.sessionId) !== facts.sessionId
    || ctx.runId !== facts.runId || resolve(ctx.cwd, input.cwd ?? '.') !== facts.cwd.path
    || environmentFingerprint(process.env) !== facts.environment
    || executableIdentity(facts.shell.path) !== facts.shell.identity
    || fingerprint(plan.directories.map(directoryIdentity)) !== plan.directoryIdentity) {
    throw new Error('Shell authorization invalidated: execution facts changed');
  }
}
