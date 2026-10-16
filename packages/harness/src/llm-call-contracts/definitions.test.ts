import { describe, expect, it } from 'vitest';
import { LLM_CALL_CONTRACT_TEMPLATES } from './definitions.js';
import { LlmCallContractViolationError, resolveLlmCallContract } from './registry.js';

describe('LLM call contract definitions', () => {
  it('limits session compaction to a summary with no durable-memory intent', () => {
    const contract = LLM_CALL_CONTRACT_TEMPLATES.session_compaction;

    expect(contract.goal({} as never)).toBe('Merge older transcript evidence into a versioned session summary.');
    expect(contract.allowedDecisions).toEqual(['produce_summary']);
    expect(contract.outputSchema).toMatchObject({
      kind: 'json',
      schemaId: 'session-compaction-summary.v1',
      strict: true,
    });
    expect(contract.memoryIntents).toEqual(['none']);
    expect(contract.requiresMemoryEvidence).toBe(false);
    expect(contract.writableBranches).toBeUndefined();
  });

  it('does not register a model verification contract for new runs', () => {
    expect(LLM_CALL_CONTRACT_TEMPLATES).not.toHaveProperty('verify');
    expect(LLM_CALL_CONTRACT_TEMPLATES.decide?.allowedDecisions).not.toContain('partial_replan');
    expect(() => resolveLlmCallContract({ tools: [] } as never, 'verify'))
      .toThrow(LlmCallContractViolationError);
  });
});
