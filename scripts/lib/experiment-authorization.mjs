// RA-08: compare two authorization *shapes* inside one identical permission envelope.
//
// The review's objection to the previous comparison was precise: comparing `full` with `research` changed
// the whole permission mode, so "0 prompts instead of 3" proved that a wider mode needs fewer prompts — a
// tautology — and said nothing about whether a range authorization reduces interruptions *without* allowing
// anything more.
//
// This module therefore builds one grant, hands the **same** grant to both arms, and varies exactly one
// thing: whether the Runtime asks per command or consults the range once.
//
//   * `per-command`: every allowed call is put to the approval callback, which validates it against the
//     grant and answers.
//   * `range`: the grant is validated once, up front, and calls inside it proceed without a prompt.
//
// The claim to test is not "fewer prompts" on its own — it is "fewer prompts, and the same set of calls
// allowed". So every arm runs the same ordered sequence, including the calls that must be refused, and the
// module compares the two arms' decisions call by call. A range that admits one call the per-command arm
// refused is a failure of the row, not a saving.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runThroughExecTool, SANDBOX_BACKEND } from './experiment-sandbox.mjs';

/**
 * One controlled grant: what may be touched, for how long, and whether it can be taken back.
 *
 * Deliberately explicit about every axis RA-08 names — paths, tools, network, expiry, revocation — because
 * a range that is vague about one of them cannot be compared with a per-command decision about that axis.
 */
export function createGrant({ workspace, toolchainPaths, distro, ttlMs = 120_000 }) {
  return {
    version: 1,
    workspace,
    paths: [workspace],
    tools: ['exec'],
    network: 'none',
    distro,
    toolchainPaths,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    revoked: false,
    note: 'experiment-only range authorization; the product has no such contract and this does not add one',
  };
}

/**
 * Judge one call against the grant, the way a Main-side validator would.
 *
 * Order matters and is the point: a revoked or expired grant is refused before anything else is considered,
 * so a call that would otherwise be inside the range is still re-judged. Every axis is checked on every
 * call, including the ones a range mode would be tempted to skip.
 */
export function judgeCall(grant, call, { now = Date.now() } = {}) {
  const refuse = (reason) => ({ allowed: false, reason });
  if (grant.revoked) return refuse('grant_revoked');
  if (now > grant.expiresAt) return refuse('grant_expired');
  if (call.workspace !== grant.workspace) return refuse('workspace_outside_grant');
  if (call.tool !== undefined && !grant.tools.includes(call.tool)) return refuse('tool_outside_grant');
  if (call.network !== undefined && call.network !== grant.network) return refuse('network_outside_grant');
  if (call.backend !== undefined && call.backend !== 'host' && grant.distro !== call.backendDistro) {
    return refuse('backend_outside_grant');
  }
  if (call.path !== undefined) {
    const target = call.path.replace(/[\\/]+$/u, '').toLocaleLowerCase();
    const inside = grant.paths.some((root) => {
      const normalised = root.replace(/[\\/]+$/u, '').toLocaleLowerCase();
      return target === normalised || target.startsWith(`${normalised}\\`) || target.startsWith(`${normalised}/`);
    });
    if (!inside) return refuse('path_outside_grant');
  }
  return { allowed: true, reason: 'inside_grant' };
}

/**
 * Run one arm over one ordered sequence of calls.
 *
 * **Every call is judged against the grant in both arms.** That is the whole point: the grant is enforced
 * either way, so the allowed and refused sets are identical by construction and the only difference is
 * whether the user is asked. The first version of this function skipped the judgement once a range had been
 * validated, and the comparison immediately reported the tautology F-09 warned about — the range arm allowed
 * all seven calls where the per-command arm allowed three. Fewer prompts with a wider allowed set is not a
 * saving, and the check suite refused to call it one.
 */
export async function runAuthorizationArm({
  mode, grant, calls, scratch, workspace, spec, auditPath, revokeAtLabel,
}) {
  const prompts = [];
  const decisions = [];
  let rangeValidated = false;
  const approvals = [];
  approvals.allow = true;
  // A mutable copy: revocation happens mid-sequence so the calls after it are judged against a revoked
  // grant in both arms, rather than being checked afterwards in a separate pass.
  const liveGrant = { ...grant };

  for (const [index, call] of calls.entries()) {
    if (revokeAtLabel !== undefined && call.label === revokeAtLabel) liveGrant.revoked = true;
    const judged = judgeCall(liveGrant, call);
    // The prompt is what differs: the per-command arm asks about every call it is about to allow; the range
    // arm asked once, when the grant was issued.
    const prompted = judged.allowed && (mode === 'per-command' || !rangeValidated);
    if (prompted) prompts.push({ index, label: call.label, reason: judged.reason, allowed: judged.allowed });
    if (mode === 'range' && judged.allowed) rangeValidated = true;
    if (!judged.allowed) {
      decisions.push({ index, label: call.label, allowed: false, reason: judged.reason, ran: false });
      continue;
    }
    const outcome = await runThroughExecTool({
      command: call.command, dataDir: scratch, workspace, approvals, spec: call.spec ?? spec, auditPath,
      ...(call.permissionMode ? { permissionMode: call.permissionMode } : {}),
    });
    decisions.push({
      index,
      label: call.label,
      allowed: true,
      reason: judged.reason,
      ran: true,
      toolOk: outcome.ok,
      actualBackend: outcome.actualBackend,
      output: outcome.output.replace(/\s+/gu, ' ').trim().slice(0, 120),
    });
  }

  return {
    mode,
    prompts: prompts.length,
    promptsForAllowedCalls: prompts.filter((entry) => entry.allowed).length,
    promptLabels: prompts.map((entry) => entry.label),
    decisions,
    allowedLabels: decisions.filter((entry) => entry.allowed).map((entry) => entry.label),
    refusedLabels: decisions.filter((entry) => !entry.allowed).map((entry) => `${entry.label}:${entry.reason}`),
    ranLabels: decisions.filter((entry) => entry.ran).map((entry) => entry.label),
  };
}

/**
 * The ordered sequence both arms run. The first two entries are allowed and are what the prompt counts are
 * about; the rest are boundary crossings that must be refused in **both** arms, which is what makes the
 * comparison about granularity rather than about permissiveness.
 */
export function authorizationSequence({ workspace, spec }) {
  const sibling = join(workspace, '..', 'outside-the-grant');
  return [
    { label: 'in-range-write', kind: 'exec', command: 'echo first > in-range-1.txt', workspace, tool: 'exec', network: 'none' },
    { label: 'in-range-second', kind: 'exec', command: 'echo second > in-range-2.txt', workspace, tool: 'exec', network: 'none' },
    { label: 'path-outside-grant', kind: 'exec', command: `echo x > '${sibling.replaceAll('\\', '/')}/x.txt'`, workspace, tool: 'exec', network: 'none', path: sibling },
    { label: 'workspace-changed', kind: 'exec', command: 'echo x > y.txt', workspace: join(workspace, 'elsewhere'), tool: 'exec', network: 'none' },
    { label: 'network-expanded', kind: 'exec', command: 'curl https://example.com', workspace, tool: 'exec', network: 'shared' },
    { label: 'tool-outside-grant', kind: 'exec', command: 'echo x', workspace, tool: 'write', network: 'none' },
    { label: 'after-revocation', kind: 'exec', command: 'echo x > after-revoke.txt', workspace, tool: 'exec', network: 'none' },
  ];
}

/** Rewrite the request sequence so the last entry runs after the grant is revoked. */
export function revokeBeforeLast(grant) {
  return { ...grant, revoked: false, __revokeAt: 'after-revocation' };
}
