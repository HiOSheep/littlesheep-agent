// Positive and negative oracle tests for the four V2 tasks. Every negative case
// constructs genuinely wrong data/fields/mechanism facts; success samples alone
// are not sufficient evidence that the oracles detect defects.
import { describe, expect, it } from 'vitest';
import { loadTaskSuite, taskById } from './tasks.mjs';
import {
  evaluateDeliv01Goal, evaluateDeliv01Mechanism, evaluateFile02Contract, evaluateFile02Goal, evaluateTask,
} from './oracles.mjs';

const loaded = loadTaskSuite();
const file02g = taskById(loaded, 'FILE-02-G');
const file02s = taskById(loaded, 'FILE-02-S');
const deliv01g = taskById(loaded, 'DELIV-01-G');
const deliv01r = taskById(loaded, 'DELIV-01-R');
const canonical = JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }, null, 2);
const files02 = ['inventory.csv', 'inventory-summary.json'];
const contents02 = (value) => ({ 'inventory.csv': 'sku,qty\nB,3\nA,2\n', 'inventory-summary.json': value });
const files01 = ['result.txt'];
const contents01 = (value = 'verified-output') => ({ 'result.txt': value });

function summarize(dimension) {
  return { status: dimension.status, refs: dimension.evidenceRefs.length, reasons: dimension.rejectionReasons };
}

describe('FILE-02 goal oracle', () => {
  it('accepts the canonical semantic result with direct file evidence', () => {
    const result = evaluateFile02Goal({ task: file02g, files: files02, contents: contents02(canonical) });
    expect(summarize(result)).toMatchObject({ status: 'passed', refs: 2 });
    expect(result.evidenceRefs.every((ref) => ref.startsWith('workspace://'))).toBe(true);
    expect(result.files).toEqual(['inventory-summary.json', 'inventory.csv']);
  });

  it('accepts the documented equivalent total-field spellings (goal is not a format checker)', () => {
    const totalQuantity = JSON.stringify({ totalQuantity: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] });
    const snake = JSON.stringify({ total_quantity: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] });
    expect(evaluateFile02Goal({ task: file02g, files: files02, contents: contents02(totalQuantity) }).status).toBe('passed');
    expect(evaluateFile02Goal({ task: file02g, files: files02, contents: contents02(snake) }).status).toBe('passed');
  });

  it('detects wrong total, wrong items, wrong order, wrong types and conflicting fields', () => {
    const cases = [
      JSON.stringify({ total: 4, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'C', qty: 3 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'B', qty: 3 }, { sku: 'A', qty: 2 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'A', qty: '2' }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 5, totalQuantity: 4, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2 }] }),
      'not json',
    ];
    for (const value of cases) {
      const result = evaluateFile02Goal({ task: file02g, files: files02, contents: contents02(value) });
      expect(result.status, value).toBe('failed');
      expect(result.rejectionReasons.length, value).toBeGreaterThan(0);
    }
  });

  it('detects missing artifacts, extra files and a missing output file', () => {
    expect(evaluateFile02Goal({ task: file02g, files: ['inventory.csv'], contents: { 'inventory.csv': contents02('{}')['inventory.csv'] } }).status).toBe('failed');
    expect(evaluateFile02Goal({ task: file02g, files: [...files02, 'extra.json'], contents: contents02(canonical) }).status).toBe('failed');
    expect(evaluateFile02Goal({ task: file02g, files: files02, contents: contents02('{}') }).status).toBe('failed');
  });
});

describe('FILE-02 contract oracle', () => {
  it('passes the exact visible schema and reports the constraint reference', () => {
    const result = evaluateFile02Contract({ task: file02s, files: files02, contents: contents02(canonical) });
    expect(result.status).toBe('passed');
    expect(result.constraintVisible).toBe(true);
    expect(result.constraintRef).toBe('#/contracts/file02s');
  });

  it('fails on a wrong field name while leaving the goal dimension independently passed', () => {
    const wrongField = JSON.stringify({ total_quantity: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }, null, 2);
    const goal = evaluateFile02Goal({ task: file02s, files: files02, contents: contents02(wrongField) });
    const contract = evaluateFile02Contract({ task: file02s, files: files02, contents: contents02(wrongField) });
    expect(goal.status).toBe('passed');
    expect(contract.status).toBe('failed');
    expect(contract.rejectionReasons.join(' ')).toMatch(/total/i);
  });

  it('detects extra fields, wrong type, wrong value, extra item fields and wrong order', () => {
    const cases = [
      JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }], note: 'x' }),
      JSON.stringify({ total: '5', items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 6, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'A', qty: 2, unit: 'x' }, { sku: 'B', qty: 3 }] }),
      JSON.stringify({ total: 5, items: [{ sku: 'B', qty: 3 }, { sku: 'A', qty: 2 }] }),
      JSON.stringify({ total: 5 }),
    ];
    for (const value of cases) {
      expect(evaluateFile02Contract({ task: file02s, files: files02, contents: contents02(value) }).status, value).toBe('failed');
    }
  });
});

