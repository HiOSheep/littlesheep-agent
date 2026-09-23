// Runtime facts injection, split by how often each fact changes.
//
// Stable capability facts (snapshot epoch, permission policy, workspace, network,
// tool availability) are fixed for the whole run, so they belong in the
// cacheable prefix: they are inserted as a system message immediately after the
// main system prompt, before the conversation history. Sending them at the tail
// instead would re-bill them on every request.
//
// Facts that really change while the run progresses (task state and progress,
// capability probe results, permission decisions) stay in one trailing message
// below the cache boundary, so a change cannot invalidate the shared prefix.
//
// The exact clock, time zone, run start, elapsed time and repeated tool/run
// statistics are deliberately not injected at all: they changed on every
// request, they are not judgement inputs, and the UI reads them from Runtime
// data. Anything else a request genuinely needs is fetched on demand.
import type { ContextMessageCandidate } from '@littlesheep/context';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type { LlmCallPurpose, RunContext } from '@littlesheep/types';
import { describeExecutionShell } from '@littlesheep/tools';
import { isExecutionContinuationRequest } from './continuation-intent.js';
import {
  RUNTIME_CONTEXT_TAIL_ID,
  renderRuntimeContextNotice,
} from './runtime-context-notice.js';

/** Sorts immediately after the primary system prompt (order 0) and before any history. */
const STABLE_FACTS_ORDER = 0.5;
/** Sorts after the capability facts, which it must not displace. */
const RUNTIME_CONTEXT_ORDER = 0.6;

export interface RuntimeAwarenessInjection {
  request: ChatRequest;
  candidates?: ContextMessageCandidate[];
}

/** Add bounded, Runtime-owned facts to an outbound request before it is sent. */
export function injectRuntimeAwareness(
  ctx: RunContext,
  request: ChatRequest,
  candidates: ContextMessageCandidate[] | undefined,
  requestIndex: number,
  purpose?: LlmCallPurpose,
): RuntimeAwarenessInjection {
  const systemIndex = request.messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return { request, candidates };

  const compact = shouldUseCompactRuntime(ctx, purpose);
  const stableText = compact ? renderCompactCapabilityFacts(ctx) : renderCapabilitySnapshot(ctx);
  const volatileText = renderVolatileRunState(ctx);
  // The environment brief: only present when the model has not already been told
  // this exact state. Because the last observed notice is read from the replayed
  // transcript as well as from this run's own output, an unchanged environment
  // adds nothing here — the replayed copy is the current fact.
  const runtimeContextText = renderRuntimeContextNotice(ctx);

  const stableMessage: ChatMessage = { role: 'system', content: stableText };
  const runtimeContextMessage: ChatMessage | undefined = runtimeContextText
    ? { role: 'system', content: runtimeContextText }
    : undefined;
  const messages = [...request.messages];
  messages.splice(
    systemIndex + 1,
    0,
    stableMessage,
    ...(runtimeContextMessage ? [runtimeContextMessage] : []),
  );
  const volatileMessage: ChatMessage | undefined = volatileText
    ? { role: 'system', content: `${CACHE_BOUNDARY_MARKER}\n\n${volatileText}` }
    : undefined;
  if (volatileMessage) messages.push(volatileMessage);

  if (!candidates) return { request: { ...request, messages } };

  const stableSource = {
    kind: 'runtime_event' as const,
    id: `runtime-awareness:${ctx.runId}:${requestIndex}:stable`,
    runId: ctx.runId,
    ...(ctx.startedAt ? { generatedAt: ctx.startedAt } : {}),
  };
  const stableCandidate: ContextMessageCandidate = {
    id: `runtime-awareness:${requestIndex}:stable`,
    order: STABLE_FACTS_ORDER,
    message: stableMessage,
    kind: 'runtime_event',
    source: stableSource,
    priority: 100,
    required: true,
    sensitive: true,
    scope: 'run',
  };
  const runtimeContextCandidate: ContextMessageCandidate | undefined = runtimeContextMessage
    ? {
        id: `runtime-awareness:${requestIndex}:${RUNTIME_CONTEXT_TAIL_ID}`,
        order: RUNTIME_CONTEXT_ORDER,
        message: runtimeContextMessage,
        kind: 'runtime_event',
        source: {
          kind: 'runtime_event',
          id: `${RUNTIME_CONTEXT_TAIL_ID}:${ctx.runId}:${requestIndex}`,
          runId: ctx.runId,
          ...(ctx.startedAt ? { generatedAt: ctx.startedAt } : {}),
        },
        priority: 100,
        required: true,
        sensitive: true,
        scope: 'run',
      }
    : undefined;
  const volatileCandidate: ContextMessageCandidate | undefined = volatileMessage
    ? {
        id: `runtime-awareness:${requestIndex}`,
        order: Number.MAX_SAFE_INTEGER,
        message: volatileMessage,
        kind: 'runtime_event',
        source: {
          kind: 'runtime_event',
          id: `runtime-awareness:${ctx.runId}:${requestIndex}`,
          runId: ctx.runId,
          ...(ctx.startedAt ? { generatedAt: ctx.startedAt } : {}),
        },
        priority: 100,
        required: true,
        sensitive: true,
        scope: 'run',
      }
    : undefined;

  return {
    request: { ...request, messages },
    candidates: [
      ...candidates,
      stableCandidate,
      ...(runtimeContextCandidate ? [runtimeContextCandidate] : []),
      ...(volatileCandidate ? [volatileCandidate] : []),
    ],
  };
}

