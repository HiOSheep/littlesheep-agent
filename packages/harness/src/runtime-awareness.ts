// Runtime-aware prompt injection: keep exact clock, capability facts and
// bounded execution status below the cache boundary for every model request.
import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import {
  CACHE_BOUNDARY_MARKER,
  formatElapsedMilliseconds,
  formatRuntimeClock,
} from '@littlesheep/prompt';
import type {
  LlmCallPurpose,
  RunContext,
  SessionRunToolTiming,
} from '@littlesheep/types';
import { isExecutionContinuationRequest } from './continuation-intent.js';
import { isCompactReadOnlyResult } from './compact-read-only-result.js';
import {
  resolveCompactAutonomousReadDecisionTools,
  resolveCompactAutonomousReadExecutionTools,
} from './compact-autonomous-read-task.js';

const MAX_RUNTIME_TOOL_DETAILS = 8;

export interface RuntimeAwarenessInjection {
  request: ChatRequest;
  candidates?: ContextMessageCandidate[];
}

/** Add exact, bounded runtime facts immediately before an outbound model call. */
export function injectRuntimeAwareness(
  ctx: RunContext,
  request: ChatRequest,
  candidates: ContextMessageCandidate[] | undefined,
  requestIndex: number,
  purpose?: LlmCallPurpose,
): RuntimeAwarenessInjection {
  const systemIndex = request.messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return { request, candidates };

  const now = resolveNow(ctx);
  const clock = formatRuntimeClock(now, ctx.timeZone);
  const section = shouldUseCompactRuntime(ctx, purpose)
    ? renderCompactRuntimeAwareness(ctx, now, clock)
    : renderRuntimeAwareness(ctx, now, clock);
  const original = request.messages[systemIndex]!;
  const originalText = typeof original.content === 'string' ? original.content : undefined;
  const separator = originalText?.includes(CACHE_BOUNDARY_MARKER)
    ? '\n\n---\n\n'
    : `\n\n${CACHE_BOUNDARY_MARKER}\n\n`;
  const segmentText = `${separator}${section}`;
  const message = appendSystemText(original, segmentText);
  const messages = request.messages.map((candidate, index) => index === systemIndex ? message : candidate);
  const preparedRequest = { ...request, messages };

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
      generatedAt: clock.instant,
    },
    priority: 100,
    required: true,
    sensitive: true,
    scope: 'run',
  };
  const preparedCandidates = candidates.map((candidate) => {
    if (candidate.order !== systemIndex || candidate.message.role !== 'system') return candidate;
    if (candidate.segments) {
      return {
        ...candidate,
        message,
        segments: [...candidate.segments, segment],
      };
    }
    if (originalText !== undefined) {
      return {
        ...candidate,
        message,
        segments: [
          {
            id: `${candidate.id}:base`,
            order: 0,
            text: originalText,
            kind: candidate.kind,
            source: candidate.source,
            priority: candidate.priority,
            required: candidate.required,
            sensitive: candidate.sensitive,
            scope: candidate.scope,
          },
          segment,
        ],
      };
    }
    return { ...candidate, message };
  });

  return { request: preparedRequest, candidates: preparedCandidates };
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

function renderCompactRuntimeAwareness(
  ctx: RunContext,
  now: Date,
  clock: ReturnType<typeof formatRuntimeClock>,
): string {
  const runElapsedMs = elapsedSince(ctx.startedAt, now);
  return [
    '# Runtime Clock',
    '',
    `local=${clock.localDateTime} ${clock.utcOffset} (${clock.timeZone}); elapsed_ms=${runElapsedMs}; task=${taskProgress(ctx).state}.`,
    ...renderCapabilityLines(ctx, true),
    '',
    'Use these exact facts only when relevant.',
  ].join('\n');
}

function renderRuntimeAwareness(
  ctx: RunContext,
  now: Date,
  clock: ReturnType<typeof formatRuntimeClock>,
): string {
  const runElapsedMs = elapsedSince(ctx.startedAt, now);
  const progress = taskProgress(ctx);
  const currentTools = collectCurrentToolTimings(ctx);
  const currentToolTotals = toolTotals(currentTools);
  const lines = [
    '# Live Runtime State',
    '',
    `- local_datetime: ${clock.localDateTime} ${clock.utcOffset}`,
    `- time_zone: ${clock.timeZone}`,
    `- user_time_format: ${ctx.timeFormat ?? 'auto'} (default answer precision: hour and minute)`,
    `- utc_instant: ${clock.instant}`,
    `- run_started_at: ${ctx.startedAt}`,
    `- run_elapsed: ${runElapsedMs} ms (${formatElapsedMilliseconds(runElapsedMs)})`,
    `- task_state: ${progress.state}`,
  ];
  lines.push(...renderCapabilityLines(ctx, false));

  if (progress.total > 0) {
    lines.push(`- task_progress: ${progress.completed}/${progress.total} completed (${progress.percent}%)`);
    if (progress.active) lines.push(`- active_step: ${progress.active}`);
  }
  lines.push(
    `- current_run_tools: ${currentToolTotals.succeeded} succeeded, ${currentToolTotals.failed} failed, ${currentToolTotals.total} finished, ${currentToolTotals.durationMs} ms cumulative tool time`,
  );
  if (currentTools.length > 0) {
    lines.push(`- recent_current_tools: ${renderToolTimings(currentTools.slice(-MAX_RUNTIME_TOOL_DETAILS))}`);
  }

  const previous = ctx.previousRun;
  if (previous) {
    const task = previous.task
      ? `, task=${previous.task.completedSteps}/${previous.task.totalSteps} ${previous.task.status}`
      : '';
    lines.push(
      `- previous_run: id=${previous.runId}, status=${previous.status}, elapsed=${previous.durationMs} ms (${formatElapsedMilliseconds(previous.durationMs)})${task}`,
      `- previous_run_tools: ${previous.tools.succeeded} succeeded, ${previous.tools.failed} failed, ${previous.tools.total} total, ${previous.tools.totalDurationMs} ms cumulative tool time${previous.tools.truncated ? ', recent list truncated' : ''}`,
    );
    if (previous.tools.recent.length > 0) {
      lines.push(`- recent_previous_tools: ${renderToolTimings(previous.tools.recent)}`);
    }
  }

  lines.push(
    '',
    'Runtime disclosure policy:',
    '- Use these exact facts for time, progress, timeout, recovery, and immediate follow-up questions; do not estimate them from prose.',
    '- A plain current-time answer should show only hour and minute. Add date, seconds, time zone, or UTC offset only when explicitly requested or in a follow-up.',
    '- Do not volunteer elapsed time, percentages, or tool timing when they add no value. Surface them when the user asks or when they materially explain status, failure, cost, or risk.',
  );
  return lines.join('\n');
}

