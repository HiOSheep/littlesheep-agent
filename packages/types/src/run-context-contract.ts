// @littlesheep/types - machine-readable ownership and lifecycle contracts for high-churn RunContext fields.
import type { RunContext, StageName } from './agent.js';

export type RunContextFieldGroup = 'reply' | 'replan' | 'runtimeControl' | 'memory';
export type RunContextLifecycle = 'run-local' | 'checkpoint-carried' | 'session-persisted';
export type RunContextContractStage = StageName | 'runner-init' | 'runner-restore' | 'runtime-boundary' | 'post-run';

export interface RunContextFieldContract {
  field: keyof RunContext & string;
  group: RunContextFieldGroup;
  owner: string;
  readStages: readonly RunContextContractStage[];
  writeStages: readonly RunContextContractStage[];
  lifecycle: RunContextLifecycle;
  purpose: string;
}

const field = (
  definition: RunContextFieldContract,
): Readonly<RunContextFieldContract> => Object.freeze({
  ...definition,
  readStages: Object.freeze([...definition.readStages]),
  writeStages: Object.freeze([...definition.writeStages]),
});

const coreStages: readonly StageName[] = Object.freeze([
  'enter', 'classify', 'decide', 'execute', 'recover', 'verify',
  'evolve', 'capture', 'reply', 'ask_user', 'finalize',
]);

/**
 * Machine-readable ownership for the four high-churn RunContext domains.
 * This is deliberately additive: existing callers can keep using RunContext,
 * while new code can validate a write before mutating a shared field.
 */
