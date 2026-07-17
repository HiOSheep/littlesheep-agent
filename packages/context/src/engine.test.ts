import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  type ContextItemKind,
  type LlmCallContract,
} from '@littlesheep/types';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import {
  ContextBudgetExceededError,
  ContextContractViolationError,
  ContextEngine,
  type ContextMessageCandidate,
  type ExactContextTokenCounter,
} from './engine.js';

const lengthCounter: ExactContextTokenCounter = {
  id: 'deterministic-test-counter-v1',
  supports: () => true,
  countRequest: (request) => request.messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length;
    return total + message.content.reduce(
      (sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length),
      0,
    );
  }, 0),
};

const exactLengthCapability = () => ({
  status: 'exact' as const,
  counterId: lengthCounter.id,
  requestFormat: 'openai-compatible-chat-completions' as const,
  source: 'builtin-model-registry' as const,
  verifiedAt: '2026-07-13',
});

function candidate(
  id: string,
  order: number,
  content: string,
  options: { required?: boolean; priority?: number; kind?: ContextItemKind; role?: ChatMessage['role'] } = {},
): ContextMessageCandidate {
  const role = options.role ?? 'user';
  return {
    id,
    order,
    message: { role, content },
    kind: options.kind ?? (role === 'system' ? 'system_prompt' : 'recent_message'),
    source: { kind: role === 'system' ? 'prompt' : 'message', id },
    priority: options.priority ?? 50,
    required: options.required ?? false,
    sensitive: true,
  };
}

function baseRequest(messages: ChatMessage[] = []): ChatRequest {
  return { model: 'gpt-test', messages, temperature: 0, max_tokens: 10 };
}

function callContract(
  allowedContextKinds: ContextItemKind[],
  requiredContextKinds: ContextItemKind[],
): LlmCallContract {
  return {
    version: 1,
    id: 'test/reply@1',
    purpose: 'reply',
    stage: 'reply',
    modelCall: 'required',
    goal: 'test context filtering',
    inputs: {
      sourcePolicy: 'explicit_candidates_only',
      allowedContextKinds,
      requiredContextKinds,
      history: 'none',
      attachments: 'none',
    },
    allowedDecisions: ['respond'],
    outputSchema: { kind: 'text', schemaId: 'test.v1', strict: false, description: 'test' },
    memoryIntentPolicy: {
      allowed: ['none'],
      defaultIntent: 'none',
      commitAuthority: 'runtime_only',
      requiresEvidence: true,
    },
    toolPolicy: {
      mode: 'none',
      allowedToolNames: [],
      runtimeApprovalRequired: false,
      maxIterations: 0,
    },
    budget: { maxAttempts: 1, maxOutputTokens: 10 },
  };
}

