import { describe, expect, it } from 'vitest';
import { isAllowedTransition, isCurrentStageName } from '../packages/types/src/stage-transitions.ts';
import {
  admittedIntoContext,
  assertCurrentTrace,
  assertMemoryEnteredContext,
} from './lib/memory-v3-provider-acceptance-contract.mjs';

const currentStageGraph = { isAllowedTransition, isCurrentStageName };

function assertTrace(log) {
  assertCurrentTrace(log, currentStageGraph);
}

function trace(...names) {
  return names.map((name) => ({ name, ok: true }));
}

describe('Memory v3 Provider acceptance contract', () => {
  it('accepts legal paths in the current seven-stage graph without requiring every optional stage', () => {
    expect(() => assertTrace({ trace: trace('enter', 'classify', 'execute', 'finalize') })).not.toThrow();
    expect(() => assertTrace({
      trace: trace('enter', 'classify', 'execute', 'recover', 'execute', 'ask_user', 'finalize'),
    })).not.toThrow();
  });

  it.each(['decide', 'verify', 'evolve', 'capture'])('rejects retired stage %s', (retired) => {
    expect(() => assertTrace({ trace: trace('enter', retired, 'finalize') }))
      .toThrow(`retired stage '${retired}'`);
  });

  it('rejects transitions outside the current graph', () => {
    expect(() => assertTrace({ trace: trace('enter', 'classify', 'finalize') }))
      .toThrow(/illegal transition 'classify' -> 'finalize'/);
  });

  it('still fails when recall lacks memory ledger or KnownState admission evidence', () => {
    const ledgerOnly = {
      memoryAccess: { records: [{ action: 'branch-index', status: 'admitted', tokensUsed: 24, fragmentIds: ['atom-1'] }] },
      memoryKnownState: { references: [] },
    };
    const completeEvidence = {
      ...ledgerOnly,
      memoryKnownState: { references: [{ atomId: 'atom-1', decision: 'adopted' }] },
    };

    expect(admittedIntoContext({}, ['atom-1']).admittedAtomIds).toEqual([]);
    expect(() => assertMemoryEnteredContext({}, ['atom-1'], 'recall')).toThrow(/admitted none/);
    expect(() => assertMemoryEnteredContext(ledgerOnly, ['atom-1'], 'recall')).toThrow(/admitted none/);
    expect(assertMemoryEnteredContext(completeEvidence, ['atom-1'], 'recall')).toMatchObject({
      admittedAtomIds: ['atom-1'],
      stages: ['branch-index'],
    });
  });
});