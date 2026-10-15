// Main-owned, process-local L0/L1 authority. No grants are serialized or reconstructed.
import { randomUUID } from 'node:crypto';
import type { AgentTool, ShellApprovalBatch, ToolContext } from '@littlesheep/types';
import { DEFAULT_APPROVAL, checkApproval, type ApprovalConfig } from './approval.js';
import { commandReferencesProtectedRoot, findProtectedWriteRoot, isReadOnlyCoreCommand } from './path-protection.js';
import { fingerprint, prepareShellPlan, validateShellPlan, type ShellExecutionPlan } from './shell-execution-plan.js';

type Decision = 'allow' | 'approval' | 'deny' | 'unavailable';
export interface ShellAuthorityOptions {
  runId?: string;
  sessionId?: string;
  workspaceRoot: string;
  workspaceId?: string;
  permission: unknown;
  signal?: AbortSignal;
  /** Main returns a fail-closed decision for each exact invocation. */
  decide(input: { command: string; cwd: string }): Decision;
  /** Re-read current Main-owned session/project/policy facts before authorization and launch. */
  current(): Promise<string>;
  request(batch: ShellApprovalBatch): Promise<boolean>;
}
interface Authority { options: ShellAuthorityOptions; sessionId?: string; runId?: string; metrics: ShellApprovalMetrics }
export interface ShellApprovalMetrics {
  calls: number; operations: number; approved: number; denied: number; invalidated: number; waitingMs: number;
}
interface Grant {
  authority: Authority; plan: ShellExecutionPlan; current: string; expiresAt: number;
  permission: string;
  signal?: AbortSignal; consumed: boolean; closed: boolean;
}
export interface ShellBatchResult {
  grants: ReadonlyMap<number, object>;
  failures: ReadonlyMap<number, ShellAuthorizationFailure>;
  close(): void;
}
export interface ShellAuthorizationFailure {
  status: 'hard_denied' | 'approval_denied' | 'approval_unavailable' | 'aborted';
  errorKind: string;
  message: string;
}
const authorities = new WeakMap<NonNullable<ToolContext['approve']>, Authority>();
const executors = new WeakMap<AgentTool, ApprovalConfig>();
const grants = new WeakMap<object, Grant>();
const invocations = new WeakMap<ToolContext, { grant: object; tool: AgentTool }>();

/** Only trusted host assembly calls this; JSON flags and Renderer IDs cannot register an authority. */
export function bindShellApprovalAuthority(approve: NonNullable<ToolContext['approve']>, options: ShellAuthorityOptions): void {
  authorities.set(approve, { options, sessionId: options.sessionId, runId: options.runId,
    metrics: { calls: 0, operations: 0, approved: 0, denied: 0, invalidated: 0, waitingMs: 0 } });
}
export function shellApprovalMetrics(approve: NonNullable<ToolContext['approve']>): ShellApprovalMetrics | undefined {
  const value = authorities.get(approve)?.metrics;
  return value ? { ...value } : undefined;
}
export function registerShellExecutor(tool: AgentTool, config: ApprovalConfig): AgentTool {
  // Keep hard-deny configuration immutable even if the caller later edits its arrays.
  executors.set(tool, { ...config, whitelist: [], blacklist: [...new Set([...DEFAULT_APPROVAL.blacklist, ...config.blacklist])] });
  return tool;
}
export function isShellExecutor(tool: AgentTool): boolean { return executors.has(tool); }

