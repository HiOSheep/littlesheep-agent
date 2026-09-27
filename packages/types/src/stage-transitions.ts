import type { StageName } from './agent.js';

/** Terminal exit is available from every stage as the bounded abort path. */
export type StageTransitionTarget = StageName | 'exit';

/** Stages the current registry contains: the ones a run may actually enter. */
export type CurrentStageName =
  | 'enter'
  | 'classify'
  | 'execute'
  | 'recover'
  | 'verify'
  | 'reply'
  | 'ask_user'
  | 'finalize';

/**
 * Stages a retired build ran and this one does not: `decide` (second executor planning), `evolve`
 * (automatic memory evolution) and `capture` (automatic settlement). Records on disk still name them, so
 * readers must recognize the names, but nothing routes here and no new decision may target them.
 */
export type HistoricalStageName = 'decide' | 'evolve' | 'capture';

export type StageTransitionManifest = Readonly<Record<StageName, readonly StageTransitionTarget[]>>;
export type CurrentStageTransitionManifest =
  Readonly<Record<CurrentStageName, readonly StageTransitionTarget[]>>;

const targets = (...values: StageTransitionTarget[]): readonly StageTransitionTarget[] => Object.freeze(values);

/**
 * The live Core Flow graph: `inspectStageTransition` validates every real transition against exactly
 * this, so a stage cannot decide to jump into a retired one.
 *
 * `exit` is intentionally present for every stage: Runtime control events, stage exceptions and provider
 * failures must always have a terminal escape. Every edge here leads to a registered stage — an edge to a
 * retired stage would be a route the driver could validate and then fail to run.
 */
export const allowedTransitions: CurrentStageTransitionManifest = Object.freeze({
  enter: targets('classify', 'exit'),
  classify: targets('execute', 'reply', 'ask_user', 'exit'),
  // Custom lightweight EXECUTE stages may already own a verified reply and therefore use the
  // compatibility shortcut directly to FINALIZE. `ask_user` is a real EXECUTE edge, not a compatibility
  // one: the model can call `request_user_input` inside the main loop. Leaving it out made a legitimate
  // question fail the whole run (measured on the 28-turn long task, turn 17: `invalid stage transition
  // 'execute' -> 'ask_user'`).
  execute: targets('verify', 'recover', 'ask_user', 'finalize', 'exit'),
  recover: targets('classify', 'execute', 'verify', 'reply', 'ask_user', 'finalize', 'exit'),
  // `execute` carries the live partial re-plan back into the one main loop.
  verify: targets('execute', 'recover', 'ask_user', 'finalize', 'exit'),
  reply: targets('verify', 'finalize', 'exit'),
  ask_user: targets('finalize', 'exit'),
  finalize: targets('exit'),
});

/**
 * Edges records were written with before the second execution system was deleted.
 *
 * This is read-path data, not a routing table: `stageTransitionEdges`/`renderStageTransitionGraph` default
 * to the live graph, and `inspectStageTransition` never consults this. It exists so tooling and tests can
 * tell "this edge is retired" from "this edge is unknown", and so a replay reader can explain an old
 * record instead of treating it as corruption.
 */
export const historicalStageTransitions: Readonly<Record<HistoricalStageName, readonly StageTransitionTarget[]>>
  = Object.freeze({
    decide: targets('execute', 'ask_user', 'finalize', 'recover', 'exit'),
    evolve: targets('capture', 'exit'),
    capture: targets('finalize', 'exit'),
  });

/** Stages in the order the current registry lists them. */
export const currentStageNames: readonly CurrentStageName[] = Object.freeze([
  'enter',
  'classify',
  'execute',
  'recover',
  'verify',
  'reply',
  'ask_user',
  'finalize',
]);

export const historicalStageNames: readonly HistoricalStageName[] = Object.freeze([
  'decide',
  'evolve',
  'capture',
]);

/**
 * Stable stage ordering shared by checkpoint readers and graph tooling, historical names included:
 * persisted transcripts and checkpoints interleave both, so a reader needs one order over all of them.
 */
export const stageNames: readonly StageName[] = Object.freeze([
  'enter',
  'classify',
  'decide',
  'execute',
  'recover',
  'verify',
  'evolve',
  'capture',
  'reply',
  'ask_user',
  'finalize',
]);

export const stageNameSet: ReadonlySet<StageName> = new Set(stageNames);
export const currentStageNameSet: ReadonlySet<CurrentStageName> = new Set(currentStageNames);

/** True for any stage name a record may contain, current or retired. */
export function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && stageNameSet.has(value as StageName);
}

/** True only for stages this build can run; a retired name is a historical value, not a route. */
export function isCurrentStageName(value: unknown): value is CurrentStageName {
  return typeof value === 'string' && currentStageNameSet.has(value as CurrentStageName);
}

export function isHistoricalStageName(value: unknown): value is HistoricalStageName {
  return typeof value === 'string' && (historicalStageNames as readonly string[]).includes(value);
}

export function isAllowedTransition(from: StageName, to: unknown): to is StageTransitionTarget {
  if (!isCurrentStageName(from)) return false;
  return allowedTransitions[from].includes(to as StageTransitionTarget);
}

export interface StageTransitionViolation {
  from: StageName;
  attempted: unknown;
  /** `retired-stage` means the record is readable but unroutable; `not-an-edge` means the jump is wrong. */
  reason: 'not-an-edge' | 'retired-stage';
  allowed: readonly StageTransitionTarget[];
}

export function inspectStageTransition(
  from: StageName,
  to: unknown,
): { ok: true; next: StageTransitionTarget } | { ok: false; violation: StageTransitionViolation } {
  if (isCurrentStageName(from)) {
    if (isAllowedTransition(from, to)) return { ok: true, next: to };
    return {
      ok: false,
      violation: { from, attempted: to, reason: 'not-an-edge', allowed: allowedTransitions[from] },
    };
  }
  // A retired stage cannot make a live decision. Normalization maps these before the loop runs, so this
  // is a fail-closed guard rather than a path: never silently continue from a stage that does not exist.
  return {
    ok: false,
    violation: {
      from,
      attempted: to,
      reason: 'retired-stage',
      allowed: historicalStageTransitions[from as HistoricalStageName] ?? [],
    },
  };
}

export interface StageTransitionEdge {
  from: StageName;
  to: StageTransitionTarget;
}

export function stageTransitionEdges(
  manifest: CurrentStageTransitionManifest = allowedTransitions,
): readonly StageTransitionEdge[] {
  return Object.freeze(currentStageNames.flatMap((from) => manifest[from].map((to) => ({ from, to }))));
}

/** Render the live manifest as a Mermaid state graph for navigation docs/tooling. */
export function renderStageTransitionGraph(
  manifest: CurrentStageTransitionManifest = allowedTransitions,
): string {
  const lines = ['stateDiagram-v2'];
  for (const { from, to } of stageTransitionEdges(manifest)) {
    lines.push(`  ${from} --> ${to}`);
  }
  return lines.join('\n');
}

/** Render the retired edges for comparison; never used to route. */
export function renderHistoricalStageTransitionGraph(): string {
  const lines = ['stateDiagram-v2'];
  for (const from of historicalStageNames) {
    for (const to of historicalStageTransitions[from]) lines.push(`  ${from} --> ${to}`);
  }
  return lines.join('\n');
}
