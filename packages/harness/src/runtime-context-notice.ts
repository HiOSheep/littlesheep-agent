// The Runtime's "current execution environment" brief.
//
// Switching the model, the workspace or the permission mode used to be invisible
// to the model: the settings page changed, the next request was routed with the
// new values, and the only way the model learned about it was by guessing from
// conversation history or by probing the environment with a tool call. This
// module renders one short block that states what is actually in effect for the
// request it travels with.
//
// Design constraints, all of them load-bearing:
//
// - Runtime-authored. Every field is read from state the Runtime already
//   resolved (the run's `resolvedRunConfig`, its workspace and the real shell
//   descriptor). Nothing here calls a model, and nothing here is a user-facing
//   reply.
// - Append-only and replayed. The block is a tail entry stored in the session
//   transcript by the existing runtime-tail mechanism, so a later run reads the
//   last state the model actually saw from the replayed prefix instead of
//   keeping a second change-log store.
// - Silent when nothing moved. Rendering is a pure function of the current
//   fields and the fields parsed out of the previous notice; an unchanged
//   environment renders nothing at all, so "the same state" can never be
//   announced twice.
// - Bounded. At most six lines: one header plus five field lines. Paths are
//   rendered in full — a truncation that produces a plausible but wrong path is
//   worse than a longer line.
import type { RunContext } from '@littlesheep/types';
import { randomUUID } from 'node:crypto';
import { describeExecutionShell } from '@littlesheep/tools';

/** Tail-entry id every notice carries, and the key the previous one is found by. */
export const RUNTIME_CONTEXT_TAIL_ID = 'runtime-context';

/** Field keys, in render order. This order is part of the byte-stable format. */
const FIELD_KEYS = ['model', 'workspace', 'shell', 'access', 'tools'] as const;

type FieldKey = typeof FIELD_KEYS[number];

export type RuntimeContextFields = Partial<Record<FieldKey, string>>;

/**
 * What this run actually routes and executes with.
 *
 * `resolvedRunConfig` is the authoritative record of the decision (which
 * provider the request is really addressed to, which permission policy was
 * applied, whether network reads are enabled). `ctx.model` is only the
 * configured reference and is used as a fallback for contexts built outside the
 * Runner, such as direct stage tests.
 */
export function currentRuntimeContextFields(ctx: RunContext): RuntimeContextFields {
  const resolved = ctx.resolvedRunConfig;
  const provider = resolved?.provider ?? providerOf(ctx.model);
  const model = resolved?.model ?? modelOf(ctx.model);
  const shell = describeExecutionShell();
  const permission = resolved?.permissionPolicyId;
  const network = resolved?.networkPolicy?.enabled;
  return {
    model: `${provider}/${model}`,
    workspace: ctx.cwd,
    shell: shell.binary,
    access: [
      `permission=${permission ?? 'unknown'}`,
      `network=${network === undefined ? 'unknown' : network ? 'enabled' : 'disabled'}`,
    ].join('; '),
    tools: String(resolved?.availableToolNames?.length ?? ctx.tools?.length ?? 0),
  };
}

/**
 * Read the fields back out of a previously rendered notice.
 *
 * The grammar is deliberately trivial: `- <key>: <value>`, value to end of line,
 * no escaping and no annotation. Every line that does not match is ignored, so
 * the header (and any future prose line) cannot corrupt the parsed state.
 */
export function parseRuntimeContextNotice(text: string): RuntimeContextFields | undefined {
  const fields: RuntimeContextFields = {};
  let found = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = /^-\s+([a-z_]+):\s?(.*)$/u.exec(rawLine.trim());
    if (!match) continue;
    const key = match[1]!;
    if (!(FIELD_KEYS as readonly string[]).includes(key)) continue;
    fields[key as FieldKey] = match[2]!.trim();
    found = true;
  }
  return found ? fields : undefined;
}

