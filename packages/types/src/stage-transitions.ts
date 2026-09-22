import type { StageName } from './agent.js';

/** Terminal exit is available from every stage as the bounded abort path. */
export type StageTransitionTarget = StageName | 'exit';

export type StageTransitionManifest = Readonly<Record<StageName, readonly StageTransitionTarget[]>>;

const targets = (...values: StageTransitionTarget[]): readonly StageTransitionTarget[] => Object.freeze(values);

/**
 * The single source of truth for Core Flow edges.
 *
 * `exit` is intentionally present for every stage: Runtime control events,
 * stage exceptions and provider failures must always have a terminal escape.
 *
 * Edges into `decide`, `evolve` and `capture` are historical. Those stages are
 * no longer registered, so no live route may target them; the edges stay only so
 * records written before the second execution system was deleted keep parsing.
 * The driver validates every real transition with `inspectStageTransition`, and
 * `@littlesheep/harness` guards its routing sources against naming a stage the
 * registry does not contain.
 */
export const allowedTransitions: StageTransitionManifest = Object.freeze({
  enter: targets('classify', 'exit'),
  classify: targets('decide', 'execute', 'reply', 'ask_user', 'exit'),
  decide: targets('execute', 'ask_user', 'finalize', 'recover', 'exit'),
  // Custom lightweight EXECUTE stages may already own a verified reply and
  // therefore use the compatibility shortcut directly to FINALIZE.
  execute: targets('verify', 'recover', 'decide', 'finalize', 'exit'),
  recover: targets('classify', 'decide', 'execute', 'verify', 'reply', 'ask_user', 'finalize', 'exit'),
  // `execute` carries the live partial re-plan back into the one main loop.
  // `decide` and `capture` stay listed for older persisted records only; no
  // registered stage routes there any more.
  verify: targets('execute', 'capture', 'recover', 'decide', 'ask_user', 'finalize', 'exit'),
  // `evolve` is retained only so persisted records from older runs can still be
  // read and replayed; the stage is no longer registered or reachable.
  evolve: targets('capture', 'exit'),
  capture: targets('finalize', 'exit'),
  reply: targets('verify', 'finalize', 'exit'),
  ask_user: targets('finalize', 'exit'),
  finalize: targets('exit'),
});

/** Stable stage ordering shared by checkpoint readers and graph tooling. */
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

export function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && stageNameSet.has(value as StageName);
}

export function isAllowedTransition(from: StageName, to: unknown): to is StageTransitionTarget {
  return allowedTransitions[from].includes(to as StageTransitionTarget);
}

export interface StageTransitionViolation {
  from: StageName;
  attempted: unknown;
  allowed: readonly StageTransitionTarget[];
}

export function inspectStageTransition(
  from: StageName,
  to: unknown,
): { ok: true; next: StageTransitionTarget } | { ok: false; violation: StageTransitionViolation } {
  if (isAllowedTransition(from, to)) return { ok: true, next: to };
  return {
    ok: false,
    violation: {
      from,
      attempted: to,
      allowed: allowedTransitions[from],
    },
  };
}

export interface StageTransitionEdge {
  from: StageName;
  to: StageTransitionTarget;
}

export function stageTransitionEdges(
  manifest: StageTransitionManifest = allowedTransitions,
): readonly StageTransitionEdge[] {
  return Object.freeze(stageNames.flatMap((from) => manifest[from].map((to) => ({ from, to }))));
}

/** Render the manifest as a Mermaid state graph for navigation docs/tooling. */
export function renderStageTransitionGraph(
  manifest: StageTransitionManifest = allowedTransitions,
): string {
  const lines = ['stateDiagram-v2'];
  for (const { from, to } of stageTransitionEdges(manifest)) {
    lines.push(`  ${from} --> ${to}`);
  }
  return lines.join('\n');
}