export const runContextFieldOwnership: readonly RunContextFieldContract[] = Object.freeze([
  field({
    field: 'reply',
    group: 'reply',
    owner: 'user-facing-reply-boundary',
    readStages: ['verify', 'finalize', 'capture', 'post-run'],
    writeStages: ['decide', 'execute', 'recover', 'reply', 'ask_user', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Provisional and approved user-facing text; publish only after provenance and duplicate checks.',
  }),
  field({
    field: 'replyProvenance',
    group: 'reply',
    owner: 'user-facing-reply-boundary',
    readStages: ['verify', 'finalize', 'post-run'],
    writeStages: ['decide', 'execute', 'recover', 'reply', 'ask_user', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Binds visible reply text to the real model request that produced it.',
  }),
  field({
    field: 'usage',
    group: 'reply',
    owner: 'model-observability',
    readStages: ['finalize', 'post-run'],
    writeStages: ['classify', 'decide', 'execute', 'evolve', 'capture', 'reply', 'ask_user'],
    lifecycle: 'run-local',
    purpose: 'Provider-reported token usage for the reply-bearing call.',
  }),
  field({
    field: 'taskBook',
    group: 'replan',
    owner: 'decide-taskbook-boundary',
    readStages: ['decide', 'execute', 'verify', 'evolve', 'capture', 'finalize', 'runner-restore'],
    writeStages: ['decide', 'execute', 'recover', 'runtime-boundary', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Authoritative normalized task contract; model output is only a proposal; EXECUTE adds step evidence to stageResults.',
  }),
  field({
    field: 'plan',
    group: 'replan',
    owner: 'decide-taskbook-boundary',
    readStages: ['decide', 'execute', 'verify', 'recover', 'finalize', 'runner-restore'],
    writeStages: ['decide', 'recover', 'runtime-boundary', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Execution projection of the current TaskBook revision.',
  }),
  field({
    field: 'taskBookRevision',
    group: 'replan',
    owner: 'decide-taskbook-boundary',
    readStages: ['decide', 'execute', 'runtime-boundary', 'runner-restore'],
    writeStages: ['decide', 'runtime-boundary', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Monotonic revision used to reject stale task updates.',
  }),
  field({
    field: 'taskExecution',
    group: 'replan',
    owner: 'execute-taskbook-boundary',
    readStages: ['execute', 'verify', 'evolve', 'capture', 'finalize', 'runner-restore'],
    writeStages: ['execute', 'verify', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Step-level execution evidence and status, including the VERIFY-owned replan history projection.',
  }),
  field({
    field: 'replanAttempts',
    group: 'replan',
    owner: 'verify-replan-boundary',
    readStages: ['verify', 'decide', 'runner-restore'],
    writeStages: ['verify', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Bounded partial re-plan counter.',
  }),
  field({
    field: 'verifyFeedback',
    group: 'replan',
    owner: 'verify-replan-boundary',
    readStages: ['decide', 'runner-restore'],
    writeStages: ['verify', 'decide', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Structured failure feedback consumed by the next DECIDE pass.',
  }),
  field({
    field: 'partialReplanRequest',
    group: 'replan',
    owner: 'verify-replan-boundary',
    readStages: ['decide', 'execute', 'verify', 'runner-restore'],
    writeStages: ['verify', 'decide', 'execute', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Step-scoped re-plan request; completed sibling evidence is preserved.',
  }),
  field({
    field: 'replanHistory',
    group: 'replan',
    owner: 'verify-replan-boundary',
    readStages: ['decide', 'execute', 'verify', 'finalize', 'runner-restore'],
    writeStages: ['verify', 'decide', 'execute', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Bounded audit trail for re-plan decisions and resumed steps.',
  }),
  field({
    field: 'appliedTaskBookPatchIds',
    group: 'replan',
    owner: 'runtime-taskbook-boundary',
    readStages: ['runtime-boundary', 'decide', 'execute', 'runner-restore'],
    writeStages: ['runtime-boundary', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Bounded idempotency ledger for runtime TaskBook patches.',
  }),
  field({
    field: 'runtimeControl',
    group: 'runtimeControl',
    owner: 'runtime-control-boundary',
    readStages: [...coreStages, 'runner-restore'],
    writeStages: ['runtime-boundary', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Deterministic pause, interrupt and stop state consumed at safe boundaries.',
  }),
  field({
    field: 'runtimeEventQueue',
    group: 'runtimeControl',
    owner: 'runner-runtime-queue',
    readStages: ['enter', 'classify', 'decide', 'execute', 'verify', 'finalize', 'runner-restore'],
    writeStages: ['runner-init', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Run-owned queue for control and task events; payloads open only at safe boundaries.',
  }),
  field({
    field: 'deferredRuntimeEvents',
    group: 'runtimeControl',
    owner: 'runtime-control-boundary',
    readStages: ['decide', 'execute', 'runner-restore'],
    writeStages: ['runner-init', 'runtime-boundary', 'decide', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Bounded task events deferred into the next planning pass.',
  }),
  field({
    field: 'deferredRuntimeEventIds',
    group: 'runtimeControl',
    owner: 'runtime-control-boundary',
    readStages: ['decide', 'finalize', 'runner-restore'],
    writeStages: ['runner-init', 'runtime-boundary', 'decide', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Bounded settled event ids retained for audit and checkpoint continuity.',
  }),
  field({
    field: 'loopBudget',
    group: 'runtimeControl',
    owner: 'runner-runtime-budget',
    readStages: ['execute', 'recover', 'runner-restore'],
    writeStages: ['runner-init', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Provider/tool loop budget snapshot used by recovery diagnostics.',
  }),
  field({
    field: 'prelude',
    group: 'memory',
    owner: 'runner-memory-bootstrap',
    readStages: ['enter', 'classify', 'decide', 'reply', 'execute', 'runner-restore'],
    writeStages: ['runner-init', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Bounded memory bootstrap injected before the first model decision.',
  }),
  field({
    field: 'sessionSummary',
    group: 'memory',
    owner: 'runner-memory-continuity',
    readStages: ['enter', 'classify', 'decide', 'reply', 'execute', 'finalize', 'runner-restore'],
    writeStages: ['runner-init', 'runner-restore', 'post-run'],
    lifecycle: 'session-persisted',
    purpose: 'Versioned summary of older session messages; transcript remains authoritative.',
  }),
  field({
    field: 'memoryRootIndex',
    group: 'memory',
    owner: 'runner-memory-bootstrap',
    readStages: ['enter', 'classify', 'decide', 'reply', 'execute'],
    writeStages: ['runner-init', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Stable root index handle for on-demand memory navigation.',
  }),
  field({
    field: 'initialMemoryContext',
    group: 'memory',
    owner: 'runner-memory-bootstrap',
    readStages: ['enter', 'classify', 'decide', 'reply', 'execute'],
    writeStages: ['runner-init', 'decide', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Small selected memory context; full memory tree is not auto-injected.',
  }),
  field({
    field: 'memoryKnownState',
    group: 'memory',
    owner: 'memory-evidence-boundary',
    readStages: ['decide', 'execute', 'verify', 'evolve', 'capture', 'reply', 'finalize', 'runner-restore'],
    writeStages: ['runner-init', 'decide', 'execute', 'verify', 'evolve', 'capture', 'reply', 'finalize', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Evidence ledger separating adopted, excluded and conflicted memory facts.',
  }),
  field({
    field: 'memoryContinuityAssessment',
    group: 'memory',
    owner: 'finalize-memory-continuity',
    readStages: ['finalize', 'post-run'],
    writeStages: ['finalize', 'post-run', 'runner-restore'],
    lifecycle: 'session-persisted',
    purpose: 'Local evidence assessment of whether the final answer used supported memory.',
  }),
  field({
    field: 'memoryContextWorkingSet',
    group: 'memory',
    owner: 'memory-context-boundary',
    readStages: ['decide', 'execute', 'verify', 'finalize', 'runner-restore'],
    writeStages: ['runner-init', 'decide', 'execute', 'runner-restore'],
    lifecycle: 'checkpoint-carried',
    purpose: 'Run-scoped active/released atom set and model-call ownership.',
  }),
  field({
    field: 'evolutionNotes',
    group: 'memory',
    owner: 'evolve-memory-boundary',
    readStages: ['capture', 'finalize', 'post-run'],
    writeStages: ['evolve', 'runner-restore'],
    lifecycle: 'session-persisted',
    purpose: 'Bounded reusable capability notes proposed by EVOLVE.',
  }),
  field({
    field: 'insights',
    group: 'memory',
    owner: 'capture-memory-boundary',
    readStages: ['finalize', 'post-run'],
    writeStages: ['capture', 'runner-restore'],
    lifecycle: 'session-persisted',
    purpose: 'Bounded CAPTURE run facts and observations.',
  }),
  field({
    field: 'memoryIntentDecisions',
    group: 'memory',
    owner: 'memory-intent-gate',
    readStages: ['evolve', 'capture', 'finalize', 'post-run'],
    writeStages: ['evolve', 'capture', 'runner-restore'],
    lifecycle: 'run-local',
    purpose: 'Bounded audit of model memory proposals versus runtime decisions and persistence outcomes.',
  }),
]);

const fieldIndex = new Map(runContextFieldOwnership.map((definition) => [definition.field, definition]));

export function getRunContextFieldContract(fieldName: string): RunContextFieldContract | undefined {
  return fieldIndex.get(fieldName as keyof RunContext & string);
}

export function runContextFieldsForGroup(group: RunContextFieldGroup): readonly RunContextFieldContract[] {
  return runContextFieldOwnership.filter((definition) => definition.group === group);
}

export function canWriteRunContextField(
  fieldName: string,
  stage: RunContextContractStage,
): boolean {
  return getRunContextFieldContract(fieldName)?.writeStages.includes(stage) ?? false;
}

export function assertRunContextFieldWriteAllowed(
  fieldName: string,
  stage: RunContextContractStage,
): void {
  const definition = getRunContextFieldContract(fieldName);
  if (!definition) throw new Error(`Unknown RunContext contract field '${fieldName}'.`);
  if (!definition.writeStages.includes(stage)) {
    throw new Error(
      `RunContext field '${fieldName}' is owned by ${definition.owner} and cannot be written during '${stage}'. `
      + `Allowed writers: ${definition.writeStages.join(', ')}.`,
    );
  }
}
