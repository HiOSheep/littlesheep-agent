import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  inspectStageTransition,
  renderStageTransitionGraph,
  stageNames,
  stageTransitionEdges,
} from './stage-transitions.js';

describe('Core Flow transition manifest', () => {
  it('covers every stage and always exposes a terminal exit edge', () => {
    expect(Object.keys(allowedTransitions).sort()).toEqual([...stageNames].sort());
    for (const stage of stageNames) expect(allowedTransitions[stage]).toContain('exit');
  });

  it('accepts the supported recovery and re-plan edges', () => {
    expect(inspectStageTransition('execute', 'recover')).toEqual({ ok: true, next: 'recover' });
    expect(inspectStageTransition('execute', 'finalize')).toEqual({ ok: true, next: 'finalize' });
    // A partial re-plan re-enters the main loop: DECIDE is not registered.
    expect(inspectStageTransition('verify', 'execute')).toEqual({ ok: true, next: 'execute' });
    // The DECIDE edge survives only so older persisted records stay readable.
    expect(inspectStageTransition('verify', 'decide')).toEqual({ ok: true, next: 'decide' });
    expect(inspectStageTransition('recover', 'ask_user')).toEqual({ ok: true, next: 'ask_user' });
  });

  it('rejects an edge absent from the manifest with the allowed targets', () => {
    const result = inspectStageTransition('finalize', 'reply');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toMatchObject({ from: 'finalize', attempted: 'reply' });
    expect(result.violation.allowed).toEqual(['exit']);
  });

  it('produces a deterministic edge list and Mermaid graph', () => {
    const edges = stageTransitionEdges();
    expect(edges[0]).toEqual({ from: 'enter', to: 'classify' });
    expect(edges).toContainEqual({ from: 'finalize', to: 'exit' });
    expect(renderStageTransitionGraph()).toContain('stateDiagram-v2');
    expect(renderStageTransitionGraph()).toContain('verify --> decide');
  });
});
