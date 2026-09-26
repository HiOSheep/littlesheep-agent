// Guards the constraints the compaction prompt must state.
//
// Measured before the bound existed (see acceptance 5.49/5.50): the summary was re-emitted unbounded
// and hit the output budget, so finish_reason was 'length' and the JSON never closed — 27 of 40
// operations failed (67.5%), wasting 75.4% of all compaction prompt tokens. With the bound stated,
// failures fell to 1 of 40 (2.5%) and wasted tokens to 4.4%.
//
// RS-05 removed the second half of the old contract: the prompt no longer asks for durable memory
// candidates, so the branch/scope values it used to spell out for them are gone with them. These are
// source-level assertions because the prompt is an inline literal inside the compaction call, not an
// exported value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./session-continuity.ts', import.meta.url), 'utf8');

describe('session compaction prompt contract', () => {
  it('bounds the summary so the required output fits the token budget', () => {
    // Without a bound the summary grows until the answer is truncated mid-JSON.
    expect(source).toMatch(/keep it under \d+ characters/u);
  });

  it('asks for a summary and no durable-memory candidates', () => {
    expect(source).toContain('Return one JSON object with a `summary` field and no other required field.');
    expect(source).not.toContain('`candidates` is an array of at most 8 durable facts');
    expect(source).not.toContain('Allowed `branch` values are exactly');
    // The legacy wording that let compaction propose memory is gone from the source, not just the
    // prompt: nothing here extracts or commits candidates any more.
    expect(source).not.toContain('commitCompactionCandidate');
    expect(source).not.toContain('memoryService.write');
  });

  it('keeps the existing fidelity priorities alongside the bound', () => {
    // The bound must not displace what the summary has to preserve.
    expect(source).toContain('Preserve unfinished work, open decisions, artifact paths and exact `label: value` pairs');
  });
});
