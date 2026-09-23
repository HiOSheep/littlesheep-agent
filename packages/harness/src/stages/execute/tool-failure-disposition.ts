// Which tool failures the main loop may let the model correct, and which ones
// are authoritative Runtime boundaries.
//
// The loop used to treat every `ok: false` the same way: it forced a final
// answer with tools withheld for the rest of the run. That is right for a
// permission denial, a hard safety policy rejection or an unknown tool — the
// model must not probe around an authoritative boundary — but it is wrong for a
// path that does not exist, a command that exited non-zero or a typo in an
// argument. Those are ordinary execution errors, and the model can only correct
// them if it is still allowed to act, which is why the user had to type
// "continue" after a single failed command.
//
// The classification is derived from records the Runtime already keeps: the
// invocation record the tool boundary published for this call, and the
// side-effect ledger entry that call settled. Nothing here guesses from the
// error text; a call the Runtime cannot identify stays authoritative, because
// the safe direction for an unknown outcome is to stop rather than to retry.
import type { RunContext, ToolInvocationStatus, ToolResult } from '@littlesheep/types';
import { CORE_SOURCE_READ_ONLY_KIND } from '@littlesheep/tools';

export type ToolFailureDisposition =
  /** The Runtime refused, or cannot prove what happened: stop and report it. */
  | 'authoritative'
  /** The invocation ran to a known negative outcome: the model may correct it. */
  | 'correctable';

export interface ToolFailureClassification {
  disposition: ToolFailureDisposition;
  /** Bounded machine-readable reason, for evidence and tests. */
  reason: string;
  /** True when the failed call may already have changed something. */
  effectful: boolean;
}

const AUTHORITATIVE_STATUSES = new Set<ToolInvocationStatus>([
  'hard_denied',
  'approval_denied',
  'approval_unavailable',
  'validation_failed',
  'unknown_tool',
  'repeated_call_blocked',
  'aborted',
]);

/**
 * Error kinds the tool boundary assigns when the failure is a boundary decision
 * rather than an execution outcome.
 */
const AUTHORITATIVE_ERROR_KINDS = new Set([
  'hard_deny',
  'approval_denied',
  'approval_unavailable',
  'approval_error',
  'approval_aborted',
  'side_effect_replay',
  'side_effect_blocked',
  // The execution service's own runaway guard: the same call has now been
  // proposed more times than any legitimate retry, so the loop stops rather than
  // letting the model keep re-issuing it. Distinct from `side_effect_replay`,
  // which refuses one specific re-run of an operation that already applied.
  'repeated_call',
  'effect_intent_persistence',
  'effect_settlement_persistence',
  'checkpoint_before_effect',
  'checkpoint_after_effect',
  'run_aborted_before_effect',
  // Host-level read-only protection on the LS core source. It is declared by the
  // tools that refuse inside a protected root, and it is exactly the boundary the
  // model must not probe around with a different tool: approval cannot lift it.
  CORE_SOURCE_READ_ONLY_KIND,
]);

/**
 * Refusals that are final for the call but not for the run.
 *
 * A duplicate rejection says the operation already succeeded and the Runtime
 * will not run it again. Nothing executed and nothing is unknown, so the safe
 * direction is to continue: the model can observe the result with a read-only
 * tool or take a different action. It is not a way around the boundary — the
 * call is refused either way — whereas an `unknown` effect stays authoritative,
 * because there the Runtime cannot say what happened.
 */
const REPLAY_REFUSAL_ERROR_KINDS = new Set(['side_effect_replay']);

/** Side-effect settlements that leave the real outcome unknown. */
const UNSETTLED_EFFECT_STATUSES = new Set(['planned', 'in_progress', 'unknown']);

/**
 * Classify one failed result.
 *
 * `correctable` means exactly one thing: the invocation ran and reached a
 * determinate negative outcome that the Runtime recorded. It does not mean the
 * runtime will retry anything — only the model may propose the next call, and
 * the side-effect ledger still refuses to replay a call that succeeded.
 */
export function classifyToolFailure(ctx: RunContext, result: ToolResult): ToolFailureClassification {
  const effect = (ctx.sideEffects ?? []).find((candidate) => candidate.callId === result.callId);
  const effectful = effect !== undefined;
  const unsettled = effect ? UNSETTLED_EFFECT_STATUSES.has(effect.status) : false;
  const invocation = [...(ctx.toolInvocations ?? [])]
    .reverse()
    .find((candidate) => candidate.callId === result.callId);
  const declared = (result.meta as Record<string, unknown> | undefined)?.['errorKind'];
  const errorKind = typeof declared === 'string' ? declared : invocation?.errorKind;

  if (!invocation) {
    // A result with no invocation record was refused before the tool boundary
    // (a withheld capability) or produced by a path that keeps no record. The
    // Runtime cannot say what happened, so the model must not keep probing.
    return { disposition: 'authoritative', reason: 'no_invocation_record', effectful };
  }
  if (errorKind && REPLAY_REFUSAL_ERROR_KINDS.has(errorKind)) {
    return { disposition: 'correctable', reason: errorKind, effectful: true };
  }
  if (errorKind && AUTHORITATIVE_ERROR_KINDS.has(errorKind)) {
    return { disposition: 'authoritative', reason: errorKind, effectful };
  }
  if (AUTHORITATIVE_STATUSES.has(invocation.status)) {
    return { disposition: 'authoritative', reason: `status_${invocation.status}`, effectful };
  }
  if (unsettled) {
    // The invocation may have applied a partial effect (it threw, timed out or
    // was cut short). Replaying it could duplicate whatever it already did.
    return { disposition: 'authoritative', reason: `unsettled_effect_${effect!.status}`, effectful };
  }
  return {
    disposition: 'correctable',
    reason: invocation.status === 'timed_out'
      ? 'timed_out_settled'
      : `status_${invocation.status}`,
    effectful,
  };
}

export interface ToolRoundFailurePolicy {
  /** Withhold tools and force one final answer: the boundary is authoritative. */
  forceFinalResponse: boolean;
  /**
   * Runtime control text to persist, when the model has to be told something
   * about the failures before it decides what to do next.
   */
  controlMessage?: string;
}

/**
 * What one tool round's failures mean for the loop, as a pure decision.
 *
 * Kept here rather than inline in the loop for two reasons: the loop stays a
 * loop, and the rule is testable on its own. `messages` is the loop's
 * Runtime-control text (`RUNTIME_CONTROL_MESSAGES`).
 */
export function toolRoundFailurePolicy(
  ctx: RunContext,
  results: readonly ToolResult[],
  messages: { readonly boundaryFailure: string; readonly effectfulFailure: string },
): ToolRoundFailurePolicy {
  const classifications = results
    .filter((result) => !result.ok)
    .map((result) => classifyToolFailure(ctx, result));
  if (classifications.some((entry) => entry.disposition === 'authoritative')) {
    return { forceFinalResponse: true, controlMessage: messages.boundaryFailure };
  }
  if (classifications.some((entry) => entry.effectful)) {
    // A failed effectful call may already have written something: a command that
    // exits non-zero after creating a file is not a call that did nothing. The
    // Runtime does not replay it and says so, so the model observes the actual
    // state before deciding what to do next.
    return { forceFinalResponse: false, controlMessage: messages.effectfulFailure };
  }
  return { forceFinalResponse: false };
}