describe('ContextEngine', () => {
  it('assembles explicit candidates in deterministic order and records a known window', () => {
    const engine = new ContextEngine({
      resolveContextWindow: () => ({ maxContextTokens: 1_000, source: 'builtin-model-registry' }),
    });
    const result = engine.prepare({
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [
        candidate('current', 20, 'current', { required: true, priority: 90 }),
        candidate('system', 0, 'system', { required: true, priority: 100, role: 'system' }),
        candidate('history', 10, 'history'),
      ],
    });

    expect(result.request.messages.map((message) => message.content)).toEqual(['system', 'history', 'current']);
    expect(result.contextSnapshot.budget).toEqual({
      status: 'known',
      maxContextTokens: 1_000,
      reservedOutputTokens: 10,
      availablePromptTokens: 990,
      compressionThresholdRatio: 0.8,
    });
    expect(result.contextSnapshot.localTokenLedger).toMatchObject({ accuracy: 'unavailable' });
    expect(result.modelRequestSnapshot.contextSnapshotId).toBe(result.contextSnapshot.id);
    expect(result.contextSnapshot.safetyEstimate).toMatchObject({
      accuracy: 'conservative',
      purpose: 'overflow_protection',
      displayable: false,
    });
  });

  it('uses exact counting to omit the lowest-priority optional context before sending', () => {
    const engine = new ContextEngine({
      tokenCounter: lengthCounter,
      resolveContextWindow: () => ({ maxContextTokens: 50, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: exactLengthCapability,
    });
    const result = engine.prepare({
      runId: 'run-2',
      sessionId: asSessionId('session-2'),
      stage: 'decide',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [
        candidate('system', 0, 's'.repeat(15), { required: true, priority: 100, role: 'system' }),
        candidate('old-history', 10, 'h'.repeat(15), { priority: 10 }),
        candidate('current', 20, 'u'.repeat(25), { required: true, priority: 90, kind: 'user_input' }),
      ],
    });

    expect(result.omittedCandidateIds).toEqual(['old-history']);
    expect(result.request.messages).toHaveLength(2);
    expect(result.contextSnapshot.localTokenLedger).toMatchObject({
      accuracy: 'exact',
      tokenizerId: lengthCounter.id,
      promptTokens: 40,
    });
    expect(result.contextSnapshot.items.find((item) => item.id === 'old-history')).toMatchObject({
      disposition: 'omitted',
      omissionReason: 'budget',
    });
    expect(result.compressionRecommended).toBe(true);
    expect(result.contextSnapshot.compressionRecommended).toBe(true);
  });

  it('fails closed when required context alone exceeds an exact known budget', () => {
    const engine = new ContextEngine({
      tokenCounter: lengthCounter,
      resolveContextWindow: () => ({ maxContextTokens: 30, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: exactLengthCapability,
    });

    expect(() => engine.prepare({
      runId: 'run-3',
      sessionId: asSessionId('session-3'),
      stage: 'execute',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [candidate('required', 0, 'x'.repeat(25), { required: true })],
    })).toThrow(ContextBudgetExceededError);
  });

  it('tracks and omits optional segments inside one outbound system message', () => {
    const engine = new ContextEngine({
      tokenCounter: lengthCounter,
      resolveContextWindow: () => ({ maxContextTokens: 40, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: exactLengthCapability,
    });
    const system: ContextMessageCandidate = {
      id: 'system',
      order: 0,
      message: { role: 'system', content: `${'s'.repeat(15)}${'b'.repeat(20)}` },
      kind: 'system_prompt',
      source: { kind: 'prompt', id: 'system' },
      priority: 100,
      required: true,
      sensitive: true,
      segments: [
        {
          id: 'system:policy',
          order: 0,
          text: 's'.repeat(15),
          kind: 'system_prompt',
          source: { kind: 'prompt', id: 'policy' },
          priority: 100,
          required: true,
          sensitive: true,
          scope: 'global',
        },
        {
          id: 'system:bootstrap',
          order: 1,
          text: 'b'.repeat(20),
          kind: 'project_knowledge',
          source: { kind: 'prompt', id: 'AGENTS.md', path: 'AGENTS.md' },
          priority: 40,
          required: false,
          sensitive: true,
          scope: 'workspace',
        },
      ],
    };
    const result = engine.prepare({
      runId: 'run-segments',
      sessionId: asSessionId('session-segments'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [
        system,
        candidate('current', 10, 'u'.repeat(15), { required: true, kind: 'user_input' }),
      ],
    });

    expect(result.omittedCandidateIds).toEqual(['system:bootstrap']);
    expect(result.request.messages[0]?.content).toBe('s'.repeat(15));
    expect(result.contextSnapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'system:policy', scope: 'global', disposition: 'included' }),
      expect.objectContaining({
        id: 'system:bootstrap',
        kind: 'project_knowledge',
        scope: 'workspace',
        disposition: 'omitted',
        omissionReason: 'budget',
      }),
    ]));
  });

  it('filters optional Context and system-prompt segments through the call contract', () => {
    const engine = new ContextEngine({ resolveContextWindow: () => undefined });
    const system: ContextMessageCandidate = {
      id: 'system',
      order: 0,
      message: { role: 'system', content: 'policyworkspace' },
      kind: 'system_prompt',
      source: { kind: 'prompt', id: 'system' },
      priority: 100,
      required: true,
      sensitive: true,
      segments: [
        {
          id: 'policy', order: 0, text: 'policy', kind: 'system_prompt',
          source: { kind: 'prompt', id: 'policy' }, priority: 100,
          required: true, sensitive: true, scope: 'global',
        },
        {
          id: 'workspace', order: 1, text: 'workspace', kind: 'project_knowledge',
          source: { kind: 'configuration', id: 'workspace' }, priority: 50,
          required: false, sensitive: true, scope: 'workspace',
        },
      ],
    };
    const result = engine.prepare({
      runId: 'run-contract-filter',
      sessionId: asSessionId('session-contract-filter'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      callContract: callContract(['system_prompt', 'user_input'], ['system_prompt', 'user_input']),
      candidates: [
        system,
        candidate('history', 5, 'history', { kind: 'recent_message' }),
        candidate('current', 10, 'current', { required: true, kind: 'user_input' }),
      ],
    });

    expect(result.request.messages.map((message) => message.content)).toEqual(['policy', 'current']);
    expect(result.contextSnapshot.items.map((item) => item.id)).toEqual(['policy', 'current']);
    expect(result.modelRequestSnapshot.callContract?.id).toBe('test/reply@1');
    expect(Object.isFrozen(result.modelRequestSnapshot.callContract)).toBe(true);
  });

  it('rejects required forbidden or missing Context with an explicit contract error', () => {
    const engine = new ContextEngine({ resolveContextWindow: () => undefined });
    const contract = callContract(['system_prompt', 'user_input'], ['system_prompt', 'user_input']);

    expect(() => engine.prepare({
      runId: 'run-contract-forbidden',
      sessionId: asSessionId('session-contract-forbidden'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      callContract: contract,
      candidates: [
        candidate('system', 0, 'system', { required: true, role: 'system' }),
        candidate('tool', 1, 'tool', { required: true, kind: 'tool_result', role: 'tool' }),
        candidate('current', 2, 'current', { required: true, kind: 'user_input' }),
      ],
    })).toThrow(ContextContractViolationError);

    expect(() => engine.prepare({
      runId: 'run-contract-missing',
      sessionId: asSessionId('session-contract-missing'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      callContract: contract,
      candidates: [candidate('system', 0, 'system', { required: true, role: 'system' })],
    })).toThrow(/required Context kind user_input is absent/);
  });

  it('keeps unknown models explicit instead of inventing a context window', () => {
    const engine = new ContextEngine({ resolveContextWindow: () => undefined });
    const result = engine.prepare({
      runId: 'run-4',
      sessionId: asSessionId('session-4'),
      stage: 'classify',
      requestIndex: 1,
      provider: 'custom',
      request: baseRequest([{ role: 'user', content: 'hello' }]),
    });

    expect(result.contextSnapshot.budget).toMatchObject({ status: 'unknown' });
    expect(result.contextSnapshot.localTokenLedger).toMatchObject({ accuracy: 'unavailable' });
    expect(result.compressionRecommended).toBe(false);
  });

  it('does not recommend session compaction from a stage soft target when the model window has room', () => {
    const engine = new ContextEngine({
      tokenCounter: lengthCounter,
      resolveContextWindow: () => ({ maxContextTokens: 1_000, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: exactLengthCapability,
    });
    const contract = callContract(
      ['system_prompt', 'recent_message', 'user_input'],
      ['system_prompt', 'user_input'],
    );
    contract.budget.maxPromptTokens = 40;
    const result = engine.prepare({
      runId: 'run-soft-target',
      sessionId: asSessionId('session-soft-target'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      callContract: contract,
      candidates: [
        candidate('system', 0, 's'.repeat(15), { required: true, priority: 100, role: 'system' }),
        candidate('history', 10, 'h'.repeat(15), { priority: 10 }),
        candidate('current', 20, 'u'.repeat(25), { required: true, priority: 90, kind: 'user_input' }),
      ],
    });

    expect(result.omittedCandidateIds).toEqual(['history']);
    expect(result.contextSnapshot.localTokenLedger?.promptTokens).toBe(40);
    expect(result.contextSnapshot.budget).toMatchObject({ availablePromptTokens: 990 });
    expect(result.compressionRecommended).toBe(false);
  });

  it('does not let a counter self-declare exactness for an unavailable model', () => {
    const counter: ExactContextTokenCounter = {
      id: 'untrusted-counter',
      supports: () => true,
      countRequest: () => {
        throw new Error('must not be called');
      },
    };
    const engine = new ContextEngine({
      tokenCounter: counter,
      resolveTokenizerCapability: () => ({
        status: 'unavailable',
        reasonCode: 'no-verified-final-request-counter',
        reason: 'No verified final request counter.',
        source: 'builtin-model-registry',
        verifiedAt: '2026-07-13',
      }),
    });

    const result = engine.prepare({
      runId: 'run-unavailable-counter',
      sessionId: asSessionId('session-unavailable-counter'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest([{ role: 'user', content: 'hello' }]),
    });

    expect(result.contextSnapshot.localTokenLedger).toMatchObject({
      accuracy: 'unavailable',
      reason: 'No verified final request counter.',
    });
  });

  it('uses a conservative estimate to omit optional context when exact counting is unavailable', () => {
    const safetyEstimator = {
      id: 'length-safety-estimator-v1',
      estimatePromptTokens: (request: ChatRequest) => request.messages.reduce((total, message) => {
        if (typeof message.content === 'string') return total + message.content.length;
        return total + message.content.reduce(
          (sum, part) => sum + (part.type === 'text' ? part.text.length : 1),
          0,
        );
      }, 0),
    };
    const engine = new ContextEngine({
      safetyEstimator,
      resolveContextWindow: () => ({ maxContextTokens: 50, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: () => ({
        status: 'unavailable',
        reasonCode: 'no-verified-final-request-counter',
        reason: 'No verified final request counter.',
        source: 'builtin-model-registry',
        verifiedAt: '2026-07-13',
      }),
    });
    const result = engine.prepare({
      runId: 'run-safety-estimate',
      sessionId: asSessionId('session-safety-estimate'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [
        candidate('system', 0, 's'.repeat(15), { required: true, role: 'system', priority: 100 }),
        candidate('history', 10, 'h'.repeat(15), { priority: 10 }),
        candidate('current', 20, 'u'.repeat(25), { required: true, kind: 'user_input', priority: 90 }),
      ],
    });

    expect(result.omittedCandidateIds).toEqual(['history']);
    expect(result.request.messages.map((message) => message.content)).toEqual([
      's'.repeat(15),
      'u'.repeat(25),
    ]);
    expect(result.contextSnapshot.safetyEstimate).toMatchObject({
      estimatorId: safetyEstimator.id,
      estimatedPromptTokens: 40,
      displayable: false,
    });
    expect(result.contextSnapshot.localTokenLedger).toMatchObject({ accuracy: 'unavailable' });
    expect(result.compressionRecommended).toBe(true);
  });

  it('fails closed when required context exceeds the conservative safety budget', () => {
    const engine = new ContextEngine({
      safetyEstimator: {
        id: 'length-safety-estimator-v1',
        estimatePromptTokens: (request) => request.messages.reduce(
          (total, message) => total + (typeof message.content === 'string' ? message.content.length : 0),
          0,
        ),
      },
      resolveContextWindow: () => ({ maxContextTokens: 30, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: () => ({
        status: 'unavailable',
        reasonCode: 'no-verified-final-request-counter',
        reason: 'No verified final request counter.',
        source: 'builtin-model-registry',
        verifiedAt: '2026-07-13',
      }),
    });

    expect(() => engine.prepare({
      runId: 'run-safety-overflow',
      sessionId: asSessionId('session-safety-overflow'),
      stage: 'execute',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest(),
      candidates: [candidate('required', 0, 'x'.repeat(25), { required: true })],
    })).toThrow(ContextBudgetExceededError);

    try {
      engine.prepare({
        runId: 'run-safety-overflow-2',
        sessionId: asSessionId('session-safety-overflow-2'),
        stage: 'execute',
        requestIndex: 1,
        provider: 'openai',
        request: baseRequest(),
        candidates: [candidate('required', 0, 'x'.repeat(25), { required: true })],
      });
    } catch (error) {
      expect(error).toMatchObject({ measurement: 'conservative_estimate' });
    }
  });

  it('does not count image data URLs as text bytes in the safety estimate', () => {
    const engine = new ContextEngine({
      resolveContextWindow: () => ({ maxContextTokens: 100_000, source: 'builtin-model-registry' }),
      resolveTokenizerCapability: () => ({
        status: 'unavailable',
        reasonCode: 'no-verified-final-request-counter',
        reason: 'No verified final request counter.',
        source: 'builtin-model-registry',
        verifiedAt: '2026-07-13',
      }),
    });
    const result = engine.prepare({
      runId: 'run-safety-image',
      sessionId: asSessionId('session-safety-image'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest([{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${'a'.repeat(200_000)}`, detail: 'auto' },
        }],
      }]),
    });

    expect(result.contextSnapshot.safetyEstimate?.estimatedPromptTokens).toBeLessThan(100_000);
    expect(result.contextSnapshot.safetyEstimate?.estimatedPromptTokens).toBeGreaterThan(32_768);
  });

  it('requires the registered counter id to match the model capability', () => {
    const engine = new ContextEngine({
      tokenCounter: lengthCounter,
      resolveTokenizerCapability: () => ({
        ...exactLengthCapability(),
        counterId: 'different-counter',
      }),
    });

    const result = engine.prepare({
      runId: 'run-counter-mismatch',
      sessionId: asSessionId('session-counter-mismatch'),
      stage: 'reply',
      requestIndex: 1,
      provider: 'openai',
      request: baseRequest([{ role: 'user', content: 'hello' }]),
    });

    expect(result.contextSnapshot.localTokenLedger).toMatchObject({
      accuracy: 'unavailable',
      reason: expect.stringContaining('expected different-counter'),
    });
  });

  it('snapshots reasoning controls and provider reasoning message shape', () => {
    const engine = new ContextEngine({ resolveContextWindow: () => undefined });
    const result = engine.prepare({
      runId: 'run-reasoning',
      sessionId: asSessionId('session-reasoning'),
      stage: 'execute',
      requestIndex: 1,
      provider: 'glm',
      request: {
        model: 'glm-5.2',
        messages: [{
          role: 'assistant',
          content: '',
          reasoning_content: 'keep this reasoning',
        }],
        reasoning_effort: 'max',
        thinking: { type: 'enabled', clear_thinking: false },
      },
    });

    expect(result.modelRequestSnapshot).toMatchObject({
      reasoningEffort: 'max',
      thinkingMode: 'enabled',
      preserveThinking: true,
    });
    expect(result.modelRequestSnapshot.messages[0]).toMatchObject({
      reasoningCharacterCount: 19,
    });
    expect(result.modelRequestSnapshot.messages[0]?.reasoningHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