function shouldUseCompactRuntime(ctx: RunContext, purpose: LlmCallPurpose | undefined): boolean {
  // The compact projection is now only about the capability/status answer, which
  // needs nothing but the Runtime facts. Planning and the TaskBook step executor
  // are gone, so their once-compact purposes no longer exist.
  if (purpose === 'decide_explicit_tool') return true;
  if (purpose !== 'reply') return purpose === 'classify' || purpose === 'ask_user';
  const request = ctx.inbound.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return !isExecutionContinuationRequest(request);
}

function renderCompactCapabilityFacts(ctx: RunContext): string {
  return [
    '# Runtime Facts',
    '',
    compactCapabilityFacts(ctx),
    '',
    'Use these exact Runtime facts only when relevant.',
  ].join('\n');
}

/**
 * The capability facts exactly as the main loop sends them.
 *
 * They are run-stable, so the main loop appends them once as part of its
 * append-only tail instead of re-injecting them on every iteration.
 */
export function renderRuntimeFacts(ctx: RunContext): string {
  return renderCapabilitySnapshot(ctx);
}

export function renderCapabilitySnapshot(ctx: RunContext): string {
  return [
    '# Runtime Facts',
    '',
    ...capabilityFactLines(ctx),
    '- Runtime capability facts above are Runtime-owned. A capability probe or Web query may only be claimed when its corresponding Runtime event exists.',
  ].join('\n');
}

/** Task progress, probe results and permission decisions: these can change mid-run. */
export function renderVolatileRunState(ctx: RunContext): string | undefined {
  const lines: string[] = [];
  const progress = taskProgress(ctx);
  if (ctx.taskBook || ctx.taskExecution) {
    lines.push(`task=${progress.state}`);
    if (progress.total > 0) {
      lines.push(`task_progress=${progress.completed}/${progress.total} (${progress.percent}%)`);
    }
    if (progress.active) lines.push(`active_step=${cleanInline(progress.active)}`);
  }
  const probe = capabilityProbeLine(ctx);
  if (probe) lines.push(probe);
  const decision = ctx.capabilityPermissionEvent?.decision;
  if (decision) lines.push(`capability_permission_decision: ${decision}`);
  if (lines.length === 0) return undefined;
  return ['# Runtime State', '', ...lines].join('\n');
}

function compactCapabilityFacts(ctx: RunContext): string {
  const snapshot = ctx.capabilitySnapshot;
  if (!snapshot) return 'capability_snapshot=unavailable';
  const toolSummary = snapshot.tools
    .map((tool) => `${cleanInline(tool.name)}=${tool.status}`)
    .join(', ');
  return `capability_epoch=${snapshot.epoch}; permission=${snapshot.permissionPolicyId}; `
    + `workspace=${snapshot.workspace}; `
    + `network=${snapshot.network.enabled ? 'enabled' : 'disabled'}/${snapshot.network.status}; `
    + `tools=${toolSummary || 'none'}`;
}

function capabilityProbeLine(ctx: RunContext): string | undefined {
  const probe = ctx.capabilityProbe;
  if (!probe) return undefined;
  return `capability_probe=${probe.status}; evidence=${probe.evidence}; epoch=${probe.capabilityEpoch}`;
}

function capabilityFactLines(ctx: RunContext): string[] {
  const snapshot = ctx.capabilitySnapshot;
  const shell = executionShellFactLines();
  if (!snapshot) {
    return [
      '- capability_snapshot: unavailable (no Runtime snapshot was supplied)',
      ...shell,
    ];
  }
  const toolSummary = snapshot.tools
    .map((tool) => `${cleanInline(tool.name)}=${tool.status}`)
    .join(', ');
  return [
    `- capability_epoch: ${snapshot.epoch}`,
    `- permission_policy: ${snapshot.permissionPolicyId}`,
    `- workspace_access: ${snapshot.workspace}`,
    `- network: ${snapshot.network.enabled ? 'enabled' : 'disabled'} (${snapshot.network.status})${snapshot.network.providerId ? ` provider=${cleanInline(snapshot.network.providerId)}` : ''}`,
    `- registered_tools: ${toolSummary || 'none'}`,
    ...shell,
  ];
}

/**
 * The real shell, disclosed from the executor's own descriptor.
 *
 * The model's first command is where a wrong assumption about the interpreter
 * shows up, and neither the workspace's TOOLS.md nor the repository copy is a
 * Runtime-owned fact: a user may replace or empty its runtime copy. So the value
 * comes from the code that spawns the process, and the syntax note that follows
 * from it travels with the same line.
 */
function executionShellFactLines(): string[] {
  const shell = describeExecutionShell();
  const invocation = `${shell.binary} ${shell.args.join(' ')} "<command>"`;
  const syntax = shell.family === 'windows-powershell'
    ? 'Windows PowerShell, not PowerShell 7/pwsh; `;` separates statements, Get-ChildItem/Test-Path list and test paths, quote paths containing spaces, cmd.exe `&&` is unavailable'
    : 'POSIX sh, not bash; quote paths containing spaces, do not rely on bash-only syntax';
  return [`- shell: ${invocation} (${syntax})`];
}

function taskProgress(ctx: RunContext): {
  state: string;
  completed: number;
  total: number;
  percent: number;
  active?: string;
} {
  const steps = ctx.taskExecution?.steps ?? [];
  const total = ctx.taskBook?.steps.length ?? steps.length;
  const completed = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
  const activeResult = steps.find((step) => step.status === 'in_progress');
  const activePlan = ctx.taskBook?.steps.find((step) => step.status === 'in_progress');
  const active = activeResult?.title ?? activeResult?.description ?? activePlan?.title ?? activePlan?.description;
  const state = ctx.taskExecution?.status ?? (ctx.taskBook ? 'pending' : 'lightweight');
  return {
    state,
    completed,
    total,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    active: active ? cleanInline(active) : undefined,
  };
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 120);
}