export async function authorizeShellBatch(
  items: readonly { index: number; tool: AgentTool; input: unknown; signal?: AbortSignal }[],
  ctx: ToolContext, timeoutMs: number,
): Promise<ShellBatchResult> {
  const approved = new Map<number, object>();
  const failures = new Map<number, ShellAuthorizationFailure>();
  const issued: Grant[] = [];
  const result = { grants: approved, failures, close() { for (const grant of issued) grant.closed = true; } };
  const authority = ctx.approve && authorities.get(ctx.approve);
  if (!authority) {
    for (const item of items) failures.set(item.index, failure('approval_unavailable', 'approval_unavailable', 'Shell authorization unavailable: Main authority is required'));
    return result;
  }
  const { options, metrics } = authority;
  metrics.calls += items.length;
  authority.sessionId ??= String(ctx.sessionId);
  authority.runId ??= ctx.runId;
  const pending: { index: number; grant: Grant; decision: Decision }[] = [];
  const expiresAt = Date.now() + 120_000;
  let current: string;
  try { current = await options.current(); }
  catch { for (const item of items) failures.set(item.index, failure('approval_unavailable', 'approval_unavailable', 'Shell authorization unavailable: Main state unavailable')); return result; }
  for (const item of items) {
    try {
      if (items.length > 32 || authority.runId !== ctx.runId || authority.sessionId !== String(ctx.sessionId)
        || options.signal?.aborted || ctx.signal?.aborted || item.signal?.aborted) {
        if (options.signal?.aborted || ctx.signal?.aborted || item.signal?.aborted) {
          failures.set(item.index, failure('aborted', 'approval_aborted', 'Shell invocation cancelled'));
          continue;
        }
        throw new Error('Shell invocation scope invalid');
      }
      const config = executors.get(item.tool);
      if (!config || item.tool.name !== 'exec') throw new Error('untrusted Shell executor');
      const plan = prepareShellPlan(item.input, ctx, {
        invocationId: randomUUID(), workspaceRoot: options.workspaceRoot,
        workspaceId: options.workspaceId ?? `session:${ctx.sessionId}`, permission: fingerprint(['permission-v1', options.permission, current]), timeoutMs,
      });
      const { command, cwd } = plan.description;
      const protectedRoot = findProtectedWriteRoot(cwd.path, ctx) ?? commandReferencesProtectedRoot(command, ctx.protectedWriteRoots);
      if (protectedRoot && !isReadOnlyCoreCommand(command)) throw new Error('core source is read-only. Write into a writable workspace.');
      const hard = checkApproval(command, { ...config, whitelist: [], approvalMode: 'interactive' });
      if (hard.decision === 'denied') throw new Error(`Approval denied: ${hard.reason}`);
      const decision = options.decide({ command, cwd: cwd.path });
      if (decision === 'deny' || decision === 'unavailable') {
        failures.set(item.index, failure('hard_denied', decision === 'deny' ? 'hard_deny' : 'permission_safety_unavailable', `Shell policy ${decision}`));
        continue;
      }
      pending.push({ index: item.index, decision, grant: { authority, plan, current, expiresAt,
        permission: fingerprint(options.permission),
        signal: item.signal ?? ctx.signal, consumed: false, closed: false } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Shell authorization failed';
      failures.set(item.index, failure('hard_denied', message.startsWith('Approval denied:') ? 'hard_deny'
        : message.includes('core source is read-only') ? 'core_source_read_only' : 'hard_deny', message));
    }
  }
  // A batch is atomic: hard denial of any listed item prevents asking for/executing the rest.
  if (failures.size) {
    for (const item of items) if (!failures.has(item.index)) failures.set(item.index,
      failure('hard_denied', 'shell_batch_hard_denied', 'Shell batch rejected: one or more commands failed policy checks'));
    metrics.denied += items.length;
    return result;
  }
  const asking = pending.filter((item) => item.decision === 'approval');
  let allowed = true;
  if (asking.length) {
    metrics.operations++;
    const started = Date.now();
    try {
      const batch: ShellApprovalBatch = Object.freeze({ version: 1, batchId: randomUUID(),
        scope: asking.length === 1 ? 'once' : 'batch', expiresAt,
        commands: Object.freeze(asking.map((item) => item.grant.plan.description)) });
      // Race is owned here as well as by Main's broker: a missing UI callback cannot hang a run.
      allowed = await waitForShellDecision(options.request, batch, options.signal, ctx.signal, ...items.map((item) => item.signal));
    } catch { allowed = false; }
    finally { metrics.waitingMs += Date.now() - started; }
  }
  for (const item of pending) {
    if (!allowed || Date.now() >= expiresAt || options.signal?.aborted || item.grant.signal?.aborted) {
      const cancelled = options.signal?.aborted || item.grant.signal?.aborted;
      const expired = Date.now() >= expiresAt;
      failures.set(item.index, failure(cancelled ? 'aborted' : expired ? 'approval_unavailable' : 'approval_denied',
        cancelled ? 'approval_aborted' : expired ? 'approval_timeout' : 'approval_denied',
        cancelled ? 'Shell approval cancelled' : expired ? 'Shell approval expired' : 'Shell approval denied'));
      metrics.denied++;
    } else {
      const token = Object.freeze({});
      grants.set(token, item.grant); issued.push(item.grant); approved.set(item.index, token); metrics.approved++;
    }
  }
  return result;
}

function failure(status: ShellAuthorizationFailure['status'], errorKind: string, message: string): ShellAuthorizationFailure {
  return { status, errorKind, message };
}

function waitForShellDecision(
  request: ShellAuthorityOptions['request'], batch: ShellApprovalBatch, ...signals: (AbortSignal | undefined)[]
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener('abort', abort);
      resolve(value === true);
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, Math.max(0, batch.expiresAt - Date.now()));
    for (const signal of signals) signal?.addEventListener('abort', abort, { once: true });
    if (signals.some((signal) => signal?.aborted)) { finish(false); return; }
    Promise.resolve().then(() => request(batch)).then(finish, abort);
  });
}

export function attachShellInvocation(ctx: ToolContext, tool: AgentTool, token: object): void {
  if (!executors.has(tool) || !grants.has(token)) throw new Error('invalid Shell invocation capability');
  invocations.set(ctx, { grant: token, tool });
}
export function hasShellInvocation(ctx: ToolContext, tool: AgentTool): boolean {
  return invocations.get(ctx)?.tool === tool;
}

/** Rechecks then synchronously starts the captured plan; no await may separate final facts from spawn. */
export async function startAuthorizedShell<T>(ctx: ToolContext, tool: AgentTool, input: unknown, start: (plan: ShellExecutionPlan) => T): Promise<T> {
  const invocation = invocations.get(ctx);
  invocations.delete(ctx);
  const grant = invocation && invocation.tool === tool ? grants.get(invocation.grant) : undefined;
  if (!grant || grant.consumed || grant.closed) throw new Error('Approval denied: Main invocation authorization unavailable');
  grant.consumed = true;
  const { options, metrics } = grant.authority;
  try {
    if (await options.current() !== grant.current) throw new Error('Main policy or workspace changed');
    const facts = grant.plan.description;
    const decision = options.decide({ command: facts.command, cwd: facts.cwd.path });
    if (fingerprint(options.permission) !== grant.permission || decision === 'deny' || decision === 'unavailable' || Date.now() >= grant.expiresAt
      || grant.closed || options.signal?.aborted || grant.signal?.aborted || ctx.signal?.aborted) throw new Error('Shell authorization revoked, expired or cancelled');
    validateShellPlan(grant.plan, input, ctx);
    return start(grant.plan);
  } catch (error) { metrics.invalidated++; throw error; }
}