/**
 * The effective state the model was last told about.
 *
 * Both halves are needed and neither is optional. `modelHistory` is the replayed
 * task interval — the notices an earlier run appended, which is what makes the
 * brief survive a restart, a checkpoint resume and a compaction. `produced` is
 * this run's own transcript buffer, and it is read *after* the replay because it
 * is appended later: without it, the second and later model requests of one run
 * would each re-announce the state the first request had already established,
 * and a capability reply or an `ask_user` turn inside the same run would repeat
 * the main loop's brief.
 */
export function lastRuntimeContextNotice(
  ctx: Pick<RunContext, 'modelHistory' | 'produced'>,
): RuntimeContextFields | undefined {
  let latest: RuntimeContextFields | undefined;
  for (const message of [...(ctx.modelHistory ?? []), ...(ctx.produced ?? [])]) {
    if (message.runtimeTail !== true || message.runtimeTailId !== RUNTIME_CONTEXT_TAIL_ID) continue;
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    const parsed = text ? parseRuntimeContextNotice(text) : undefined;
    if (parsed) latest = parsed;
  }
  return latest;
}

/**
 * Render the current environment brief, or `undefined` when the model has
 * already been told this exact state.
 *
 * A pure function of the current fields and the last observed ones: it keeps no
 * side state, so a request that is assembled twice renders the same bytes, and a
 * request that never reached the Provider still leaves the notice in the
 * transcript the next request replays.
 */
export function renderRuntimeContextNotice(ctx: RunContext): string | undefined {
  const current = currentRuntimeContextFields(ctx);
  const previous = lastRuntimeContextNotice(ctx);
  const changed = changedFields(previous, current);
  if (previous && changed.length === 0) return undefined;
  return renderNotice(current, changed);
}

/** Field keys whose value differs from the previous notice, in render order. */
export function changedRuntimeContextFields(
  previous: RuntimeContextFields | undefined,
  current: RuntimeContextFields,
): string[] {
  return changedFields(previous, current);
}

/**
 * Record a delivered notice in this run's transcript.
 *
 * The main loop's tail already persists what it appends. A stage that assembles
 * a single request without a tail — a conversational or capability reply — has
 * to record the block itself, or the next run would read no previous notice from
 * the replay and announce the same unchanged state a second time. Idempotent:
 * a notice this run already carries is not appended twice.
 */
export function recordRuntimeContextNotice(ctx: RunContext, text: string | undefined): void {
  if (!text) return;
  const alreadyRecorded = (ctx.produced ?? []).some((message) => (
    message.runtimeTail === true
    && message.runtimeTailId === RUNTIME_CONTEXT_TAIL_ID
    && message.content.some((part) => part.type === 'text' && part.text === text)
  ));
  if (alreadyRecorded) return;
  ctx.produced?.push({
    id: randomUUID(),
    role: 'system',
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    stage: 'reply',
    runtimeTail: true,
    runtimeTailId: RUNTIME_CONTEXT_TAIL_ID,
  });
}

function changedFields(
  previous: RuntimeContextFields | undefined,
  current: RuntimeContextFields,
): string[] {
  if (!previous) return [];
  return FIELD_KEYS.filter((key) => previous[key] !== undefined && previous[key] !== current[key]);
}

function renderNotice(current: RuntimeContextFields, changed: readonly string[]): string {
  const header = changed.length === 0
    ? '[Runtime context; effective for this request]'
    : `[Runtime context; effective for this request. Changed: ${changed.join(', ')}.${
      changed.includes('workspace') ? ' Relative paths now resolve under the current workspace.' : ''
    }]`;
  const lines = [header];
  for (const key of FIELD_KEYS) {
    const value = current[key];
    if (value === undefined) continue;
    lines.push(`- ${key}: ${value}`);
  }
  return lines.join('\n');
}

function providerOf(modelRef: string): string {
  const slash = modelRef.indexOf('/');
  return slash > 0 ? modelRef.slice(0, slash) : 'unknown';
}

function modelOf(modelRef: string): string {
  const slash = modelRef.indexOf('/');
  return slash > 0 ? modelRef.slice(slash + 1) : modelRef;
}
