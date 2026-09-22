// Guards the two constraints the compaction prompt must state.
//
// Measured before they existed (see acceptance 5.49/5.50):
//   - the summary was re-emitted unbounded and hit the output budget, so
//     finish_reason was 'length' and the JSON never closed: 27 of 40 operations
//     failed (67.5%), wasting 75.4% of all compaction prompt tokens.
//   - decodeCompaction enforces allowed branch/scope values and the rule that only
//     project candidates may use workspace/project scope, but the prompt stated
//     neither, so proposals were rejected after a valid-shaped answer.
//
// With both constraints stated, failures fell to 1 of 40 (2.5%) and wasted tokens
// to 4.4%. These are source-level assertions because the prompt is an inline
// literal inside the compaction call, not an exported value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./session-continuity.ts', import.meta.url), 'utf8');

describe('session compaction prompt contract', () => {
  it('bounds the summary so the required output fits the token budget', () => {
    // Without a bound the summary grows until the answer is truncated mid-JSON.
    expect(source).toMatch(/keep it under \d+ characters/u);
  });

  it('states the branch/scope values decodeCompaction enforces', () => {
    expect(source).toContain('Allowed `branch` values are exactly: long-term, project, experience');
    expect(source).toContain('Allowed `scope` values are exactly: global, workspace, project');
    // The pairing rule that rejects a valid-shaped proposal otherwise.
    expect(source).toMatch(/ONLY when its branch is project/u);
  });

  it('keeps the existing fidelity priorities alongside the bound', () => {
    // The bound must not displace what the summary has to preserve.
    expect(source).toContain('Preserve unfinished work, open decisions, artifact paths and exact `label: value` pairs');
  });
});
