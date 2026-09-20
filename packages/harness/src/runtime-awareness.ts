// Runtime facts injection: keep the Runtime-owned facts a model must not invent
// below the cache boundary.
//
// Only facts that can change an answer belong here: capability state, the
// current task state and its progress. The exact clock, time zone, run start,
// elapsed time and repeated tool/run statistics are deliberately not injected.
// They changed on every request (so every prompt tail was unique and re-billed),
// they are not judgement inputs, and the UI reads them straight from Runtime
// data. Facts that genuinely change arrive as runtime events, and anything else
// a request really needs is fetched on demand.
import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type { LlmCallPurpose, RunContext } from '@littlesheep/types';
import { isExecutionContinuationRequest } from './continuation-intent.js';
import { isCompactReadOnlyResult } from './compact-read-only-result.js';
import {
  resolveCompactAutonomousReadDecisionTools,
  resolveCompactAutonomousReadExecutionTools,
} from './compact-autonomous-read-task.js';

export interface RuntimeAwarenessInjection {
  request: ChatRequest;
  candidates?: ContextMessageCandidate[];
}

/** Add bounded, Runtime-owned facts immediately before an outbound model call. */
export function injectRuntimeAwareness(
  ctx: RunContext,
  request: ChatRequest,
  candidates: ContextMessageCandidate[] | undefined,
  requestIndex: number,
  purpose?: LlmCallPurpose,
): RuntimeAwarenessInjection {
  const systemIndex = request.messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return { request, candidates };

  const section = shouldUseCompactRuntime(ctx, purpose)
    ? renderCompactRuntimeFacts(ctx)
    : renderRuntimeFacts(ctx);
  // The Provider matches its prefix cache from token zero, so a per-request
  // change inside the system prompt caps reuse at that byte and every later
  // token (including the whole conversation) is re-billed. Keep these facts in
  // one trailing message whose position is stable for the run.
  const segmentText = `${CACHE_BOUNDARY_MARKER}\n\n${section}`;
  const message: ChatMessage = { role: 'system', content: segmentText };
  const preparedRequest = { ...request, messages: [...request.messages, message] };

  if (!candidates) return { request: preparedRequest };

  const segment: ContextMessageSegment = {
    id: `runtime-awareness:${requestIndex}`,
    order: Number.MAX_SAFE_INTEGER,
    text: segmentText,
    kind: 'runtime_event',
    source: {
      kind: 'runtime_event',
      id: `runtime-awareness:${ctx.runId}:${requestIndex}`,
      runId: ctx.runId,
      // The run start is the stable reference for when these facts were first
      // observed; there is no per-request clock any more.
      ...(ctx.startedAt ? { generatedAt: ctx.startedAt } : {}),
    },
    priority: 100,
    required: true,
    sensitive: true,
    scope: 'run',
  };

  return {
    request: preparedRequest,
    candidates: [...candidates, {
      id: `runtime-awareness:${requestIndex}`,
      order: Number.MAX_SAFE_INTEGER,
      message,
      kind: 'runtime_event',
      source: segment.source,
      priority: 100,
      required: true,
      sensitive: true,
      scope: 'run',
    }],
  };
}

function shouldUseCompactRuntime(ctx: RunContext, purpose: LlmCallPurpose | undefined): boolean {
  if (purpose === 'decide_explicit_tool') return true;
  if (purpose === 'decide') return Boolean(resolveCompactAutonomousReadDecisionTools(ctx));
  if (purpose === 'execute_tool_loop') return Boolean(resolveCompactAutonomousReadExecutionTools(ctx));
  if (purpose === 'execute_final_reply') return isCompactReadOnlyResult(ctx);
  if (purpose !== 'reply') return purpose === 'classify' || purpose === 'ask_user';
  const request = ctx.inbound.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return !isExecutionContinuationRequest(request);
}

function renderCompactRuntimeFacts(ctx: RunContext): string {
  const lines = [`task=${taskProgress(ctx).state}; ${compactCapabilityFacts(ctx)}`];
  const probe = capabilityProbeLine(ctx);
  if (probe) lines.push(probe);
  lines.push('', 'Use these exact Runtime facts only when relevant.');
  return [
    '# Runtime Facts',
    '',
    ...lines,
  ].join('\n');
}

function renderRuntimeFacts(ctx: RunContext): string {
  const progress = taskProgress(ctx);
  const lines = [
    '# Runtime Facts',
    '',
    `- task_state: ${progress.state}`,
  ];
  if (progress.total > 0) {
    lines.push(`- task_progress: ${progress.completed}/${progress.total} completed (${progress.percent}%)`);
    if (progress.active) lines.push(`- active_step: ${progress.active}`);
  }
  lines.push(
    ...capabilityFactLines(ctx),
    '- Runtime capability facts above are Runtime-owned. A capability probe or Web query may only be claimed when its corresponding Runtime event exists.',
  );
  return lines.join('\n');
}

function compactCapabilityFacts(ctx: RunContext): string {
  const snapshot = ctx.capabilitySnapshot;
  if (!snapshot) return 'capability_snapshot=unavailable';
  const toolSummary = snapshot.tools
    .map((tool) => `${cleanInline(tool.name)}=${tool.status}`)
    .join(', ');
  const decision = ctx.capabilityPermissionEvent?.decision;
  return `capability_epoch=${snapshot.epoch}; permission=${snapshot.permissionPolicyId}`
    + `${decision ? `/${decision}` : ''}; workspace=${snapshot.workspace}; `
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
  const probe = capabilityProbeLine(ctx);
  if (!snapshot) {
    return [
      '- capability_snapshot: unavailable (no Runtime snapshot was supplied)',
      ...(probe ? [`- ${probe}`] : []),
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
    ...(probe ? [`- ${probe}`] : []),
    ...(ctx.capabilityPermissionEvent ? [`- capability_permission_decision: ${ctx.capabilityPermissionEvent.decision}`] : []),
  ];
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