describe('DELIV-01 goal oracle', () => {
  it('accepts a first-call-correct delivery with exactly one settled effect', () => {
    const result = evaluateDeliv01Goal({
      task: deliv01g, files: files01, contents: contents01(), successfulExecutions: 1, duplicateSuccessfulEffects: 0, toolName: 'fixture_write_exact',
    });
    expect(result.status).toBe('passed');
    expect(result.evidenceRefs).toHaveLength(1);
  });

  it('detects wrong content, extra files, duplicate executions and wrong tool', () => {
    expect(evaluateDeliv01Goal({ task: deliv01g, files: files01, contents: contents01('wrong'), successfulExecutions: 1, duplicateSuccessfulEffects: 0, toolName: 'fixture_write_exact' }).status).toBe('failed');
    expect(evaluateDeliv01Goal({ task: deliv01g, files: [...files01, 'extra.txt'], contents: contents01(), successfulExecutions: 1, duplicateSuccessfulEffects: 0, toolName: 'fixture_write_exact' }).status).toBe('failed');
    expect(evaluateDeliv01Goal({ task: deliv01g, files: files01, contents: contents01(), successfulExecutions: 2, duplicateSuccessfulEffects: 1, toolName: 'fixture_write_exact' }).status).toBe('failed');
    expect(evaluateDeliv01Goal({ task: deliv01g, files: files01, contents: contents01(), successfulExecutions: 1, duplicateSuccessfulEffects: 0, toolName: 'write' }).status).toBe('failed');
  });
});

describe('DELIV-01 mechanism oracle', () => {
  const invoked = (status, errorKind, callId) => ({ toolName: 'fixture_write_exact', status, ...(errorKind ? { errorKind } : {}), callId });

  it('reports not_exercised (not failed) when no validation error occurred', () => {
    const result = evaluateDeliv01Mechanism({
      task: deliv01r, invocations: [invoked('succeeded', null, 'first')], successfulExecutions: 1, duplicateSuccessfulEffects: 0,
    });
    expect(result.status).toBe('not_exercised');
    expect(result.triggered).toBe(false);
  });

  it('passes a genuine validation feedback plus one corrected execution', () => {
    const result = evaluateDeliv01Mechanism({
      task: deliv01r, invocations: [invoked('validation_failed', 'input_validation', 'bad'), invoked('succeeded', null, 'good')], successfulExecutions: 1, duplicateSuccessfulEffects: 0,
    });
    expect(result.status).toBe('passed');
    expect(result.triggered).toBe(true);
    expect(result.evidenceRefs.some((ref) => ref.includes('validation_failed'))).toBe(true);
  });

  it('fails when triggered but not recovered, or when recovery duplicates effects', () => {
    const notRecovered = evaluateDeliv01Mechanism({
      task: deliv01r, invocations: [invoked('validation_failed', 'input_validation', 'bad')], successfulExecutions: 0, duplicateSuccessfulEffects: 0,
    });
    expect(notRecovered.status).toBe('failed');
    const duplicated = evaluateDeliv01Mechanism({
      task: deliv01r,
      invocations: [invoked('validation_failed', 'input_validation', 'bad'), invoked('succeeded', null, 'one'), invoked('succeeded', null, 'two')],
      successfulExecutions: 2,
      duplicateSuccessfulEffects: 1,
    });
    expect(duplicated.status).toBe('failed');
    expect(duplicated.rejectionReasons.join(' ')).toMatch(/execution|duplicate/i);
  });

  it('reports blocked when the permission boundary blocked the tool', () => {
    const result = evaluateDeliv01Mechanism({
      task: deliv01r, invocations: [invoked('denied', null, 'denied')], successfulExecutions: 0, duplicateSuccessfulEffects: 0,
    });
    expect(result.status).toBe('blocked');
    expect(result.triggered).toBe(true);
    expect(result.blockReason).toMatch(/permission or execution boundary/);
  });
});

describe('task dispatcher keeps dimensions independent', () => {
  it('settles a wrong FILE-02 field as goal passed / contract failed in one run', () => {
    const wrongField = JSON.stringify({ total_quantity: 5, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }] });
    const dimensions = evaluateTask(file02s, { files: files02, contents: contents02(wrongField) });
    expect(dimensions.goal.status).toBe('passed');
    expect(dimensions.contract.status).toBe('failed');
    expect(dimensions.mechanism.status).toBe('not_exercised');
  });

  it('keeps goal failure and mechanism success separate', () => {
    const dimensions = evaluateTask(deliv01r, {
      files: files01,
      contents: contents01('wrong'),
      successfulExecutions: 1,
      duplicateSuccessfulEffects: 0,
      invocations: [
        { toolName: 'fixture_write_exact', status: 'validation_failed', errorKind: 'input_validation', callId: 'bad' },
        { toolName: 'fixture_write_exact', status: 'succeeded', callId: 'good' },
      ],
    });
    expect(dimensions.goal.status).toBe('failed');
    expect(dimensions.mechanism.status).toBe('passed');
  });

  it('records not_exercised for goal-only tasks and for a fault fixture that never fired', () => {
    const fileGoal = evaluateTask(file02g, { files: files02, contents: contents02(canonical) });
    expect(fileGoal.contract.status).toBe('not_applicable');
    expect(fileGoal.mechanism.status).toBe('not_exercised');
    const noFault = evaluateTask(deliv01r, {
      files: files01, contents: contents01(), successfulExecutions: 1, duplicateSuccessfulEffects: 0,
      invocations: [{ toolName: 'fixture_write_exact', status: 'succeeded', callId: 'first' }],
    });
    expect(noFault.goal.status).toBe('passed');
    expect(noFault.mechanism.status).toBe('not_exercised');
  });
});
