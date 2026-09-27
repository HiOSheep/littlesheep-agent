import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  currentStageNames,
  historicalStageNames,
  historicalStageTransitions,
  inspectStageTransition,
  isCurrentStageName,
  isHistoricalStageName,
  renderHistoricalStageTransitionGraph,
  renderStageTransitionGraph,
  stageNames,
  stageTransitionEdges,
} from './stage-transitions.js';

describe('Core Flow transition manifest', () => {
  it('covers exactly the registered stages and always exposes a terminal exit edge', () => {
    expect(Object.keys(allowedTransitions).sort()).toEqual([...currentStageNames].sort());
    for (const stage of currentStageNames) expect(allowedTransitions[stage]).toContain('exit');
  });

  // The point of the split: a live edge may not lead into a stage this build cannot run, because the
  // driver would validate the jump and then have nothing to execute.
  it('never routes into a retired stage', () => {
    for (const stage of currentStageNames) {
      for (const target of allowedTransitions[stage]) {
        // xit is the terminal escape, not a stage.
        if (target === 'exit') continue;
        expect(isCurrentStageName(target)).toBe(true);
      }
    }
    for (const retired of historicalStageNames) {
      expect(isCurrentStageName(retired)).toBe(false);
      expect(isHistoricalStageName(retired)).toBe(true);
      expect(stageNames).toContain(retired);
    }
  });

  it('accepts the supported recovery and re-plan edges', () => {
    expect(inspectStageTransition('execute', 'recover')).toEqual({ ok: true, next: 'recover' });
    expect(inspectStageTransition('execute', 'finalize')).toEqual({ ok: true, next: 'finalize' });
    // A partial re-plan re-enters the main loop: DECIDE is not registered.
    expect(inspectStageTransition('verify', 'execute')).toEqual({ ok: true, next: 'execute' });
    expect(inspectStageTransition('recover', 'ask_user')).toEqual({ ok: true, next: 'ask_user' });
  });

  it('rejects a retired target from a live stage and names why', () => {
    const retiredTarget = inspectStageTransition('verify', 'decide');
    expect(retiredTarget.ok).toBe(false);
    if (!retiredTarget.ok) {
      expect(retiredTarget.violation).toMatchObject({ from: 'verify', attempted: 'decide', reason: 'not-an-edge' });
      expect(retiredTarget.violation.allowed).not.toContain('decide');
    }
  });

  it('fails closed when a retired stage tries to make a decision', () => {
    const result = inspectStageTransition('decide', 'execute');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toMatchObject({ from: 'decide', reason: 'retired-stage' });
    // The historical edges are reported for the reader, but they are not a route: normalization maps a
    // retired entry to the main loop before the driver ever inspects a transition.
    expect(result.violation.allowed).toEqual([...historicalStageTransitions.decide]);
  });

  it('rejects an edge absent from the manifest with the allowed targets', () => {
    const result = inspectStageTransition('finalize', 'reply');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violation).toMatchObject({ from: 'finalize', attempted: 'reply', reason: 'not-an-edge' });
    expect(result.violation.allowed).toEqual(['exit']);
  });

  it('produces a deterministic live edge list and Mermaid graph', () => {
    const edges = stageTransitionEdges();
    expect(edges[0]).toEqual({ from: 'enter', to: 'classify' });
    expect(edges).toContainEqual({ from: 'finalize', to: 'exit' });
    expect(edges.some((edge) => historicalStageNames.includes(edge.from as never))).toBe(false);
    const graph = renderStageTransitionGraph();
    expect(graph).toContain('stateDiagram-v2');
    expect(graph).not.toContain('verify --> decide');
    // The retired edges still render, from their own manifest, for anybody explaining an old record.
    expect(renderHistoricalStageTransitionGraph()).toContain('decide --> execute');
    expect(renderHistoricalStageTransitionGraph()).toContain('evolve --> capture');
  });
});