function renderCapabilityLines(ctx: RunContext, compact: boolean): string[] {
  const snapshot = ctx.capabilitySnapshot;
  if (!snapshot) {
    const unavailable = compact ? 'capability_snapshot=unavailable' : '- capability_snapshot: unavailable (no Runtime snapshot was supplied)';
    return ctx.capabilityProbe
      ? [unavailable, `- capability_probe: ${ctx.capabilityProbe.status}; evidence=${ctx.capabilityProbe.evidence}; epoch=${ctx.capabilityProbe.capabilityEpoch}`]
      : (compact ? [unavailable] : ['', unavailable]);
  }
  const toolSummary = snapshot.tools
    .map((tool) => `${cleanInline(tool.name)}=${tool.status}`)
    .join(', ');
  const probe = ctx.capabilityProbe;
  const probeLine = probe
    ? `capability_probe=${probe.status}; evidence=${probe.evidence}; epoch=${probe.capabilityEpoch}; permission=${ctx.capabilityPermissionEvent?.decision ?? 'unavailable'}`
    : undefined;
  if (compact) {
    return [
      `capability_epoch=${snapshot.epoch}; permission=${snapshot.permissionPolicyId}; workspace=${snapshot.workspace}; network=${snapshot.network.enabled ? 'enabled' : 'disabled'}/${snapshot.network.status}; tools=${toolSummary || 'none'}`,
      ...(probeLine ? [probeLine] : []),
    ];
  }
  return [
    '',
    '# Runtime Capability Snapshot',
    '',
    `- capability_epoch: ${snapshot.epoch}`,
    `- permission_policy: ${snapshot.permissionPolicyId}`,
    `- workspace_access: ${snapshot.workspace}`,
    `- network: ${snapshot.network.enabled ? 'enabled' : 'disabled'} (${snapshot.network.status})${snapshot.network.providerId ? ` provider=${cleanInline(snapshot.network.providerId)}` : ''}`,
    `- registered_tools: ${toolSummary || 'none'}`,
    ...(probeLine ? [`- ${probeLine}`] : []),
    ...(ctx.capabilityPermissionEvent ? [`- capability_permission_decision: ${ctx.capabilityPermissionEvent.decision}`] : []),
    '- Capability facts above are Runtime-owned. A capability probe or Web query may only be claimed when its corresponding Runtime event exists.',
  ];
}

function appendSystemText(message: ChatMessage, suffix: string): ChatMessage {
  if (typeof message.content === 'string') return { ...message, content: `${message.content}${suffix}` };
  return {
    ...message,
    content: [...message.content, { type: 'text', text: suffix }],
  };
}

function resolveNow(ctx: RunContext): Date {
  const candidate = ctx.runtimeNow?.() ?? new Date();
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

function elapsedSince(startedAt: string, now: Date): number {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, now.getTime() - start) : 0;
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

function collectCurrentToolTimings(ctx: RunContext): SessionRunToolTiming[] {
  const names = new Map<string, string>();
  const timings: SessionRunToolTiming[] = [];
  for (const message of ctx.produced) {
    for (const block of message.content) {
      if (block.type === 'tool_calls') {
        for (const call of block.calls) names.set(call.id, call.name);
      } else if (block.type === 'tool_result') {
        const stepId = typeof block.result.meta?.stepId === 'string'
          ? block.result.meta.stepId
          : undefined;
        timings.push({
          name: names.get(block.result.callId) ?? 'unknown',
          status: block.result.ok ? 'succeeded' : 'failed',
          durationMs: block.result.durationMs,
          stepId,
        });
      }
    }
  }
  return timings;
}

function toolTotals(tools: SessionRunToolTiming[]) {
  return tools.reduce((totals, tool) => ({
    total: totals.total + 1,
    succeeded: totals.succeeded + (tool.status === 'succeeded' ? 1 : 0),
    failed: totals.failed + (tool.status === 'failed' ? 1 : 0),
    durationMs: totals.durationMs + (tool.durationMs ?? 0),
  }), { total: 0, succeeded: 0, failed: 0, durationMs: 0 });
}

function renderToolTimings(tools: SessionRunToolTiming[]): string {
  return tools.map((tool) => {
    const duration = tool.durationMs === undefined ? 'duration unavailable' : `${tool.durationMs} ms`;
    const step = tool.stepId ? `, step=${cleanInline(tool.stepId)}` : '';
    return `${cleanInline(tool.name)}:${tool.status}:${duration}${step}`;
  }).join('; ');
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 120);
}
