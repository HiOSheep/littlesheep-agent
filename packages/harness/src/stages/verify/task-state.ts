import type { RunContext, SideEffectCheckpoint, ToolInvocationStatus } from '@littlesheep/types';

/** Side-effect statuses that mean the Runtime does not know the outcome yet. */
const UNSETTLED_EFFECT_STATUSES = new Set<SideEffectCheckpoint['status']>([
  'planned',
  'in_progress',
  'unknown',
]);

/** Refusals the model can correct: the call never ran, so the outcome is known. */
const RECORDED_REFUSAL_STATUSES = new Set<ToolInvocationStatus>([
  'validation_failed',
  'unknown_tool',
  'repeated_call_blocked',
]);

/**
 * Invocation statuses that make the recorded evidence unusable rather than
 * merely negative.
 *
 * The distinction is *what the Runtime knows*, not how bad the outcome was:
 *
 * - A permission outcome (`approval_denied`, `approval_unavailable`,
 *   `hard_denied`) is unresolved in the sense that matters — the user has to
 *   decide whether the access is granted — so the run escalates with that fact
 *   instead of publishing an answer (RECOVER's `permission_denied` branch reads
 *   the same invocation statuses).
 * - A refusal the *model* can correct (`validation_failed`, `unknown_tool`,
 *   `repeated_call_blocked`) is a recorded outcome, not a gap: the call was
 *   refused before it ran, so the Runtime knows exactly what happened — nothing.
 *   Treating those as gaps cost real runs their delivery: measured twice in the
 *   real window, a run that had written its artifact and settled ten effects was
 *   turned into a question because one incidental call was schema-invalid, and
 *   again because one repeated call was blocked. The loop already gives the model
 *   its chance to correct such a call (the refusal travels back as a tool result,
 *   under the no-progress and iteration bounds), so the verdict must stay
 *   `unverified` with the refusal in the record rather than `fail`.
 */
const EVIDENCE_BLOCKING_INVOCATION_STATUSES = new Set<ToolInvocationStatus>([
  'approval_denied',
  'approval_unavailable',
  'hard_denied',
]);


/** Runtime facts that a model verdict is not allowed to repair or hide. */
export function runtimeExecutionEvidenceGap(ctx: RunContext): string | undefined {
  // Step evidence is not judged here any more (HC-03). A plan restored from a checkpoint is read-only
  // history, and nothing executes steps at all: no run creates a TaskBook or a TaskExecution, so asking
  // whether "this run's" steps are complete could only ever fire on inherited history — which turned
  // history into a gap and spent the replan budget sending the run back to a step executor that no longer
  // exists. What the run owes is evidence for the calls it actually made, below.
  if (ctx.toolInvocationsTruncated) return 'tool invocation evidence is truncated';

  const invocations = ctx.toolInvocations ?? [];
  const callIds = new Set<string>();
  const activeInvocations = invocations.filter((invocation, index) => !(
    invocation.status !== 'succeeded'
    && invocation.stepId
    && invocations.slice(index + 1).some((candidate) => (
      candidate.stepId === invocation.stepId && candidate.status === 'succeeded'
    ))
  ));
  for (const invocation of invocations) {
    if (callIds.has(invocation.callId)) return `duplicate tool invocation ${invocation.callId}`;
    callIds.add(invocation.callId);
  }
  for (const invocation of activeInvocations) {
    if (EVIDENCE_BLOCKING_INVOCATION_STATUSES.has(invocation.status)) {
      return `tool invocation ${invocation.callId} is ${invocation.status}`;
    }
    if (invocation.outputTruncated) return `tool invocation ${invocation.callId} output is truncated`;
  }

  if (activeInvocations.length > 0) {
    const results = new Map((ctx.toolResults ?? []).map((result) => [result.callId, result]));
    for (const invocation of activeInvocations) {
      // A missing result is a gap; a recorded failed result is evidence.
      if (!results.has(invocation.callId)) return `tool result ${invocation.callId} is missing`;
    }
  }

  for (const effect of ctx.sideEffects ?? []) {
    if (UNSETTLED_EFFECT_STATUSES.has(effect.status)) {
      return `side effect ${effect.idempotencyKey} is ${effect.status}`;
    }
    if (!effect.callId || !callIds.has(effect.callId)) {
      if (!inheritedEffectEvidence(ctx, effect)) {
        return `side effect ${effect.idempotencyKey} has no matching tool invocation`;
      }
      continue;
    }
    const invocation = invocations.find((candidate) => candidate.callId === effect.callId);
    if (!invocation || invocation.toolName !== effect.toolName) {
      return `side effect ${effect.idempotencyKey} tool identity does not match its invocation`;
    }
  }
  return undefined;
}

/**
 * Negative outcomes the run recorded. They are not an evidence gap: the runtime
 * knows exactly what happened, so the model's answer can be published — but the
 * verdict must never become `pass`, and the failure stays in the record.
 */
export function recordedToolFailures(ctx: RunContext, limit = 5): string[] {
  const failures: string[] = [];
  for (const invocation of ctx.toolInvocations ?? []) {
    if (
      invocation.status === 'failed'
      || invocation.status === 'timed_out'
      || invocation.status === 'aborted'
      || RECORDED_REFUSAL_STATUSES.has(invocation.status)
    ) {
      failures.push(`tool invocation ${invocation.callId} is ${invocation.status}`);
    }
  }
  for (const effect of ctx.sideEffects ?? []) {
    if (effect.status === 'failed' || effect.status === 'cancelled') {
      failures.push(`side effect ${effect.idempotencyKey} is ${effect.status}`);
    }
  }
  return failures.slice(0, limit);
}

/**
 * Evidence for an effect this run did not itself invoke.
 *
 * A continuation restores the checkpoint's side-effect ledger but not the
 * previous run's invocation records: the invocation list belongs to the new run,
 * so an inherited call id can never match one. Reading that as "no evidence"
 * made every resumed run that settled an effect before the interruption report
 * incomplete evidence about work the Runtime had already settled — the resumed
 * run could not finish truthfully.
 *
 * The attestation therefore comes from what the checkpoint itself carried: the restored ledger entry is
 * terminal, which means the Runtime settled it before the interruption. (A legacy TaskBook checkpoint
 * could also carry the call on a step; nothing writes those any more, and reading inherited history as
 * evidence was always the weaker of the two.)
 *
 * Anything else — no call id, a non-terminal status — still reports the gap.
 */
function inheritedEffectEvidence(ctx: RunContext, effect: SideEffectCheckpoint): boolean {
  if (!ctx.resumedFromCheckpointId) return false;
  if (!effect.callId) return false;
  return effect.status === 'succeeded' || effect.status === 'failed' || effect.status === 'cancelled';
}



